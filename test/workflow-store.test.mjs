import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile, appendFile, stat } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

import { WorkflowStore, encodeResultKey } from "../src/workflow/store.ts"
import * as S from "../src/workflow/state.ts"
import { validateWorkflowSpec, WorkflowValidationError } from "../src/workflow/schema.ts"

const makeSpec = (overrides = {}) => ({
  version: 1,
  name: "demo",
  description: "A demo workflow",
  steps: [
    { id: "gather", type: "agent", agent: "explore", prompt: "Research the topic." },
  ],
  ...overrides,
})

const SPEC_JSON = (overrides = {}) => JSON.parse(JSON.stringify(makeSpec(overrides)))

const withStore = async (t, options = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wf-store-"))
  const store = new WorkflowStore({ root, ...options })
  await store.init()
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return { store, root }
}

const journalLines = async (root, runId) => {
  const raw = await readFile(path.join(root, "runs", runId, "events.jsonl"), "utf8")
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
}

const collectFilenames = async (dir) => {
  const names = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else names.push(entry.name)
    }
  }
  await walk(dir)
  return names
}

test("creates, lists, loads, and updates runs", async (t) => {
  const { store, root } = await withStore(t)
  assert.deepEqual(await store.listRuns(), [])

  const run = await store.createRun({
    instanceId: "inst-1",
    workflow: "demo",
    fingerprint: "fp-1",
    spec: makeSpec(),
    metadata: { owner: "scheduler" },
  })
  assert.match(run.runId, /^[0-9a-f]{32}$/)
  assert.equal(run.status, "queued")
  assert.equal(run.seq, 1)
  assert.equal(run.instanceId, "inst-1")
  assert.equal(run.workflow, "demo")
  assert.equal(run.fingerprint, "fp-1")
  assert.deepEqual(run.metadata, { owner: "scheduler" })
  assert.equal(run.specPath, `runs/${run.runId}/spec.json`)
  assert.equal(run.nodes.gather, undefined)

  const listed = await store.listRuns()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].runId, run.runId)
  assert.equal(listed[0].status, "queued")
  assert.equal(listed[0].seq, 1)

  const expectedSpec = validateWorkflowSpec(SPEC_JSON()).spec
  assert.deepEqual(await store.loadSpec(run.runId), expectedSpec)
  await store.saveContext(run.runId, { parentSessionID: "parent", input: { issue: 42 } })
  assert.deepEqual(await store.loadContext(run.runId), { parentSessionID: "parent", input: { issue: 42 } })
  await assert.rejects(
    () => store.saveContext(run.runId, { parentSessionID: "other" }),
    S.ImmutableSpecError,
  )

  const updated = await store.updateRun(run.runId, { status: "running", resumeToken: "tok-1" })
  assert.equal(updated.status, "running")
  assert.equal(updated.seq, 2)
  assert.equal(updated.resumeToken, "tok-1")
  assert.ok(updated.startedAt)

  const reloaded = await store.loadRun(run.runId)
  assert.equal(reloaded.status, "running")
  assert.equal(reloaded.seq, 2)
  assert.equal(reloaded.resumeToken, "tok-1")

  assert.equal(await store.loadRun("f".repeat(32)), null)
  await assert.rejects(() => store.updateRun("f".repeat(32), { status: "running" }), S.NotFoundError)
  await assert.rejects(() => store.appendEvents("f".repeat(32), []), S.NotFoundError)
  await assert.rejects(
    () => store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: { version: 2, steps: [] } }),
    WorkflowValidationError,
  )

  assert.equal((await journalLines(root, run.runId)).length, 2)
})

