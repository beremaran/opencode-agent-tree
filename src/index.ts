import type { Config, Plugin } from "@opencode-ai/plugin"
import type { Message, Part, TextPart } from "@opencode-ai/sdk"

const PLUGIN_ID = "@beremaran/opencode-agent-tree"

/**
 * Options accepted by the plugin's factory. The SDK `Plugin` type is not
 * generic, so this interface documents the accepted option shape rather
 * than flowing into the `options` parameter type.
 */
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
   * Name of the orchestrator agent. Default: "Manager". If no agent with this
   * name exists, the plugin creates one (visible in the agent picker).
   */
  orchestratorAgent?: string

  /**
   * Number of orchestrator levels in the delegation chain. Default: 1. With
   * depth N the orchestrator levels are named `<orchestratorAgent>`,
   * `<orchestratorAgent>-2`, ..., `<orchestratorAgent>-N`. Intermediate
   * levels (1..N-1) can only delegate to the next level via their `task`
   * permission; only the final level's routed subagents (general, explore)
   * keep their hands-on tools.
   */
  orchestratorDepth?: number

  /**
   * Per-level orchestrator model overrides. `orchestratorModels[0]` sets the
   * model for the top level (e.g. "Manager"), `orchestratorModels[1]` for
   * "Manager-2", etc. Optional; when a level has no entry, it falls back to
   * `orchestratorModel`, then to the agent's existing/default model. Entries
   * must be `provider/model` format. Length must not exceed
   * `orchestratorDepth`.
   */
  orchestratorModels?: string[]

  /**
   * Restrict which agents get routed to `subagentModel`. Defaults to every
   * built-in subagent (general, explore) plus all subagent/all-mode agents
   * already declared by the user. Orchestrator level agents are never routed.
   */
  agents?: string[]

  /**
   * Per-agent model overrides, keyed by agent name. Wins over
   * `subagentModel`. Never applies to orchestrator level agents (they are
   * never routed).
   */
  agentModels?: Record<string, string>

  /**
   * Extra rules appended verbatim to the top-level orchestrator's system
   * prompt.
   */
  instructions?: string

  /**
   * Tools hard-blocked for every orchestrator level via its agent
   * `permission` config. Default: ["edit", "bash"]. Pass `[]` for prompt-only
   * enforcement.
   */
  blockedTools?: string[]

  /**
   * When true, the FINAL orchestrator level's `permission.task` rule is set
   * to deny delegation to every agent except the routed subagents, so it can
   * only delegate to them. Intermediate levels always get a structurally
   * pinned task rule (to the next level) regardless of this option. Default:
   * false.
   */
  restrictTask?: boolean
}

type AgentLike = {
  model?: string
  mode?: string
  disable?: boolean
  description?: string
  prompt?: string
  permission?: Record<string, unknown>
}

type NormalizedOptions = {
  subagentModel: string
  orchestratorModel?: string
  orchestratorAgent: string
  orchestratorDepth: number
  orchestratorModels?: string[]
  agents?: string[]
  agentModels: Record<string, string>
  instructions?: string
  blockedTools: string[]
  restrictTask: boolean
}

const DEFAULTS = {
  orchestratorAgent: "Manager",
  blockedTools: ["edit", "bash"],
} as const

/**
 * Built-in agents are not present in the merged config when the plugin
 * `config` hook runs, so the target entries must be created explicitly.
 * Entries created here are merged over the built-ins at agent lookup time.
 *
 * This list mirrors opencode's built-in subagents for the supported peer
 * range (>=1.18.11 <2) and must be updated if opencode adds or renames
 * built-in subagents. Note: `scout` appears in newer opencode docs but is
 * not native as of 1.18.x, so it is deliberately excluded until the
 * supported peer range includes it (routing a non-native name creates a
 * phantom agent with no prompt/description).
 */
const BUILTIN_SUBAGENTS = ["general", "explore"]

/**
 * Known built-in agents. Unlike BUILTIN_SUBAGENTS these are never routable,
 * even when absent from the merged config, so candidates with these names
 * are excluded from routing (and from the phantom-name warning).
 *
 * This list mirrors opencode's built-in agents for the supported peer range
 * (>=1.18.11 <2) and must be updated if opencode adds or renames built-ins.
 */
const KNOWN_BUILTINS = ["build", "plan", "compaction", "title", "summary"]

