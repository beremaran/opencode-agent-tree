#!/usr/bin/env node
/**
 * Runtime smoke test for @beremaran/opencode-agent-tree.
 *
 * Drives the REAL opencode CLI (installed on this machine) with a temporary
 * fixture project and inspects the served config, validating two assumptions
 * that unit tests can only mock:
 *
 *   (a) Plugin agent entries for built-in subagents (general/explore)
 *       FIELD-MERGE over the built-ins at agent lookup time instead of
 *       replacing them — i.e. the built-in `description`/`prompt` survives
 *       after the plugin injects only `model`. "scout" must NOT be created:
 *       opencode 1.18.12 has no native scout built-in, so any scout entry in
 *       the merged config would be a phantom (regression guard, see below).
 *   (b) `default_agent` from opencode.json reaches the plugin's config hook
 *       (the plugin reads it defensively and logs "(unset)" if absent).
 *
 * How it drives opencode non-interactively (verified against opencode 1.18.12):
 *   - `opencode serve --port 0 --hostname 127.0.0.1` starts a headless HTTP
 *     server. The real port is printed to stdout (`listening on
 *     http://127.0.0.1:PORT`).
 *   - `GET /config` returns the merged effective config (post plugin hooks).
 *   - `GET /agent`  returns the effective agents AT LOOKUP TIME, which is the
 *     only view where the built-in description/prompt merge is observable.
 *
 * Isolation: the fixture runs with `XDG_CONFIG_HOME` pointed at an empty temp
 * dir so plugins installed in the user's global config do not pollute the
 * merged config (observed on this machine).
 *
 * Usage: `npm run test:smoke` (or `node test/smoke.mjs`).
 * Requires the `opencode` CLI on PATH (override with OPENCODE_BIN).
 * Exits non-zero on any failed hard assertion.
 */

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode"

const SUBAGENT_MODEL = "anthropic/claude-haiku-4-5"
const ORCHESTRATOR_MODEL = "anthropic/claude-sonnet-4-5"
const ORCHESTRATOR_AGENT = "Manager"
const DIRECTIVE_MARKER = "# Orchestrator Mode"
// Must mirror src/index.ts BUILTIN_SUBAGENTS. "scout" is intentionally absent:
// opencode 1.18.12 has no native scout agent, so the plugin must not fabricate
// one. The phantom-scout guard below catches a non-native name re-added here.
const BUILTIN_SUBAGENTS = ["general", "explore"]

// Generous but bounded. opencode serve takes a few seconds to boot and the
// plugin config hook runs on first project bootstrap.
const STARTUP_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 500

let passed = 0
let failed = 0
let infos = 0

const fail = (label, detail = "") => {
  failed++
  process.stdout.write(`FAIL ${label}${detail ? ` — ${detail}` : ""}\n`)
}

const pass = (label, detail = "") => {
  passed++
  process.stdout.write(`PASS ${label}${detail ? ` — ${detail}` : ""}\n`)
}

const info = (label, detail = "") => {
  infos++
  process.stdout.write(`[INFO] ${label}${detail ? ` — ${detail}` : ""}\n`)
}

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms))

