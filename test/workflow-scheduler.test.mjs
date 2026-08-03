import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { WorkflowStore } from "../src/workflow/store.ts"
import {
  WorkflowLimitError,
  WorkflowScheduler,
} from "../src/workflow/scheduler.ts"
import { SessionBackendError, SessionRunError } from "../src/workflow/backend.ts"

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const abort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    }
  })

const waitUntil = async (predicate, timeoutMs = 1000) => {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not reached before timeout")
    await wait(5)
  }
}

class FakeBackend {
  created = []
  runs = []
  released = []
  cancelled = []
  active = 0
  maxActive = 0
  sequence = 0
  promptAttempts = new Map()

  async createSession(input) {
    const sessionID = `child-${++this.sequence}`
    const handle = {
      sessionID,
      directory: input.worktree ? `/tmp/${sessionID}` : "/project",
      worktree: input.worktree ? { name: sessionID, directory: `/tmp/${sessionID}` } : undefined,
    }
    this.created.push({ input, handle })
    return handle
  }

  async run(input) {
    this.runs.push(input)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    const attempts = (this.promptAttempts.get(input.prompt) ?? 0) + 1
    this.promptAttempts.set(input.prompt, attempts)
    try {
      const delay = Number(input.prompt.match(/^DELAY:(\d+):/)?.[1] ?? 0)
      if (delay) await wait(delay, input.signal)
      if (input.prompt.startsWith("FAIL_ONCE:") && attempts === 1) throw new Error("transient")
      if (input.prompt.startsWith("FAIL:")) throw new Error(input.prompt.slice(5))
      let text = input.prompt
      let structured
      const body = input.prompt.replace(/^DELAY:\d+:/, "").replace(/^FAIL_ONCE:/, "")
      if (body.startsWith("JSON:")) {
        structured = JSON.parse(body.slice(5))
        text = JSON.stringify(structured)
      } else if (body === "COUNT") {
        structured = { n: attempts }
        text = JSON.stringify(structured)
      } else if (body.startsWith("VALUE:")) {
        text = body.slice(6)
      }
      return {
        sessionID: input.sessionID,
        text,
        structured,
        cost: 0.25,
        tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
        files: input.prompt.includes("EDIT") ? ["src/edited.ts"] : [],
      }
    } finally {
      this.active -= 1
    }
  }

  async cancel(sessionID) {
    this.cancelled.push(sessionID)
  }

  async releaseSession(handle) {
    this.released.push(typeof handle === "string" ? handle : handle.sessionID)
  }

  async dispose() {}
}

const fixture = async (options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-tree-scheduler-"))
  const store = new WorkflowStore({ root })
  await store.init()
  const backend = options.backend ?? new FakeBackend()
  const scheduler = new WorkflowScheduler({
    store,
    backend,
    defaultAgent: "worker",
    defaultModel: "openai/gpt-5.6-luna",
    ...options,
  })
  return {
    root,
    store,
    backend,
    scheduler,
    cleanup: async () => {
      await scheduler.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const leaf = (id, prompt, extra = {}) => ({ id, type: "agent", agent: "worker", prompt, ...extra })

test("executes a sequence with structured input and returns the final result", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    input: { name: "Ada" },
    spec: {
      version: 1,
      name: "sequence",
      steps: [
        leaf("first", "VALUE:{{ input.name }}"),
        leaf("second", "VALUE:hello {{ first }}"),
      ],
    },
  })
  assert.equal(record.status, "completed")
  assert.equal(await f.scheduler.result(record.runId), "hello Ada")
  assert.equal(f.backend.created.length, 2)
  assert.deepEqual(f.backend.created[0].input.model, "openai/gpt-5.6-luna")
  assert.equal(f.backend.released.length, 2)
})

test("runs parallel children under the requested and global concurrency caps", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxParallel: 2, maxAgents: 10 },
      steps: [{
        id: "fanout",
        type: "parallel",
        maxParallel: 2,
        steps: [leaf("a", "DELAY:150:VALUE:a"), leaf("b", "DELAY:150:VALUE:b"), leaf("c", "DELAY:150:VALUE:c")],
      }],
    },
  })
  assert.equal(record.status, "completed")
  assert.deepEqual(await f.scheduler.result(record.runId), ["a", "b", "c"])
  assert.equal(f.backend.maxActive, 2)
})