const DIRECTIVE_TOOLS = ["task", "todowrite", "question", "read", "glob", "grep", "webfetch", "websearch"]

const BLOCKED_TOOL_PATTERN = /^[a-z0-9_-]+$/

const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/

/**
 * The rendered header line of the level-1 directive. Level 1 keeps this
 * header exactly (both the rendered prompt and the idempotency marker), so
 * `orchestratorDepth: 1` stays byte-identical to the pre-chain directive.
 * Deeper levels use `# Orchestrator Mode (level i/N, enforced by
 * @beremaran/opencode-agent-tree)`.
 */
const LEVEL1_DIRECTIVE_MARKER = "# Orchestrator Mode (enforced by @beremaran/opencode-agent-tree)"

/** Per-level prompt marker: prevents re-appending the directive on re-runs. */
const levelDirectiveMarker = (level: number, depth: number): string =>
  level === 1
    ? LEVEL1_DIRECTIVE_MARKER
    : `# Orchestrator Mode (level ${level}/${depth}, enforced by @beremaran/opencode-agent-tree)`

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

const booleanOption = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") invalidOption(name, "a boolean")
  return value as boolean
}

const positiveIntegerOption = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalidOption(name, "a positive integer")
  }
  return value as number
}

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined
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

const modelString = (value: unknown, name: string): string => {
  const model = nonEmptyString(value, name)
  if (!MODEL_PATTERN.test(model)) invalidOption(name, `a model id like "provider/model" (got \`${model}\`)`)
  return model
}

/**
 * Normalizes the optional `orchestratorModels` option: an array of
 * `provider/model` strings, one per orchestrator level. `undefined` and an
 * empty array are both treated as "not provided" (no per-level overrides).
 * Entries are validated with `stringArray` (rejects non-arrays and
 * empty/non-string entries) then `modelString` (rejects malformed model ids).
 * The array length must not exceed `orchestratorDepth`.
 */
const normalizeOrchestratorModels = (value: unknown, orchestratorDepth: number): string[] | undefined => {
  if (value === undefined) return undefined
  const models = stringArray(value, "orchestratorModels").map((model) =>
    modelString(model, "orchestratorModels"),
  )
  if (models.length === 0) return undefined
  if (models.length > orchestratorDepth) {
    throw new Error(
      `[${PLUGIN_ID}] The \`orchestratorModels\` option has ${models.length} entries but \`orchestratorDepth\` is ${orchestratorDepth}.`,
    )
  }
  return models
}

const validateBlockedTools = (names: string[]): string[] => {
  for (const name of names) {
    if (!BLOCKED_TOOL_PATTERN.test(name)) {
      invalidOption("blockedTools entries", `tool names matching /^[a-z0-9_-]+$/ (got \`${name}\`)`)
    }
  }
  return names
}

/**
 * Reads `cfg.default_agent` defensively for the summary log. Returns the
 * value only when it is a non-empty string, otherwise "(unset)". Never
 * throws if the field is missing or has an unexpected shape.
 */
const defaultAgentOf = (cfg: Config): string => {
  const value = (cfg as Config & { default_agent?: unknown }).default_agent
  return typeof value === "string" && value.trim() !== "" ? value : "(unset)"
}

/**
 * Reads opencode's `subagent_depth` config defensively for the chain-depth
 * warning. The `Config` type from @opencode-ai/plugin may not expose the field
 * (the SDK's `types.gen.d.ts` declares `subagent_depth?: number`), so it is
 * read via an intersection cast. Mirrors opencode's `?? 1` default: only an
 * integer number >= 0 counts as an explicit limit; anything else (missing,
 * string, fractional, negative) falls back to 1. An explicit `0` is a real
 * limit of 0.
 */
const subagentDepthOf = (cfg: Config): number => {
  const value = (cfg as Config & { subagent_depth?: unknown }).subagent_depth
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 1
}

/**
 * Builds the `task` permission rule for a delegation target: deny delegation
 * to every agent except the allowed ones (e.g.
 * `{ "*": "deny", "Manager-2": "allow" }` or, for restrictTask,
 * `{ "*": "deny", "general": "allow", "explore": "allow" }`).
 */
const taskRuleFor = (targets: string[]): Record<string, "deny" | "allow"> => {
  const rule: Record<string, "deny" | "allow"> = { "*": "deny" }
  for (const name of targets) rule[name] = "allow"
  return rule
}

