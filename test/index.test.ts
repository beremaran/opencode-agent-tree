import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
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
  description?: string
  tools?: Record<string, unknown>
  prompt?: unknown
  permission?: Record<string, unknown> | string
}

type TestConfig = {
  model?: string
  default_agent?: unknown
  subagent_depth?: unknown
  agent: Record<string, TestAgent>
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

const apply = async (options: Record<string, unknown>, config: Partial<TestConfig>) => {
  const { input, logs } = createInput()
  const pluginHooks = await OrchestratorPlugin(input, options)
  const configHook = pluginHooks.config
  assert.ok(configHook, "plugin must expose a config hook")
  await configHook(config as Config)
  return {
    config: config as TestConfig,
    logs,
    // Wrap the raw hook so re-run call sites get a config hook that accepts
    // the looser TestConfig shape used throughout the tests.
    hooks: { config: async (cfg: TestConfig) => configHook(cfg as Config) },
  }
}

// Filter-based log helpers: tests should never depend on absolute log
// position (e.g. `.at(-1)`), so extra logs added later cannot break them.
const summaryLog = (logs: LogEntry[]) =>
  logs.filter((entry) => entry.body.level === "info" && entry.body.message.startsWith("Orchestrator")).at(-1)

const errorLogs = (logs: LogEntry[]) => logs.filter((entry) => entry.body.level === "error")

const warns = (logs: LogEntry[]) => logs.filter((entry) => entry.body.level === "warn")

const warnMatching = (logs: LogEntry[], pattern: RegExp) =>
  warns(logs).filter((entry) => pattern.test(entry.body.message))

// Access helpers: tests deliberately feed the plugin malformed shapes (e.g. a
// string permission, a non-string prompt), so these narrow the produced fields
// after asserting the plugin left them in the expected shape.
const promptOf = (config: TestConfig, name: string): string => {
  const prompt = config.agent[name]?.prompt
  assert.equal(typeof prompt, "string", `agent "${name}" prompt should be a string`)
  return prompt as string
}

const permissionOf = (config: TestConfig, name: string): Record<string, unknown> => {
  const permission = config.agent[name]?.permission
  assert.ok(
    permission && typeof permission === "object" && !Array.isArray(permission),
    `agent "${name}" permission should be an object`,
  )
  return permission as Record<string, unknown>
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
  assert.match(promptOf(config, "Manager"), /Keep reports concise\./)
  assert.equal(permissionOf(config, "Manager").edit, "deny")
  assert.equal(permissionOf(config, "Manager").bash, "deny")
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
  assert.equal((promptOf(config, "lead").match(/# Orchestrator Mode/g) ?? []).length, 1)
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
  await hooks.config?.(config as Config)

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

  assert.ok(promptOf(config, "Manager").startsWith("Existing prompt text."))
  assert.equal((promptOf(config, "Manager").match(/# Orchestrator Mode/g) ?? []).length, 1)
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
  assert.equal((promptOf(config, "Manager").match(/# Orchestrator Mode/g) ?? []).length, 1)
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
  assert.equal((promptOf(config, "Manager").match(/# Orchestrator Mode/g) ?? []).length, 1)
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
  assert.equal(permissionOf(config, "Manager").task, "deny")
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

  // Use a variable key: dot access ("config.agent.toString") would resolve to
  // Object.prototype.toString instead of the agent entry, and a literal bracket
  // access trips biome's useLiteralKeys rule.
  const collisionKey = "toString"
  assert.equal(Object.hasOwn(config.agent, collisionKey), true)
  assert.equal(config.agent[collisionKey].model, "provider/model")
})

test("whitespace-only or empty instructions are not appended to the directive", async () => {
  for (const instructions of ["", "   "]) {
    const { config } = await apply({ subagentModel: "provider/model", instructions }, { agent: {} })
    assert.ok(promptOf(config, "Manager").endsWith("`general`."))
    assert.equal(promptOf(config, "Manager").includes("   "), false)
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
  assert.equal(permissionOf(config, "Manager").edit, "deny")
  assert.equal((promptOf(config, "Manager").match(/# Orchestrator Mode/g) ?? []).length, 1)
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
  assert.equal(permissionOf(config, "Manager").task, "deny")
  assert.equal(permissionOf(config, "Manager").read, "deny")
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

  await assert.rejects(
    () => OrchestratorPlugin(input, "not-an-object" as unknown as Record<string, unknown>),
    /options.*object/,
  )
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

  assert.ok(promptOf(config, "Manager").includes("hard-blocked for you (none)"))
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

// ─── restrictTask ────────────────────────────────────────────────────────────

test("restrictTask pins task permissions to the routed delegation targets", async () => {
  const { config, logs } = await apply({ subagentModel: "provider/model", restrictTask: true }, { agent: {} })

  assert.deepEqual(permissionOf(config, "Manager").task, {
    "*": "deny",
    general: "allow",
    explore: "allow",
  })
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore"])
})

test("restrictTask preserves unrelated orchestrator permission entries", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", restrictTask: true },
    { agent: { Manager: { mode: "primary", permission: { bash: "ask", webfetch: "allow" } } } },
  )

  assert.deepEqual(config.agent.Manager.permission, {
    bash: "deny",
    webfetch: "allow",
    edit: "deny",
    task: { "*": "deny", general: "allow", explore: "allow" },
  })
})

test("restrictTask warns when overwriting an existing task rule", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", restrictTask: true },
    { agent: { Manager: { mode: "primary", permission: { task: "allow" } } } },
  )

  const overwrite = warnMatching(logs, /Overwriting existing permission for tool "task"/)
  assert.equal(overwrite.length, 1)
  assert.match(overwrite[0].body.message, /restricted delegation rule/)
  assert.deepEqual(permissionOf(config, "Manager").task, {
    "*": "deny",
    general: "allow",
    explore: "allow",
  })
})

test("restrictTask warns when replacing command-scoped task rules", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", restrictTask: true },
    { agent: { Manager: { mode: "primary", permission: { task: { "*": "allow" } } } } },
  )

  const overwrite = warnMatching(logs, /command-scoped/)
  assert.equal(overwrite.length, 1)
  assert.match(overwrite[0].body.message, /tool "task"/)
  assert.deepEqual(permissionOf(config, "Manager").task, {
    "*": "deny",
    general: "allow",
    explore: "allow",
  })
})

test("restrictTask is idempotent when the task rule already matches", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "provider/model", restrictTask: true },
    {
      agent: {
        Manager: {
          mode: "primary",
          permission: { task: { "*": "deny", general: "allow", explore: "allow" } },
        },
      },
    },
  )

  assert.equal(warnMatching(logs, /Overwriting existing permission for tool "task"/).length, 0)
  await hooks.config(config)
  assert.equal(warnMatching(logs, /Overwriting existing permission for tool "task"/).length, 0)
  assert.deepEqual(permissionOf(config, "Manager").task, {
    "*": "deny",
    general: "allow",
    explore: "allow",
  })
})

test("restrictTask defaults to false and leaves an existing task rule untouched", async () => {
  for (const options of [
    { subagentModel: "provider/model" },
    { subagentModel: "provider/model", restrictTask: false },
  ]) {
    const { config } = await apply(options, {
      agent: { Manager: { mode: "primary", permission: { task: { "*": "allow" } } } },
    })

    assert.deepEqual(config.agent.Manager.permission, { task: { "*": "allow" }, edit: "deny", bash: "deny" })
  }
})

test("non-boolean restrictTask is rejected at the factory", async () => {
  for (const restrictTask of ["yes", 1, null]) {
    const { input, logs } = createInput()
    await assert.rejects(
      () => OrchestratorPlugin(input, { subagentModel: "provider/model", restrictTask }),
      /restrictTask/,
    )
    assert.equal(errorLogs(logs).length, 1)
  }
})

// ─── orchestrator default description ────────────────────────────────────────

test("orchestrator gets the default description when created", async () => {
  const { config } = await apply({ subagentModel: "provider/model" }, { agent: {} })

  assert.equal(
    config.agent.Manager.description,
    "Orchestrator agent: decomposes every request and delegates to subagents.",
  )
})

test("orchestrator gets the default description when the existing description is empty", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", description: "" } } },
  )

  assert.equal(
    config.agent.Manager.description,
    "Orchestrator agent: decomposes every request and delegates to subagents.",
  )
})

test("orchestrator keeps an existing non-empty description", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", description: "My custom orchestrator" } } },
  )

  assert.equal(config.agent.Manager.description, "My custom orchestrator")
})

// ─── unexpected-error path ───────────────────────────────────────────────────

test("a non-string orchestrator prompt logs a distinct plugin-bug error without throwing", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", prompt: 42 } } },
  )

  const errors = errorLogs(logs)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].body.service, SERVICE)
  assert.match(errors[0].body.message, /Unexpected error in opencode-agent-tree config hook/)
  assert.match(errors[0].body.message, /plugin bug/)
  assert.ok(errors[0].body.extra?.error instanceof TypeError)
})

test("disabled-orchestrator errors are distinct from unexpected plugin-bug errors", async () => {
  const disabled = await apply({ subagentModel: "provider/model" }, { agent: { Manager: { disable: true } } })
  const unexpected = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", prompt: 42 } } },
  )

  const disabledMessage = errorLogs(disabled.logs)[0].body.message
  const unexpectedMessage = errorLogs(unexpected.logs)[0].body.message
  assert.match(disabledMessage, /orchestrator agent `Manager` is disabled/)
  assert.match(unexpectedMessage, /Unexpected error/)
  assert.notEqual(disabledMessage, unexpectedMessage)
})