test("orders parallel siblings when a prompt references another sibling", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxParallel: 2 },
      steps: [{
        id: "fanout",
        type: "parallel",
        steps: [leaf("producer", "VALUE:ready"), leaf("consumer", "VALUE:{{ producer }}")],
      }],
    },
  })
  assert.equal(record.status, "completed")
  assert.deepEqual(await f.scheduler.result(record.runId), ["ready", "ready"])
  assert.deepEqual(f.backend.runs.map((run) => run.prompt), ["VALUE:ready", "VALUE:ready"])
})

test("maps dynamic items with stable per-instance persistence and aggregation", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxParallel: 3, maxAgents: 10, maxIterations: 5 },
      steps: [
        leaf("discover", 'JSON:{"items":[1,2,3]}', { outputSchema: { type: "object" } }),
        {
          id: "mapped",
          type: "map",
          over: "discover.items",
          as: "item",
          maxParallel: 2,
          steps: [leaf("process", 'JSON:{"n":{{ item }}}', { outputSchema: { type: "object" }, isolation: true })],
        },
        { id: "summary", type: "synthesize", agent: "general", prompt: "VALUE:{{ process }}" },
      ],
    },
  })
  assert.equal(record.status, "completed")
  const loaded = await f.store.loadRun(record.runId)
  assert.ok(loaded.nodes["mapped~i0~process"])
  assert.ok(loaded.nodes["mapped~i1~process"])
  assert.ok(loaded.nodes["mapped~i2~process"])
  assert.equal(f.backend.created.filter((entry) => entry.input.worktree).length, 3)
  assert.equal(await f.scheduler.result(record.runId), '[{"n":1},{"n":2},{"n":3}]')
})

test("serially integrates changed isolated worktrees before completing", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxAgents: 3 },
      steps: [leaf("edit", "VALUE:EDIT completed", { isolation: true })],
    },
  })
  assert.equal(record.status, "completed")
  assert.equal(f.backend.created.length, 2)
  assert.equal(f.backend.created[0].input.worktree, true)
  assert.equal(f.backend.created[1].input.worktree, false)
  assert.match(f.backend.runs[1].prompt, /Integrate changes produced/)
  assert.match(f.backend.runs[1].prompt, /src\/edited\.ts/)
  assert.equal(f.backend.released.filter((id) => id === "child-1").length, 1)
  assert.equal(await f.scheduler.result(record.runId), "EDIT completed")
})

test("selects the first matching branch and ignores other cases", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      steps: [
        leaf("classify", 'JSON:{"kind":"bug"}', { outputSchema: { type: "object" } }),
        {
          id: "route",
          type: "branch",
          cases: [
            { id: "bug", when: { $eq: [{ $ref: "classify.kind" }, "bug"] }, steps: [leaf("fix", "VALUE:fixed")] },
            { id: "docs", when: { $eq: [{ $ref: "classify.kind" }, "docs"] }, steps: [leaf("write", "VALUE:wrote")] },
          ],
          otherwise: [leaf("skip", "VALUE:skipped")],
        },
      ],
    },
  })
  assert.equal(record.status, "completed")
  assert.equal(await f.scheduler.result(record.runId), "fixed")
  assert.equal(f.backend.runs.some((run) => run.prompt === "VALUE:wrote"), false)
})