/**
 * Structural equality check used to keep permission rules idempotent. Rules
 * may be the object form `{ "<target>": "allow" | "deny" }` (pattern-scoped
 * tools like `task`) or a plain action string (tools like `todowrite`, whose
 * opencode schema only accepts an action).
 */
const sameTaskRule = (value: unknown, expected: Record<string, "deny" | "allow"> | string): boolean => {
  if (typeof expected === "string") return value === expected
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== Object.keys(expected).length) return false
  return keys.every((key) => value[key] === expected[key])
}

const REQUIRED_MODEL_MESSAGE = `[${PLUGIN_ID}] The \`subagentModel\` option is required, e.g. ["${PLUGIN_ID}", { "subagentModel": "anthropic/claude-sonnet-4-6" }]`

const normalizeOptions = (rawOptions: unknown): NormalizedOptions => {
  const candidate = rawOptions == null ? {} : rawOptions
  if (!isRecord(candidate)) invalidOption("options", "an object")
  const options = candidate as Record<string, unknown>

  if (
    options.subagentModel === undefined ||
    options.subagentModel === null ||
    (typeof options.subagentModel === "string" && options.subagentModel.trim() === "")
  ) {
    throw new Error(REQUIRED_MODEL_MESSAGE)
  }

  const blockedTools = validateBlockedTools(
    options.blockedTools === undefined
      ? [...DEFAULTS.blockedTools]
      : stringArray(options.blockedTools, "blockedTools"),
  )
  const agents = options.agents === undefined ? undefined : stringArray(options.agents, "agents")
  const restrictTask =
    options.restrictTask === undefined ? false : booleanOption(options.restrictTask, "restrictTask")
  const orchestratorDepth =
    options.orchestratorDepth === undefined
      ? 1
      : positiveIntegerOption(options.orchestratorDepth, "orchestratorDepth")
  const orchestratorModels = normalizeOrchestratorModels(options.orchestratorModels, orchestratorDepth)
  const orchestratorModel =
    options.orchestratorModel === undefined ||
    options.orchestratorModel === null ||
    options.orchestratorModel === ""
      ? undefined
      : modelString(options.orchestratorModel, "orchestratorModel")
  const agentModels =
    options.agentModels === undefined ? {} : stringRecord(options.agentModels, "agentModels")
  for (const model of Object.values(agentModels)) modelString(model, "agentModels values")

  return {
    subagentModel: modelString(options.subagentModel, "subagentModel"),
    orchestratorModel,
    orchestratorAgent:
      options.orchestratorAgent === undefined
        ? DEFAULTS.orchestratorAgent
        : nonEmptyString(options.orchestratorAgent, "orchestratorAgent"),
    orchestratorDepth,
    orchestratorModels,
    agents,
    agentModels,
    instructions: optionalString(options.instructions, "instructions"),
    blockedTools,
    restrictTask,
  }
}

/**
 * Ordered list of orchestrator level agent names for the normalized options:
 * `["Manager"]` for depth 1, `["Manager", "Manager-2", "Manager-3"]` for
 * depth 3.
 */
const orchestratorLevels = (opts: NormalizedOptions): string[] => {
  const names = [opts.orchestratorAgent]
  for (let level = 2; level <= opts.orchestratorDepth; level += 1) {
    names.push(`${opts.orchestratorAgent}-${level}`)
  }
  return names
}

// Extract meaningful words (>=4 chars) as a Set
const wordSet = (text: string): Set<string> => new Set(text.toLowerCase().match(/\b[a-z0-9_-]{4,}\b/g) || [])

// Returns overlap ratio of meaningful words between subtask and root prompt
const promptOverlapRatio = (subtask: string, root: string): number => {
  if (!root || root.length < 50) return 0
  const rootWords = wordSet(root)
  const subtaskWords = wordSet(subtask)
  if (rootWords.size === 0) return 0
  let shared = 0
  for (const word of rootWords) {
    if (subtaskWords.has(word)) shared++
  }
  return shared / rootWords.size
}

// Detect explicit file/directory/module scope in a brief
const hasExplicitScope = (text: string): boolean =>
  /[\w-]+\.(ts|js|tsx|jsx|py|rs|go|java|kt|swift|json|md|css|html|yaml|yml)|\b(src|test|tests|lib|bin|app|public|private|internal|components?|utils?|helpers?|hooks?|types?|config|scripts|docs|examples|fixtures|mocks|packages|workspaces)\/|file:|path:|module:|directory:/i.test(
    text,
  )

