import type { Plugin } from "@opencode-ai/plugin"

const PLUGIN_ID = "@beremaran/opencode-agent-tree"
const DIRECTIVE_MARKER = "# Orchestrator Mode"
const WORKER_DIRECTIVE_MARKER = "# Worker Mode"
const MODEL_COMMAND = "subagent-model"
const MODEL_COMMAND_TEMPLATE =
  "Use `$ARGUMENTS` as the default model for subsequent delegated tasks in this opencode process. Confirm the active subagent model in one sentence and do nothing else."
const ORCHESTRATOR_TOOLS = ["task", "todowrite", "question"] as const
const WORKER_AGENT = "worker"

export interface OrchestratorOptions {
  /**
   * Default model for routed subagents. Format: "provider/model-id"
   * (e.g. "anthropic/claude-sonnet-4-6").
   *
   * Required. Agents that already declare an explicit `model` in
   * opencode.json are never overridden.
   */
  subagentModel: string

  /**
   * Effort/variant applied to delegated agents that do not define one.
   * The value should be a variant supported by the selected model.
   */
  subagentEffort?: string

  /**
   * Model for the orchestrator agent itself. Defaults to the agent's
   * existing model, falling back to the top-level `model` setting.
   */
  orchestratorModel?: string

  /**
   * Name of the orchestrator agent. Default: "orchestrator".
   */
  orchestratorAgent?: string

  /**
   * Restrict model and effort routing to these agents. Defaults to the
   * built-in `general` and `explore` subagents, the dedicated `worker` agent,
   * and every user-defined subagent or all-mode agent. The orchestrator is
   * never routed.
   */
  agents?: string[]

  /**
   * Per-agent model overrides, keyed by agent name. Wins over
   * `subagentModel`.
   */
  agentModels?: Record<string, string>

  /**
   * Per-agent effort/variant overrides, keyed by agent name. Wins over
   * `subagentEffort`; an agent's explicit `variant` still takes precedence.
   */
  agentEfforts?: Record<string, string>

  /**
   * Extra rules appended verbatim to the orchestrator's system prompt.
   */
  instructions?: string

  /**
   * Tools hard-blocked for the orchestrator via its agent `permission`
   * config. Default: ["edit", "write", "apply_patch", "bash"]. Pass `[]`
   * for prompt-only enforcement.
   */
  blockedTools?: string[]
}

type AgentLike = {
  model?: string
  variant?: string
  mode?: string
  disable?: boolean
  description?: string
  prompt?: string
  permission?: Record<string, unknown>
}

// `default_agent` is supported by opencode 1.18.x and its v2 config schema,
// but is missing from the legacy Config type exported by plugin 1.18.11.
type ConfigWithDefaultAgent = {
  default_agent?: string
}

type ModelReference = {
  raw: string
  providerID: string
  modelID: string
}

type NormalizedOptions = {
  subagentModel: string
  subagentEffort?: string
  orchestratorModel?: string
  orchestratorAgent: string
  agents?: string[]
  agentModels: Record<string, string>
  agentEfforts: Record<string, string>
  instructions?: string
  blockedTools: string[]
}

const DEFAULTS = {
  orchestratorAgent: "orchestrator",
  blockedTools: ["edit", "write", "apply_patch", "bash"],
} as const

/**
 * Built-in agents are not present in the merged config when the plugin
 * `config` hook runs, so the target entries must be created explicitly. The
 * dedicated worker is also created here when it is not user-defined.
 * Entries created here are merged over the built-ins at agent lookup time.
 */
const BUILTIN_SUBAGENTS = ["general", "explore"]

const workerDirective = `# Worker Mode (enforced by ${PLUGIN_ID})

You are the worker. Complete the task assigned by the orchestrator directly.

## Worker rules
1. Inspect the relevant code and context before acting.
2. Implement, test, and verify the assigned task with the tools available to you.
3. Do not delegate the task further unless the orchestrator explicitly asks you to.
4. Report your changes, verification, and any remaining blockers concisely.`

