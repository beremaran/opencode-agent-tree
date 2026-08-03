export const PLUGIN_ID = "@beremaran/opencode-agent-tree"
export const DIRECTIVE_MARKER = "# Orchestrator Mode"
export const WORKER_DIRECTIVE_MARKER = "# Worker Mode"
export const MODEL_COMMAND = "subagent-model"
export const MODEL_COMMAND_TEMPLATE =
  "Use `$ARGUMENTS` as the default model for subsequent delegated tasks in this opencode process. Confirm the active subagent model in one sentence and do nothing else."
export const ORCHESTRATOR_TOOLS = [
  "task",
  "todowrite",
  "question",
  "workflow_start",
  "workflow_status",
  "workflow_result",
  "workflow_cancel",
  "workflow_resume",
  "workflow_save",
  "workflow_list_saved",
] as const
export const WORKER_AGENT = "worker"

/**
 * Built-in agents are not present in the merged config when the plugin
 * `config` hook runs, so the target entries must be created explicitly. The
 * dedicated worker is also created here when it is not user-defined.
 * Entries created here are merged over the built-ins at agent lookup time.
 */
export const BUILTIN_SUBAGENTS = ["general", "explore"]

export const DEFAULTS = {
  orchestratorAgent: "orchestrator",
  blockedTools: ["edit", "write", "apply_patch", "bash"],
  workflows: {
    enabled: true,
    approval: "always",
    maxParallel: 4,
    maxAgents: 50,
    maxIterations: 10,
    stepTimeout: 1800,
    autoResume: false,
    notifyParent: true,
  },
} as const