// Extract user text from the most recent user message parts
const userTextFromMessages = (messages: Array<{ info: Message; parts: Part[] }> | undefined): string => {
  if (!messages) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const { info, parts } = messages[i]
    if (info.role !== "user") continue
    const texts = parts
      .filter((part: Part): part is TextPart => part.type === "text")
      .map((part) => part.text)
    return texts.join(" ").trim()
  }
  return ""
}

/**
 * Positive DISCOVER -> PLAN -> DISPATCH workflow injected into the top-level
 * (depth 1) and final-chain-level directives, between the non-negotiable rules
 * and the sizing/tool guidance. Intermediate chain levels do not get it: their
 * only `task` target is the next level, so the workflow is not actionable
 * there.
 */
const MANDATORY_FLOW_SECTION = `## Mandatory execution flow
1. **DISCOVER**: Use \`explore\`, \`glob\`, \`grep\`, or \`read\` to identify all affected files. Do NOT delegate implementation until file paths are known.
2. **PLAN**: Write a list of 2+ atomic subtasks into \`todowrite\`, assigning exact files to each subtask.
3. **DISPATCH**: Call \`task\` once per subtask in parallel (or sequentially if dependent). Each brief must include explicit file paths or module boundaries.`

/**
 * Renders the level-aware orchestrator directive.
 *
 * - `(level 1, depth 1)` — the single-level directive, byte-identical to the
 *   pre-`orchestratorDepth` template.
 * - `(level < depth)` — an intermediate level: may only delegate to
 *   `nextName` and never does hands-on work; no Default delegation section.
 * - `(level === depth, depth > 1)` — the final level of a chain: delegates to
 *   the routed subagents and includes the Default delegation section.
 *
 * `instructions` is appended only to the level-1 directive (the top level).
 */
