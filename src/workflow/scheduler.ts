import { createHash } from "node:crypto"

import type { PermissionRuleset } from "@opencode-ai/sdk/v2"

import type {
  AgentStep,
  BranchStep,
  LoopStep,
  MapStep,
  NormalizedWorkflow,
  Policy,
  Step,
  SynthesizeStep,
  WorkflowSpecV1,
} from "./types.ts"
import { evaluateCondition, renderTemplate, resolveReference, validateWorkflowSpec } from "./schema.ts"
import type {
  ChildSessionHandle,
  CreateSessionInput,
  RunResult,
  SessionBackend,
} from "./backend.ts"
import { SessionBackendError, SessionCancelledError, SessionRunError, SessionTimeoutError } from "./backend.ts"
import type { RunNode, RunRecord, RunSummary, RunUsage } from "./state.ts"
import { ACTIVE_STATUSES } from "./state.ts"
import type { WorkflowStore } from "./store.ts"

const INPUT_ROOT = "input"
const DEFAULT_SYNTHESIZER = "general"
const NON_RETRYABLE_RUN_CODES = new Set([
  "SessionNotFoundError",
  "ModelUnavailableError",
  "ProviderAuthError",
  "ContextOverflowError",
  "ContentFilterError",
])

type JsonObject = Record<string, unknown>

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

const stableStringify = (value: unknown): string => JSON.stringify(stableValue(value))
const digest = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex")

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : stableStringify(error)

const nowIso = (): string => new Date().toISOString()

const addUsage = (target: RunUsage, addition: RunUsage): void => {
  target.tokensIn = (target.tokensIn ?? 0) + (addition.tokensIn ?? 0)
  target.tokensOut = (target.tokensOut ?? 0) + (addition.tokensOut ?? 0)
  target.cost = (target.cost ?? 0) + (addition.cost ?? 0)
  target.durationMs = (target.durationMs ?? 0) + (addition.durationMs ?? 0)
}

const usageFromResult = (result: RunResult, durationMs: number): RunUsage => ({
  tokensIn: result.tokens?.input ?? 0,
  tokensOut: (result.tokens?.output ?? 0) + (result.tokens?.reasoning ?? 0),
  cost: result.cost ?? 0,
  durationMs,
})

const normalizeWorkflowName = (name: string | undefined): string => {
  const normalized = (name ?? "workflow").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "")
  return normalized.slice(0, 128) || "workflow"
}

const makeInstanceKey = (...parts: string[]): string => {
  const raw = parts.join("~").replace(/[^A-Za-z0-9._~-]/g, "-")
  if (raw.length <= 256 && raw !== "." && raw !== "..") return raw
  return `${raw.slice(0, 215)}~${digest(raw).slice(0, 32)}`
}

class Semaphore {
  private readonly limit: number
  private active = 0
  private readonly waiters: Array<{
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
    abort?: () => void
  }> = []

  constructor(limit: number) {
    this.limit = limit
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.waiters)[number]
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener("abort", waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort)
      this.active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        this.drain()
      })
    }
  }
}

export class WorkflowSchedulerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "WorkflowSchedulerError"
  }
}

export class WorkflowCancelledError extends WorkflowSchedulerError {
  constructor(message = "workflow cancelled") {
    super(message)
    this.name = "WorkflowCancelledError"
  }
}

export class WorkflowLimitError extends WorkflowSchedulerError {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowLimitError"
  }
}

export interface WorkflowInvocationContext {
  parentSessionID: string
  parentAgent?: string
  parentModel?: string
  parentVariant?: string
  notifyParent?: boolean
  input?: unknown
  defaultAgent?: string
  defaultModel?: string
  defaultVariant?: string
}

export interface StartWorkflowInput extends WorkflowInvocationContext {
  spec: WorkflowSpecV1
  workflow?: string
  metadata?: Record<string, string>
}

export interface WorkflowProgress {
  runId: string
  workflow: string
  status: RunRecord["status"]
  completed: number
  running: number
  failed: number
  skipped: number
  total: number
  usage: RunUsage
  error?: string
}