test("tracks status, usage, node, and session state through the journal", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: makeSpec() })

  await store.updateRun(run.runId, { status: "running", usage: { tokensIn: 10, cost: 0.5 } })
  await store.updateRun(run.runId, {
    session: { sessionId: "s1", agent: "explore", model: "m/1", status: "open", startedAt: "2026-01-01T00:00:00.000Z" },
  })
  await store.updateRun(run.runId, {
    node: { instanceKey: "gather", node: { instanceKey: "gather", stepId: "gather", status: "running", sessionId: "s1", attempts: 1, usage: { tokensIn: 10 } } },
  })
  await store.updateRun(run.runId, {
    session: { sessionId: "s1", agent: "explore", model: "m/1", status: "closed", endedAt: "2026-01-01T01:00:00.000Z" },
  })
  await store.updateRun(run.runId, {
    result: { instanceKey: "gather", stepId: "gather", value: "done", usage: { tokensOut: 5 } },
  })
  await store.updateRun(run.runId, { status: "failed", error: "boom" })

  const rec = await store.loadRun(run.runId)
  assert.equal(rec.status, "failed")
  assert.equal(rec.error, "boom")
  assert.ok(rec.startedAt)
  assert.ok(rec.finishedAt)
  assert.deepEqual(rec.usage, { tokensIn: 10, cost: 0.5 })
  assert.equal(rec.sessions.length, 1, "session upserts, it does not duplicate")
  assert.equal(rec.sessions[0].sessionId, "s1")
  assert.equal(rec.sessions[0].status, "closed")
  assert.equal(rec.sessions[0].endedAt, "2026-01-01T01:00:00.000Z")
  assert.equal(
    rec.nodes.gather.outputRef,
    `runs/${run.runId}/results/${encodeResultKey("gather")}.json`,
  )
  assert.equal(rec.nodes.gather.status, "completed")
  assert.deepEqual(rec.nodes.gather.usage, { tokensIn: 10, tokensOut: 5 })
  assert.deepEqual(await store.loadResult(run.runId, "gather"), "done")
  assert.equal(await store.loadResult(run.runId, "missing-step"), null)
})

test("file writes are atomic and the spec stays immutable", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "inst", workflow: "w", fingerprint: "fp", spec: makeSpec() })
  const specPath = path.join(root, "runs", run.runId, "spec.json")
  const resultPath = path.join(root, "runs", run.runId, "results", `${encodeResultKey("gather")}.json`)
  const specBefore = await readFile(specPath, "utf8")

  const writer = (async () => {
    for (let i = 0; i < 20; i++) {
      await store.updateRun(run.runId, {
        result: { instanceKey: "gather", stepId: "gather", value: { i, blob: "x".repeat(100000 + i) } },
      })
    }
    await store.updateRun(run.runId, { status: "completed" })
  })()

  const reader = (async () => {
    let reads = 0
    while (reads < 300) {
      let raw = null
      try {
        raw = await readFile(resultPath, "utf8")
      } catch {
        // Result file does not exist yet.
      }
      if (raw !== null) {
        // Every read must be a complete old or new file, never a partial one.
        const parsed = JSON.parse(raw)
        assert.ok(Number.isInteger(parsed.i), "result must always parse as a whole object")
        assert.equal(parsed.blob.length, 100000 + parsed.i)
        reads += 1
      }
    }
  })()

  await Promise.all([writer, reader])

  const specAfter = await readFile(specPath, "utf8")
  assert.equal(specAfter, specBefore, "spec.json must never change after creation")
  assert.deepEqual(await store.loadSpec(run.runId), validateWorkflowSpec(SPEC_JSON()).spec)

  const names = await collectFilenames(root)
  assert.equal(names.some((name) => name.startsWith(".tmp-")), false, "no temp files may remain")
})