/** Normalize a model value ("provider/model" or {providerID, modelID}) to "provider/model". */
const modelStr = (model) => {
  if (typeof model === "string") return model
  if (model && typeof model === "object") {
    const provider = model.providerID ?? model.provider
    const id = model.modelID ?? model.model
    if (provider && id) return `${provider}/${id}`
  }
  return String(model ?? "")
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0

const permissionDenies = (permission, tool) => {
  if (Array.isArray(permission)) {
    return permission.some((p) => p && p.permission === tool && p.action === "deny")
  }
  if (permission && typeof permission === "object") {
    return permission[tool] === "deny"
  }
  return false
}

/** Wait for a port to come up, then GET a JSON endpoint with retries. */
async function fetchJsonWithRetry(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${url}: ${lastError?.message ?? "unknown"}`)
}

const main = async () => {
  console.log(`opencode-agent-tree runtime smoke test (node ${process.version})`)
  console.log(`opencode binary: ${OPENCODE_BIN}\n`)

  // ---- Preflight: opencode must exist -------------------------------------
  const versionProbe = await new Promise((resolve_) => {
    const child = spawn(OPENCODE_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (err += c))
    child.on("error", (e) => resolve_({ ok: false, error: e }))
    child.on("close", (code) => resolve_({ ok: code === 0, out: out.trim(), err: err.trim() }))
  })
  if (!versionProbe.ok) {
    fail(
      "[setup] opencode CLI available",
      `could not run \`${OPENCODE_BIN} --version\` (${versionProbe.error?.message ?? versionProbe.err}). ` +
        "Install opencode and re-run, or set OPENCODE_BIN to the binary path.",
    )
    console.log(`\n${passed} passed, ${failed} failed, ${infos} informational`)
    process.exit(1)
  }
  info(`opencode version: ${versionProbe.out}`)

  // ---- Temporary fixture project ------------------------------------------
  const fixtureDir = mkdtempSync(join(tmpdir(), "opencode-agent-tree-smoke-"))
  const xdgHome = mkdtempSync(join(tmpdir(), "opencode-agent-tree-xdg-"))
  mkdirSync(join(xdgHome, "opencode"), { recursive: true })

  const pluginHref = pathToFileURL(join(REPO_ROOT, "src", "index.ts")).href
  const fixtureConfig = {
    $schema: "https://opencode.ai/config.json",
    default_agent: ORCHESTRATOR_AGENT,
    plugin: [[pluginHref, { subagentModel: SUBAGENT_MODEL, orchestratorModel: ORCHESTRATOR_MODEL }]],
  }
  writeFileSync(join(fixtureDir, "opencode.json"), `${JSON.stringify(fixtureConfig, null, 2)}\n`)

  let child = null
  try {
    // ---- Start opencode serve (headless HTTP server) ----------------------
    child = spawn(
      OPENCODE_BIN,
      ["serve", "--port", "0", "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"],
      {
        cwd: fixtureDir,
        env: { ...process.env, XDG_CONFIG_HOME: xdgHome },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group so we can kill the whole tree
      },
    )
    let serverOutput = ""
    let serverError = ""
    let earlyExit = null
    child.stdout.on("data", (c) => (serverOutput += c))
    child.stderr.on("data", (c) => (serverError += c))
    child.on("error", (e) => (earlyExit = e))
    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0)
        earlyExit = { message: `exit code ${code}${signal ? ` (${signal})` : ""}` }
    })
    // `--print-logs` writes logs to stderr; the listening line is on stdout.
    const combinedOutput = () => serverOutput + serverError

    // ---- Discover the real port from the listening line -------------------
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let port = null
    while (Date.now() < deadline) {
      const match = combinedOutput().match(/listening on http:\/\/[^:]+:(\d+)/)
      if (match) {
        port = Number(match[1])
        break
      }
      if (earlyExit) break
      await sleep(POLL_INTERVAL_MS)
    }

    if (!port) {
      throw new Error(
        `opencode serve never reported a listening port (${earlyExit?.message ?? "timeout"}). ` +
          `output tail: ${combinedOutput().slice(-800)}`,
      )
    }
    info(`opencode serve listening on http://127.0.0.1:${port}`)

    const baseUrl = `http://127.0.0.1:${port}`

    // ---- Fetch merged config and effective agents --------------------------
    const config = await fetchJsonWithRetry(`${baseUrl}/config`, STARTUP_TIMEOUT_MS)
    const agents = await fetchJsonWithRetry(`${baseUrl}/agent`, STARTUP_TIMEOUT_MS)

    const agentMap = new Map(agents.map((a) => [a.name, a]))
    const configAgentMap = config.agent ?? {}

    console.log("\n== Merged config (/config) ==")
    console.log(`  default_agent: ${JSON.stringify(config.default_agent)}`)
    console.log(`  agent keys:    ${Object.keys(configAgentMap).join(", ")}`)
    console.log("\n== Effective agents (/agent) ==")
    for (const name of [...BUILTIN_SUBAGENTS, ORCHESTRATOR_AGENT]) {
      const a = agentMap.get(name)
      if (!a) continue
      console.log(
        `  ${name}: mode=${a.mode} model=${modelStr(a.model)} description=${nonEmpty(a.description) ? "yes" : "no"} prompt=${nonEmpty(a.prompt) ? "yes" : "no"}`,
      )
    }
    console.log("")

    // ---- (b) default_agent visibility (informational, non-fatal) ----------
    if (config.default_agent === ORCHESTRATOR_AGENT) {
      info(
        `assumption (b): default_agent reaches config — served /config has default_agent=${JSON.stringify(config.default_agent)}`,
        'plugin\'s config hook therefore logs the value, not "(unset)"',
      )
    } else if (config.default_agent !== undefined) {
      info(
        `assumption (b): default_agent present but unexpected value ${JSON.stringify(config.default_agent)}`,
        `expected ${JSON.stringify(ORCHESTRATOR_AGENT)}`,
      )
    } else {
      info(
        "assumption (b): default_agent ABSENT from served /config",
        'plugin\'s config hook would log "(unset)"',
      )
    }
    const logDefaultAgent = combinedOutput().match(/defaultAgent=(\S+)/)
    if (logDefaultAgent) {
      info(`assumption (b): plugin summary log reported defaultAgent=${logDefaultAgent[1]}`)
    } else {
      info("assumption (b): could not find defaultAgent= in serve log (informational only)")
    }

    // ---- (a) merge-not-replace: built-in subagents -------------------------
    for (const name of BUILTIN_SUBAGENTS) {
      const effective = agentMap.get(name)
      const configEntry = configAgentMap[name]
      if (!effective) {
        fail(`agent "${name}" exists in /agent`)
        continue
      }
      if (modelStr(effective.model) !== SUBAGENT_MODEL) {
        fail(
          `agent "${name}" has plugin-injected model ${SUBAGENT_MODEL}`,
          `got ${modelStr(effective.model)}`,
        )
      } else {
        pass(`agent "${name}" exists with plugin-injected model ${SUBAGENT_MODEL}`)
      }
      if (configEntry === undefined || modelStr(configEntry.model) !== SUBAGENT_MODEL) {
        fail(`agent "${name}" model set in /config`, `got ${JSON.stringify(configEntry)}`)
      } else {
        pass(`agent "${name}" model present in /config`)
      }

      const keptBuiltIn = nonEmpty(effective.description) || nonEmpty(effective.prompt)
      if (keptBuiltIn) {
        pass(
          `agent "${name}" keeps built-in description/prompt after plugin injected only model (merge-not-replace)`,
          `description=${JSON.stringify(effective.description?.slice(0, 60) ?? "")}${nonEmpty(effective.prompt) ? ` prompt=${JSON.stringify(effective.prompt?.slice(0, 40) ?? "")}` : ""}`,
        )
      } else {
        fail(
          `agent "${name}" keeps built-in description/prompt`,
          "neither description nor prompt survived; the plugin entry may have REPLACED the built-in",
        )
      }
    }

    // ---- Regression guard: no phantom "scout" agent ------------------------
    // opencode 1.18.12 has NO native "scout" agent (verified: `opencode debug
    // agent scout` -> "Agent scout not found"). The plugin must not fabricate a
    // scout entry. This inverts the old model-injection check: if someone
    // re-adds a non-native name to BUILTIN_SUBAGENTS in src/index.ts, a phantom
    // scout appears in /config or /agent and this test fails.
    const phantomScoutInConfig = configAgentMap.scout !== undefined
    const phantomScoutInAgents = agentMap.has("scout")
    if (phantomScoutInConfig || phantomScoutInAgents) {
      fail(
        'no phantom "scout" agent (scout is not native in opencode 1.18.12)',
        `scout present in /config=${phantomScoutInConfig}, /agent=${phantomScoutInAgents} — ` +
          "a non-native name was added to BUILTIN_SUBAGENTS",
      )
    } else {
      pass('no phantom "scout" agent (scout is not native in opencode 1.18.12)')
    }

    // ---- Orchestrator agent (Manager) --------------------------------------
    const cfgManager = configAgentMap[ORCHESTRATOR_AGENT]
    if (cfgManager === undefined) {
      fail(`agent "${ORCHESTRATOR_AGENT}" exists in /config`)
    } else {
      pass(`agent "${ORCHESTRATOR_AGENT}" exists in /config`)
      const checks = [
        [cfgManager.mode === "primary", 'mode === "primary"'],
        [nonEmpty(cfgManager.description), "non-empty description"],
        [
          nonEmpty(cfgManager.prompt) && cfgManager.prompt.includes(DIRECTIVE_MARKER),
          `prompt contains "${DIRECTIVE_MARKER}"`,
        ],
        [permissionDenies(cfgManager.permission, "edit"), 'permission.edit === "deny"'],
        [permissionDenies(cfgManager.permission, "bash"), 'permission.bash === "deny"'],
        [modelStr(cfgManager.model) === ORCHESTRATOR_MODEL, `model === ${ORCHESTRATOR_MODEL}`],
      ]
      for (const [ok, label] of checks) {
        if (ok) pass(`agent "${ORCHESTRATOR_AGENT}" (config) ${label}`)
        else fail(`agent "${ORCHESTRATOR_AGENT}" (config) ${label}`, `got ${JSON.stringify(cfgManager)}`)
      }
    }

    const effManager = agentMap.get(ORCHESTRATOR_AGENT)
    if (!effManager) {
      fail(`agent "${ORCHESTRATOR_AGENT}" exists in /agent`)
    } else {
      pass(`agent "${ORCHESTRATOR_AGENT}" exists in /agent`)
      const checks = [
        [effManager.mode === "primary", 'mode === "primary"'],
        [nonEmpty(effManager.description), "non-empty description"],
        [
          nonEmpty(effManager.prompt) && effManager.prompt.includes(DIRECTIVE_MARKER),
          `prompt contains "${DIRECTIVE_MARKER}"`,
        ],
        [permissionDenies(effManager.permission, "edit"), "effective permission denies edit"],
        [permissionDenies(effManager.permission, "bash"), "effective permission denies bash"],
        [modelStr(effManager.model) === ORCHESTRATOR_MODEL, `model === ${ORCHESTRATOR_MODEL}`],
      ]
      for (const [ok, label] of checks) {
        if (ok) pass(`agent "${ORCHESTRATOR_AGENT}" (effective) ${label}`)
        else fail(`agent "${ORCHESTRATOR_AGENT}" (effective) ${label}`, `got ${JSON.stringify(effManager)}`)
      }
    }

    // ---- Evidence excerpts for the report ----------------------------------
    console.log("\n== Evidence ==")
    for (const name of ["general", "explore"]) {
      const a = agentMap.get(name)
      if (a) {
        console.log(`  ${name}: model=${modelStr(a.model)}`)
        if (nonEmpty(a.description))
          console.log(`    description: ${JSON.stringify(a.description.slice(0, 120))}...`)
        if (nonEmpty(a.prompt)) console.log(`    prompt:      ${JSON.stringify(a.prompt.slice(0, 80))}...`)
      }
    }
    const scoutEffective = agentMap.get("scout")
    if (scoutEffective || configAgentMap.scout !== undefined) {
      console.log(
        `  scout: PRESENT (agent=${scoutEffective !== undefined}, config=${configAgentMap.scout !== undefined}) — phantom agent detected`,
      )
    } else {
      console.log("  scout: absent from /agent and /config (no phantom entry)")
    }
    const mgr = agentMap.get(ORCHESTRATOR_AGENT)
    if (mgr) {
      console.log(`  Manager: model=${modelStr(mgr.model)} mode=${mgr.mode}`)
      if (nonEmpty(mgr.description))
        console.log(`    description: ${JSON.stringify(mgr.description.slice(0, 120))}...`)
      if (nonEmpty(mgr.prompt)) console.log(`    prompt:      ${JSON.stringify(mgr.prompt.slice(0, 80))}...`)
      const editRule = Array.isArray(mgr.permission)
        ? mgr.permission.find((p) => p.permission === "edit")
        : undefined
      const bashRule = Array.isArray(mgr.permission)
        ? mgr.permission.find((p) => p.permission === "bash")
        : undefined
      console.log(
        `    permission.edit=${JSON.stringify(editRule?.action ?? cfgManager?.permission?.edit)} permission.bash=${JSON.stringify(bashRule?.action ?? cfgManager?.permission?.bash)}`,
      )
    }
  } finally {
    // ---- Guaranteed cleanup: kill the server, remove the fixtures ----------
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM") // kill the whole detached process group
      } catch {
        /* already gone */
      }
      await sleep(400)
      try {
        if (child.exitCode === null) process.kill(-child.pid, "SIGKILL")
      } catch {
        /* already gone */
      }
      try {
        if (child.exitCode === null) process.kill(child.pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true })
    rmSync(xdgHome, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed, ${infos} informational`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(`\nFATAL ${error?.stack ?? error}`)
  process.exitCode = 1
})
