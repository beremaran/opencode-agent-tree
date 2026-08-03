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

  /** Durable dynamic workflow runtime. Enabled by default in manual mode. */
  workflows?: false | WorkflowOptions
}

export interface WorkflowOptions {
  enabled?: boolean
  approval?: "always" | "never"
  maxParallel?: number
  maxAgents?: number
  maxIterations?: number
  /** Default timeout for one agent step, in seconds. */
  stepTimeout?: number
  maxTokens?: number
  maxCost?: number
  autoResume?: boolean
  notifyParent?: boolean
}

export type NormalizedWorkflowOptions = {
  enabled: boolean
  approval: "always" | "never"
  maxParallel: number
  maxAgents: number
  maxIterations: number
  stepTimeout: number
  maxTokens?: number
  maxCost?: number
  autoResume: boolean
  notifyParent: boolean
}

export type AgentLike = {
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
export type ConfigWithDefaultAgent = {
  default_agent?: string
}

export type ModelReference = {
  raw: string
  providerID: string
  modelID: string
}

export type NormalizedOptions = {
  subagentModel: string
  subagentEffort?: string
  orchestratorModel?: string
  orchestratorAgent: string
  agents?: string[]
  agentModels: Record<string, string>
  agentEfforts: Record<string, string>
  instructions?: string
  blockedTools: string[]
  workflows: NormalizedWorkflowOptions
}