test("recovers a snapshot from events when it is missing, stale, or corrupt", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: makeSpec() })
  await store.updateRun(run.runId, { status: "running", usage: { tokensIn: 100 } })
  await store.updateRun(run.runId, { node: { instanceKey: "gather", node: { instanceKey: "gather", stepId: "gather", status: "running" } } })
  await store.updateRun(run.runId, { result: { instanceKey: "gather", stepId: "gather", value: { ok: true } } })
  await store.updateRun(run.runId, { status: "completed", usage: { tokensOut: 50 } })

  const snapshot = path.join(root, "runs", run.runId, "snapshot.json")
  const before = await store.loadRun(run.runId)
  assert.equal(before.seq, 7)

  await rm(snapshot, { force: true })
  const recovered = await store.loadRun(run.runId)
  assert.equal(recovered.seq, before.seq)
  assert.equal(recovered.status, "completed")
  assert.deepEqual(recovered.usage, { tokensIn: 100, tokensOut: 50 })
  assert.equal(recovered.nodes.gather.outputRef, before.nodes.gather.outputRef)
  assert.deepEqual(await store.loadResult(run.runId, "gather"), { ok: true })
  await stat(snapshot)
  assert.equal(JSON.parse(await readFile(snapshot, "utf8")).seq, before.seq)

  await writeFile(snapshot, "{ not json")
  const recovered2 = await store.loadRun(run.runId)
  assert.equal(recovered2.seq, before.seq)
  assert.equal(JSON.parse(await readFile(snapshot, "utf8")).seq, before.seq)
})

test("caches completed results by instance id and fingerprint, and resumes runs", async (t) => {
  const { store, root } = await withStore(t)
  const spec = makeSpec()
  const runA = await store.createRun({ instanceId: "inst-1", workflow: "demo", fingerprint: "fp-1", spec })
  await store.updateRun(runA.runId, { status: "running" })
  await store.updateRun(runA.runId, { result: { instanceKey: "gather", stepId: "gather", value: { answer: 42 } } })
  await store.updateRun(runA.runId, { status: "completed" })

  const cached = await store.getCachedResult("inst-1", "fp-1")
  assert.ok(cached, "a completed run populates the result cache")
  assert.equal(cached.runId, runA.runId)
  assert.equal(cached.status, "completed")
  assert.equal(cached.resultRefs.gather, `runs/${runA.runId}/results/${encodeResultKey("gather")}.json`)
  assert.deepEqual(await store.readCacheResult(cached, "gather"), { answer: 42 })
  assert.equal(await store.readCacheResult(cached, "nope"), null)

  assert.equal(await store.getCachedResult("inst-1", "fp-2"), null)
  assert.equal(await store.getCachedResult("inst-2", "fp-1"), null)

  const runB = await store.createRun({ instanceId: "inst-1", workflow: "demo", fingerprint: "fp-1", spec })
  assert.notEqual(runB.runId, runA.runId)
  assert.equal((await store.getCachedResult("inst-1", "fp-1")).runId, runA.runId)
  await store.updateRun(runB.runId, { status: "completed" })

  const runC = await store.createRun({ instanceId: "inst-3", workflow: "demo", fingerprint: "fp-3", spec })
  await store.updateRun(runC.runId, { status: "running", usage: { tokensIn: 5 } })

  const interrupted = await store.markInterrupted("restart")
  assert.deepEqual(interrupted.map((entry) => entry.runId), [runC.runId])
  const interruptedRec = await store.loadRun(runC.runId)
  assert.equal(interruptedRec.status, "interrupted")
  assert.ok(interruptedRec.finishedAt)
  assert.equal(interruptedRec.error, "restart")

  const resumed = await store.resumeRun(runC.runId)
  assert.equal(resumed.status, "running")
  assert.equal(resumed.finishedAt, undefined)
  assert.equal(resumed.seq, interruptedRec.seq + 1)
  assert.equal(resumed.usage.tokensIn, 5)
  assert.equal(resumed.error, undefined)

  const lines = await journalLines(root, runC.runId)
  assert.equal(lines.length, resumed.seq)
  assert.ok(lines.some((event) => event.type === "interrupted"))
  assert.ok(lines.some((event) => event.type === "resume"))
})