test("loops until a body result satisfies the post-body condition", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxIterations: 5, maxAgents: 10 },
      steps: [{
        id: "retry-loop",
        type: "loop",
        maxIterations: 4,
        until: { $gte: [{ $ref: "counter.n" }, 3] },
        steps: [leaf("counter", "COUNT", { outputSchema: { type: "object" } })],
      }],
    },
  })
  assert.equal(record.status, "completed")
  assert.deepEqual(await f.scheduler.result(record.runId), [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test("fails rather than silently truncating loop inputs or unmet conditions", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const tooMany = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxIterations: 2, maxAgents: 5 },
      steps: [
        leaf("items", 'JSON:{"values":[1,2,3]}', { outputSchema: { type: "object" } }),
        { id: "loop", type: "loop", over: "items.values", as: "item", steps: [leaf("use", "VALUE:{{ item }}")] },
      ],
    },
  })
  assert.equal(tooMany.status, "failed")
  assert.match(tooMany.error, /exceeding maxIterations 2/)

  const unmet = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxIterations: 2, maxAgents: 3 },
      steps: [{
        id: "loop",
        type: "loop",
        until: { $gte: [{ $ref: "counter.n" }, 9] },
        steps: [leaf("counter", "COUNT", { outputSchema: { type: "object" } })],
      }],
    },
  })
  assert.equal(unmet.status, "failed")
  assert.match(unmet.error, /did not satisfy/)
})

test("retries failures in fresh sessions and records all sessions", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, limits: { maxAgents: 3 }, steps: [leaf("flaky", "FAIL_ONCE:VALUE:ok", { retry: 1 })] },
  })
  assert.equal(record.status, "completed")
  assert.equal(f.backend.created.length, 2)
  const loaded = await f.store.loadRun(record.runId)
  assert.equal(loaded.sessions.length, 2)
  assert.equal(loaded.nodes.flaky.attempts, 2)
})

test("enforces maxAgents including retry attempts", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, limits: { maxAgents: 1 }, steps: [leaf("flaky", "FAIL_ONCE:VALUE:ok", { retry: 1 })] },
  })
  assert.equal(record.status, "failed")
  assert.match(record.error, /maxAgents 1/)
})

test("stops after a token budget and reports bounded overshoot", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, limits: { maxTokens: 5 }, steps: [leaf("expensive", "VALUE:done")] },
  })
  assert.equal(record.status, "failed")
  assert.match(record.error, /maxTokens 5/)
  assert.match(record.error, /bounded overshoot/)
  assert.equal(record.usage.tokensIn + record.usage.tokensOut, 6)
})

test("enforces cost budgets, expired deadlines, and a configured default step timeout", async (t) => {
  const f = await fixture({ defaultStepTimeoutMs: 321 })
  t.after(f.cleanup)
  const costly = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, limits: { maxCost: 0.2 }, steps: [leaf("costly", "VALUE:done")] },
  })
  assert.equal(costly.status, "failed")
  assert.match(costly.error, /maxCost 0.2/)
  assert.equal(f.backend.runs[0].timeoutMs, 321)

  const expired = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { deadline: "2000-01-01T00:00:00Z" },
      steps: [leaf("never", "VALUE:never")],
    },
  })
  assert.equal(expired.status, "failed")
  assert.match(expired.error, /deadline has passed/)
  assert.equal(f.backend.runs.some((run) => run.prompt === "VALUE:never"), false)
})

test("cancels a running workflow and releases the active session", async (t) => {
  const events = []
  const f = await fixture({ onEvent: (event) => events.push(event) })
  t.after(f.cleanup)
  const started = await f.scheduler.start({
    parentSessionID: "parent",
    spec: { version: 1, steps: [leaf("slow", "DELAY:200:VALUE:late")] },
  })
  await waitUntil(() => f.backend.created.length > 0)
  const record = await f.scheduler.cancel(started.runId)
  assert.equal(record.status, "canceled")
  assert.ok(events.some((event) => event.type === "run.canceled"))
  assert.equal(events.some((event) => event.type === "run.failed"), false)
  assert.ok(f.backend.cancelled.length >= 1)
  assert.ok(f.backend.released.length >= 1)
})

test("aborts and joins parallel siblings after the first terminal failure", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: {
      version: 1,
      steps: [{
        id: "work",
        type: "parallel",
        steps: [leaf("broken", "FAIL:boom"), leaf("slow", "DELAY:200:VALUE:late")],
      }],
    },
  })

  assert.equal(record.status, "failed")
  const persisted = await f.store.loadRun(record.runId)
  assert.notEqual(persisted.nodes["work~slow"].status, "completed")
  assert.equal(persisted.nodes.work.status, "failed")
  assert.equal(f.backend.active, 0)
})