const orchestratorDirective = (
  opts: NormalizedOptions,
  level: number,
  depth: number,
  nextName: string | undefined,
): string => {
  const blocked = opts.blockedTools.length > 0 ? opts.blockedTools.join(", ") : "none"
  const extra = opts.instructions && level === 1 ? `\n\n${opts.instructions}` : ""

  if (depth === 1) {
    // Byte-identical to the pre-orchestratorDepth single-level directive.
    return `# Orchestrator Mode (enforced by @beremaran/opencode-agent-tree)

You are the ORCHESTRATOR. You do not do hands-on work. You plan, decompose, delegate, and review.

## Non-negotiable rules
1. Treat every user request as a project: decompose it into discrete, independently verifiable subtasks before touching anything.
2. Keep subtasks SMALL. A subtask is one concern: one file or a small cluster of related files, one bug, one component, one test area. If a brief needs many steps, spans unrelated areas, or would produce a report as long as the original request, split it further — never hand a monolithic task to a single subagent.
3. Delegate EVERY subtask with the \`task\` tool to a subagent. Never bundle several subtasks into one delegation, and never perform implementation work yourself.
4. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
5. Fan out: dispatch independent subtasks as several small \`task\` calls in a single message — more, smaller subagents in parallel beats one big delegation. Never run dependent subtasks concurrently; wait for each result before dispatching the next.
6. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
7. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
8. Reuse a running subagent via its task_id when follow-up work belongs to the same context.
9. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

${MANDATORY_FLOW_SECTION}

## Subtask sizing
- Split a request along its seams: separate files, functions, concerns, or verification steps each become their own subtask.
- A subtask is TOO BIG if: it touches many unrelated files, its brief runs more than a few paragraphs, a subagent could not finish and report back in one focused pass, or you cannot verify its result in isolation.
- When in doubt, split again — an extra small subagent costs less than one bloated delegation.

## Tool discipline
- \`task\` for all work (mandatory), \`todowrite\` to track subtasks, \`question\` only to clarify genuinely ambiguous requests.
- \`read\`/\`glob\`/\`grep\`/\`webfetch\`/\`websearch\` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (${blocked}). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- \`explore\` — codebase research, locating code, understanding existing implementations.
- \`general\` — implementation, refactoring, testing, and any task without a more specific subagent.
- Prefer the most specialized subagent for each subtask; fall back to \`general\`.${extra}`
  }

  const header = levelDirectiveMarker(level, depth)

  if (level < depth) {
    // Intermediate orchestrator level: structurally pinned to the next level.
    const target = nextName as string
    return `${header}

You are ORCHESTRATOR level ${level} of ${depth} in a delegation chain. You do not do hands-on work. You plan, decompose, delegate, and review.

## Non-negotiable rules
1. Treat every request from the level above as a project: break it into discrete, independently verifiable subtasks before touching anything.
2. Keep subtasks SMALL. A subtask is one concern: one file or a small cluster of related files, one bug, one component, one test area. If a brief needs many steps, spans unrelated areas, or would produce a report as long as the original request, split it further — never hand a monolithic task to \`${target}\`.
3. Delegate EVERY subtask with the \`task\` tool, and ONLY to \`${target}\`. Never bundle several subtasks into one delegation, and never perform implementation work yourself.
4. Never delegate to worker subagents — only the FINAL orchestrator level delegates to them. Your only \`task\` target is \`${target}\`.
5. Fan out: dispatch independent subtasks as several small \`task\` calls in a single message — more, smaller delegations to \`${target}\` in parallel beats one big delegation. Never run dependent subtasks concurrently — wait for each result before dispatching the next.
6. Give \`${target}\` a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
7. Review every report from \`${target}\`. If work is incomplete or wrong, delegate the fix back to \`${target}\` — never fix it yourself.
8. Reuse a running \`${target}\` session via its task_id when follow-up work belongs to the same context.
9. Keep the level above informed: report what was delegated, the results, blockers, and the final state.

## Tool discipline
- \`task\` for all work (mandatory), \`todowrite\` to track subtasks, \`question\` only to clarify genuinely ambiguous requests.
- \`read\`/\`glob\`/\`grep\`/\`webfetch\`/\`websearch\` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (${blocked}). If \`${target}\` lacks a tool it needs, tell the level above instead of doing it yourself.${extra}`
  }

  // Final level of a multi-level chain: delegates to the routed subagents.
  return `${header}

You are ORCHESTRATOR level ${level} of ${depth} in a delegation chain — the FINAL orchestrator level. You do not do hands-on work. You plan, decompose, delegate, and review. Your subagents (\`explore\`, \`general\`) have the hands-on tools; they do the implementation.

## Non-negotiable rules
1. Treat every user request as a project: break it into discrete, independently verifiable subtasks before touching anything.
2. Keep subtasks SMALL. A subtask is one concern: one file or a small cluster of related files, one bug, one component, one test area. If a brief needs many steps, spans unrelated areas, or would produce a report as long as the original request, split it further — never hand a monolithic task to a single subagent.
3. Delegate EVERY subtask with the \`task\` tool to a subagent. Never bundle several subtasks into one delegation, and never perform implementation work yourself.
4. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
5. Fan out: dispatch independent subtasks as several small \`task\` calls in a single message — more, smaller subagents in parallel beats one big delegation. Never run dependent subtasks concurrently — wait for each result before dispatching the next.
6. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
7. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
8. Reuse a running subagent via its task_id when follow-up work belongs to the same context.
9. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

${MANDATORY_FLOW_SECTION}

## Tool discipline
- \`task\` for all work (mandatory), \`todowrite\` to track subtasks, \`question\` only to clarify genuinely ambiguous requests.
- \`read\`/\`glob\`/\`grep\`/\`webfetch\`/\`websearch\` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (${blocked}). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- \`explore\` — codebase research, locating code, understanding existing implementations.
- \`general\` — implementation, refactoring, testing, and any task without a more specific subagent.
- Prefer the most specialized subagent for each subtask; fall back to \`general\`.${extra}`
}

type LogBody = {
  service: string
  level: "error" | "warn" | "info"
  message: string
  extra?: Record<string, unknown>
}

type LogEntry = {
  body: LogBody
}

type LogFn = (entry: LogEntry) => Promise<void>

/**
 * Returns a fresh, shallow-copied permission object for the agent, logging a
 * warning when an existing non-object permission is replaced (mirrors the
 * historical behavior of treating a missing or malformed permission as an
 * empty object).
 */
const permissionFor = async (
  entry: AgentLike,
  name: string,
  log: LogFn,
): Promise<Record<string, unknown>> => {
  const rawPermission = entry.permission
  if (!isRecord(rawPermission)) {
    await log({
      body: {
        service: PLUGIN_ID,
        level: "warn",
        message: `Orchestrator agent "${name}" has a non-object permission; replacing it with an empty permission object`,
      },
    })
    return {}
  }
  return { ...rawPermission }
}