test("resume atomically preserves completed nodes and resets stale unfinished state", async (t) => {
  const { store } = await withStore(t)
  const run = await store.createRun({
    instanceId: "resume-nodes",
    workflow: "demo",
    fingerprint: "resume-fingerprint",
    spec: makeSpec(),
  })
  await store.updateRun(run.runId, { status: "running" })
  await store.updateRun(run.runId, {
    result: { instanceKey: "done", stepId: "done", value: "kept" },
  })
  await store.updateRun(run.runId, {
    node: {
      instanceKey: "failed",
      node: {
        instanceKey: "failed",
        stepId: "failed",
        status: "failed",
        sessionId: "old-session",
        worktree: { directory: "/tmp/old-worktree" },
        attempts: 1,
        usage: { tokensIn: 7, tokensOut: 3 },
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:01:00.000Z",
        error: "stale failure",
      },
    },
  })
  await store.updateRun(run.runId, { status: "failed", error: "stale run failure" })

  const resumed = await store.resumeRun(run.runId)

  assert.equal(resumed.status, "running")
  assert.equal(resumed.error, undefined)
  assert.equal(resumed.nodes.done.status, "completed")
  assert.equal(resumed.nodes.done.outputRef !== undefined, true)
  assert.deepEqual(resumed.nodes.failed, {
    instanceKey: "failed",
    stepId: "failed",
    status: "pending",
    attempts: 1,
    usage: { tokensIn: 7, tokensOut: 3 },
  })
})

test("expectedSeq retries are idempotent and gaps are rejected", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: makeSpec() })
  const expected = run.seq + 1

  const committed = await store.updateRun(run.runId, { status: "running" }, { expectedSeq: expected })
  assert.equal(committed.seq, expected)

  const retry = await store.updateRun(run.runId, { status: "running" }, { expectedSeq: expected })
  assert.equal(retry.seq, expected, "a stale expectedSeq is an idempotent no-op")
  assert.equal((await store.loadRun(run.runId)).seq, expected)

  assert.equal((await journalLines(root, run.runId)).length, 2)

  await assert.rejects(
    () => store.updateRun(run.runId, { status: "completed" }, { expectedSeq: expected + 5 }),
    S.SequenceError,
  )
  await assert.rejects(
    () => store.appendEvents(run.runId, [{ type: "usage", at: new Date().toISOString(), usage: {} }], { expectedSeq: expected + 3 }),
    S.SequenceError,
  )

  const afterGapAttempt = await store.loadRun(run.runId)
  assert.equal(afterGapAttempt.seq, expected)
  assert.equal(afterGapAttempt.status, "running")
})

test("concurrent appends are serialized with contiguous sequence numbers", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: makeSpec() })
  assert.equal(run.seq, 1)

  const N = 40
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.updateRun(run.runId, {
        node: { instanceKey: `step-${i}`, node: { instanceKey: `step-${i}`, stepId: `step-${i}`, status: "running", attempts: i } },
      }),
    ),
  )

  const M = 20
  await Promise.all(
    Array.from({ length: M }, (_, i) =>
      store.appendEvents(run.runId, [
        { type: "usage", at: new Date().toISOString(), usage: { tokensIn: i } },
      ]),
    ),
  )

  const loaded = await store.loadRun(run.runId)
  assert.equal(loaded.seq, 1 + N + M)
  assert.equal(Object.keys(loaded.nodes).length, N)
  assert.equal(loaded.usage.tokensIn, (M * (M - 1)) / 2, "usage events all applied exactly once")

  const lines = await journalLines(root, run.runId)
  assert.equal(lines.length, 1 + N + M)
  lines.forEach((event, index) => {
    assert.equal(event.seq, index + 1, "journal sequences must be contiguous and gap-free")
  })
  assert.ok(new Set(lines.map((event) => event.seq)).size === lines.length, "no duplicate sequences")
})

