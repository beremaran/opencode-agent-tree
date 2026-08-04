import assert from "node:assert/strict"
import test from "node:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"

const { OrchestratorPlugin } = await import("../src/index.ts")

const SERVICE = "@beremaran/opencode-agent-tree"

type LogBody = {
  service: string
  level: "error" | "warn" | "info"
  message: string
  extra?: Record<string, unknown>
}

type LogEntry = {
  body: LogBody
}

type TestAgent = {
  model?: string
  mode?: string
  disable?: boolean
  prompt?: string
  permission?: Record<string, unknown> | string
}

type TestConfig = {
  model?: string
  default_agent?: string
  agent?: Record<string, TestAgent>
}

const createInput = () => {
  const logs: LogEntry[] = []
  return {
    input: {
      client: {
        app: {
          log: async (entry: LogEntry) => {
            logs.push(entry)
          },
        },
      },
    } as unknown as PluginInput,
    logs,
  }
}

const apply = async (options: Record<string, unknown>, config: TestConfig) => {
  const { input, logs } = createInput()
  const hooks = await OrchestratorPlugin(input, options)
  await hooks.config(config as Config)
  return { config, logs, hooks }
}

// Filter-based log helpers: tests should never depend on absolute log
// position (e.g. `.at(-1)`), so extra logs added later cannot break them.
const summaryLog = (logs: LogEntry[]) =>
  logs.filter((entry) => entry.body.level === "info" && entry.body.message.startsWith("Orchestrator")).at(-1)

const errorLogs = (logs: LogEntry[]) => logs.filter((entry) => entry.body.level === "error")

const warns = (logs: LogEntry[]) => logs.filter((entry) => entry.body.level === "warn")

const warnMatching = (logs: LogEntry[], pattern: RegExp) =>
  warns(logs).filter((entry) => pattern.test(entry.body.message))

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

  const summary = summaryLog(logs)
  assert.ok(summary)
  assert.deepEqual(summary.body.extra?.routedAgents, ["general", "explore", "worker", "existing"])
  assert.equal(summary.body.service, SERVICE)
  assert.equal(config.agent.general.model, "fallback/model")
  assert.equal(config.agent.explore.model, "fallback/model")
  assert.equal(config.agent.worker.model, "special/model")
  assert.equal(config.agent.existing.model, "explicit/model")
  assert.equal(config.agent.primary.model, undefined)
  assert.equal(config.agent.disabled.model, undefined)
  assert.equal(config.agent.Manager.model, "override/model")
  assert.equal(config.agent.Manager.mode, "primary")
  assert.match(config.agent.Manager.prompt, /Keep reports concise\./)
  assert.equal(config.agent.Manager.permission.edit, "deny")
  assert.equal(config.agent.Manager.permission.bash, "deny")
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

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["worker", "general"])
  assert.equal(config.agent.worker.model, "fallback/model")
  assert.equal(config.agent.general.model, "fallback/model")
  assert.equal(config.agent.explore, undefined)
  assert.equal(warnMatching(logs, /unknown name/).length, 0)
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
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore", "helper"])
  assert.equal(warnMatching(logs, /Converting agent/).length, 0)
})

test("invalid options fail with a useful error instead of a runtime TypeError", async () => {
  const defaults = await apply({ subagentModel: "provider/model", blockedTools: undefined }, { agent: {} })
  assert.deepEqual(defaults.config.agent.Manager.permission, { edit: "deny", bash: "deny" })

  for (const options of [
    { subagentModel: "provider/model", blockedTools: null },
    { subagentModel: "provider/model", agents: null },
    { subagentModel: "provider/model", agents: "general" },
  ]) {
    const { input, logs } = createInput()
    await assert.rejects(() => OrchestratorPlugin(input, options), /blockedTools|agents/)
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("missing subagentModel is reported as configuration error", async () => {
  const { input, logs } = createInput()

  await assert.rejects(() => OrchestratorPlugin(input, {}), /subagentModel.*required/)
  assert.match(errorLogs(logs)[0].body.message, /subagentModel.*required/)
})

test("whitespace-only subagentModel is reported as a required-option error", async () => {
  const { input, logs } = createInput()

  await assert.rejects(() => OrchestratorPlugin(input, { subagentModel: "   " }), /subagentModel.*required/)
  assert.equal(errorLogs(logs).length, 1)
})

test("disabled orchestrator agent logs an error without throwing and makes no mutations", async () => {
  const { input, logs } = createInput()
  const hooks = await OrchestratorPlugin(input, { subagentModel: "provider/model" })
  const config: TestConfig = { agent: { Manager: { disable: true } } }

  // The config hook must never throw; a disabled orchestrator is handled
  // by logging an error and returning without mutating anything.
  await hooks.config(config as Config)

  const errors = errorLogs(logs)
  assert.equal(errors.length, 1)
  assert.match(errors[0].body.message, /orchestrator agent `Manager` is disabled/)
  assert.equal(errors[0].body.service, SERVICE)
  assert.equal(config.agent.Manager.mode, undefined)
  assert.equal(config.agent.Manager.permission, undefined)
  assert.equal(config.agent.Manager.prompt, undefined)
  assert.equal(config.agent.general, undefined)
  assert.equal(config.agent.worker, undefined)
  assert.equal(summaryLog(logs), undefined)
  assert.equal(warns(logs).length, 0)
})

test("directive is appended to an existing orchestrator prompt", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", prompt: "Existing prompt text." } } },
  )

  assert.ok(config.agent.Manager.prompt.startsWith("Existing prompt text."))
  assert.equal((config.agent.Manager.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
})

test("orchestrator permissions merge with a clobber warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", permission: { bash: "ask", webfetch: "allow" } } } },
  )

  assert.deepEqual(config.agent.Manager.permission, { bash: "deny", webfetch: "allow", edit: "deny" })
  const overwrite = warnMatching(logs, /Overwriting existing permission/)
  assert.equal(overwrite.length, 1)
  assert.match(
    overwrite[0].body.message,
    /Overwriting existing permission for tool "bash" on agent "Manager"/,
  )
})

