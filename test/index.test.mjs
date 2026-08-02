import assert from "node:assert/strict"
import test from "node:test"

const { OrchestratorPlugin } = await import("../src/index.ts")

const createInput = () => {
  const logs = []
  return {
    input: { client: { app: { log: async (entry) => logs.push(entry) } } },
    logs,
  }
}

const apply = async (options, config) => {
  const { input, logs } = createInput()
  const hooks = await OrchestratorPlugin(input, options)
  await hooks.config(config)
  return { config, logs, hooks }
}

test("routes only eligible agents and preserves explicit models", async () => {
  const { config, logs } = await apply(
    {
      subagentModel: "fallback/model",
      orchestratorModel: "override/model",
      instructions: "Keep reports concise.",
      agentModels: { worker: "special/model" },
    },
    {
      model: "orchestrator/model",
      agent: {
        build: { mode: "primary", model: "existing/model", permission: { edit: "allow" } },
        worker: { mode: "subagent" },
        existing: { mode: "all", model: "explicit/model" },
        primary: { mode: "primary" },
        disabled: { mode: "subagent", disable: true },
      },
    },
  )

  assert.deepEqual(logs.at(-1).body.extra.routedAgents, ["general", "explore", "worker", "existing"])
  assert.equal(config.agent.general.model, "fallback/model")
  assert.equal(config.agent.explore.model, "fallback/model")
  assert.equal(config.agent.worker.model, "special/model")
  assert.equal(config.agent.existing.model, "explicit/model")
  assert.equal(config.agent.primary.model, undefined)
  assert.equal(config.agent.disabled.model, undefined)
  assert.deepEqual(config.agent.build, {
    mode: "primary",
    model: "existing/model",
    permission: { edit: "allow" },
  })
  assert.equal(config.default_agent, "orchestrator")
  assert.equal(config.agent.orchestrator.model, "override/model")
  assert.match(config.agent.orchestrator.prompt, /Keep reports concise\./)
  assert.equal(config.agent.orchestrator.permission.edit, "deny")
  assert.equal(config.agent.orchestrator.permission.write, "deny")
  assert.equal(config.agent.orchestrator.permission.apply_patch, "deny")
  assert.equal(config.agent.orchestrator.permission.bash, "deny")
  assert.equal(config.agent.orchestrator.permission.task, "allow")
  assert.equal(config.agent.orchestrator.permission.todowrite, "allow")
  assert.equal(config.agent.orchestrator.permission.question, "allow")
  assert.deepEqual(logs.at(-1).body.extra.orchestratorTools, ["task", "todowrite", "question"])
  assert.equal(config.command["subagent-model"].agent, "orchestrator")
})

test("explicit agent selection is filtered, deduplicated, and accurately logged", async () => {
  const { config, logs } = await apply(
    {
      subagentModel: "fallback/model",
      agents: ["worker", "worker", "primary", "disabled", "general", "build", "orchestrator"],
    },
    {
      default_agent: "build",
      agent: {
        build: { mode: "primary" },
        worker: { mode: "subagent" },
        primary: { mode: "primary" },
        disabled: { mode: "subagent", disable: true },
      },
    },
  )

  assert.deepEqual(logs.at(-1).body.extra.routedAgents, ["worker", "general"])
  assert.equal(config.agent.worker.model, "fallback/model")
  assert.equal(config.agent.general.model, "fallback/model")
  assert.equal(config.agent.explore, undefined)
  assert.equal(config.default_agent, "build")
})

test("configuration is idempotent and custom orchestrators are primary agents", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "fallback/model", orchestratorAgent: "lead", blockedTools: [] },
    { agent: { helper: { mode: "subagent" } } },
  )

  await hooks.config(config)

  assert.equal(config.agent.lead.mode, "primary")
  assert.equal(config.default_agent, "lead")
  assert.deepEqual(config.agent.lead.permission, {
    task: "allow",
    todowrite: "allow",
    question: "allow",
  })
  assert.equal((config.agent.lead.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.deepEqual(logs.at(-1).body.extra.routedAgents, ["general", "explore", "helper"])
})