test("rejects path traversal everywhere", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wf-guard-"))
  t.after(async () => {
    await rm(parent, { recursive: true, force: true })
  })
  const root = path.join(parent, "root")
  const store = new WorkflowStore({ root })
  await store.init()
  const spec = makeSpec()

  await assert.rejects(() => store.loadRun(".."), S.TraversalError)
  await assert.rejects(() => store.loadRun("../../etc"), S.TraversalError)
  await assert.rejects(() => store.loadRun("/etc/passwd"), S.TraversalError)
  await assert.rejects(() => store.loadRun("..%2f..%2fetc"), S.TraversalError)
  await assert.rejects(() => store.loadRun(""), S.TraversalError)

  await assert.rejects(
    () => store.createRun({ instanceId: "i", workflow: "../escape", fingerprint: "f", spec }),
    S.TraversalError,
  )
  await assert.rejects(
    () => store.createRun({ instanceId: "i/../x", workflow: "w", fingerprint: "f", spec }),
    S.TraversalError,
  )
  await assert.rejects(
    () => store.createRun({ instanceId: "i", workflow: "w", fingerprint: "../f", spec }),
    S.TraversalError,
  )

  await assert.rejects(() => store.saveWorkflow("../x", spec), S.TraversalError)
  await assert.rejects(() => store.saveWorkflow("a/b", spec), S.TraversalError)
  await assert.rejects(() => store.loadWorkflow("../x"), S.TraversalError)

  await assert.rejects(() => store.getCachedResult("../inst", "fp"), S.TraversalError)
  await assert.rejects(() => store.getCachedResult("inst", "../fp"), S.TraversalError)
  await assert.rejects(
    () =>
      store.putCachedResult({
        runId: "0123456789abcdef0123456789abcdef",
        instanceId: "inst",
        fingerprint: "../fp",
        status: "completed",
        createdAt: new Date().toISOString(),
        nodes: {},
        resultRefs: {},
      }),
    S.TraversalError,
  )

  const run = await store.createRun({ instanceId: "inst", workflow: "w", fingerprint: "fp", spec })
  await assert.rejects(() => store.loadResult(run.runId, "../evil"), S.TraversalError)
  await assert.rejects(() => store.loadResult(run.runId, ".."), S.TraversalError)
  await assert.rejects(() => store.updateRun("../nope", { status: "running" }), S.TraversalError)
  await assert.rejects(() => store.resumeRun("../nope"), S.TraversalError)

  const parentEntries = (await readdir(parent)).sort()
  assert.deepEqual(parentEntries, ["root"], "nothing may escape the store root")
  const rootEntries = (await readdir(root)).sort()
  assert.deepEqual(rootEntries, ["cache", "runs", "workflows"])
})

test("surfaces corrupt data and tolerates torn appends", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: makeSpec() })
  await store.updateRun(run.runId, { status: "running" })
  await store.updateRun(run.runId, { node: { instanceKey: "gather", node: { instanceKey: "gather", stepId: "gather", status: "running" } } })
  const eventsFile = path.join(root, "runs", run.runId, "events.jsonl")

  await appendFile(eventsFile, '{"type":"status","seq":9,"at":"2026-01-01T00:00:00Z","status":"run')
  const recovered = await store.loadRun(run.runId)
  assert.equal(recovered.seq, 3)
  assert.equal(recovered.status, "running")

  await store.updateRun(run.runId, { usage: { tokensIn: 1 } })
  const repaired = await store.loadRun(run.runId)
  assert.equal(repaired.seq, 4)
  const linesAfter = await journalLines(root, run.runId)
  assert.deepEqual(linesAfter.map((event) => event.seq), [1, 2, 3, 4])

  const goodJournal = await readFile(eventsFile, "utf8")
  const split = goodJournal.split("\n")
  split[1] = "this is not json"
  await writeFile(eventsFile, split.join("\n"))
  await assert.rejects(() => store.loadRun(run.runId), S.CorruptJournalError)

  await writeFile(eventsFile, goodJournal)
  await rm(path.join(root, "runs", run.runId, "spec.json"), { force: true })
  await assert.rejects(() => store.loadRun(run.runId), S.CorruptJournalError)

  await writeFile(path.join(root, "runs", run.runId, "results", `${encodeResultKey("gather")}.json`), "nope")
  await assert.rejects(() => store.loadResult(run.runId, "gather"), S.CorruptSnapshotError)
})