test("non-record orchestrator permission is treated as an empty object with a warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", permission: "nope" } } },
  )

  assert.deepEqual(config.agent.Manager.permission, { edit: "deny", bash: "deny" })
  const warnings = warns(logs).filter((entry) => /permission/i.test(entry.body.message))
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].body.service, SERVICE)
})

test("command-scoped permission rules are replaced by a blanket deny with a warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", permission: { bash: { "npm install": "allow" } } } } },
  )

  assert.deepEqual(config.agent.Manager.permission, { edit: "deny", bash: "deny" })
  const warnings = warnMatching(logs, /granular|command-scoped/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].body.message, /bash/)
})

test("re-running the config hook is idempotent and does not repeat warnings", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "fallback/model" },
    { agent: { Manager: { mode: "primary", permission: { bash: "ask" } }, worker: { mode: "subagent" } } },
  )

  await hooks.config(config)

  assert.equal(config.agent.worker.model, "fallback/model")
  assert.equal((config.agent.Manager.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.equal(warnMatching(logs, /Overwriting existing permission/).length, 1)
  assert.equal(warnMatching(logs, /Converting agent/).length, 0)
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
  const { config, logs } = await apply(
    { subagentModel: "provider/model", orchestratorAgent: "lead" },
    { agent: {} },
  )

  assert.equal(config.agent.lead.mode, "primary")
  assert.deepEqual(config.agent.lead.permission, { edit: "deny", bash: "deny" })
  assert.equal(warnMatching(logs, /Converting agent/).length, 0)
})

test("default config creates a Manager orchestrator agent with the directive and blocks", async () => {
  const { config, logs } = await apply({ subagentModel: "provider/model" }, { agent: {} })

  assert.equal(config.agent.Manager.mode, "primary")
  assert.deepEqual(config.agent.Manager.permission, { edit: "deny", bash: "deny" })
  assert.equal((config.agent.Manager.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.equal(config.agent.Manager.tools, undefined)
  assert.equal(config.agent.Manager.disable, undefined)
  assert.equal(summaryLog(logs)?.body.service, SERVICE)
})

test("known built-ins are never routed or phantom-created even when explicitly listed", async () => {
  // build/plan/compaction/title/summary are known built-ins: they are never
  // routed and never trigger the phantom (typo) warning, even though they are
  // absent from cfg.agent.
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agents: ["build", "plan", "compaction", "title", "summary"] },
    { agent: {} },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, [])
  assert.equal(config.agent.build, undefined)
  assert.equal(config.agent.plan, undefined)
  assert.equal(config.agent.compaction, undefined)
  assert.equal(config.agent.title, undefined)
  assert.equal(config.agent.summary, undefined)
  assert.equal(warnMatching(logs, /unknown name/).length, 0)
  assert.equal(config.agent.Manager.mode, "primary")
})

test("default routing never creates known built-in entries", async () => {
  const { config } = await apply({ subagentModel: "provider/model" }, { agent: {} })

  for (const name of ["build", "plan", "compaction", "title", "summary"]) {
    assert.equal(config.agent[name], undefined)
  }
})

