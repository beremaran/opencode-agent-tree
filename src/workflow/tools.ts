import { tool } from "@opencode-ai/plugin"

import type { WorkflowSpecV1 } from "./types.ts"
import type { WorkflowScheduler } from "./scheduler.ts"
import type { WorkflowStore } from "./store.ts"

export const WORKFLOW_TOOL_NAMES = [
  "workflow_start",
  "workflow_status",
  "workflow_result",
  "workflow_cancel",
  "workflow_resume",
  "workflow_save",
  "workflow_list_saved",
] as const

export interface WorkflowServices {
  scheduler: WorkflowScheduler
  store: WorkflowStore
}

export interface WorkflowToolOptions {
  services: () => Promise<WorkflowServices>
  defaultModel: () => string
  parentExecution?: (sessionID: string) => {
    agent: string
    model?: string
    variant?: string
  } | undefined
  approval: "always" | "never"
  limits?: () => {
    maxParallel: number
    maxAgents: number
    maxIterations: number
    maxTokens?: number
    maxCost?: number
  }
}

const objectSchema = tool.schema.record(tool.schema.string(), tool.schema.unknown())

const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

const workflowAgentNames = (value: unknown, names = new Set<string>()): string[] => {
  if (!Array.isArray(value)) return [...names]
  for (const entry of value) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      if (
        (record.type === "agent" || record.type === "synthesize") &&
        typeof record.agent === "string"
      ) {
        names.add(record.agent)
      } else if (record.type === "synthesize" && record.agent === undefined) {
        names.add("worker")
      }
      workflowAgentNames(record.steps, names)
      if (Array.isArray(record.cases)) {
        for (const branchCase of record.cases) {
          if (branchCase !== null && typeof branchCase === "object" && !Array.isArray(branchCase)) {
            workflowAgentNames((branchCase as Record<string, unknown>).steps, names)
          }
        }
      }
      workflowAgentNames(record.otherwise, names)
    }
  }
  return [...names]
}

const WORKFLOW_AUTHORING_GUIDE = `The inline spec is strict JSON data, never JavaScript. workflow_start requires exactly one source: spec or name, never both:
{version:1,name?,description?,limits?,phases?,steps:[...]}. Root steps run in sequence.
Every step has a globally unique id, a type, optional label/phase/dependsOn.
- agent: {id,type:"agent",agent,prompt,model?,variant?,outputSchema?,retry?,timeout?,isolation?}
- synthesize: like agent, with optional agent and input:[references]. input uses raw tokens such as ["audits"], while prompt interpolation uses {{ audits }}; never put {{ }} around input entries.
- sequence/parallel: {id,type,steps:[...]}; parallel may set maxParallel
- map: {id,type:"map",over:"prior.array",as:"item",maxParallel?,steps:[...]}
- branch: {id,type:"branch",cases:[{id,when,steps}],otherwise?}
- loop: {id,type:"loop",over?,as?,until?,maxIterations?,steps:[...]}
Default allowed agents are general, explore, and worker; configured agent restrictions are enforced during validation. Do not inspect plugin source to discover them.
Prompts interpolate only safe references such as {{ input.issue }}, {{ discover.files }}, or a map variable like {{ item }}. A literal }} outside a matched {{ reference }} is ordinary text, so inline JSON is safe.
Conditions are closed objects: {$ref:"x"}, {$eq:[{$ref:"x"},value]}, $ne/$lt/$lte/$gt/$gte, {$and:[...]}, {$or:[...]}, {$not:{...}}.
outputSchema must be a complete JSON Schema object with a required type (for example {type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false}); shorthand field maps are invalid. The plugin requests JSON in the final response and validates it locally, so this works with models that do not support provider-native structured output.
Supported top-level limits are maxParallel, maxAgents, maxIterations, maxTokens, maxCost, and deadline (ISO 8601). maxSteps and maxDurationMin are not supported. Set isolation:true for editing agents that need a worktree; changed worktrees are serially integrated before completion. Keep limits explicit and bounded.`

