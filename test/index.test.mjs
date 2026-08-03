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
        build: { mode: "primary", model: "existing/model" },
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
  assert.equal(config.agent.build.model, "override/model")
  assert.match(config.agent.build.prompt, /Keep reports concise\./)
  assert.equal(config.agent.build.permission.edit, "deny")
  assert.equal(config.agent.build.permission.bash, "deny")
})

test("explicit agent selection is filtered, deduplicated, and accurately logged", async () => {
  const { config, logs } = await apply(
    {
      subagentModel: "fallback/model",
      agents: ["worker", "worker", "primary", "disabled", "general", "build"],
    },
    {
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
})

test("configuration is idempotent and custom orchestrators are primary agents", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "fallback/model", orchestratorAgent: "lead", blockedTools: [] },
    { agent: { helper: { mode: "subagent" } } },
  )

  await hooks.config(config)

  assert.equal(config.agent.lead.mode, "primary")
  assert.equal(config.agent.lead.permission, undefined)
  assert.equal((config.agent.lead.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.deepEqual(logs.at(-1).body.extra.routedAgents, ["general", "explore", "helper"])
})

test("invalid options fail with a useful error instead of a runtime TypeError", async () => {
  const defaults = await apply(
    { subagentModel: "model", blockedTools: undefined },
    { agent: {} },
  )
  assert.deepEqual(defaults.config.agent.build.permission, { edit: "deny", bash: "deny" })

  for (const options of [
    { subagentModel: "model", blockedTools: null },
    { subagentModel: "model", agents: null },
    { subagentModel: "model", agents: "general" },
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