test("saved workflow discovery honors project precedence and strict JSON errors", async (t) => {
  const { store, root } = await withStore(t)
  await store.saveWorkflow("shared", makeSpec({ description: "project version" }))
  await store.saveWorkflow("shared", makeSpec({ description: "personal version" }), "personal")
  await store.saveWorkflow("only-personal", makeSpec({ description: "personal only" }), "personal")
  await store.saveWorkflow("plain", makeSpec({ description: "plain" }))

  assert.equal((await store.loadWorkflow("shared")).description, "project version")
  assert.equal((await store.loadWorkflow("only-personal")).description, "personal only")

  const workflows = await store.listWorkflows()
  const names = workflows.map((workflow) => `${workflow.source}:${workflow.name}`).sort()
  assert.deepEqual(names, ["personal:only-personal", "project:plain", "project:shared"])
  assert.equal(workflows.find((workflow) => workflow.name === "shared").source, "project")

  await assert.rejects(() => store.loadWorkflow("missing"), S.NotFoundError)

  const projectShared = path.join(root, "workflows", "project", "shared.json")
  await writeFile(projectShared, "{ broken json")
  await assert.rejects(() => store.loadWorkflow("shared"), S.CorruptWorkflowError)
  await assert.rejects(() => store.listWorkflows(), S.CorruptWorkflowError)

  await writeFile(projectShared, JSON.stringify(makeSpec({ description: "project version" })))
  await writeFile(path.join(root, "workflows", "personal", "shared.json"), "garbage")
  assert.equal((await store.loadWorkflow("shared")).description, "project version")
  const afterShadow = await store.listWorkflows()
  assert.deepEqual(afterShadow.map((workflow) => `${workflow.source}:${workflow.name}`).sort(), names)
})

test("refuses to persist secret-bearing fields", async (t) => {
  const { store } = await withStore(t)
  const leakySpec = makeSpec({
    steps: [
      {
        id: "gather",
        type: "agent",
        agent: "explore",
        prompt: "Do.",
        outputSchema: { type: "object", properties: { apiKey: { type: "string" } } },
      },
    ],
  })
  await assert.rejects(
    () => store.createRun({ instanceId: "i", workflow: "w", fingerprint: "f", spec: leakySpec }),
    S.SecretPolicyError,
  )
  await assert.rejects(() => store.saveWorkflow("leaky", leakySpec), S.SecretPolicyError)
  await assert.rejects(
    () =>
      store.createRun({
        instanceId: "i",
        workflow: "w",
        fingerprint: "f",
        spec: makeSpec(),
        metadata: { password: "hunter2" },
      }),
    S.SecretPolicyError,
  )

  // The guard scans keys, not values: a benign mention must not be blocked.
  const run = await store.createRun({
    instanceId: "i",
    workflow: "w",
    fingerprint: "f",
    spec: makeSpec({ description: "ask the user for their password before continuing" }),
  })
  assert.ok(run)
})

test("stores nested containers and caches them under separate keys", async (t) => {
  const { store } = await withStore(t)
  const spec = makeSpec({
    steps: [
      {
        id: "seq",
        type: "sequence",
        steps: [
          { id: "a", type: "agent", agent: "explore", prompt: "Do A." },
          { id: "b", type: "agent", agent: "worker", prompt: "Do B.", dependsOn: ["a"] },
        ],
      },
    ],
  })
  const run = await store.createRun({ instanceId: "nested", workflow: "nested-wf", fingerprint: "hash-1", spec })
  assert.equal(run.workflow, "nested-wf")
  await store.updateRun(run.runId, { node: { instanceKey: "b", node: { instanceKey: "b", stepId: "b", status: "completed" } } })
  const rec = await store.loadRun(run.runId)
  assert.equal(rec.nodes.b.status, "completed")
  const cache = await store.getCachedResult("nested", "hash-1")
  assert.equal(cache, null)
  await store.putCachedResult({
    runId: run.runId,
    instanceId: "nested",
    fingerprint: "hash-1",
    status: "completed",
    createdAt: new Date().toISOString(),
    nodes: rec.nodes,
    resultRefs: {},
  })
  assert.equal((await store.getCachedResult("nested", "hash-1")).runId, run.runId)
  assert.equal((await store.getCachedResult("nested", "hash-2")), null)
})