test("built-in primaries like build/plan are skipped while real workers route", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agents: ["build", "plan", "worker"] },
    { agent: {} },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["worker"])
  assert.equal(config.agent.build, undefined)
  assert.equal(config.agent.plan, undefined)
  assert.equal(config.agent.worker.model, "provider/model")
  // Only the genuinely unknown "worker" triggers the phantom warning.
  const phantom = warnMatching(logs, /unknown name/)
  assert.equal(phantom.length, 1)
  assert.match(phantom[0].body.message, /"worker"/)
})

test("orchestrator mode is forced to primary with a one-time conversion warning", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "provider/model", orchestratorAgent: "lead" },
    { agent: { lead: { mode: "subagent" } } },
  )

  assert.equal(config.agent.lead.mode, "primary")
  const converting = warnMatching(logs, /Converting agent/)
  assert.equal(converting.length, 1)
  assert.match(converting[0].body.message, /lead/)
  assert.match(converting[0].body.message, /to "primary"/)
  assert.equal(converting[0].body.service, SERVICE)

  // Re-running the hook must not repeat the conversion warning.
  await hooks.config(config)
  assert.equal(warnMatching(logs, /Converting agent/).length, 1)
})

test("a pre-existing primary orchestrator mode does not warn about conversion", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary" } } },
  )

  assert.equal(warnMatching(logs, /Converting agent/).length, 0)
})

test("creating the Manager agent is logged once and not repeated on re-run", async () => {
  const { config, hooks, logs } = await apply({ subagentModel: "provider/model" }, { agent: {} })

  const creations = () =>
    logs.filter(
      (entry) =>
        entry.body.level === "info" && entry.body.message.includes('Creating orchestrator agent "Manager"'),
    )

  assert.equal(creations().length, 1)
  await hooks.config(config)
  assert.equal(creations().length, 1)
})

test("malformed model ids are rejected and logged as errors", async () => {
  for (const [options, message] of [
    [{ subagentModel: "garbage" }, /provider\/model/],
    [{ subagentModel: "provider/model", orchestratorModel: "nope" }, /orchestratorModel/],
    [{ subagentModel: "provider/model", agentModels: { worker: "bad" } }, /agentModels/],
  ] as [Record<string, unknown>, RegExp][]) {
    const { input, logs } = createInput()
    await assert.rejects(() => OrchestratorPlugin(input, options), message)
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("invalid blockedTools entries are rejected with a useful message", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", blockedTools: ["Edit"] }),
    /blockedTools/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("blocking a directive tool warns but still applies the deny", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", blockedTools: ["task"] },
    { agent: {} },
  )

  const directiveWarnings = warnMatching(logs, /Orchestrator relies on blocked tool/)
  assert.equal(directiveWarnings.length, 1)
  assert.match(directiveWarnings[0].body.message, /Orchestrator relies on blocked tool\(s\): task/)
  assert.deepEqual(directiveWarnings[0].body.extra?.blockedTools, ["task"])
  assert.equal(config.agent.Manager.permission.task, "deny")
})

test("explicit agents omitting built-ins log a warning", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model", agents: ["worker"] },
    { agent: { worker: { mode: "subagent" } } },
  )

  const builtinWarnings = warnMatching(logs, /built-in subagents/)
  assert.equal(builtinWarnings.length, 1)
  assert.deepEqual(builtinWarnings[0].body.extra?.agents, ["worker"])
  assert.deepEqual(builtinWarnings[0].body.extra?.targets, ["worker"])
  assert.equal(builtinWarnings[0].body.service, SERVICE)
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["worker"])
})

test("phantom agent names are created and logged with a warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agents: ["typoAgent"] },
    { agent: {} },
  )

  const phantomWarnings = warnMatching(logs, /unknown name/)
  assert.equal(phantomWarnings.length, 1)
  assert.match(phantomWarnings[0].body.message, /Creating agent entry for unknown name "typoAgent"/)
  assert.equal(phantomWarnings[0].body.service, SERVICE)
  assert.equal(config.agent.typoAgent.model, "provider/model")
})

test("agent names colliding with Object.prototype keys are handled safely", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", agents: ["toString"], agentModels: {} },
    { agent: {} },
  )

  assert.equal(Object.hasOwn(config.agent, "toString"), true)
  assert.equal(config.agent.toString.model, "provider/model")
})

test("whitespace-only or empty instructions are not appended to the directive", async () => {
  for (const instructions of ["", "   "]) {
    const { config } = await apply({ subagentModel: "provider/model", instructions }, { agent: {} })
    assert.ok(config.agent.Manager.prompt.endsWith("`general`."))
    assert.equal(config.agent.Manager.prompt.includes("   "), false)
  }
})

test("orchestratorModel null is treated as unset", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", orchestratorModel: null },
    { agent: {} },
  )

  assert.equal(config.agent.Manager.model, undefined)
  assert.equal(summaryLog(logs)?.body.extra?.orchestratorModel, "(default)")
})

