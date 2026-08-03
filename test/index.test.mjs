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
    { subagentModel: "provider/model", blockedTools: undefined },
    { agent: {} },
  )
  assert.deepEqual(defaults.config.agent.build.permission, { edit: "deny", bash: "deny" })

  for (const options of [
    { subagentModel: "provider/model", blockedTools: null },
    { subagentModel: "provider/model", agents: null },
    { subagentModel: "provider/model", agents: "general" },
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

test("disabled orchestrator agent rejects and logs an error", async () => {
  const { input, logs } = createInput()
  const hooks = await OrchestratorPlugin(input, { subagentModel: "provider/model" })

  await assert.rejects(
    () => hooks.config({ agent: { build: { mode: "primary", disable: true } } }),
    /disabled/,
  )
  const errorLogs = logs.filter((entry) => entry.body.level === "error")
  assert.equal(errorLogs.length, 1)
  assert.match(errorLogs[0].body.message, /orchestrator agent `build` is disabled/)
})

test("directive is appended to an existing orchestrator prompt", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model" },
    { agent: { build: { mode: "primary", prompt: "Existing prompt text." } } },
  )

  assert.ok(config.agent.build.prompt.startsWith("Existing prompt text."))
  assert.equal((config.agent.build.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
})

test("orchestrator permissions merge with a clobber warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { build: { mode: "primary", permission: { bash: "ask", webfetch: "allow" } } } },
  )

  assert.deepEqual(config.agent.build.permission, { bash: "deny", webfetch: "allow", edit: "deny" })
  const bashWarnings = logs.filter(
    (entry) => entry.body.level === "warn" && entry.body.message.includes("bash"),
  )
  assert.equal(bashWarnings.length, 1)
  assert.match(bashWarnings[0].body.message, /Overwriting existing permission for tool "bash" on agent "build"/)
})

test("re-running the config hook is idempotent and does not repeat warnings", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "fallback/model" },
    { agent: { build: { mode: "primary", permission: { bash: "ask" } }, worker: { mode: "subagent" } } },
  )

  await hooks.config(config)

  assert.equal(config.agent.worker.model, "fallback/model")
  assert.equal((config.agent.build.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
  const bashWarnings = logs.filter(
    (entry) => entry.body.level === "warn" && entry.body.message.includes("bash"),
  )
  assert.equal(bashWarnings.length, 1)
})

test("explicit agent model takes precedence over agentModels and subagentModel", async () => {
  const { config } = await apply(
    { subagentModel: "fallback/model", agentModels: { worker: "override/model", general: "special/model" } },
    { agent: { worker: { mode: "subagent", model: "explicit/model" } } },
  )

  assert.equal(config.agent.worker.model, "explicit/model")
  assert.equal(config.agent.general.model, "special/model")
})

test("custom orchestrator is routed to primary mode with default blocked tools", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", orchestratorAgent: "lead" },
    { agent: {} },
  )

  assert.equal(config.agent.lead.mode, "primary")
  assert.deepEqual(config.agent.lead.permission, { edit: "deny", bash: "deny" })
})

test("malformed model ids are rejected and logged as errors", async () => {
  for (const [options, message] of [
    [{ subagentModel: "garbage" }, /provider\/model/],
    [{ subagentModel: "provider/model", orchestratorModel: "nope" }, /orchestratorModel/],
    [{ subagentModel: "provider/model", agentModels: { worker: "bad" } }, /agentModels/],
  ]) {
    const { input, logs } = createInput()
    await assert.rejects(() => OrchestratorPlugin(input, options), message)
    assert.equal(logs.at(-1).body.level, "error")
  }
})

test("invalid blockedTools entries are rejected with a useful message", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", blockedTools: ["Edit"] }),
    /blockedTools/,
  )
  assert.equal(logs.at(-1).body.level, "error")
})

test("blocking a directive tool warns but still applies the deny", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", blockedTools: ["task"] },
    { agent: {} },
  )

  const directiveWarnings = logs.filter((entry) => entry.body.level === "warn")
  assert.equal(directiveWarnings.length, 1)
  assert.match(directiveWarnings[0].body.message, /Orchestrator relies on blocked tool\(s\): task/)
  assert.equal(config.agent.build.permission.task, "deny")
})

test("explicit agents omitting built-ins log a warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agents: ["worker"] },
    { agent: { worker: { mode: "subagent" } } },
  )

  const builtinWarnings = logs.filter(
    (entry) => entry.body.level === "warn" && entry.body.message.includes("built-in subagents"),
  )
  assert.equal(builtinWarnings.length, 1)
  assert.deepEqual(logs.at(-1).body.extra.routedAgents, ["worker"])
})

test("phantom agent names are created and logged with a warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agents: ["typoAgent"] },
    { agent: {} },
  )

  const phantomWarnings = logs.filter(
    (entry) => entry.body.level === "warn" && entry.body.message.includes("typoAgent"),
  )
  assert.equal(phantomWarnings.length, 1)
  assert.match(phantomWarnings[0].body.message, /Creating agent entry for unknown name "typoAgent"/)
  assert.equal(config.agent.typoAgent.model, "provider/model")
})

test("agent names colliding with Object.prototype keys are handled safely", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", agents: ["toString"], agentModels: {} },
    { agent: {} },
  )

  assert.equal(Object.prototype.hasOwnProperty.call(config.agent, "toString"), true)
  assert.equal(config.agent.toString.model, "provider/model")
})
