export const PLUGIN_ID = "@beremaran/opencode-agent-tree";

export const MANAGER_AGENT = "Manager";
export const FIRST_WORKER_AGENT = "general";

/**
 * Built-in workers may not be present in the agent draft when the plugin
 * transform runs, so they are added explicitly when needed.
 */
export const BUILTIN_WORKERS = ["general", "explore"] as const;

/** Built-in primary/system agents are never valid recursive workers. */
export const KNOWN_PRIMARY_AGENTS = ["build", "plan", "compaction", "title", "summary"] as const;

/** V2 wildcard action used to make Manager delegation-only. */
export const ROOT_BLOCKED_ACTION = "*";

export const MANAGER_DIRECTIVE_MARKER = `# Recursive Decomposition Delegation (enforced by ${PLUGIN_ID})`;
export const WORKER_DIRECTIVE_MARKER = `# Recursive Worker Mode (enforced by ${PLUGIN_ID})`;
