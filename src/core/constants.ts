export const PLUGIN_ID = "@beremaran/opencode-agent-tree";

export const DEFAULTS = {
    orchestratorAgent: "Manager",
    blockedTools: ["edit", "bash"],
} as const;

/**
 * Built-in agents may not be present in the agent draft when the plugin
 * transform runs, so target entries must be created explicitly.
 *
 * This list mirrors OpenCode's built-in subagents and must be updated if
 * OpenCode adds or renames built-in subagents. Note: `scout` appears in some
 * newer OpenCode docs but is not a native general-purpose subagent, so it remains
 * excluded until the host exposes it as a real agent.
 */
export const BUILTIN_SUBAGENTS = ["general", "explore"];

/**
 * Known built-in agents. Unlike BUILTIN_SUBAGENTS these are never routable,
 * even when absent from the merged config, so candidates with these names are
 * excluded from routing (and from the phantom-name warning).
 *
 * This list mirrors OpenCode's built-in agents and must be updated if OpenCode
 * adds or renames built-ins.
 */
export const KNOWN_BUILTINS = ["build", "plan", "compaction", "title", "summary"];

export const DIRECTIVE_TOOLS = ["task", "todowrite", "question", "read", "glob", "grep", "webfetch", "websearch"];

export const BLOCKED_TOOL_PATTERN = /^[a-z0-9_-]+$/;
export const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/**
 * The rendered header line of the level-1 directive. Level 1 keeps this
 * header exactly (both the rendered prompt and the idempotency marker), so
 * `orchestratorDepth: 1` stays byte-identical to the pre-chain directive.
 * Deeper levels use `# Orchestrator Mode (level i/N, enforced by
 * @beremaran/opencode-agent-tree)`.
 */
export const LEVEL1_DIRECTIVE_MARKER = "# Orchestrator Mode (enforced by @beremaran/opencode-agent-tree)";
