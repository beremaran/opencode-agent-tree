import type { Plugin } from "@opencode-ai/plugin"

import {
  BUILTIN_SUBAGENTS,
  MODEL_COMMAND,
  MODEL_COMMAND_TEMPLATE,
  ORCHESTRATOR_TOOLS,
  PLUGIN_ID,
  WORKER_AGENT,
} from "./constants.ts"
import { createRoutingState } from "./model-routing.ts"
import { configureOrchestrator, configureWorker } from "./orchestrator.ts"
import { modelReference, normalizeOptions } from "./options.ts"
import type { AgentLike, ConfigWithDefaultAgent, NormalizedOptions } from "./types.ts"
import { createWorkflowServicesFactory } from "./workflow/runtime.ts"
import { createWorkflowTools } from "./workflow/tools.ts"
import type { WorkflowServices } from "./workflow/tools.ts"

export type { OrchestratorOptions } from "./types.ts"

const isSubagentLike = (agent: AgentLike | undefined) =>
  !agent || agent.mode === undefined || agent.mode === "subagent" || agent.mode === "all"

export const OrchestratorPlugin: Plugin = async (pluginInput, options = {}) => {
  const { client } = pluginInput
  const sessionExecutions = new Map<string, { agent: string; model?: string; variant?: string }>()
  let opts: NormalizedOptions
  try {
    opts = normalizeOptions(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : `[${PLUGIN_ID}] Invalid plugin options.`
    await client.app.log({ body: { service: PLUGIN_ID, level: "error", message } })
    throw error
  }

  const routing = createRoutingState(modelReference(opts.subagentModel, "subagentModel"))
  const workflowAgents = [...BUILTIN_SUBAGENTS, WORKER_AGENT]
  const workflowModels = [opts.subagentModel, ...Object.values(opts.agentModels)]
  const runtimeFactory = createWorkflowServicesFactory({
    input: pluginInput,
    options: opts.workflows,
    policy: () => ({ agents: workflowAgents, models: workflowModels }),
    defaultAgent: () => WORKER_AGENT,
    defaultModel: () => routing.getActiveModel().raw,
    defaultVariant: () => opts.subagentEffort,
    log: async (level, message, extra) => {
      await client.app.log({ body: { service: PLUGIN_ID, level, message, extra } })
    },
  })
  let servicesPromise: Promise<WorkflowServices> | undefined
  const services = () => {
    servicesPromise ??= runtimeFactory().catch((error) => {
      servicesPromise = undefined
      throw error
    })
    return servicesPromise
  }
  const workflowTools = createWorkflowTools({
    services,
    defaultModel: () => routing.getActiveModel().raw,
    parentExecution: (sessionID) => sessionExecutions.get(sessionID),
    approval: opts.workflows.approval,
    limits: () => opts.workflows,
  })

  return {
    dispose: async () => {
      if (servicesPromise) await (await servicesPromise).scheduler.dispose()
    },
    tool: opts.workflows.enabled ? workflowTools : {},
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
      workflowAgents.splice(0, workflowAgents.length, ...targets)

      routing.prune(targetSet)

      // Route every delegation target to the user-chosen model.
      for (const name of targets) {
        const def = ensureAgent(name)
        if (name === WORKER_AGENT) configureWorker(def)
        routing.applyModel(name, def, opts.agentModels[name])
        routing.applyEffort(name, def, opts.agentEfforts[name] ?? opts.subagentEffort)
      }
      const configuredModels = [...new Set([
        routing.getActiveModel().raw,
        ...targets.map((name) => getAgent(name)?.model).filter((model): model is string => Boolean(model)),
      ])]
      workflowModels.splice(0, workflowModels.length, ...configuredModels)

      // Configure the orchestrator: model, hard tool block, and the
      // delegation directive as its system prompt.
      const orchestrator = configureOrchestrator(ensureAgent(opts.orchestratorAgent), opts)

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
      if (opts.workflows.enabled) {
        command.workflow ??= {
          template: "Design a validated dynamic workflow for `$ARGUMENTS`, then call `workflow_start` with spec and `wait: true`. Never also pass name; name is only for loading a saved workflow. Review and report the completed result. Foreground waiting keeps one-shot `opencode run` processes alive until the workflow finishes.",
          description: "Start a durable dynamic workflow",
          agent: opts.orchestratorAgent,
          subtask: false,
        }
        command.workflows ??= {
          template: "Call `workflow_status` without a run id and summarize the current and recent workflow runs.",
          description: "List dynamic workflow runs",
          agent: opts.orchestratorAgent,
          subtask: false,
        }
        command["workflow-resume"] ??= {
          template: "Call `workflow_resume` with run id `$ARGUMENTS`, then report whether it resumed.",
          description: "Resume a dynamic workflow run",
          agent: opts.orchestratorAgent,
          subtask: false,
        }
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
            orchestratorTools: ORCHESTRATOR_TOOLS.filter((tool) => opts.workflows.enabled || !tool.startsWith("workflow_")),
            blockedTools: [...opts.blockedTools],
            workflows: opts.workflows,
          },
        },
      })
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== MODEL_COMMAND) return

      const model = routing.setActiveModel(modelReference(input.arguments, `/${MODEL_COMMAND} argument`))
      if (!workflowModels.includes(model.raw)) workflowModels.push(model.raw)

      for (const part of output.parts) {
        if (part.type === "text") {
          part.text = `Use \`${model.raw}\` as the default model for subsequent delegated tasks in this opencode process. Confirm the active subagent model in one sentence and do nothing else.`
        }
      }

      await client.app.log({
        body: {
          service: PLUGIN_ID,
          level: "info",
          message: `Changed the default subagent model to "${model.raw}" for this opencode process.`,
        },
      })
    },
    "chat.message": async (input, output) => {
      const notification = output.parts.some(
        (part) => part.type === "text" && /^\[workflow-(complete|failed):/.test(part.text),
      )
      if (notification) output.message.tools = { ...output.message.tools, workflow_start: false }
      const agentName = input.agent ?? output.message.agent
      if (routing.hasRoute(agentName)) {
        const model = routing.routeFor(agentName) ?? routing.getActiveModel()
        output.message.model = { ...output.message.model, providerID: model.providerID, modelID: model.modelID }
      }
      sessionExecutions.set(input.sessionID, {
        agent: agentName,
        model: `${output.message.model.providerID}/${output.message.model.modelID}`,
        variant: input.variant,
      })
    },
  }
}

export default OrchestratorPlugin