/** Merges the blocked-tools denies into the agent's permission object. */
const applyBlockedTools = async (
  entry: AgentLike,
  name: string,
  blockedTools: string[],
  log: LogFn,
): Promise<void> => {
  if (blockedTools.length === 0) return
  const permission = await permissionFor(entry, name, log)
  for (const tool of blockedTools) {
    if (permission[tool] !== undefined && permission[tool] !== "deny") {
      await log({
        body: {
          service: PLUGIN_ID,
          level: "warn",
          message: isRecord(permission[tool])
            ? `Overwriting existing command-scoped rules for tool "${tool}" on agent "${name}" with blanket "deny"`
            : `Overwriting existing permission for tool "${tool}" on agent "${name}" with "deny"`,
        },
      })
    }
    permission[tool] = "deny"
  }
  entry.permission = permission
}

/**
 * Sets (or preserves) the agent's permission rule for `toolName` (default
 * `task`), warning on clobber. Rule values are either the object form
 * `{ "<target>": "allow" | "deny" }` for pattern-scoped tools (`task`) or a
 * plain action string for tools whose opencode schema only accepts an action
 * (`todowrite`).
 */
const applyTaskRule = async (
  entry: AgentLike,
  name: string,
  rule: Record<string, "deny" | "allow"> | string,
  log: LogFn,
  toolName = "task",
): Promise<void> => {
  const permission = await permissionFor(entry, name, log)
  const existing = permission[toolName]
  if (existing !== undefined && !sameTaskRule(existing, rule)) {
    await log({
      body: {
        service: PLUGIN_ID,
        level: "warn",
        message: isRecord(existing)
          ? `Overwriting existing command-scoped rules for tool "${toolName}" on agent "${name}" with the delegation rule`
          : `Overwriting existing permission for tool "${toolName}" on agent "${name}" with the delegation rule`,
      },
    })
    permission[toolName] = rule
  } else if (existing === undefined) {
    permission[toolName] = rule
  }
  entry.permission = permission
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

  const log: LogFn = async (entry) => {
    await client.app.log(entry)
  }

  return {
    config: async (cfg) => {
      try {
        if (cfg.agent == null) cfg.agent = {}
        const agent = cfg.agent as Record<string, AgentLike>
        const hasAgent = (name: string) => Object.hasOwn(agent, name)
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

        const levels = orchestratorLevels(opts)
        const levelNames = new Set(levels)

        const inScope = (name: string, def: AgentLike | undefined) =>
          !KNOWN_BUILTINS.includes(name) && !def?.disable && isSubagentLike(def) && !levelNames.has(name)

        // Every orchestrator level must be enabled; a disabled level aborts
        // the whole configuration (mirrors the single-orchestrator behavior).
        for (const name of levels) {
          if (getAgent(name)?.disable) {
            await log({
              body: {
                service: PLUGIN_ID,
                level: "error",
                message: `The orchestrator agent \`${name}\` is disabled; plugin will not apply its configuration.`,
              },
            })
            return
          }
        }

        const blockedDirectiveTools = DIRECTIVE_TOOLS.filter((tool) => opts.blockedTools.includes(tool))
        if (blockedDirectiveTools.length > 0) {
          await log({
            body: {
              service: PLUGIN_ID,
              level: "warn",
              message: `Orchestrator relies on blocked tool(s): ${blockedDirectiveTools.join(", ")}`,
              extra: { blockedTools: opts.blockedTools },
            },
          })
        }

        // A chain of depth N performs N-1 nested task hops, so opencode's
        // `subagent_depth` (default 1) must be >= N. Warn before configuring
        // anything so the user can fix opencode.json up front.
        const subagentDepth = subagentDepthOf(cfg)
        if (opts.orchestratorDepth > subagentDepth) {
          await log({
            body: {
              service: PLUGIN_ID,
              level: "warn",
              message: `orchestratorDepth (${opts.orchestratorDepth}) exceeds opencode's subagent_depth (${subagentDepth}); set "subagent_depth": ${opts.orchestratorDepth} in opencode.json or delegation beyond the first hop will fail with "Subagent depth limit reached"`,
              extra: { orchestratorDepth: opts.orchestratorDepth, subagentDepth },
            },
          })
        }

        const candidates = opts.agents ?? [...BUILTIN_SUBAGENTS, ...Object.keys(agent)]
        const targets = [...new Set(candidates)].filter((name) => inScope(name, getAgent(name)))

        if (opts.agents !== undefined && !BUILTIN_SUBAGENTS.some((name) => targets.includes(name))) {
          await log({
            body: {
              service: PLUGIN_ID,
              level: "warn",
              message:
                "Explicit agents list excludes built-in subagents (general, explore); the orchestrator directive still instructs delegation to them.",
              extra: { agents: opts.agents, targets },
            },
          })
        }

        // Route every delegation target to the user-chosen model. Known
        // built-in primaries (build, plan, compaction, title, summary) were
        // already filtered out by inScope and never reach this loop.
        for (const name of targets) {
          const existed = hasAgent(name)
          const def = ensureAgent(name)
          if (!existed && !BUILTIN_SUBAGENTS.includes(name) && !KNOWN_BUILTINS.includes(name)) {
            await log({
              body: {
                service: PLUGIN_ID,
                level: "warn",
                message: `Creating agent entry for unknown name "${name}" (typo in agents list?)`,
              },
            })
          }
          const model = Object.hasOwn(opts.agentModels, name) ? opts.agentModels[name] : opts.subagentModel
          if (!def.model) def.model = model
        }

        // Configure every orchestrator level in the chain. Levels 1..N-1 may
        // only delegate to the next level (structural task pinning);
        // level N delegates to the routed subagents. Every level defaults to
        // the orchestrator model (or its `orchestratorModels[i]` entry) and
        // the blocked hands-on tools.
        let topOrchestrator: AgentLike | undefined
        const effectiveModels: string[] = []
        for (let index = 0; index < levels.length; index += 1) {
          const name = levels[index]
          const level = index + 1
          const depth = opts.orchestratorDepth
          const isFinal = level === depth
          // Per-level model resolution: `orchestratorModels[level - 1]` wins,
          // then `orchestratorModel`, then the agent's existing/default model.
          const levelModel = opts.orchestratorModels?.[level - 1] ?? opts.orchestratorModel

          const existed = hasAgent(name) && getAgent(name) != null
          const entry = ensureAgent(name)
          if (index === 0) topOrchestrator = entry
          if (!existed) {
            await log({
              body: {
                service: PLUGIN_ID,
                level: "info",
                message: `Creating orchestrator agent "${name}"`,
              },
            })
          }
          if (!entry.description) {
            entry.description =
              level === 1
                ? "Orchestrator agent: decomposes every request and delegates to subagents."
                : isFinal
                  ? `Orchestrator agent (level ${level}/${depth}): decomposes requests from the level above and delegates to the routed subagents.`
                  : `Orchestrator agent (level ${level}/${depth}): decomposes requests from the level above and delegates to the next level.`
          }
          const targetMode = level === 1 ? "primary" : "subagent"
          const previousMode = entry.mode
          if (entry.mode !== targetMode) {
            entry.mode = targetMode
            if (previousMode !== undefined) {
              await log({
                body: {
                  service: PLUGIN_ID,
                  level: "warn",
                  message: `Converting agent "${name}" mode "${previousMode}" to "${targetMode}" for orchestrator use`,
                },
              })
            }
          }
          if (levelModel) entry.model = levelModel
          await applyBlockedTools(entry, name, opts.blockedTools, log)
          if (isFinal) {
            // The final level of a chain with depth >= 2 runs as a subagent.
            // opencode injects `task: deny *` into the session of any
            // subagent whose own permission declares no task rule, and a
            // blanket deny hides the task tool from the model entirely — so
            // without an explicit rule the final orchestrator cannot delegate
            // at all. `restrictTask` pins the rule to the routed targets;
            // otherwise a blanket allow preserves the documented prompt-only
            // enforcement while keeping the tool available.
            const pinToTargets = opts.restrictTask && targets.length > 0
            if (depth > 1 || pinToTargets) {
              await applyTaskRule(entry, name, pinToTargets ? taskRuleFor(targets) : { "*": "allow" }, log)
            }
          } else {
            // Structural chain enforcement, independent of restrictTask.
            await applyTaskRule(entry, name, taskRuleFor([levels[index + 1]]), log)
          }
          if (level > 1) {
            // opencode strips todowrite from subagent sessions the same way
            // it strips task; every level's directive relies on it to track
            // subtasks, so subagent levels must declare it explicitly. Note:
            // opencode's config schema only accepts a plain action for
            // todowrite (no pattern-object form), hence the string.
            await applyTaskRule(entry, name, "allow", log, "todowrite")
          }
          const marker = levelDirectiveMarker(level, depth)
          if (!entry.prompt?.includes(marker)) {
            const directive = orchestratorDirective(
              opts,
              level,
              depth,
              isFinal ? undefined : levels[index + 1],
            )
            entry.prompt = entry.prompt ? `${entry.prompt}\n\n${directive}` : directive
          }
          effectiveModels.push(levelModel ?? "(default)")
        }

        await log({
          body: {
            service: PLUGIN_ID,
            level: "info",
            message: `Orchestrator "${opts.orchestratorAgent}" enabled; subagents -> ${opts.subagentModel}`,
            extra: {
              routedAgents: targets,
              orchestratorModel: topOrchestrator?.model ?? cfg.model ?? "(default)",
              orchestratorModels: effectiveModels,
              blockedTools: [...opts.blockedTools],
              defaultAgent: defaultAgentOf(cfg),
              orchestratorDepth: opts.orchestratorDepth,
              orchestratorLevels: levels,
            },
          },
        })
      } catch (error) {
        await client.app.log({
          body: {
            service: PLUGIN_ID,
            level: "error",
            message: `[${PLUGIN_ID}] Unexpected error in opencode-agent-tree config hook (this is a plugin bug; please report it)`,
            extra: { error },
          },
        })
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return

      // Only enforce for orchestrator agents (any level created by this plugin)
      const levelNames = new Set(orchestratorLevels(opts))
      let agentName: string | undefined
      try {
        const sessionResult = await client.session.get({ path: { id: input.sessionID } })
        const session = sessionResult.data
        if (
          session &&
          typeof session === "object" &&
          "agent" in session &&
          typeof session.agent === "string"
        ) {
          agentName = session.agent
        }
      } catch {
        // fall back to inferring from messages
      }
      if (!agentName) {
        try {
          const messagesResult = await client.session.messages({
            path: { id: input.sessionID },
            query: { limit: 5 },
          })
          const messages = messagesResult.data
          if (messages) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const { info } = messages[i]
              if ("agent" in info && typeof info.agent === "string") {
                agentName = info.agent
                break
              }
            }
          }
        } catch {
          // ignore
        }
      }
      if (!agentName || !levelNames.has(agentName)) return

      const subtaskPrompt = typeof output.args?.prompt === "string" ? output.args.prompt : ""
      const rootPrompt = await (async () => {
        try {
          const messagesResult = await client.session.messages({
            path: { id: input.sessionID },
            query: { limit: 50 },
          })
          return userTextFromMessages(messagesResult.data)
        } catch {
          return ""
        }
      })()

      // 1. Reject monolithic copy (>75% word overlap with root user prompt)
      if (promptOverlapRatio(subtaskPrompt, rootPrompt) > 0.75) {
        const message = `[${PLUGIN_ID}] Delegation rejected: subtask prompt is a monolithic copy of the user's request. Decompose into atomic subtasks covering specific files or components.`
        await client.app.log({ body: { service: PLUGIN_ID, level: "warn", message } })
        throw new Error(message)
      }

      // 2. Reject long briefs without explicit file/module scope
      if (subtaskPrompt.length > 200 && !hasExplicitScope(subtaskPrompt)) {
        const message = `[${PLUGIN_ID}] Delegation rejected: subtask brief lacks explicit target file, directory, or module scope. Specify exact paths or boundaries for the worker subagent.`
        await client.app.log({ body: { service: PLUGIN_ID, level: "warn", message } })
        throw new Error(message)
      }

      // 3. Require at least 2 TODO items before first delegation
      try {
        const todoResult = await client.session.todo({ path: { id: input.sessionID } })
        const todos = todoResult.data || []
        if (todos.length < 2) {
          const message = `[${PLUGIN_ID}] Delegation rejected: you must decompose the request into at least 2 TODO items using \`todowrite\` before dispatching subagents.`
          await client.app.log({ body: { service: PLUGIN_ID, level: "warn", message } })
          throw new Error(message)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Delegation rejected")) throw error
        // If TODO API is unavailable, log and allow (fail-open to avoid breaking)
        await client.app.log({
          body: {
            service: PLUGIN_ID,
            level: "warn",
            message: `[${PLUGIN_ID}] Could not verify TODO prerequisite for session ${input.sessionID}`,
            extra: { error },
          },
        })
      }
    },
  }
}

export default OrchestratorPlugin