const isSubagentLike = (agent: AgentLike | undefined) =>
  !agent || agent.mode === undefined || agent.mode === "subagent" || agent.mode === "all"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const invalidOption = (name: string, expected: string): never => {
  throw new Error(`[${PLUGIN_ID}] The \`${name}\` option must be ${expected}.`)
}

const nonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== "string") invalidOption(name, "a non-empty string")
  const trimmed = (value as string).trim()
  if (trimmed === "") invalidOption(name, "a non-empty string")
  return trimmed
}

const modelReference = (value: unknown, name: string): ModelReference => {
  const raw = nonEmptyString(value, name)
  const separator = raw.indexOf("/")
  if (separator <= 0 || separator === raw.length - 1) {
    invalidOption(name, 'a model reference in "provider/model-id" format')
  }

  return {
    raw,
    providerID: raw.slice(0, separator),
    modelID: raw.slice(separator + 1),
  }
}

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === "") return undefined
  return nonEmptyString(value, name)
}

const stringArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value)) invalidOption(name, "an array of non-empty strings")
  const entries = value as unknown[]
  return [...new Set(entries.map((entry: unknown) => nonEmptyString(entry, `${name} entries`)))]
}

const stringRecord = (
  value: unknown,
  name: string,
  parseValue: (value: unknown, name: string) => string = nonEmptyString,
): Record<string, string> => {
  if (!isRecord(value)) invalidOption(name, "an object with non-empty string values")
  const record = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      nonEmptyString(key, `${name} keys`),
      parseValue(entry, `${name} values`),
    ]),
  )
}

const REQUIRED_MODEL_MESSAGE =
  `[${PLUGIN_ID}] The \`subagentModel\` option is required. Configure the plugin as ["${PLUGIN_ID}", { "subagentModel": "anthropic/claude-sonnet-4-6" }].`

const normalizeOptions = (rawOptions: unknown): NormalizedOptions => {
  const candidate = rawOptions == null ? {} : rawOptions
  if (!isRecord(candidate)) invalidOption("options", "an object")
  const options = candidate as Record<string, unknown>

  if (options.subagentModel === undefined || options.subagentModel === "") {
    throw new Error(REQUIRED_MODEL_MESSAGE)
  }

  const blockedTools =
    options.blockedTools === undefined ? [...DEFAULTS.blockedTools] : stringArray(options.blockedTools, "blockedTools")
  const agents = options.agents === undefined ? undefined : stringArray(options.agents, "agents")

  return {
    subagentModel: modelReference(options.subagentModel, "subagentModel").raw,
    subagentEffort: optionalString(options.subagentEffort, "subagentEffort"),
    orchestratorModel: optionalString(options.orchestratorModel, "orchestratorModel"),
    orchestratorAgent:
      options.orchestratorAgent === undefined
        ? DEFAULTS.orchestratorAgent
        : nonEmptyString(options.orchestratorAgent, "orchestratorAgent"),
    agents,
    agentModels:
      options.agentModels === undefined
        ? {}
        : stringRecord(options.agentModels, "agentModels", (entry, entryName) => modelReference(entry, entryName).raw),
    agentEfforts: options.agentEfforts === undefined ? {} : stringRecord(options.agentEfforts, "agentEfforts"),
    instructions: optionalString(options.instructions, "instructions"),
    blockedTools,
  }
}