export const createWorkflowTools = (options: WorkflowToolOptions) => ({
  workflow_start: tool({
    description: `Start a validated, durable multi-agent workflow. Provide either an inline v1 workflow spec or a saved workflow name. Returns immediately unless wait is true.\n\n${WORKFLOW_AUTHORING_GUIDE}`,
    args: {
      spec: objectSchema.optional(),
      name: tool.schema.string().min(1).optional(),
      input: tool.schema.unknown().optional(),
      wait: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      if ((args.spec === undefined) === (args.name === undefined)) {
        throw new Error("workflow_start requires exactly one of spec or name")
      }
      const { scheduler, store } = await options.services()
      const spec = args.name ? await store.loadWorkflow(args.name) : (args.spec as unknown as WorkflowSpecV1)
      const name = args.name ?? spec.name ?? "workflow"
      if (options.approval === "always") {
        const configuredLimits = options.limits?.()
        await context.ask({
          permission: "workflow",
          patterns: [name],
          always: [name],
          metadata: {
            name,
            steps: spec.steps?.length ?? 0,
            agents: workflowAgentNames(spec.steps),
            effectiveLimits: {
              maxParallel: spec.limits?.maxParallel ?? configuredLimits?.maxParallel,
              maxAgents: spec.limits?.maxAgents ?? configuredLimits?.maxAgents,
              maxIterations: spec.limits?.maxIterations ?? configuredLimits?.maxIterations,
              maxTokens: spec.limits?.maxTokens ?? configuredLimits?.maxTokens,
              maxCost: spec.limits?.maxCost ?? configuredLimits?.maxCost,
              deadline: spec.limits?.deadline,
            },
            childPermissions: "configured OpenCode agent/session rules; parent CLI --auto is not inherited",
          },
        })
      }
      context.metadata({ title: `Workflow: ${name}`, metadata: { status: "starting" } })
      const parent = options.parentExecution?.(context.sessionID)
      const run = await scheduler.start({
        parentSessionID: context.sessionID,
        parentAgent: parent?.agent ?? context.agent,
        parentModel: parent?.model,
        parentVariant: parent?.variant,
        notifyParent: args.wait !== true,
        spec,
        input: args.input,
        workflow: name,
        defaultModel: options.defaultModel(),
      })
      if (args.wait) {
        const completed = await scheduler.wait(run.runId)
        return {
          title: `Workflow ${completed.status}`,
          output: pretty({ run: await scheduler.progress(run.runId), result: await scheduler.result(run.runId) }),
          metadata: { runId: run.runId, status: completed.status },
        }
      }
      return {
        title: `Workflow started: ${name}`,
        output: `Workflow ${run.runId} started in the background. Use workflow_status or workflow_result to inspect it.`,
        metadata: { runId: run.runId, status: "queued" },
      }
    },
  }),
  workflow_status: tool({
    description: "Show progress for one workflow run, or list recent runs when runId is omitted.",
    args: { runId: tool.schema.string().min(1).optional() },
    async execute(args) {
      const { scheduler } = await options.services()
      const output = args.runId ? await scheduler.progress(args.runId) : await scheduler.list()
      return { title: args.runId ? "Workflow status" : "Workflows", output: pretty(output) }
    },
  }),
  workflow_result: tool({
    description: "Read the final result and current status of a workflow run.",
    args: { runId: tool.schema.string().min(1) },
    async execute(args) {
      const { scheduler } = await options.services()
      const progress = await scheduler.progress(args.runId)
      if (!progress) throw new Error(`workflow run "${args.runId}" was not found`)
      return {
        title: `Workflow ${progress.status}`,
        output: pretty({ run: progress, result: await scheduler.result(args.runId) }),
        metadata: { runId: args.runId, status: progress.status },
      }
    },
  }),
  workflow_cancel: tool({
    description: "Cancel a workflow and propagate cancellation to every running agent session.",
    args: { runId: tool.schema.string().min(1) },
    async execute(args) {
      const { scheduler } = await options.services()
      const run = await scheduler.cancel(args.runId)
      return { title: "Workflow cancelled", output: pretty(await scheduler.progress(run.runId)) }
    },
  }),
  workflow_resume: tool({
    description: "Resume an interrupted, canceled, or failed workflow from its journal without rerunning matching completed nodes.",
    args: {
      runId: tool.schema.string().min(1),
      wait: tool.schema.boolean().optional(),
    },
    async execute(args) {
      const { scheduler } = await options.services()
      const run = await scheduler.resume(args.runId, { wait: args.wait })
      return {
        title: args.wait ? `Workflow ${run.status}` : "Workflow resumed",
        output: pretty({ run: await scheduler.progress(args.runId), result: args.wait ? await scheduler.result(args.runId) : undefined }),
        metadata: { runId: args.runId, status: run.status },
      }
    },
  }),
  workflow_save: tool({
    description: `Validate and save a reusable workflow definition at project or personal scope.\n\n${WORKFLOW_AUTHORING_GUIDE}`,
    args: {
      name: tool.schema.string().min(1),
      spec: objectSchema,
      scope: tool.schema.enum(["project", "personal"]).optional(),
    },
    async execute(args) {
      const { store } = await options.services()
      const scope = args.scope ?? "project"
      await store.saveWorkflow(args.name, args.spec as unknown as WorkflowSpecV1, scope)
      return { title: "Workflow saved", output: `Saved ${scope} workflow \`${args.name}\`.` }
    },
  }),
  workflow_list_saved: tool({
    description: "List reusable project and personal workflow definitions.",
    args: {},
    async execute() {
      const { store } = await options.services()
      const workflows = await store.listWorkflows()
      return {
        title: "Saved workflows",
        output: pretty(workflows.map(({ name, source, path }) => ({ name, source, path }))),
      }
    },
  }),
})
