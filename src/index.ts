import type { Plugin } from "@opencode-ai/plugin"

const PLUGIN_ID = "@beremaran/opencode-agent-tree"
const DIRECTIVE_MARKER = "# Orchestrator Mode"

export interface OrchestratorOptions {
  /**
   * Model used for ALL delegated work — every subagent spawned via the
   * `task` tool. Format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-6").
   *
   * Required. Agents that already declare an explicit `model` in
   * opencode.json are never overridden.
   */
  subagentModel: string

  /**
   * Model for the orchestrator agent itself. Defaults to the agent's
   * existing model, falling back to the top-level `model` setting.
   */
  orchestratorModel?: string

  /**
   * Name of the orchestrator agent. Default: "build".
   */
  orchestratorAgent?: string

  /**
   * Restrict which agents get routed to `subagentModel`. Defaults to every
   * built-in subagent (general, explore) plus all subagent/all-mode agents
   * already declared by the user. The orchestrator agent is never routed.
   */
  agents?: string[]

  /**
   * Per-agent model overrides, keyed by agent name. Wins over
   * `subagentModel`.
   */
  agentModels?: Record<string, string>

  /**
   * Extra rules appended verbatim to the orchestrator's system prompt.
   */
  instructions?: string

  /**
   * Tools hard-blocked for the orchestrator via its agent `permission`
   * config. Default: ["edit", "bash"]. Pass `[]` for prompt-only
   * enforcement.
   */
  blockedTools?: string[]
}

type AgentLike = {
  model?: string
  mode?: string
  disable?: boolean
  prompt?: string
  permission?: Record<string, unknown>
}

type NormalizedOptions = {
  subagentModel: string
  orchestratorModel?: string
  orchestratorAgent: string
  agents?: string[]
  agentModels: Record<string, string>
  instructions?: string
  blockedTools: string[]
}

const DEFAULTS = {
  orchestratorAgent: "build",
  blockedTools: ["edit", "bash"],
} as const

/**
 * Built-in agents are not present in the merged config when the plugin
 * `config` hook runs, so the target entries must be created explicitly.
 * Entries created here are merged over the built-ins at agent lookup time.
 */
const BUILTIN_SUBAGENTS = ["general", "explore"]

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

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === "") return undefined
  return nonEmptyString(value, name)
}

const stringArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value)) invalidOption(name, "an array of non-empty strings")
  const entries = value as unknown[]
  return [...new Set(entries.map((entry: unknown) => nonEmptyString(entry, `${name} entries`)))]
}

const stringRecord = (value: unknown, name: string): Record<string, string> => {
  if (!isRecord(value)) invalidOption(name, "an object with non-empty string values")
  const record = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      nonEmptyString(key, `${name} keys`),
      nonEmptyString(entry, `${name} values`),
    ]),
  )
}

const REQUIRED_MODEL_MESSAGE =
  `[${PLUGIN_ID}] The \`subagentModel\` option is required, e.g. ["${PLUGIN_ID}", { "subagentModel": "anthropic/claude-sonnet-4-6" }]`

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
    subagentModel: nonEmptyString(options.subagentModel, "subagentModel"),
    orchestratorModel: optionalString(options.orchestratorModel, "orchestratorModel"),
    orchestratorAgent:
      options.orchestratorAgent === undefined
        ? DEFAULTS.orchestratorAgent
        : nonEmptyString(options.orchestratorAgent, "orchestratorAgent"),
    agents,
    agentModels: options.agentModels === undefined ? {} : stringRecord(options.agentModels, "agentModels"),
    instructions: optionalString(options.instructions, "instructions"),
    blockedTools,
  }
}

const orchestratorDirective = (opts: NormalizedOptions) => {
  const blocked = opts.blockedTools.length > 0 ? opts.blockedTools.join(", ") : "none"
  const extra = opts.instructions ? `\n\n${opts.instructions}` : ""
  return `# Orchestrator Mode (enforced by @beremaran/opencode-agent-tree)

You are the ORCHESTRATOR. You do not do hands-on work. You plan, decompose, delegate, and review.

## Non-negotiable rules
1. Treat every user request as a project: break it into discrete, independently verifiable subtasks before touching anything.
2. Delegate EVERY subtask with the \`task\` tool to a subagent. Never perform implementation work yourself.
3. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
4. Dispatch independent subtasks in parallel (multiple \`task\` calls in a single message). Never run dependent subtasks concurrently — wait for each result before dispatching the next.
5. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
6. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
7. Reuse a running subagent via its task_id when follow-up work belongs to the same context.
8. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

## Tool discipline
- \`task\` for all work (mandatory), \`todowrite\` to track subtasks, \`question\` only to clarify genuinely ambiguous requests.
- \`read\`/\`glob\`/\`grep\`/\`webfetch\`/\`websearch\` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (${blocked}). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- \`explore\` — codebase research, locating code, understanding existing implementations.
- \`general\` — implementation, refactoring, testing, and any task without a more specific subagent.
- Prefer the most specialized subagent for each subtask; fall back to \`general\`.${extra}`
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

      const candidates = opts.agents ?? [...BUILTIN_SUBAGENTS, ...Object.keys(agent)]
      const targets = [...new Set(candidates)].filter((name) => inScope(name, getAgent(name)))

      // Route every delegation target to the user-chosen model.
      for (const name of targets) {
        const def = ensureAgent(name)
        const model = opts.agentModels?.[name] ?? opts.subagentModel
        if (!def.model) def.model = model
      }

      // Configure the orchestrator: model, hard tool block, and the
      // delegation directive as its system prompt.
      const orchestrator = ensureAgent(opts.orchestratorAgent)
      orchestrator.mode ??= "primary"
      if (opts.orchestratorModel) orchestrator.model = opts.orchestratorModel
      if (opts.blockedTools.length > 0) {
        const permission = { ...orchestrator.permission }
        for (const tool of opts.blockedTools) permission[tool] = "deny"
        orchestrator.permission = permission
      }
      if (!orchestrator.prompt?.includes(DIRECTIVE_MARKER)) {
        orchestrator.prompt = orchestrator.prompt
          ? `${orchestrator.prompt}\n\n${orchestratorDirective(opts)}`
          : orchestratorDirective(opts)
      }

      await client.app.log({
        body: {
          service: PLUGIN_ID,
          level: "info",
          message: `Orchestrator "${opts.orchestratorAgent}" enabled; subagents -> ${opts.subagentModel}`,
          extra: {
            routedAgents: targets,
            orchestratorModel: orchestrator.model ?? cfg.model ?? "(default)",
            blockedTools: [...opts.blockedTools],
          },
        },
      })
    },
  }
}

export default OrchestratorPlugin