const orchestratorDirective = (opts: NormalizedOptions) => {
  const toolRestriction =
    opts.blockedTools.length > 0
      ? `The following hands-on tools are blocked: ${opts.blockedTools.join(", ")}.`
      : "No hands-on tools are blocked; prompt-only enforcement is active."
  const extra = opts.instructions ? `\n\n${opts.instructions}` : ""
  return `# Orchestrator Mode (enforced by @beremaran/opencode-agent-tree)

You are the orchestrator. Plan, decompose, delegate, and review. Do not perform hands-on work.

## Required behavior
1. Break every request into discrete, independently verifiable subtasks.
2. Delegate every subtask with the \`task\` tool. Never perform implementation work yourself.
3. Limit your work to planning, writing subtask briefs, dispatching agents, reviewing reports, and summarizing results.
4. Dispatch independent subtasks in parallel with multiple \`task\` calls in one message. Run dependent subtasks sequentially.
5. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
6. Review every report. If work is incomplete or incorrect, delegate the fix instead of making it yourself.
7. Reuse a running subagent through its \`task_id\` when follow-up work needs the same context.
8. Keep the user informed about delegated work, results, blockers, and the final state.

## Tool discipline
- Use \`task\` for all delegated work, \`todowrite\` to track subtasks, and \`question\` only for genuinely ambiguous requests.
- Keep the task list current so the user can see what is active, completed, or blocked.
- Use \`read\`, \`glob\`, \`grep\`, \`webfetch\`, and \`websearch\` only to prepare a better brief or verify a result.
- ${toolRestriction} If a subagent lacks a required tool, tell the user instead of taking over its work.

## Default delegation
- \`worker\`: implementation, refactoring, testing, and verification.
- \`explore\`: codebase research, code discovery, and implementation analysis.
- \`general\`: complex research or work without a more specific subagent.
- Prefer \`worker\` for hands-on work and the most specialized subagent for every other task. Fall back to \`general\`.${extra}`
}