export type WorkflowSchedulerEvent =
  | { type: "run.started"; runId: string }
  | { type: "run.completed"; runId: string; result: unknown }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.canceled"; runId: string; reason: string }
  | { type: "node.started"; runId: string; instanceKey: string; stepId: string }
  | { type: "node.completed"; runId: string; instanceKey: string; stepId: string; cached: boolean }

export interface WorkflowSchedulerOptions {
  store: WorkflowStore
  backend: SessionBackend
  policy?: Policy
  defaultAgent?: string
  defaultModel?: string
  defaultVariant?: string
  permission?: PermissionRuleset | ((step: AgentStep | SynthesizeStep) => PermissionRuleset | undefined)
  onEvent?: (event: WorkflowSchedulerEvent) => void | Promise<void>
  disposeBackend?: boolean
  defaultStepTimeoutMs?: number
}

type PersistedContext = WorkflowInvocationContext & {
  workflow: string
  specFingerprint: string
}

type ActiveRun = {
  controller: AbortController
  promise: Promise<RunRecord>
  sessions: Map<string, ChildSessionHandle>
}

type RunContext = {
  runId: string
  invocation: PersistedContext
  workflow: NormalizedWorkflow
  controller: AbortController
  semaphore: Semaphore
  values: JsonObject
  usage: RunUsage
  agentCount: number
  sessions: Map<string, ChildSessionHandle>
  integrations: Array<{
    handle: ChildSessionHandle
    sourceStepId: string
    sourceInstanceKey: string
    files: string[]
  }>
  integrationTail: Promise<void>
  deferredLimits: Map<string, WorkflowLimitError>
  deadlineTimer?: ReturnType<typeof setTimeout>
}

type StepResult = { value: unknown; scope: JsonObject }

export class WorkflowScheduler {
  private readonly store: WorkflowStore
  private readonly backend: SessionBackend
  private readonly options: WorkflowSchedulerOptions
  private readonly active = new Map<string, ActiveRun>()
  private disposed = false

  constructor(options: WorkflowSchedulerOptions) {
    this.store = options.store
    this.backend = options.backend
    this.options = options
  }

  async start(input: StartWorkflowInput): Promise<RunRecord> {
    this.assertActive()
    if (!input.parentSessionID) throw new WorkflowSchedulerError("parentSessionID is required")
    const workflow = validateWorkflowSpec(input.spec, this.options.policy)
    const invocation: PersistedContext = {
      parentSessionID: input.parentSessionID,
      parentAgent: input.parentAgent,
      parentModel: input.parentModel,
      parentVariant: input.parentVariant,
      notifyParent: input.notifyParent,
      input: input.input ?? {},
      defaultAgent: input.defaultAgent ?? this.options.defaultAgent,
      defaultModel: input.defaultModel ?? this.options.defaultModel,
      defaultVariant: input.defaultVariant ?? this.options.defaultVariant,
      workflow: normalizeWorkflowName(input.workflow ?? workflow.spec.name),
      specFingerprint: digest(workflow.spec),
    }
    const runFingerprint = digest({ spec: workflow.spec, invocation })
    const record = await this.store.createRun({
      instanceId: digest({ parentSessionID: invocation.parentSessionID, runFingerprint }).slice(0, 32),
      workflow: invocation.workflow,
      fingerprint: runFingerprint,
      spec: workflow.spec,
      metadata: input.metadata,
    })
    await this.store.saveContext(record.runId, invocation)
    this.launch(record.runId, invocation, workflow, false)
    return record
  }

  async execute(input: StartWorkflowInput): Promise<RunRecord> {
    const record = await this.start(input)
    return this.wait(record.runId)
  }

  async resume(runId: string, options: { wait?: boolean } = {}): Promise<RunRecord> {
    this.assertActive()
    if (this.active.has(runId)) return this.wait(runId)
    const record = await this.store.loadRun(runId)
    if (record === null) throw new WorkflowSchedulerError(`workflow run "${runId}" was not found`)
    if (record.status === "completed") return record
    const rawSpec = await this.store.loadSpec(runId)
    const rawContext = await this.store.loadContext(runId)
    if (rawSpec === null || !isRecord(rawContext)) {
      throw new WorkflowSchedulerError(`workflow run "${runId}" cannot resume without spec and context`)
    }
    const invocation = rawContext as unknown as PersistedContext
    const workflow = validateWorkflowSpec(rawSpec, this.options.policy)
    if (digest(workflow.spec) !== invocation.specFingerprint) {
      throw new WorkflowSchedulerError(`workflow run "${runId}" spec fingerprint does not match its context`)
    }
    await this.store.resumeRun(runId, { reason: "workflow scheduler resume" })
    this.launch(runId, invocation, workflow, true)
    return options.wait === false ? (await this.store.loadRun(runId))! : this.wait(runId)
  }