// ─── default_agent guard ─────────────────────────────────────────────────────

test("summary log reports (unset) for a non-string default_agent", async () => {
  const { logs } = await apply({ subagentModel: "provider/model" }, { default_agent: 42, agent: {} })

  assert.equal(summaryLog(logs)?.body.extra?.defaultAgent, "(unset)")
})

// ─── model validation ────────────────────────────────────────────────────────

test("model ids with internal whitespace are rejected", async () => {
  for (const subagentModel of ["prov ider/model", "provider/mod el"]) {
    const { input, logs } = createInput()
    await assert.rejects(() => OrchestratorPlugin(input, { subagentModel }), /provider\/model/)
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("model ids with dots, dashes, underscores, and colons are accepted", async () => {
  const { config } = await apply(
    {
      subagentModel: "provider/model",
      orchestratorModel: "provider/claude-sonnet-4-6",
      agentModels: {
        worker: "provider/model_id",
        general: "provider/model:tag",
        explore: "my-provider/my.model",
      },
    },
    {
      agent: {
        worker: { mode: "subagent" },
        general: { mode: "subagent" },
        explore: { mode: "subagent" },
      },
    },
  )

  assert.equal(config.agent.worker.model, "provider/model_id")
  assert.equal(config.agent.general.model, "provider/model:tag")
  assert.equal(config.agent.explore.model, "my-provider/my.model")
  assert.equal(config.agent.Manager.model, "provider/claude-sonnet-4-6")
})

test("subagentModel null is reported as a required-option error", async () => {
  const { input, logs } = createInput()

  await assert.rejects(() => OrchestratorPlugin(input, { subagentModel: null }), /subagentModel.*required/)
  assert.equal(errorLogs(logs).length, 1)
})

test("agents: ['general'] routes only general with no omission or phantom warnings", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", agents: ["general"] },
    { agent: {} },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general"])
  assert.equal(config.agent.general.model, "provider/model")
  assert.equal(config.agent.explore, undefined)
  assert.equal(config.agent.scout, undefined)
  assert.equal(warnMatching(logs, /built-in subagents/).length, 0)
  assert.equal(warnMatching(logs, /unknown name/).length, 0)
})

// ─── coverage gaps: routing and factory validation ──────────────────────────

test("declared agents without a mode are routed by default like subagents", async () => {
  const { config, logs } = await apply({ subagentModel: "provider/model" }, { agent: { worker: {} } })

  assert.equal(config.agent.worker.model, "provider/model")
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore", "worker"])
})

test("empty-string orchestratorAgent is rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", orchestratorAgent: "" }),
    /orchestratorAgent/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("blockedTools as a plain string is rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", blockedTools: "task" }),
    /blockedTools/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("agents entries that are empty strings or non-strings are rejected", async () => {
  for (const agents of [[""], [42], ["general", ""]]) {
    const { input, logs } = createInput()
    await assert.rejects(
      () => OrchestratorPlugin(input, { subagentModel: "provider/model", agents }),
      /agents/,
    )
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("blockedTools entries that are empty strings or non-strings are rejected", async () => {
  for (const blockedTools of [[""], [42], ["edit", ""]]) {
    const { input, logs } = createInput()
    await assert.rejects(
      () => OrchestratorPlugin(input, { subagentModel: "provider/model", blockedTools }),
      /blockedTools/,
    )
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("agentModels: [] is rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", agentModels: [] }),
    /agentModels/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("agentModels with empty-string or non-string values are rejected", async () => {
  for (const agentModels of [{ worker: "" }, { worker: 42 }]) {
    const { input, logs } = createInput()
    await assert.rejects(
      () => OrchestratorPlugin(input, { subagentModel: "provider/model", agentModels }),
      /agentModels values/,
    )
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("instructions: 42 is rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () => OrchestratorPlugin(input, { subagentModel: "provider/model", instructions: 42 }),
    /instructions/,
  )
  assert.equal(errorLogs(logs).length, 1)
})

test("an already-denied blocked tool produces no overwrite warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model" },
    { agent: { Manager: { mode: "primary", permission: { edit: "deny", bash: "deny" } } } },
  )

  assert.equal(warnMatching(logs, /Overwriting existing permission/).length, 0)
  assert.deepEqual(config.agent.Manager.permission, { edit: "deny", bash: "deny" })
})

test("empty blockedTools preserve an existing permission object", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", blockedTools: [] },
    { agent: { Manager: { mode: "primary", permission: { bash: "ask", webfetch: "allow" } } } },
  )

  assert.deepEqual(config.agent.Manager.permission, { bash: "ask", webfetch: "allow" })
  assert.equal(warnMatching(logs, /Overwriting/).length, 0)
})

test("agentModels entries for built-in primary agents are ignored", async () => {
  const { config, logs } = await apply(
    {
      subagentModel: "provider/model",
      agentModels: { build: "x/build", plan: "x/plan", worker: "x/worker" },
    },
    { agent: { worker: { mode: "subagent" } } },
  )

  assert.equal(config.agent.build, undefined)
  assert.equal(config.agent.plan, undefined)
  assert.equal(config.agent.worker.model, "x/worker")
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore", "worker"])
})

test("blocking a non-directive custom tool applies deny with no directive warning", async () => {
  const { config, logs } = await apply(
    { subagentModel: "provider/model", blockedTools: ["custom_tool"] },
    { agent: {} },
  )

  assert.deepEqual(config.agent.Manager.permission, { custom_tool: "deny" })
  assert.equal(warnMatching(logs, /Orchestrator relies on blocked tool/).length, 0)
})

test("subagentModel is trimmed of surrounding whitespace", async () => {
  const { config, logs } = await apply({ subagentModel: "  provider/model  " }, { agent: {} })

  assert.equal(config.agent.general.model, "provider/model")
  assert.equal(config.agent.explore.model, "provider/model")
  const summary = summaryLog(logs)
  assert.ok(summary)
  assert.match(summary.body.message, /subagents -> provider\/model/)
})

// ─── directive/README sync ───────────────────────────────────────────────────

// Extracts the content of the fenced markdown block whose lines include the
// given marker (e.g. the "# Orchestrator Mode" directive in README.md).
const extractFencedBlock = (markdown: string, marker: string): string => {
  const lines = markdown.split("\n")
  const markerIndex = lines.findIndex((line) => line.includes(marker))
  assert.ok(markerIndex >= 0, `expected a fenced block containing "${marker}"`)

  let start = markerIndex
  while (start >= 0 && !/^```/.test(lines[start])) start -= 1
  let end = markerIndex
  while (end < lines.length && !/^```/.test(lines[end])) end += 1
  assert.ok(start >= 0 && end < lines.length, "fenced block must be well-formed")

  return lines.slice(start + 1, end).join("\n")
}

test("rendered directive matches the README fenced block byte-for-byte", async () => {
  const { config } = await apply({ subagentModel: "provider/model" }, { agent: {} })
  const rendered = promptOf(config, "Manager")
  const readmePath = fileURLToPath(new URL("../README.md", import.meta.url))
  const readme = readFileSync(readmePath, "utf8")
  const block = extractFencedBlock(readme, "# Orchestrator Mode (enforced by")

  // Normalize trailing newlines: the rendered directive has none, and the
  // README block may have one before the closing fence. Everything else must
  // match exactly, so a drift in either file fails this test.
  assert.equal(rendered.replace(/\n+$/, ""), block.replace(/\n+$/, ""))
})

// ─── orchestratorDepth ───────────────────────────────────────────────────────

// Hyphenated level names ("Manager-2") cannot use dot access, so read them
// through a dynamic-key helper instead of literal bracket access.
const agentEntry = (config: TestConfig, name: string): TestAgent => config.agent[name]

const descriptionOf = (config: TestConfig, name: string): string => {
  const description = config.agent[name]?.description
  assert.equal(typeof description, "string", `agent "${name}" description should be a string`)
  return description as string
}

const creationLogs = (logs: LogEntry[]) =>
  logs.filter(
    (entry) => entry.body.level === "info" && entry.body.message.startsWith("Creating orchestrator agent"),
  )

test("orchestratorDepth 2 creates a Manager -> Manager-2 chain with structural task pinning", async () => {
  const { config, logs } = await apply(
    {
      subagentModel: "fallback/model",
      orchestratorModel: "orchestrator/model",
      orchestratorDepth: 2,
    },
    { agent: {} },
  )

  assert.equal(config.agent.Manager.mode, "primary")
  assert.equal(agentEntry(config, "Manager-2").mode, "subagent")
  assert.deepEqual(config.agent.Manager.permission, {
    edit: "deny",
    bash: "deny",
    task: { "*": "deny", "Manager-2": "allow" },
  })
  assert.deepEqual(agentEntry(config, "Manager-2").permission, { edit: "deny", bash: "deny" })
  assert.equal(agentEntry(config, "Manager-2").model, "orchestrator/model")
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore"])
  assert.equal(summaryLog(logs)?.body.extra?.orchestratorDepth, 2)
  assert.deepEqual(summaryLog(logs)?.body.extra?.orchestratorLevels, ["Manager", "Manager-2"])

  // Level 1 keeps the level-1 marker exactly; the deeper level gets its own
  // level marker, references the chain, and neither prompt has duplicates.
  const managerPrompt = promptOf(config, "Manager")
  const manager2Prompt = promptOf(config, "Manager-2")
  assert.match(managerPrompt, /# Orchestrator Mode \(enforced by @beremaran\/opencode-agent-tree\)/)
  assert.match(
    manager2Prompt,
    /# Orchestrator Mode \(level 2\/2, enforced by @beremaran\/opencode-agent-tree\)/,
  )
  assert.match(managerPrompt, /ONLY to `Manager-2`/)
  assert.equal((managerPrompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.equal((manager2Prompt.match(/# Orchestrator Mode/g) ?? []).length, 1)
})

test("orchestratorDepth 3 creates a three-level chain; only the final level delegates to workers", async () => {
  const { config, logs } = await apply(
    { subagentModel: "fallback/model", orchestratorDepth: 3 },
    { agent: {} },
  )

  assert.equal(config.agent.Manager.mode, "primary")
  assert.equal(agentEntry(config, "Manager-2").mode, "subagent")
  assert.equal(agentEntry(config, "Manager-3").mode, "subagent")
  assert.deepEqual(permissionOf(config, "Manager").task, { "*": "deny", "Manager-2": "allow" })
  assert.deepEqual(permissionOf(config, "Manager-2").task, { "*": "deny", "Manager-3": "allow" })
  assert.equal(permissionOf(config, "Manager-3").task, undefined)
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore"])

  // Workers keep their tools: the plugin never touches their permission.
  assert.equal(config.agent.general.permission, undefined)
  assert.equal(config.agent.explore.permission, undefined)

  const managerPrompt = promptOf(config, "Manager")
  const manager2Prompt = promptOf(config, "Manager-2")
  const manager3Prompt = promptOf(config, "Manager-3")
  // Level 1 keeps the level-1 header exactly (its body states the level);
  // deeper levels carry their own level marker.
  assert.match(managerPrompt, /# Orchestrator Mode \(enforced by @beremaran\/opencode-agent-tree\)/)
  assert.match(managerPrompt, /level 1 of 3 in a delegation chain/)
  assert.match(manager2Prompt, /# Orchestrator Mode \(level 2\/3, enforced by/)
  assert.match(manager3Prompt, /# Orchestrator Mode \(level 3\/3, enforced by/)
  // Only the final level's directive mentions the worker subagents.
  assert.equal(manager3Prompt.includes("## Default delegation"), true)
  assert.equal(manager3Prompt.includes("`general`"), true)
  assert.equal(managerPrompt.includes("general"), false)
  assert.equal(manager2Prompt.includes("general"), false)
  assert.equal(managerPrompt.includes("explore"), false)
  assert.equal(manager2Prompt.includes("explore"), false)
})

test("orchestratorDepth 2 with restrictTask pins the final level to the routed workers", async () => {
  const { config } = await apply(
    { subagentModel: "fallback/model", orchestratorDepth: 2, restrictTask: true },
    { agent: {} },
  )

  assert.deepEqual(permissionOf(config, "Manager").task, { "*": "deny", "Manager-2": "allow" })
  assert.deepEqual(permissionOf(config, "Manager-2").task, {
    "*": "deny",
    general: "allow",
    explore: "allow",
  })
})

test("orchestrator level names are excluded from routing and never phantom-warned", async () => {
  const { config, logs } = await apply(
    { subagentModel: "fallback/model", orchestratorDepth: 2, agents: ["Manager-2", "worker"] },
    { agent: { worker: { mode: "subagent" } } },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["worker"])
  assert.equal(config.agent.worker.model, "fallback/model")
  assert.equal(warnMatching(logs, /unknown name/).length, 0)
})

test("agentModels entries for orchestrator level names are ignored", async () => {
  const { config, logs } = await apply(
    {
      subagentModel: "fallback/model",
      orchestratorModel: "orchestrator/model",
      orchestratorDepth: 2,
      agentModels: { "Manager-2": "x/y", worker: "special/model" },
    },
    { agent: { worker: { mode: "subagent" } } },
  )

  assert.equal(agentEntry(config, "Manager-2").model, "orchestrator/model")
  assert.equal(config.agent.worker.model, "special/model")
  assert.deepEqual(summaryLog(logs)?.body.extra?.routedAgents, ["general", "explore", "worker"])
})

test("invalid orchestratorDepth values are rejected at the factory", async () => {
  for (const orchestratorDepth of [0, -1, 1.5, "3", null]) {
    const { input, logs } = createInput()
    await assert.rejects(
      () => OrchestratorPlugin(input, { subagentModel: "provider/model", orchestratorDepth }),
      /orchestratorDepth/,
    )
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("re-running the config hook with orchestratorDepth 2 is idempotent", async () => {
  const { config, hooks, logs } = await apply(
    { subagentModel: "fallback/model", orchestratorDepth: 2 },
    { agent: {} },
  )

  await hooks.config(config)

  assert.equal((promptOf(config, "Manager").match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.equal((promptOf(config, "Manager-2").match(/# Orchestrator Mode/g) ?? []).length, 1)
  assert.equal(creationLogs(logs).length, 2)
  assert.equal(warnMatching(logs, /Converting agent/).length, 0)
})

test("a disabled deeper orchestrator level logs an error and applies nothing", async () => {
  const { input, logs } = createInput()
  const hooks = await OrchestratorPlugin(input, {
    subagentModel: "provider/model",
    orchestratorDepth: 2,
  })
  const config: TestConfig = { agent: { "Manager-2": { disable: true } } }

  await hooks.config?.(config as Config)

  const errors = errorLogs(logs)
  assert.equal(errors.length, 1)
  assert.match(errors[0].body.message, /orchestrator agent `Manager-2` is disabled/)
  assert.equal(config.agent.Manager, undefined)
  assert.equal(agentEntry(config, "Manager-2").mode, undefined)
  assert.equal(agentEntry(config, "Manager-2").permission, undefined)
  assert.equal(summaryLog(logs), undefined)
})

test("explicit orchestratorDepth 1 matches the default single-orchestrator behavior", async () => {
  const explicit = await apply({ subagentModel: "provider/model", orchestratorDepth: 1 }, { agent: {} })
  const implicit = await apply({ subagentModel: "provider/model" }, { agent: {} })

  assert.equal(promptOf(explicit.config, "Manager"), promptOf(implicit.config, "Manager"))
  assert.deepEqual(explicit.config.agent.Manager.permission, implicit.config.agent.Manager.permission)
  assert.equal(explicit.config.agent["Manager-2"], undefined)
  assert.equal(summaryLog(explicit.logs)?.body.message, summaryLog(implicit.logs)?.body.message)
  assert.equal(summaryLog(explicit.logs)?.body.extra?.orchestratorDepth, 1)
})

test("custom orchestratorAgent with orchestratorDepth names levels base-2, base-3", async () => {
  const { config, logs } = await apply(
    { subagentModel: "fallback/model", orchestratorAgent: "lead", orchestratorDepth: 2 },
    { agent: {} },
  )

  assert.equal(config.agent.lead.mode, "primary")
  assert.equal(agentEntry(config, "lead-2").mode, "subagent")
  assert.deepEqual(permissionOf(config, "lead").task, { "*": "deny", "lead-2": "allow" })
  assert.deepEqual(summaryLog(logs)?.body.extra?.orchestratorLevels, ["lead", "lead-2"])
})

test("deeper orchestrator levels keep custom descriptions", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 2 },
    { agent: { "Manager-2": { mode: "subagent", description: "Custom level two" } } },
  )

  assert.equal(agentEntry(config, "Manager-2").description, "Custom level two")
})

test("deeper orchestrator levels get a default description when empty", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 2 },
    { agent: { "Manager-2": { mode: "subagent", description: "" } } },
  )

  assert.match(descriptionOf(config, "Manager-2"), /level 2\/2/)
})

test("a user-defined agent matching a deeper level name is taken over as that level", async () => {
  const { config } = await apply(
    {
      subagentModel: "provider/model",
      orchestratorModel: "orchestrator/model",
      orchestratorDepth: 2,
    },
    { agent: { "Manager-2": { mode: "subagent", description: "Existing level two" } } },
  )

  assert.equal(agentEntry(config, "Manager-2").mode, "subagent")
  assert.equal(agentEntry(config, "Manager-2").description, "Existing level two")
  assert.equal(agentEntry(config, "Manager-2").model, "orchestrator/model")
  assert.deepEqual(permissionOf(config, "Manager-2"), { edit: "deny", bash: "deny" })
  assert.match(promptOf(config, "Manager-2"), /# Orchestrator Mode \(level 2\/2/)
})

// ─── orchestratorModels ──────────────────────────────────────────────────────

test("orchestratorModels assigns per-level models with fallback to orchestratorModel", async () => {
  const { config } = await apply(
    {
      subagentModel: "fallback/model",
      orchestratorDepth: 3,
      orchestratorModels: ["a/x", "b/y"],
      orchestratorModel: "c/z",
    },
    { agent: {} },
  )

  assert.equal(config.agent.Manager.model, "a/x")
  assert.equal(agentEntry(config, "Manager-2").model, "b/y")
  assert.equal(agentEntry(config, "Manager-3").model, "c/z")
})

test("orchestratorModels overrides an existing orchestrator model unconditionally", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", orchestratorModels: ["a/x"] },
    { agent: { Manager: { mode: "primary", model: "old/x" } } },
  )

  assert.equal(config.agent.Manager.model, "a/x")
})

test("orchestratorModels partial fallback leaves missing levels unset", async () => {
  const { config } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 2, orchestratorModels: ["a/x"] },
    { agent: {} },
  )

  assert.equal(config.agent.Manager.model, "a/x")
  assert.equal(agentEntry(config, "Manager-2").model, undefined)
})

test("empty orchestratorModels behaves exactly like not provided", async () => {
  const { config } = await apply(
    {
      subagentModel: "provider/model",
      orchestratorDepth: 2,
      orchestratorModels: [],
      orchestratorModel: "c/z",
    },
    { agent: {} },
  )

  assert.equal(config.agent.Manager.model, "c/z")
  assert.equal(agentEntry(config, "Manager-2").model, "c/z")
})

test("invalid orchestratorModels are rejected at the factory", async () => {
  for (const orchestratorModels of ["a/x", ["bad-model"], ["a/x", 42]]) {
    const { input, logs } = createInput()
    await assert.rejects(
      () => OrchestratorPlugin(input, { subagentModel: "provider/model", orchestratorModels }),
      /orchestratorModels/,
    )
    assert.equal(errorLogs(logs).length, 1)
  }
})

test("orchestratorModels longer than orchestratorDepth is rejected at the factory", async () => {
  const { input, logs } = createInput()

  await assert.rejects(
    () =>
      OrchestratorPlugin(input, {
        subagentModel: "provider/model",
        orchestratorDepth: 2,
        orchestratorModels: ["a/x", "b/y", "c/z"],
      }),
    /orchestratorModels.*orchestratorDepth/,
  )
  const error = errorLogs(logs)
  assert.equal(error.length, 1)
  assert.match(error[0].body.message, /has 3 entries but `orchestratorDepth` is 2/)
})

test("summary log reports the effective per-level orchestrator models", async () => {
  const { logs } = await apply(
    {
      subagentModel: "provider/model",
      orchestratorDepth: 2,
      orchestratorModels: ["a/x"],
      orchestratorModel: "c/z",
    },
    { agent: {} },
  )

  assert.deepEqual(summaryLog(logs)?.body.extra?.orchestratorModels, ["a/x", "c/z"])
})

test("summary log reports (default) for unset orchestrator models", async () => {
  const { logs } = await apply({ subagentModel: "provider/model", orchestratorDepth: 2 }, { agent: {} })

  assert.deepEqual(summaryLog(logs)?.body.extra?.orchestratorModels, ["(default)", "(default)"])
})

// ─── subagent_depth warning ──────────────────────────────────────────────────

test("warns when orchestratorDepth exceeds the default subagent_depth of 1", async () => {
  const { logs } = await apply({ subagentModel: "provider/model", orchestratorDepth: 2 }, { agent: {} })

  const warnings = warnMatching(logs, /subagent_depth/)
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0].body.extra, { orchestratorDepth: 2, subagentDepth: 1 })
})

test("no subagent_depth warning when subagent_depth is sufficient", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 2 },
    { subagent_depth: 3, agent: {} },
  )

  assert.equal(warnMatching(logs, /subagent_depth/).length, 0)
})

test("warns when orchestratorDepth 3 exceeds subagent_depth 2", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 3 },
    { subagent_depth: 2, agent: {} },
  )

  const warnings = warnMatching(logs, /subagent_depth/)
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0].body.extra, { orchestratorDepth: 3, subagentDepth: 2 })
})

test("no subagent_depth warning for default orchestratorDepth 1", async () => {
  const { logs } = await apply({ subagentModel: "provider/model" }, { agent: {} })

  assert.equal(warnMatching(logs, /subagent_depth/).length, 0)
})

test("a string subagent_depth is treated as unset for the warning", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 2 },
    { subagent_depth: "3", agent: {} },
  )

  const warnings = warnMatching(logs, /subagent_depth/)
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0].body.extra, { orchestratorDepth: 2, subagentDepth: 1 })
})

test("explicit subagent_depth 0 warns even for orchestratorDepth 1", async () => {
  const { logs } = await apply(
    { subagentModel: "provider/model", orchestratorDepth: 1 },
    { subagent_depth: 0, agent: {} },
  )

  const warnings = warnMatching(logs, /subagent_depth/)
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0].body.extra, { orchestratorDepth: 1, subagentDepth: 0 })
})
