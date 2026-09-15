/**
 * Options accepted by the plugin's factory. The SDK `Plugin` type is not
 * generic, so this interface documents the accepted option shape rather
 * than flowing into the `options` parameter type.
 */
export interface OrchestratorOptions {
    /**
     * Model used for ALL delegated work — every subagent spawned via the
     * `subagent` action. Format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-6").
     *
     * Required. Agents that already declare an explicit `model` in
     * opencode.json are never overridden.
     */
    subagentModel: string;

    /**
     * Model for the orchestrator agent itself. Defaults to the agent's
     * existing model, falling back to the top-level `model` setting.
     */
    orchestratorModel?: string;

    /**
     * Name of the orchestrator agent. Default: "Manager". If no agent with this
     * name exists, the plugin creates one (visible in the agent picker).
     */
    orchestratorAgent?: string;

    /**
     * Number of orchestrator levels in the delegation chain. Default: 1. With
     * depth N the orchestrator levels are named `<orchestratorAgent>`,
     * `<orchestratorAgent>-2`, ..., `<orchestratorAgent>-N`. Intermediate
     * levels (1..N-1) can only delegate to the next level via their `subagent`
     * permission; only the final level's routed subagents (general, explore)
     * keep their hands-on tools.
     */
    orchestratorDepth?: number;

    /**
     * Per-level orchestrator model overrides. `orchestratorModels[0]` sets the
     * model for the top level (e.g. "Manager"), `orchestratorModels[1]` for
     * "Manager-2", etc. Optional; when a level has no entry, it falls back to
     * `orchestratorModel`, then to the agent's existing/default model. Entries
     * must be `provider/model` format. Length must not exceed
     * `orchestratorDepth`.
     */
    orchestratorModels?: string[];

    /**
     * Restrict which agents get routed to `subagentModel`. Defaults to every
     * built-in subagent (general, explore) plus all subagent/all-mode agents
     * already declared by the user. Orchestrator level agents are never routed.
     */
    agents?: string[];

    /**
     * Per-agent model overrides, keyed by agent name. Wins over
     * `subagentModel`. Never applies to orchestrator level agents (they are
     * never routed).
     */
    agentModels?: Record<string, string>;

    /**
     * Extra rules appended verbatim to the top-level orchestrator's system
     * prompt.
     */
    instructions?: string;

    /**
     * Tools hard-blocked for every orchestrator level via its agent
     * `permissions` config. Default: ["edit", "bash"]. Pass [] for prompt-only
     * enforcement.
     */
    blockedTools?: string[];

    /**
     * When true, the FINAL orchestrator level's `subagent` rule is set
     * to deny delegation to every agent except the routed subagents, so it can
     * only delegate to them. Intermediate levels always get a structurally
     * pinned subagent rule (to the next level) regardless of this option. Default:
     * false.
     */
    restrictTask?: boolean;
}

export type NormalizedOptions = {
    subagentModel: string;
    orchestratorModel?: string;
    orchestratorAgent: string;
    orchestratorDepth: number;
    orchestratorModels?: string[];
    agents?: string[];
    agentModels: Record<string, string>;
    instructions?: string;
    blockedTools: string[];
    restrictTask: boolean;
};
