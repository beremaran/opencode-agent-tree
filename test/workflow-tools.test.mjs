import assert from "node:assert/strict"
import test from "node:test"

import { createWorkflowTools } from "../src/workflow/tools.ts"

const spec = { version: 1, name: "demo", steps: [{ id: "one", type: "agent", agent: "worker", prompt: "Do it." }] }

const fixture = (approval = "always") => {
  const calls = []
  const runs = new Map()
  const scheduler = {
    async start(input) {
      calls.push(["start", input])
      const run = { runId: "run-1", status: "queued" }
      runs.set(run.runId, run)
      return run
    },
    async wait(runId) {
      calls.push(["wait", runId])
      return { runId, status: "completed" }
    },
    async progress(runId) {
      calls.push(["progress", runId])
      return { runId, status: "completed" }
    },
    async result(runId) {
      calls.push(["result", runId])
      return { ok: true }
    },
    async list() {
      calls.push(["list"])
      return [...runs.values()]
    },
    async cancel(runId) {
      calls.push(["cancel", runId])
      return { runId, status: "canceled" }
    },
    async resume(runId, options) {
      calls.push(["resume", runId, options])
      return { runId, status: options.wait ? "completed" : "running" }
    },
  }
  const store = {
    async loadWorkflow(name) {
      calls.push(["loadWorkflow", name])
      return spec
    },
    async saveWorkflow(name, value, scope) {
      calls.push(["saveWorkflow", name, value, scope])
    },
    async listWorkflows() {
      calls.push(["listWorkflows"])
      return [{ name: "demo", source: "project", path: "/project/demo.json", spec }]
    },
  }
  const tools = createWorkflowTools({
    services: async () => ({ scheduler, store }),
    defaultModel: () => "openai/gpt-5.6-luna",
    parentExecution: () => ({ agent: "orchestrator", model: "openai/gpt-5.6-luna", variant: "high" }),
    approval,
    limits: () => ({ maxParallel: 3, maxAgents: 8, maxIterations: 5 }),
  })
  const approvals = []
  const metadata = []
  const context = {
    sessionID: "parent",
    messageID: "message",
    agent: "orchestrator",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: (value) => metadata.push(value),
    ask: async (value) => approvals.push(value),
  }
  return { tools, calls, approvals, metadata, context }
}

test("workflow_start approves and starts an inline workflow in the background", async () => {
  const f = fixture()
  const result = await f.tools.workflow_start.execute({ spec, input: { issue: 42 } }, f.context)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.approvals[0].permission, "workflow")
  assert.deepEqual(f.approvals[0].metadata.agents, ["worker"])
  assert.deepEqual(f.approvals[0].metadata.effectiveLimits, {
    maxParallel: 3,
    maxAgents: 8,
    maxIterations: 5,
    maxTokens: undefined,
    maxCost: undefined,
    deadline: undefined,
  })
  assert.match(f.approvals[0].metadata.childPermissions, /--auto is not inherited/)
  const start = f.calls.find(([name]) => name === "start")[1]
  assert.equal(start.parentSessionID, "parent")
  assert.equal(start.parentAgent, "orchestrator")
  assert.equal(start.parentModel, "openai/gpt-5.6-luna")
  assert.equal(start.parentVariant, "high")
  assert.equal(start.notifyParent, true)
  assert.equal(start.defaultModel, "openai/gpt-5.6-luna")
  assert.deepEqual(start.input, { issue: 42 })
  assert.equal(result.metadata.runId, "run-1")
  assert.match(result.output, /background/)
})

test("workflow_start loads a saved workflow and can wait for completion", async () => {
  const f = fixture("never")
  const result = await f.tools.workflow_start.execute({ name: "demo", wait: true }, f.context)
  assert.equal(f.approvals.length, 0)
  assert.deepEqual(f.calls[0], ["loadWorkflow", "demo"])
  assert.equal(f.calls.find(([name]) => name === "start")[1].notifyParent, false)
  assert.ok(f.calls.some(([name]) => name === "wait"))
  assert.match(result.output, /"ok": true/)
})

test("workflow_start requires exactly one source", async () => {
  const f = fixture()
  await assert.rejects(() => f.tools.workflow_start.execute({}, f.context), /exactly one/)
  await assert.rejects(() => f.tools.workflow_start.execute({ spec, name: "demo" }, f.context), /exactly one/)
})

test("workflow tool guidance documents strict schemas, supported limits, and exclusive sources", () => {
  const f = fixture()
  for (const name of ["workflow_start", "workflow_save"]) {
    const description = f.tools[name].description
    assert.match(description, /exactly one source: spec or name/)
    assert.match(description, /complete JSON Schema object with a required type/)
    assert.match(description, /maxParallel, maxAgents, maxIterations, maxTokens, maxCost, and deadline/)
    assert.match(description, /maxSteps and maxDurationMin are not supported/)
    assert.match(description, /validates it locally/)
    assert.match(description, /input uses raw tokens such as \["audits"\]/)
    assert.match(description, /Default allowed agents are general, explore, and worker/)
  }
})

test("management tools delegate status, result, cancel, and resume", async () => {
  const f = fixture("never")
  await f.tools.workflow_status.execute({}, f.context)
  await f.tools.workflow_status.execute({ runId: "run-1" }, f.context)
  await f.tools.workflow_result.execute({ runId: "run-1" }, f.context)
  await f.tools.workflow_cancel.execute({ runId: "run-1" }, f.context)
  await f.tools.workflow_resume.execute({ runId: "run-1", wait: false }, f.context)
  for (const name of ["list", "progress", "result", "cancel", "resume"]) {
    assert.ok(f.calls.some(([called]) => called === name), `missing ${name}`)
  }
})

test("saved workflow tools preserve scope and omit specs from listings", async () => {
  const f = fixture("never")
  await f.tools.workflow_save.execute({ name: "demo", spec, scope: "personal" }, f.context)
  const result = await f.tools.workflow_list_saved.execute({}, f.context)
  assert.ok(f.calls.some(([name, workflow, , scope]) => name === "saveWorkflow" && workflow === "demo" && scope === "personal"))
  assert.doesNotMatch(result.output, /"steps"/)
  assert.match(result.output, /\/project\/demo.json/)
})
