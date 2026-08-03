import path from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

import type { Policy } from "./types.ts"
import { OpenCodeSessionBackend } from "./backend.ts"
import { WorkflowScheduler } from "./scheduler.ts"
import { WorkflowStore } from "./store.ts"
import type { WorkflowServices } from "./tools.ts"

type PathInfo = { state: string; config: string }
type ClientTransport = NonNullable<Parameters<typeof createOpencodeClient>[0]>["fetch"]

interface InjectedClientConfig {
  fetch?: ClientTransport
  headers?: ConstructorParameters<typeof Headers>[0]
}

interface InjectedClientInternals {
  _client?: {
    getConfig?: () => InjectedClientConfig
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const unwrap = (value: unknown): unknown => {
  let current = value
  for (let i = 0; i < 3 && isRecord(current) && "data" in current; i++) current = current.data
  return current
}

const pathInfo = async (client: PluginInput["client"]): Promise<PathInfo> => {
  const value = unwrap(await client.path.get())
  if (!isRecord(value) || typeof value.state !== "string" || typeof value.config !== "string") {
    throw new Error("OpenCode did not return state/config paths required by the workflow runtime")
  }
  return { state: value.state, config: value.config }
}

const injectedClientConfig = (client: PluginInput["client"]): InjectedClientConfig => {
  const config = (client as unknown as InjectedClientInternals)._client?.getConfig?.()
  if (!config?.headers) return { fetch: config?.fetch }
  const headers: Record<string, string> = {}
  new Headers(config.headers).forEach((value, key) => {
    headers[key] = value
  })
  return { fetch: config.fetch, headers }
}

const promptModel = (value: string | undefined): { providerID: string; modelID: string } | undefined => {
  if (!value) return undefined
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

export interface WorkflowRuntimeOptions {
  enabled: boolean
  maxParallel: number
  maxAgents: number
  maxIterations: number
  stepTimeout: number
  maxTokens?: number
  maxCost?: number
  autoResume: boolean
  notifyParent: boolean
}

export interface WorkflowRuntimeFactoryOptions {
  input: PluginInput
  options: WorkflowRuntimeOptions
  policy: () => Pick<Policy, "agents" | "models">
  defaultAgent: () => string
  defaultModel: () => string
  defaultVariant: () => string | undefined
  log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>
}

export const createWorkflowServicesFactory = (factory: WorkflowRuntimeFactoryOptions) => {
  let pending: Promise<WorkflowServices> | undefined

  return async (): Promise<WorkflowServices> => {
    if (!factory.options.enabled) throw new Error("Dynamic workflows are disabled in plugin options")
    if (pending) return pending
    pending = (async () => {
      const paths = await pathInfo(factory.input.client)
      const store = new WorkflowStore({
        root: path.join(paths.state, "opencode-agent-tree", "workflows"),
        projectWorkflowDir: path.join(factory.input.directory, ".opencode", "workflows"),
        personalWorkflowDir: path.join(paths.config, "workflows"),
      })
      await store.init()
      const injected = injectedClientConfig(factory.input.client)
      const sdk = createOpencodeClient({
        baseUrl: factory.input.serverUrl.toString(),
        directory: factory.input.directory,
        fetch: injected.fetch,
        headers: injected.headers,
      })
      const backend = new OpenCodeSessionBackend(sdk, { directory: factory.input.directory })
      const configuredPolicy = factory.policy()
      const scheduler = new WorkflowScheduler({
        store,
        backend,
        policy: {
          ...configuredPolicy,
          maxParallel: factory.options.maxParallel,
          maxAgents: factory.options.maxAgents,
          maxIterations: factory.options.maxIterations,
          maxTokens: factory.options.maxTokens,
          maxCost: factory.options.maxCost,
        },
        defaultAgent: factory.defaultAgent(),
        defaultModel: factory.defaultModel(),
        defaultVariant: factory.defaultVariant(),
        defaultStepTimeoutMs: factory.options.stepTimeout * 1000,
        disposeBackend: true,
        onEvent: async (event) => {
          if (event.type === "node.started" || event.type === "node.completed") return
          await factory.log(event.type === "run.failed" ? "error" : "info", event.type, { runId: event.runId })
          if (!factory.options.notifyParent || (event.type !== "run.completed" && event.type !== "run.failed")) return
          const rawContext = await store.loadContext(event.runId)
          if (!isRecord(rawContext) || typeof rawContext.parentSessionID !== "string" || rawContext.notifyParent === false) return
          const text = event.type === "run.completed"
            ? `[workflow-complete:${event.runId}] The background workflow completed. Call workflow_result with this run id, review the result, and report it to the user. Do not start another workflow for this notification.`
            : `[workflow-failed:${event.runId}] The background workflow failed: ${event.error}. Call workflow_status with this run id and report the failure. Do not start another workflow for this notification.`
          const parentModel = promptModel(
            typeof rawContext.parentModel === "string"
              ? rawContext.parentModel
              : typeof rawContext.defaultModel === "string"
                ? rawContext.defaultModel
                : undefined,
          )
          await sdk.session.promptAsync({
            sessionID: rawContext.parentSessionID,
            directory: factory.input.directory,
            agent: typeof rawContext.parentAgent === "string" ? rawContext.parentAgent : undefined,
            model: parentModel,
            variant: typeof rawContext.parentVariant === "string" ? rawContext.parentVariant : undefined,
            parts: [{ type: "text", text }],
          }).catch(async (error) => {
            await factory.log("warn", "Could not notify the parent session about workflow completion", {
              runId: event.runId,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        },
      })
      const interrupted = await scheduler.recoverInterrupted()
      if (factory.options.autoResume) {
        for (const run of interrupted) void scheduler.resume(run.runId, { wait: false }).catch(() => undefined)
      }
      await factory.log("info", "Initialized dynamic workflow runtime", {
        root: store.root,
        serverUrl: factory.input.serverUrl.toString(),
        interrupted: interrupted.length,
        autoResume: factory.options.autoResume,
      })
      return { scheduler, store }
    })().catch((error) => {
      pending = undefined
      throw error
    })
    return pending
  }
}