test("persists nodes and results per instance key with collision-resistant filenames", async (t) => {
  const { store, root } = await withStore(t)
  const run = await store.createRun({ instanceId: "audit", workflow: "w", fingerprint: "fp-1", spec: makeSpec() })

  const keyA = "audit~0~check"
  const keyB = "audit~1~check"
  await store.updateRun(run.runId, {
    node: { instanceKey: keyA, node: { instanceKey: keyA, stepId: "check", status: "running", executionFingerprint: "spec-hash-1" } },
  })
  await store.updateRun(run.runId, {
    result: { instanceKey: keyA, stepId: "check", value: { ok: 1 } },
  })
  await store.updateRun(run.runId, {
    node: { instanceKey: keyB, node: { instanceKey: keyB, stepId: "check", status: "running", executionFingerprint: "spec-hash-1" } },
  })
  await store.updateRun(run.runId, {
    result: { instanceKey: keyB, stepId: "check", value: { ok: 2 } },
  })

  const rec = await store.loadRun(run.runId)
  assert.deepEqual(Object.keys(rec.nodes).sort(), [keyA, keyB])
  assert.equal(rec.nodes[keyA].stepId, "check", "stepId metadata is retained")
  assert.equal(rec.nodes[keyA].executionFingerprint, "spec-hash-1")
  assert.notEqual(rec.nodes[keyA].outputRef, rec.nodes[keyB].outputRef)
  assert.equal(rec.nodes[keyA].outputRef, `runs/${run.runId}/results/${encodeResultKey(keyA)}.json`)
  assert.match(rec.nodes[keyA].outputRef, /[0-9a-f]{32}\.json$/, "filename must be a safe hash")

  assert.deepEqual(await store.loadResult(run.runId, keyA), { ok: 1 })
  assert.deepEqual(await store.loadResult(run.runId, keyB), { ok: 2 })

  const filenames = await collectFilenames(path.join(root, "runs", run.runId, "results"))
  assert.equal(filenames.length, 2)
  assert.equal(
    filenames.some((name) => name.includes("~")),
    false,
    "the raw instance key must never appear in a result filename",
  )
})

test("rejects unsafe instance keys everywhere", async (t) => {
  const { store } = await withStore(t)
  const run = await store.createRun({ instanceId: "inst", workflow: "w", fingerprint: "fp", spec: makeSpec() })

  for (const bad of ["../evil", "..", "a/b", "a\\b", "", "a b"]) {
    await assert.rejects(() => store.loadResult(run.runId, bad), S.TraversalError)
    await assert.rejects(
      () => store.updateRun(run.runId, { node: { instanceKey: bad, node: { instanceKey: bad, stepId: "x", status: "running" } } }),
      S.TraversalError,
    )
    await assert.rejects(
      () => store.updateRun(run.runId, { result: { instanceKey: bad, stepId: "x", value: 1 } }),
      S.TraversalError,
    )
  }
})

test("executionFingerprint round-trips through the journal and into the cache", async (t) => {
  const { store } = await withStore(t)
  const spec = makeSpec()
  const run = await store.createRun({ instanceId: "inst-x", workflow: "w", fingerprint: "fp-x", spec })
  await store.updateRun(run.runId, {
    node: { instanceKey: "audit~0~check", node: { instanceKey: "audit~0~check", stepId: "check", status: "running", executionFingerprint: "exact-exec-hash" } },
  })
  await store.updateRun(run.runId, { result: { instanceKey: "audit~0~check", stepId: "check", value: { n: 1 } } })
  await store.updateRun(run.runId, { status: "completed" })

  const rec = await store.loadRun(run.runId)
  assert.equal(rec.nodes["audit~0~check"].executionFingerprint, "exact-exec-hash")

  const cached = await store.getCachedResult("inst-x", "fp-x")
  assert.equal(cached.nodes["audit~0~check"].executionFingerprint, "exact-exec-hash")
  assert.deepEqual(await store.readCacheResult(cached, "audit~0~check"), { n: 1 })
})