  async wait(runId: string): Promise<RunRecord> {
    const active = this.active.get(runId)
    if (active) return active.promise
    const record = await this.store.loadRun(runId)
    if (record === null) throw new WorkflowSchedulerError(`workflow run "${runId}" was not found`)
    return record
  }

  async cancel(runId: string): Promise<RunRecord> {
    const active = this.active.get(runId)
    if (active) {
      active.controller.abort(new WorkflowCancelledError())
      await Promise.all([...active.sessions.keys()].map((id) => this.backend.cancel(id).catch(() => undefined)))
      return active.promise
    }
    const record = await this.store.loadRun(runId)
    if (record === null) throw new WorkflowSchedulerError(`workflow run "${runId}" was not found`)
    if (ACTIVE_STATUSES.has(record.status) || record.status === "interrupted") {
      return this.store.updateRun(runId, { status: "canceled", error: "workflow cancelled" })
    }
    return record
  }

  async get(runId: string): Promise<RunRecord | null> {
    return this.store.loadRun(runId)
  }

  async list(): Promise<RunSummary[]> {
    return this.store.listRuns()
  }

  async result(runId: string): Promise<unknown | null> {
    const spec = await this.store.loadSpec(runId)
    if (spec === null || spec.steps.length === 0) return null
    return this.store.loadResult(runId, spec.steps.at(-1)!.id)
  }

  async progress(runId: string): Promise<WorkflowProgress | null> {
    const record = await this.store.loadRun(runId)
    if (record === null) return null
    const nodes = Object.values(record.nodes)
    return {
      runId,
      workflow: record.workflow,
      status: record.status,
      completed: nodes.filter((node) => node.status === "completed" || node.status === "cached").length,
      running: nodes.filter((node) => node.status === "running").length,
      failed: nodes.filter((node) => node.status === "failed" || node.status === "cancelled").length,
      skipped: nodes.filter((node) => node.status === "skipped").length,
      total: nodes.length,
      usage: record.usage ?? {},
      error: record.error,
    }
  }