test("does not retry permanent backend configuration errors", async (t) => {
  class PermanentFailureBackend extends FakeBackend {
    async run(input) {
      this.runs.push(input)
      throw new SessionBackendError("session.promptAsync is unavailable")
    }
  }
  const backend = new PermanentFailureBackend()
  const f = await fixture({ backend })
  t.after(f.cleanup)

  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, steps: [leaf("one", "VALUE:no", { retry: 3 })] },
  })

  assert.equal(record.status, "failed")
  assert.equal(backend.runs.length, 1)
})

test("does not retry permanent session run errors", async (t) => {
  class MissingSessionBackend extends FakeBackend {
    async run(input) {
      this.runs.push(input)
      throw new SessionRunError("SessionNotFoundError", "missing child session")
    }
  }
  const backend = new MissingSessionBackend()
  const f = await fixture({ backend })
  t.after(f.cleanup)

  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, steps: [leaf("one", "VALUE:no", { retry: 3 })] },
  })

  assert.equal(record.status, "failed")
  assert.equal(backend.runs.length, 1)
})

test("resumes a canceled parallel run without rerunning completed leaf instances", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const started = await f.scheduler.start({
    parentSessionID: "parent",
    spec: {
      version: 1,
      limits: { maxParallel: 2, maxAgents: 6 },
      steps: [{
        id: "work",
        type: "parallel",
        steps: [leaf("quick", "DELAY:5:VALUE:quick"), leaf("slow", "DELAY:150:VALUE:slow")],
      }],
    },
  })
  await waitUntil(() => f.backend.runs.some((run) => run.prompt === "DELAY:5:VALUE:quick"))
  await waitUntil(async () => {
    const record = await f.store.loadRun(started.runId)
    return record?.nodes["work~quick"]?.status === "completed"
  })
  await f.scheduler.cancel(started.runId)
  const quickRuns = () => f.backend.runs.filter((run) => run.prompt === "DELAY:5:VALUE:quick").length
  assert.equal(quickRuns(), 1)
  const resumed = await f.scheduler.resume(started.runId)
  assert.equal(resumed.status, "completed")
  assert.equal(quickRuns(), 1)
  assert.deepEqual(await f.scheduler.result(started.runId), ["quick", "slow"])
})

test("exposes progress, listing, and durable usage", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const record = await f.scheduler.execute({
    parentSessionID: "parent",
    spec: { version: 1, name: "observed", steps: [leaf("one", "VALUE:ok")] },
  })
  const progress = await f.scheduler.progress(record.runId)
  assert.equal(progress.status, "completed")
  assert.equal(progress.completed, 1)
  assert.equal(progress.total, 1)
  assert.equal(progress.usage.cost, 0.25)
  const persisted = await f.store.loadRun(record.runId)
  assert.deepEqual(persisted.nodes.one.usage, persisted.usage, "result persistence must not double-count node usage")
  assert.equal((await f.scheduler.list()).some((run) => run.runId === record.runId), true)
})

test("rejects invocation input fields that would persist secrets", async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await assert.rejects(
    () => f.scheduler.start({
      parentSessionID: "parent",
      input: { apiKey: "do-not-store" },
      spec: { version: 1, steps: [leaf("one", "VALUE:ok")] },
    }),
    /secret-bearing field/,
  )
})

test("dispose cancels owned runs and prevents new starts", async (t) => {
  const f = await fixture()
  t.after(async () => rm(f.root, { recursive: true, force: true }))
  const started = await f.scheduler.start({
    parentSessionID: "parent",
    spec: { version: 1, steps: [leaf("slow", "DELAY:200:VALUE:late")] },
  })
  await wait(10)
  await f.scheduler.dispose()
  assert.equal((await f.store.loadRun(started.runId)).status, "canceled")
  await assert.rejects(
    () => f.scheduler.start({ parentSessionID: "x", spec: { version: 1, steps: [leaf("x", "VALUE:x")] } }),
    /disposed/,
  )
})