test("orchestrator agent is never routed even when listed in agentModels", async () => {
  // Contract: agentModels keys are only honored for routed subagents. The
  // orchestrator agent is never routed, so a Manager entry in agentModels
  // must not turn Manager into a target nor assign it a model.
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agentModels: { Manager: "x/y" } },
    { agent: {} },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore"])
  assert.equal(config.agent.Manager.model, undefined)
})

test("config without an agent key gets a working agent object", async () => {
  const { config } = await apply({ subagentModel: "provider/model" }, {})

  assert.ok(config.agent)
  assert.equal(config.agent.Manager.mode, "primary")
  assert.equal(config.agent.Manager.permission.edit, "deny")
  assert.equal((config.agent.Manager.prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
})

test("summary log reports the top-level model when no orchestratorModel is set", async () => {
  const { config, logs } = await apply({ subagentModel: "provider/model" }, { model: "top/model", agent: {} })

  assert.equal(config.agent.Manager.model, undefined)
  assert.equal(summaryLog(logs)?.body.extra?.orchestratorModel, "top/model")
})

test("blocked directive tools are joined into a single warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", blockedTools: ["task", "read"] },
    { agent: {} },
  )

  const warnings = warnMatching(logs, /Orchestrator relies on blocked tool/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].body.message, /task, read/)
  assert.deepEqual(warnings[0].body.extra?.blockedTools, ["task", "read"])
  assert.equal(config.agent.Manager.permission.task, "deny")
  assert.equal(config.agent.Manager.permission.read, "deny")
})

test("an empty explicit agents list warns about built-in omission and routes nothing", async () => {
  const { config, logs } = await apply({ subagentModel: "provider/model", agents: [] }, { agent: {} })

  const builtinWarnings = warnMatching(logs, /built-in subagents/)
  assert.equal(builtinWarnings.length, 1)
  assert.deepEqual(builtinWarnings[0].body.extra?.agents, [])
  assert.deepEqual(builtinWarnings[0].body.extra?.targets, [])
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, [])
  assert.equal(config.agent.general, undefined)
  assert.equal(config.agent.explore, undefined)
  assert.equal(config.agent.Manager.mode, "primary")
})

test("mode: 'all' agents with disable: true are excluded from routing", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { multi: { mode: "all", disable: true } } },
  )

  const routed = summaryLog(logs)?.body.extra?.routedAgents as string[]
  assert.equal(routed.includes("multi"), false)
  assert.equal(config.agent.multi.model, undefined)
})

test("orchestratorModel overrides an existing orchestrator model unconditionally", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", orchestratorModel: "new/model" },
    { agent: { Manager: { mode: "primary", model: "old/model" } } },
  )

  assert.equal(config.agent.Manager.model, "new/model")
  assert.equal(summaryLog(logs)?.body.extra?.orchestratorModel, "new/model")
})

test("non-record options are rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(() => OrchestratorPlugin(input, "not-an-object"), /options.*object/)
  assert.equal(errorLogs(logs).length, 1)
})

test("agentModels: null is rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", agentModels: null }),
    /agentModels/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("empty-string agentModels keys are rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", agentModels: { "": "x/y" } }),
    /agentModels keys/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("the orchestrator agent is excluded from routing even when listed in agents", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", orchestratorAgent: "lead", agents: ["lead", "worker"] },
    { agent: { worker: { mode: "subagent" } } },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["worker"])
  assert.equal(config.agent.lead.model, undefined)
  assert.equal(config.agent.lead.mode, "primary")
  assert.equal(config.agent.worker.model, "provider/model")
})

test("empty blockedTools render the directive with a (none) placeholder", async () => {
  const { config } = await apply({ subagentModel: "provider/model", blockedTools: [] }, { agent: {} })

  assert.ok(config.agent.Manager.prompt.includes("hard-blocked for you (none)"))
  assert.equal(config.agent.Manager.permission, undefined)
})

test("summary log records routedAgents, blockedTools, and defaultAgent in extra", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model" },
    { default_agent: "coordinator", agent: {} },
  )

  const extra = summaryLog(logs)?.body.extra
  assert.deepEqual(extra?.routedAgents, ["general", "explore"])
  assert.deepEqual(extra?.blockedTools, ["edit", "bash"])
  assert.equal(extra?.defaultAgent, "coordinator")
})

test("summary log reports (unset) when no default agent is configured", async () => {
  const { logs } = await apply({ subagentModel: "provider/model" }, { agent: {} })

  assert.equal(summaryLog(logs)?.body.extra?.defaultAgent, "(unset)")
})