test("invalid options fail with a useful error instead of a runtime TypeError", async () => {
  const defaults = await apply(
    { subagentModel: "fallback/model", blockedTools: undefined },
    { agent: {} },
  )
  assert.deepEqual(defaults.config.agent.orchestrator.permission, {
    task: "allow",
    todowrite: "allow",
    question: "allow",
    edit: "deny",
    write: "deny",
    apply_patch: "deny",
    bash: "deny",
  })

  for (const options of [
    { subagentModel: "fallback/model", blockedTools: null },
    { subagentModel: "fallback/model", agents: null },
    { subagentModel: "fallback/model", agents: "general" },
  ]) {
    const { input, logs } = createInput()
    await assert.rejects(() => OrchestratorPlugin(input, options), /blockedTools|agents/)
    assert.equal(logs.at(-1).body.level, "error")
  }
})

test("missing subagentModel is reported as configuration error", async () => {
  const { input, logs } = createInput()

  await assert.rejects(() => OrchestratorPlugin(input, {}), /subagentModel.*required/)
  assert.match(logs.at(-1).body.message, /subagentModel.*required/)
})

test("chat command changes only fallback-routed subagent models", async () => {
  const { config, hooks, logs } = await apply(
    {
      subagentModel: "fallback/one",
      agentModels: { explore: "special/explore" },
    },
    {
      agent: {
        worker: { mode: "subagent" },
        explicit: { mode: "subagent", model: "user/model" },
      },
    },
  )

  const parts = [{ type: "text", text: "original command template" }]
  await hooks["command.execute.before"](
    { command: "subagent-model", sessionID: "session", arguments: " openrouter/anthropic/claude-sonnet " },
    { parts },
  )

  assert.equal(config.agent.general.model, "openrouter/anthropic/claude-sonnet")
  assert.equal(config.agent.worker.model, "openrouter/anthropic/claude-sonnet")
  assert.equal(config.agent.explore.model, "special/explore")
  assert.equal(config.agent.explicit.model, "user/model")
  assert.match(parts[0].text, /openrouter\/anthropic\/claude-sonnet/)
  assert.match(logs.at(-1).body.message, /Subagent model changed from chat/)

  const fallbackMessage = { agent: "general", model: { providerID: "old", modelID: "model" } }
  await hooks["chat.message"]({ sessionID: "child", agent: "general" }, { message: fallbackMessage, parts: [] })
  assert.deepEqual(fallbackMessage.model, {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet",
  })

  const overrideMessage = { agent: "explore", model: { providerID: "old", modelID: "model" } }
  await hooks["chat.message"]({ sessionID: "child", agent: "explore" }, { message: overrideMessage, parts: [] })
  assert.deepEqual(overrideMessage.model, { providerID: "special", modelID: "explore" })

  const explicitMessage = { agent: "explicit", model: { providerID: "user", modelID: "model" } }
  await hooks["chat.message"]({ sessionID: "child", agent: "explicit" }, { message: explicitMessage, parts: [] })
  assert.deepEqual(explicitMessage.model, { providerID: "user", modelID: "model" })
})

test("chat model command and model options reject invalid references", async () => {
  const { hooks } = await apply({ subagentModel: "fallback/model" }, { agent: {} })

  await assert.rejects(
    () =>
      hooks["command.execute.before"](
        { command: "subagent-model", sessionID: "session", arguments: "missing-provider" },
        { parts: [] },
      ),
    /provider\/model-id/,
  )

  const { input } = createInput()
  await assert.rejects(() => OrchestratorPlugin(input, { subagentModel: "missing-provider" }), /provider\/model-id/)
})

test("does not silently replace a user-defined subagent-model command", async () => {
  await assert.rejects(
    () =>
      apply(
        { subagentModel: "fallback/model" },
        { command: { "subagent-model": { template: "User command" } }, agent: {} },
      ),
    /already defined/,
  )
})