export const OrchestratorPlugin: Plugin = async ({ client }, options = {}) => {
  let opts: NormalizedOptions
  try {
    opts = normalizeOptions(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : `[${PLUGIN_ID}] Invalid plugin options.`
    await client.app.log({ body: { service: PLUGIN_ID, level: "error", message } })
    throw error
  }

  let activeSubagentModel = modelReference(opts.subagentModel, "subagentModel")
  const routedModels = new Map<string, ModelReference | undefined>()
  const routedEfforts = new Map<string, string>()
  const routedDefinitions = new Map<string, AgentLike>()

  return {
    config: async (cfg) => {
      const agent = (cfg.agent ??= {}) as Record<string, AgentLike>
      const hasAgent = (name: string) => Object.prototype.hasOwnProperty.call(agent, name)
      const getAgent = (name: string) => (hasAgent(name) ? agent[name] : undefined)
      const ensureAgent = (name: string) => {
        if (!hasAgent(name) || agent[name] == null) {
          Object.defineProperty(agent, name, {
            configurable: true,
            enumerable: true,
            value: {},
            writable: true,
          })
        }
        return agent[name]
      }

      const inScope = (name: string, def: AgentLike | undefined) =>
        !def?.disable && isSubagentLike(def) && name !== opts.orchestratorAgent

      if (getAgent(opts.orchestratorAgent)?.disable) {
        throw new Error(`[${PLUGIN_ID}] The orchestrator agent \`${opts.orchestratorAgent}\` is disabled.`)
      }

      const candidates = opts.agents ?? [...BUILTIN_SUBAGENTS, WORKER_AGENT, ...Object.keys(agent)]
      const targets = [...new Set(candidates)].filter((name) => inScope(name, getAgent(name)))
      const targetSet = new Set(targets)

      for (const name of routedModels.keys()) {
        if (!targetSet.has(name)) {
          routedModels.delete(name)
          routedDefinitions.delete(name)
        }
      }
      for (const name of routedEfforts.keys()) {
        if (!targetSet.has(name)) routedEfforts.delete(name)
      }

      // Route every delegation target to the user-chosen model.
      for (const name of targets) {
        const def = ensureAgent(name)
        if (name === WORKER_AGENT) {
          def.mode ??= "subagent"
          def.description ??= "Handles implementation, refactoring, testing, and verification delegated by the orchestrator."
          if (!def.prompt?.includes(WORKER_DIRECTIVE_MARKER)) {
            def.prompt = def.prompt ? `${def.prompt}\n\n${workerDirective}` : workerDirective
          }
        }
        const override = opts.agentModels[name]
        const wasRouted = routedModels.has(name)
        if (!def.model || wasRouted) {
          const model = override ? modelReference(override, `agentModels.${name}`) : activeSubagentModel
          def.model = model.raw
          routedModels.set(name, override ? model : undefined)
          routedDefinitions.set(name, def)
        }

        const effort = opts.agentEfforts[name] ?? opts.subagentEffort
        if (effort && (!def.variant || routedEfforts.has(name))) {
          def.variant = effort
          routedEfforts.set(name, effort)
        }
      }

      // Configure the orchestrator: model, hard tool block, and the
      // delegation directive as its system prompt.
      const orchestrator = ensureAgent(opts.orchestratorAgent)
      orchestrator.mode = "primary"
      orchestrator.description ??= "Plans work, delegates it to subagents, and reviews the results."
      if (opts.orchestratorModel) orchestrator.model = opts.orchestratorModel
      const permission = { ...orchestrator.permission }
      for (const tool of ORCHESTRATOR_TOOLS) permission[tool] = "allow"
      for (const tool of opts.blockedTools) permission[tool] = "deny"
      orchestrator.permission = permission
      if (!orchestrator.prompt?.includes(DIRECTIVE_MARKER)) {
        orchestrator.prompt = orchestrator.prompt
          ? `${orchestrator.prompt}\n\n${orchestratorDirective(opts)}`
          : orchestratorDirective(opts)
      }

      // Keep the built-in build agent available for hands-on work. The
      // dedicated orchestrator is the default only when the user has not
      // explicitly selected a different primary agent.
      const configWithDefaultAgent = cfg as typeof cfg & ConfigWithDefaultAgent
      configWithDefaultAgent.default_agent ??= opts.orchestratorAgent

      const command = (cfg.command ??= {})
      const existingCommand = command[MODEL_COMMAND]
      if (existingCommand && existingCommand.template !== MODEL_COMMAND_TEMPLATE) {
        throw new Error(`[${PLUGIN_ID}] The \`/${MODEL_COMMAND}\` command is already defined.`)
      }
      command[MODEL_COMMAND] ??= {
        template: MODEL_COMMAND_TEMPLATE,
        description: "Change the default model for delegated subagents",
        agent: opts.orchestratorAgent,
        subtask: false,
      }

      await client.app.log({
        body: {
          service: PLUGIN_ID,
          level: "info",
          message: `Enabled orchestrator "${opts.orchestratorAgent}" with default subagent model "${opts.subagentModel}".`,
          extra: {
            routedAgents: targets,
            orchestratorModel: orchestrator.model ?? cfg.model ?? "(default)",
            subagentEffort: opts.subagentEffort ?? "(model default)",
            agentEfforts: { ...opts.agentEfforts },
            orchestratorTools: [...ORCHESTRATOR_TOOLS],
            blockedTools: [...opts.blockedTools],
          },
        },
      })
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== MODEL_COMMAND) return

      activeSubagentModel = modelReference(input.arguments, `/${MODEL_COMMAND} argument`)
      for (const [name, override] of routedModels) {
        if (override) continue
        const def = routedDefinitions.get(name)
        if (def) def.model = activeSubagentModel.raw
      }

      for (const part of output.parts) {
        if (part.type === "text") {
          part.text = `Use \`${activeSubagentModel.raw}\` as the default model for subsequent delegated tasks in this opencode process. Confirm the active subagent model in one sentence and do nothing else.`
        }
      }

      await client.app.log({
        body: {
          service: PLUGIN_ID,
          level: "info",
          message: `Changed the default subagent model to "${activeSubagentModel.raw}" for this opencode process.`,
        },
      })
    },
    "chat.message": async (input, output) => {
      const agentName = input.agent ?? output.message.agent
      const route = routedModels.get(agentName)
      if (!routedModels.has(agentName)) return

      const model = route ?? activeSubagentModel
      output.message.model = { providerID: model.providerID, modelID: model.modelID }
    },
  }
}

export default OrchestratorPlugin
