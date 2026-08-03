import { DIRECTIVE_MARKER, ORCHESTRATOR_TOOLS, WORKER_DIRECTIVE_MARKER } from "./constants.ts"
import { orchestratorDirective, workerDirective } from "./prompts.ts"
import type { AgentLike, NormalizedOptions } from "./types.ts"

export const configureWorker = (def: AgentLike): AgentLike => {
  def.mode ??= "subagent"
  def.description ??= "Handles implementation, refactoring, testing, and verification delegated by the orchestrator."
  if (!def.prompt?.includes(WORKER_DIRECTIVE_MARKER)) {
    def.prompt = def.prompt ? `${def.prompt}\n\n${workerDirective}` : workerDirective
  }
  return def
}

export const configureOrchestrator = (orchestrator: AgentLike, opts: NormalizedOptions): AgentLike => {
  orchestrator.mode = "primary"
  orchestrator.description ??= "Plans work, delegates it to subagents, and reviews the results."
  if (opts.orchestratorModel) orchestrator.model = opts.orchestratorModel
  const permission = { ...orchestrator.permission }
  for (const tool of ORCHESTRATOR_TOOLS) {
    if (opts.workflows.enabled || !tool.startsWith("workflow_")) permission[tool] = "allow"
  }
  for (const tool of opts.blockedTools) permission[tool] = "deny"
  orchestrator.permission = permission
  if (!orchestrator.prompt?.includes(DIRECTIVE_MARKER)) {
    orchestrator.prompt = orchestrator.prompt
      ? `${orchestrator.prompt}\n\n${orchestratorDirective(opts)}`
      : orchestratorDirective(opts)
  }
  return orchestrator
}