  async recoverInterrupted(reason = "opencode restarted while workflow was active"): Promise<RunSummary[]> {
    return this.store.markInterrupted(reason)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.active.keys()].map((runId) => this.cancel(runId).catch(() => undefined)))
    if (this.options.disposeBackend) await this.backend.dispose()
  }

  private assertActive(): void {
    if (this.disposed) throw new WorkflowSchedulerError("workflow scheduler has been disposed")
  }

  private launch(
    runId: string,
    invocation: PersistedContext,
    workflow: NormalizedWorkflow,
    resumed: boolean,
  ): void {
    const controller = new AbortController()
    const sessions = new Map<string, ChildSessionHandle>()
    const promise = this.runInternal(runId, invocation, workflow, controller, sessions, resumed)
      .finally(() => this.active.delete(runId))
    this.active.set(runId, { controller, promise, sessions })
    void promise.catch(() => undefined)
  }

  private async runInternal(
    runId: string,
    invocation: PersistedContext,
    workflow: NormalizedWorkflow,
    controller: AbortController,
    sessions: Map<string, ChildSessionHandle>,
    resumed: boolean,
  ): Promise<RunRecord> {
    const existing = await this.store.loadRun(runId)
    if (existing === null) throw new WorkflowSchedulerError(`workflow run "${runId}" was not found`)
    const context: RunContext = {
      runId,
      invocation,
      workflow,
      controller,
      semaphore: new Semaphore(workflow.limits.maxParallel),
      values: { [INPUT_ROOT]: invocation.input ?? {} },
      usage: { ...(existing.usage ?? {}) },
      agentCount: existing.sessions.length,
      sessions,
      integrations: [],
      integrationTail: Promise.resolve(),
      deferredLimits: new Map(),
    }
    if (workflow.limits.deadline) {
      const remaining = Date.parse(workflow.limits.deadline) - Date.now()
      if (remaining <= 0) controller.abort(new WorkflowLimitError("workflow deadline has passed"))
      else context.deadlineTimer = setTimeout(
        () => controller.abort(new WorkflowLimitError("workflow deadline reached; in-flight agents were cancelled")),
        remaining,
      )
    }
    try {
      if (!resumed) await this.store.updateRun(runId, { status: "running" })
      await this.emit({ type: "run.started", runId })
      await this.preloadValues(context, existing)
      let last: unknown
      for (const step of workflow.spec.steps) {
        this.throwIfAborted(context)
        last = (await this.executeStep(context, step, step.id, context.values)).value
      }
      await this.integrateWorktrees(context)
      const record = await this.store.updateRun(runId, { status: "completed" })
      await this.emit({ type: "run.completed", runId, result: last })
      return record
    } catch (error) {
      const cancelled = error instanceof WorkflowCancelledError || error instanceof SessionCancelledError
      const status = cancelled ? "canceled" : "failed"
      if (!controller.signal.aborted) controller.abort(error)
      await Promise.all([...sessions.values()].map((handle) => this.backend.cancel(handle.sessionID).catch(() => undefined)))
      const record = await this.store.updateRun(runId, { status, error: errorMessage(error) })
      await this.emit(cancelled
        ? { type: "run.canceled", runId, reason: errorMessage(error) }
        : { type: "run.failed", runId, error: errorMessage(error) })
      return record
    } finally {
      if (context.deadlineTimer) clearTimeout(context.deadlineTimer)
      await Promise.all([...sessions.values()].map((handle) => this.backend.releaseSession(handle)))
      sessions.clear()
    }
  }

  private async preloadValues(context: RunContext, record: RunRecord): Promise<void> {
    const grouped = new Map<string, Array<{ key: string; value: unknown }>>()
    for (const [instanceKey, node] of Object.entries(record.nodes)) {
      if (node.status !== "completed" && node.status !== "cached") continue
      const value = await this.store.loadResult(context.runId, instanceKey)
      if (value === null) continue
      const entries = grouped.get(node.stepId) ?? []
      entries.push({ key: instanceKey, value })
      grouped.set(node.stepId, entries)
    }
    for (const [stepId, entries] of grouped) {
      entries.sort((a, b) => a.key.localeCompare(b.key))
      context.values[stepId] = entries.length === 1 ? entries[0].value : entries.map((entry) => entry.value)
    }
  }

  private async executeStep(
    context: RunContext,
    step: Step,
    instanceKey: string,
    scope: JsonObject,
  ): Promise<StepResult> {
    this.throwIfAborted(context)
    if (step.type !== "agent" && step.type !== "synthesize") {
      await this.recordNode(context, instanceKey, step.id, "running", {
        startedAt: nowIso(),
        attempts: 0,
      })
    }
    await this.emit({ type: "node.started", runId: context.runId, instanceKey, stepId: step.id })
    try {
      let value: unknown
      switch (step.type) {
        case "agent":
        case "synthesize":
          value = await this.executeLeaf(context, step, instanceKey, scope)
          await this.integrateInstanceWorktree(context, instanceKey)
          if (context.deferredLimits.has(instanceKey)) throw context.deferredLimits.get(instanceKey)
          break
        case "sequence":
          value = await this.executeSequence(context, step.steps, instanceKey, scope)
          break
        case "parallel":
          value = await this.executeParallel(context, step.steps, instanceKey, scope, step.maxParallel)
          break
        case "map":
          value = await this.executeMap(context, step, instanceKey, scope)
          break
        case "branch":
          value = await this.executeBranch(context, step, instanceKey, scope)
          break
        case "loop":
          value = await this.executeLoop(context, step, instanceKey, scope)
          break
      }
      scope[step.id] = value
      context.values[step.id] = value
      if (step.type !== "agent" && step.type !== "synthesize") {
        const fingerprint = digest({ step, scope: stableValue(scope) })
        await this.store.updateRun(context.runId, {
          node: {
            instanceKey,
            node: { instanceKey, stepId: step.id, status: "completed", executionFingerprint: fingerprint, finishedAt: nowIso() },
          },
          result: { instanceKey, stepId: step.id, value },
        })
      }
      await this.emit({ type: "node.completed", runId: context.runId, instanceKey, stepId: step.id, cached: false })
      return { value, scope }
    } catch (error) {
      const cancelled = error instanceof WorkflowCancelledError || error instanceof SessionCancelledError
      await this.recordNode(context, instanceKey, step.id, cancelled ? "cancelled" : "failed", {
        finishedAt: nowIso(),
        error: errorMessage(error),
      })
      throw error
    }
  }

  private async executeSequence(
    context: RunContext,
    steps: readonly Step[],
    parentKey: string,
    scope: JsonObject,
  ): Promise<unknown> {
    let last: unknown
    for (const child of steps) {
      last = (await this.executeStep(context, child, makeInstanceKey(parentKey, child.id), scope)).value
    }
    return last
  }

  private async executeParallel(
    context: RunContext,
    steps: readonly Step[],
    parentKey: string,
    scope: JsonObject,
    requested?: number,
  ): Promise<unknown[]> {
    const limit = Math.min(requested ?? context.workflow.limits.maxParallel, context.workflow.limits.maxParallel)
    const pending = new Map(steps.map((step, index) => [step.id, { step, index }]))
    const results: unknown[] = new Array(steps.length)
    const completed = new Set<string>()
    while (pending.size > 0) {
      const ready = [...pending.values()].filter(({ step }) =>
        [...new Set([...(step.dependsOn ?? []), ...(context.workflow.dependencies[step.id] ?? [])])]
          .every((id) => !pending.has(id) || completed.has(id)),
      )
      if (ready.length === 0) {
        throw new WorkflowSchedulerError(`parallel step "${parentKey}" has unresolved sibling dependencies`)
      }
      await this.mapLimit(ready, limit, async ({ step, index }) => {
        const result = await this.executeStep(context, step, makeInstanceKey(parentKey, step.id), scope)
        results[index] = result.value
        completed.add(step.id)
        pending.delete(step.id)
      }, context.controller)
    }
    return results
  }

  private async executeMap(context: RunContext, step: MapStep, instanceKey: string, scope: JsonObject): Promise<unknown[]> {
    const source = this.resolve(context, scope, step.over)
    if (!Array.isArray(source)) throw new WorkflowSchedulerError(`map step "${step.id}" source "${step.over}" is not an array`)
    if (source.length > context.workflow.limits.maxIterations) {
      throw new WorkflowLimitError(`map step "${step.id}" has ${source.length} items, exceeding maxIterations ${context.workflow.limits.maxIterations}`)
    }
    const iterationScopes: JsonObject[] = new Array(source.length)
    const values = await this.mapLimit(
      source,
      Math.min(step.maxParallel ?? context.workflow.limits.maxParallel, context.workflow.limits.maxParallel),
      async (item, index) => {
        const local: JsonObject = { ...scope, [step.as]: item }
        iterationScopes[index] = local
        return this.executeSequence(context, step.steps, makeInstanceKey(instanceKey, `i${index}`), local)
      },
      context.controller,
    )
    for (const child of step.steps) {
      const aggregated = iterationScopes.map((entry) => entry[child.id])
      scope[child.id] = aggregated
      context.values[child.id] = aggregated
    }
    return values
  }

  private async executeBranch(context: RunContext, step: BranchStep, instanceKey: string, scope: JsonObject): Promise<unknown> {
    for (const branchCase of step.cases) {
      if (!evaluateCondition(branchCase.when, context.values, scope)) continue
      return this.executeSequence(context, branchCase.steps, makeInstanceKey(instanceKey, `c${branchCase.id}`), scope)
    }
    if (step.otherwise) return this.executeSequence(context, step.otherwise, makeInstanceKey(instanceKey, "otherwise"), scope)
    return null
  }

  private async executeLoop(context: RunContext, step: LoopStep, instanceKey: string, scope: JsonObject): Promise<unknown[]> {
    const limit = Math.min(step.maxIterations ?? context.workflow.limits.maxIterations, context.workflow.limits.maxIterations)
    const source = step.over ? this.resolve(context, scope, step.over) : undefined
    if (source !== undefined && !Array.isArray(source)) {
      throw new WorkflowSchedulerError(`loop step "${step.id}" source "${step.over}" is not an array`)
    }
    const iterations = source ?? Array.from({ length: limit }, () => undefined)
    if (source && source.length > limit) {
      throw new WorkflowLimitError(
        `loop step "${step.id}" has ${source.length} items, exceeding maxIterations ${limit}`,
      )
    }
    const results: unknown[] = []
    const childResults = new Map<string, unknown[]>()
    const loopScope: JsonObject = { ...scope }
    let conditionMet = step.until === undefined
    for (let index = 0; index < iterations.length && index < limit; index++) {
      this.throwIfAborted(context)
      if (step.as) loopScope[step.as] = iterations[index]
      const value = await this.executeSequence(context, step.steps, makeInstanceKey(instanceKey, `i${index}`), loopScope)
      results.push(value)
      for (const child of step.steps) {
        const entries = childResults.get(child.id) ?? []
        entries.push(loopScope[child.id])
        childResults.set(child.id, entries)
      }
      if (step.until && evaluateCondition(step.until, context.values, loopScope)) {
        conditionMet = true
        break
      }
    }
    for (const [childId, values] of childResults) {
      scope[childId] = values
      context.values[childId] = values
    }
    if (!conditionMet) {
      throw new WorkflowLimitError(`loop step "${step.id}" did not satisfy its until condition within ${limit} iterations`)
    }
    return results
  }

  private async executeLeaf(
    context: RunContext,
    step: AgentStep | SynthesizeStep,
    instanceKey: string,
    scope: JsonObject,
  ): Promise<unknown> {
    const prompt = renderTemplate(step.prompt, context.values, scope)
    const agent = step.agent ?? context.invocation.defaultAgent ?? DEFAULT_SYNTHESIZER
    const model = step.model ?? context.invocation.defaultModel
    const variant = step.variant ?? context.invocation.defaultVariant
    const executionFingerprint = digest({
      stepId: step.id,
      prompt,
      agent,
      model,
      variant,
      schema: step.outputSchema,
      isolation: step.isolation ?? false,
      input: stableValue(context.invocation.input),
    })
    const current = await this.store.loadRun(context.runId)
    const node = current?.nodes[instanceKey]
    if (
      node &&
      (node.status === "completed" || node.status === "cached") &&
      node.executionFingerprint === executionFingerprint
    ) {
      const cached = await this.store.loadResult(context.runId, instanceKey)
      if (cached !== null) {
        await this.recordNode(context, instanceKey, step.id, "cached", {
          ...node,
          cached: true,
          executionFingerprint,
        })
        await this.emit({ type: "node.completed", runId: context.runId, instanceKey, stepId: step.id, cached: true })
        return cached
      }
    }

    const retries = step.retry ?? 0
    let lastError: unknown
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      this.throwIfAborted(context)
      const release = await context.semaphore.acquire(context.controller.signal)
      let handle: ChildSessionHandle | undefined
      let retainForIntegration = false
      const startedAt = Date.now()
      try {
        const requiredAgents = step.isolation === true ? 2 : 1
        if (context.agentCount + requiredAgents > context.workflow.limits.maxAgents) {
          throw new WorkflowLimitError(`workflow exceeded maxAgents ${context.workflow.limits.maxAgents}; retries count toward this limit`)
        }
        context.agentCount += 1
        await this.recordNode(context, instanceKey, step.id, "running", {
          executionFingerprint,
          attempts: attempt,
          startedAt: nowIso(),
        })
        const createInput: CreateSessionInput = {
          parentID: context.invocation.parentSessionID,
          agent,
          model,
          variant,
          title: `${context.invocation.workflow}: ${step.label ?? step.id}`,
          metadata: { workflowRunId: context.runId, stepId: step.id, instanceKey },
          permission: typeof this.options.permission === "function" ? this.options.permission(step) : this.options.permission,
          worktree: step.isolation === true,
        }
        handle = await this.backend.createSession(createInput)
        context.sessions.set(handle.sessionID, handle)
        const runningNode = (await this.store.loadRun(context.runId))?.nodes[instanceKey]
        await this.store.updateRun(context.runId, {
          node: {
            instanceKey,
            node: {
              ...runningNode,
              instanceKey,
              stepId: step.id,
              status: "running",
              executionFingerprint,
              sessionId: handle.sessionID,
              worktree: handle.worktree
                ? { directory: handle.worktree.directory, branch: handle.worktree.branch }
                : undefined,
              attempts: attempt,
              startedAt: nowIso(),
            },
          },
          session: { sessionId: handle.sessionID, agent, model, status: "open", startedAt: nowIso() },
        })
        const result = await this.backend.run({
          sessionID: handle.sessionID,
          prompt,
          format: step.outputSchema,
          timeoutMs: step.timeout === undefined ? this.options.defaultStepTimeoutMs : step.timeout * 1000,
          signal: context.controller.signal,
        })
        const usage = usageFromResult(result, Date.now() - startedAt)
        addUsage(context.usage, usage)
        const priorUsage = (await this.store.loadRun(context.runId))?.nodes[instanceKey]?.usage
        const nodeUsage = { ...(priorUsage ?? {}) }
        addUsage(nodeUsage, usage)
        const value = result.structured !== undefined ? result.structured : result.text
        await this.store.updateRun(context.runId, {
          usage,
          node: {
            instanceKey,
            node: {
              instanceKey,
              stepId: step.id,
              status: "completed",
              executionFingerprint,
              sessionId: handle.sessionID,
              worktree: handle.worktree
                ? { directory: handle.worktree.directory, branch: handle.worktree.branch }
                : undefined,
              attempts: attempt,
              usage: nodeUsage,
              startedAt: nowIso(),
              finishedAt: nowIso(),
            },
          },
          session: { sessionId: handle.sessionID, agent, model, status: "closed", endedAt: nowIso(), usage },
          result: { instanceKey, stepId: step.id, value },
        })
        if (handle.worktree) {
          retainForIntegration = true
          context.integrations.push({
            handle,
            sourceStepId: step.id,
            sourceInstanceKey: instanceKey,
            files: result.files,
          })
        }
        try {
          this.enforceUsageLimits(context, !handle.worktree)
        } catch (error) {
          if (!(error instanceof WorkflowLimitError) || !handle.worktree) throw error
          context.deferredLimits.set(instanceKey, error)
        }
        return value
      } catch (error) {
        let failure = error
        if (handle) {
          const partialResult = error instanceof SessionBackendError ? error.partialResult : undefined
          if (partialResult !== undefined) {
            const usage = usageFromResult(partialResult, Date.now() - startedAt)
            addUsage(context.usage, usage)
            const existingNode = (await this.store.loadRun(context.runId))?.nodes[instanceKey]
            const nodeUsage = { ...(existingNode?.usage ?? {}) }
            addUsage(nodeUsage, usage)
            await this.store.updateRun(context.runId, {
              usage,
              node: {
                instanceKey,
                node: {
                  ...existingNode,
                  instanceKey,
                  stepId: step.id,
                  status: "running",
                  usage: nodeUsage,
                },
              },
              session: {
                sessionId: handle.sessionID,
                agent,
                model,
                status: "failed",
                endedAt: nowIso(),
                usage,
              },
            })
            try {
              this.enforceUsageLimits(context)
            } catch (limitError) {
              failure = limitError
            }
          } else {
            await this.store.updateRun(context.runId, {
              session: { sessionId: handle.sessionID, agent, model, status: "failed", endedAt: nowIso() },
            }).catch(() => undefined)
          }
        }
        lastError = failure
        if (
          attempt > retries ||
          context.controller.signal.aborted ||
          failure instanceof SessionCancelledError ||
          failure instanceof SessionTimeoutError ||
          (failure instanceof SessionBackendError && failure.constructor === SessionBackendError) ||
          (failure instanceof SessionRunError && NON_RETRYABLE_RUN_CODES.has(failure.code)) ||
          failure instanceof WorkflowLimitError
        ) throw failure
      } finally {
        if (handle && !retainForIntegration) {
          context.sessions.delete(handle.sessionID)
          await this.backend.releaseSession(handle)
        }
        release()
      }
    }
    throw lastError
  }

  private enforceUsageLimits(context: RunContext, abort = true): void {
    const tokens = (context.usage.tokensIn ?? 0) + (context.usage.tokensOut ?? 0)
    if (context.workflow.limits.maxTokens !== undefined && tokens >= context.workflow.limits.maxTokens) {
      const error = new WorkflowLimitError(
        `workflow reached maxTokens ${context.workflow.limits.maxTokens}; already-running agents may cause bounded overshoot`,
      )
      if (abort) context.controller.abort(error)
      throw error
    }
    if (context.workflow.limits.maxCost !== undefined && (context.usage.cost ?? 0) >= context.workflow.limits.maxCost) {
      const error = new WorkflowLimitError(
        `workflow reached maxCost ${context.workflow.limits.maxCost}; already-running agents may cause bounded overshoot`,
      )
      if (abort) context.controller.abort(error)
      throw error
    }
  }

  private async integrateWorktrees(context: RunContext): Promise<void> {
    for (const integration of [...context.integrations]) {
      await this.integrateInstanceWorktree(context, integration.sourceInstanceKey)
    }
    await context.integrationTail
  }

  private async integrateInstanceWorktree(context: RunContext, sourceInstanceKey: string): Promise<void> {
    const index = context.integrations.findIndex((entry) => entry.sourceInstanceKey === sourceInstanceKey)
    if (index === -1) return
    const [integration] = context.integrations.splice(index, 1)
    const previous = context.integrationTail
    let release!: () => void
    context.integrationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      this.throwIfAborted(context)
      const branch = integration.handle.worktree?.branch
      const prompt = [
        "Integrate changes produced by an isolated workflow worker into the current workspace.",
        `Source worktree: ${integration.handle.directory}`,
        branch ? `Source branch: ${branch}` : undefined,
        `Changed files reported by the worker: ${stableStringify(integration.files)}`,
        "Inspect the source worktree diff, apply the equivalent minimal changes to the current workspace, and run focused verification.",
        "Do not delete the source worktree or delegate further. Report exactly what was integrated and verified.",
      ].filter((line): line is string => line !== undefined).join("\n")
      const step: AgentStep = {
        id: `_integrate_${integration.sourceStepId}`,
        type: "agent",
        agent: context.invocation.defaultAgent ?? this.options.defaultAgent ?? "worker",
        prompt,
      }
      const key = makeInstanceKey("integration", integration.sourceInstanceKey)
      await this.executeStep(context, step, key, context.values)
      context.sessions.delete(integration.handle.sessionID)
      await this.backend.releaseSession(integration.handle)
    } finally {
      release()
    }
  }

  private resolve(context: RunContext, scope: JsonObject, reference: string): unknown {
    const root = reference.split(/[.[]/, 1)[0]
    return Object.prototype.hasOwnProperty.call(scope, root)
      ? resolveReference(scope, reference)
      : resolveReference(context.values, reference)
  }

  private async recordNode(
    context: RunContext,
    instanceKey: string,
    stepId: string,
    status: RunNode["status"],
    patch: Partial<RunNode> = {},
  ): Promise<void> {
    const existing = (await this.store.loadRun(context.runId))?.nodes[instanceKey]
    await this.store.updateRun(context.runId, {
      node: {
        instanceKey,
        node: { ...existing, ...patch, instanceKey, stepId, status },
      },
    })
  }

  private throwIfAborted(context: RunContext): void {
    if (!context.controller.signal.aborted) return
    const reason = context.controller.signal.reason
    if (reason instanceof Error) throw reason
    throw new WorkflowCancelledError()
  }

  private async mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
    controller: AbortController,
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason
        const index = next++
        if (index >= items.length) return
        results[index] = await fn(items[index], index)
      }
    })
    try {
      await Promise.all(workers)
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error)
      await Promise.allSettled(workers)
      throw error
    }
    return results
  }

  private async emit(event: WorkflowSchedulerEvent): Promise<void> {
    await this.options.onEvent?.(event)
  }
}
