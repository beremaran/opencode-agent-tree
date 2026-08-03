/**
 * Durable, auditable workflow persistence for a server-side scheduler.
 *
 * Layout under the store root:
 *
 *   runs/<runId>/spec.json        immutable, validated WorkflowSpecV1
 *   runs/<runId>/events.jsonl     append-only JSONL event journal (source of truth)
 *   runs/<runId>/snapshot.json    materialized RunRecord, atomically rewritten
 *   runs/<runId>/results/<hash>.json  per-node-instance result files (instance
 *                                keys are hashed for a collision-resistant,
 *                                traversal-safe filename), atomically written
 *   cache/<hash(instanceId)>/<fingerprint>.json  completed-result cache entries
 *   workflows/project/<name>.json saved workflow specs (project precedence)
 *   workflows/personal/<name>.json
 *
 * Guarantees:
 * - Run IDs are 128-bit CSPRNG values; every path is validated and confined
 *   to the store root (`TraversalError`).
 * - JSON files are written to a temp file in the same directory, fsynced, and
 *   atomically renamed. Readers never observe a partial file.
 * - Event appends are serialized in-process per run and assign contiguous,
 *   idempotent sequence numbers. Retrying a batch with the same expected
 *   sequence is a no-op instead of a double-append.
 * - The journal is the source of truth; a missing/stale/corrupt snapshot is
 *   rebuilt from events on load.
 * - Secret-bearing fields are rejected before anything touches disk.
 */

import { createHash, randomBytes } from "node:crypto"
import * as fsp from "node:fs/promises"
import * as path from "node:path"

import { validateWorkflowSpec } from "./schema.ts"
import type { WorkflowSpecV1 } from "./types.ts"
import * as S from "./state.ts"
import type {
  CacheEntry,
  RunEvent,
  RunEventInput,
  RunNode,
  RunRecord,
  RunStatus,
  RunSummary,
  RunUsage,
  SavedWorkflow,
  SessionState,
  WorkflowSource,
} from "./state.ts"

const RUN_DIR = "runs"
const CACHE_DIR = "cache"
const RESULTS_DIR = "results"
const SPEC_FILE = "spec.json"
const CONTEXT_FILE = "context.json"
const EVENTS_FILE = "events.jsonl"
const SNAPSHOT_FILE = "snapshot.json"

const RUN_ID_RE = /^[0-9a-f]{32}$/
const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{1,128}$/
const INSTANCE_ID_RE = /^[A-Za-z0-9._~-]{1,256}$/
const INSTANCE_KEY_RE = /^[A-Za-z0-9._~-]{1,256}$/

type ErrorCtor = new (message: string) => S.StoreError

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as NodeJS.ErrnoException).code === "ENOENT"

const isoNow = (): string => new Date().toISOString()

/** Optional store configuration. */
export interface WorkflowStoreOptions {
  /** Root directory for run records, cache, and (by default) workflows. */
  root: string
  /** Directory of project-scoped saved workflows. */
  projectWorkflowDir?: string
  /** Directory of personal-scoped saved workflows. */
  personalWorkflowDir?: string
}

/** Input to `WorkflowStore.createRun`. */
export interface CreateRunInput {
  /** Logical workflow invocation id used as the first cache key dimension. */
  instanceId: string
  /** Saved-workflow name (or arbitrary label) this run executes. */
  workflow: string
  /** Execution fingerprint used as the second cache key dimension. */
  fingerprint: string
  /** Workflow IR v1 spec; validated and frozen before being stored. */
  spec: WorkflowSpecV1
  /** Initial run status. Defaults to "queued". */
  status?: RunStatus
  /** Small, non-secret metadata attached to the run. */
  metadata?: Record<string, string>
}

/** A batched, high-level mutation. */
export interface RunPatch {
  status?: RunStatus
  error?: string
  usage?: RunUsage
  /** Upsert a single node instance, keyed by `instanceKey`. */
  node?: { instanceKey: string; node: RunNode }
  session?: SessionState
  /** Write a node instance result to its own JSON file and reference it. */
  result?: { instanceKey: string; stepId: string; value: unknown; usage?: RunUsage }
  resumeToken?: string
}

export interface UpdateRunOptions {
  /**
   * Idempotency guard: the sequence number the caller believes is next.
   * If it is below the store's next sequence, the batch is treated as an
   * already-committed retry and is a no-op. If it is above, a gap is
   * reported (`SequenceError`).
   */
  expectedSeq?: number
}

const TOKEN = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

const SECRET_KEY_TOKENS = [
  "secret",
  "secrets",
  "password",
  "passphrase",
  "apikey",
  "clientsecret",
  "accesstoken",
  "bearertoken",
  "authorization",
  "credential",
].map(TOKEN)

/** Recursively locate a secret-bearing object key, or null. */
const findSecretKey = (value: unknown, basePath: string): string | null => {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecretKey(value[i], `${basePath}[${i}]`)
      if (hit !== null) return hit
    }
    return null
  }
  if (!isPlainObject(value)) return null
  for (const [key, child] of Object.entries(value)) {
    const flat = TOKEN(key)
    for (const token of SECRET_KEY_TOKENS) {
      if (flat.includes(token)) return `${basePath}.${key}`
    }
    const hit = findSecretKey(child, `${basePath}.${key}`)
    if (hit !== null) return hit
  }
  return null
}

const assertNoSecrets = (value: unknown, label: string): void => {
  const hit = findSecretKey(value, "$")
  if (hit !== null) {
    throw new S.SecretPolicyError(`${label} contains a secret-bearing field at ${hit}; refusing to persist secrets`)
  }
}

const assertRunId = (runId: string): void => {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new S.TraversalError(`invalid run id ${JSON.stringify(runId)}`)
  }
}

const assertWorkflowName = (name: string): void => {
  if (typeof name !== "string" || !WORKFLOW_NAME_RE.test(name)) {
    throw new S.TraversalError(`invalid workflow name ${JSON.stringify(name)}`)
  }
}

const assertFingerprint = (fingerprint: string): void => {
  if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
    throw new S.TraversalError(`invalid execution fingerprint ${JSON.stringify(fingerprint)}`)
  }
}

const assertInstanceId = (instanceId: string): void => {
  if (typeof instanceId !== "string" || !INSTANCE_ID_RE.test(instanceId)) {
    throw new S.TraversalError(`invalid instance id ${JSON.stringify(instanceId)}`)
  }
}

const assertInstanceKey = (instanceKey: string): void => {
  if (
    typeof instanceKey !== "string" ||
    !INSTANCE_KEY_RE.test(instanceKey) ||
    instanceKey === "." ||
    instanceKey === ".."
  ) {
    throw new S.TraversalError(`invalid instance key ${JSON.stringify(instanceKey)}`)
  }
}

/**
 * Maps a node instance key to a collision-resistant result filename. The raw
 * key (which may contain `~`, `.`, or `-`) never appears in a path; the file
 * name is a deterministic truncated SHA-256 so any key produces a safe,
 * single-segment name.
 */
export const encodeResultKey = (instanceKey: string): string =>
  createHash("sha256").update(instanceKey).digest("hex").slice(0, 32)

/**
 * Resolve path segments under `root`, rejecting anything that would escape it
 * through `..`, absolute segments, or separators in a segment.
 */
const resolveWithin = (root: string, ...segments: string[]): string => {
  const joined = path.resolve(root, ...segments)
  const relative = path.relative(root, joined)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new S.TraversalError(`path escapes store root: ${segments.join("/")}`)
  }
  return joined
}

/** Atomic write: temp file in the same dir, fsync, rename, dir fsync. */
const atomicWrite = async (filePath: string, data: string): Promise<void> => {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.tmp-${randomBytes(6).toString("hex")}`)
  const handle = await fsp.open(tmp, "w", 0o600)
  try {
    await handle.writeFile(data, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, filePath)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  await syncDir(dir)
}

const syncDir = async (dir: string): Promise<void> => {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(dir, "r")
    await handle.sync()
  } catch {
    // Directory fsync is best-effort and unsupported on some platforms.
  } finally {
    await handle?.close()
  }
}

const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

const readJson = async (
  filePath: string,
  ErrorCtor: ErrorCtor,
  label: string,
): Promise<unknown | null> => {
  let raw: string
  try {
    raw = await fsp.readFile(filePath, "utf8")
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ErrorCtor(`${label} is not valid JSON (${filePath}): ${detail}`)
  }
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fsp.stat(filePath)
    return true
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

/**
 * Parse an event journal. A malformed final line without a trailing newline is
 * treated as a torn append and ignored; any other malformed line or a gap in
 * sequence numbers is reported as corruption.
 */
const parseJournal = (raw: string, runId: string): RunEvent[] => {
  const events: RunEvent[] = []
  const lines = raw.split("\n")
  const tornTail = raw !== "" && !raw.endsWith("\n")
  let expectedSeq = 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      if (tornTail && i === lines.length - 1) break
      const detail = error instanceof Error ? error.message : String(error)
      throw new S.CorruptJournalError(`run ${runId} journal line ${i + 1} is not valid JSON: ${detail}`)
    }
    const candidate = parsed as { type?: unknown; seq?: unknown }
    if (typeof candidate.type !== "string" || !(S.EVENT_TYPES as readonly string[]).includes(candidate.type)) {
      throw new S.CorruptJournalError(`run ${runId} journal line ${i + 1} has an unknown event type`)
    }
    if (!Number.isInteger(candidate.seq) || (candidate.seq as number) !== expectedSeq) {
      throw new S.CorruptJournalError(
        `run ${runId} journal line ${i + 1} expected sequence ${expectedSeq} but found ${JSON.stringify(candidate.seq)}`,
      )
    }
    events.push(parsed as RunEvent)
    expectedSeq += 1
  }
  return events
}

const mergeUsage = (a: RunUsage | undefined, b: RunUsage | undefined): RunUsage | undefined => {
  if (b === undefined) return a
  if (a === undefined) return b
  const merged: RunUsage = {}
  for (const key of ["tokensIn", "tokensOut", "cost", "durationMs"] as const) {
    if (a[key] !== undefined || b[key] !== undefined) {
      merged[key] = (a[key] ?? 0) + (b[key] ?? 0)
    }
  }
  return merged
}

const upsertSession = (sessions: SessionState[], next: SessionState): SessionState[] => {
  const index = sessions.findIndex((entry) => entry.sessionId === next.sessionId)
  if (index === -1) return [...sessions, next]
  const copy = sessions.slice()
  copy[index] = { ...copy[index], ...next }
  return copy
}

const baseRecord = (runId: string): RunRecord => ({
  runId,
  instanceId: "",
  workflow: "",
  fingerprint: "",
  specPath: path.posix.join(RUN_DIR, runId, SPEC_FILE),
  status: "queued",
  version: S.RUN_RECORD_VERSION,
  createdAt: "",
  updatedAt: "",
  seq: 0,
  nodes: {},
  sessions: [],
})

/** Pure fold of one event onto a record. */
const applyEvent = (record: RunRecord, event: RunEvent): RunRecord => {
  switch (event.type) {
    case "created":
      return {
        ...record,
        runId: event.runId,
        instanceId: event.instanceId,
        workflow: event.workflow,
        fingerprint: event.fingerprint,
        status: event.status,
        startedAt: event.status === "running" ? event.at : undefined,
        finishedAt: S.TERMINAL_STATUSES.has(event.status) ? event.at : undefined,
        createdAt: event.at,
        updatedAt: event.at,
        metadata: event.metadata,
        seq: event.seq,
      }
    case "status":
      return {
        ...record,
        status: event.status,
        startedAt: record.startedAt ?? (event.status === "running" ? event.at : undefined),
        finishedAt: S.TERMINAL_STATUSES.has(event.status) ? record.finishedAt ?? event.at : undefined,
        resumeToken: event.resumeToken ?? record.resumeToken,
        error: event.error ?? record.error,
        updatedAt: event.at,
        seq: event.seq,
      }
    case "usage":
      return { ...record, usage: mergeUsage(record.usage, event.usage), updatedAt: event.at, seq: event.seq }
    case "node":
      return {
        ...record,
        nodes: { ...record.nodes, [event.instanceKey]: event.node },
        updatedAt: event.at,
        seq: event.seq,
      }
    case "session":
      return { ...record, sessions: upsertSession(record.sessions, event.session), updatedAt: event.at, seq: event.seq }
    case "result": {
      const prior = record.nodes[event.instanceKey]
      return {
        ...record,
        nodes: {
          ...record.nodes,
          [event.instanceKey]: {
            ...prior,
            instanceKey: event.instanceKey,
            stepId: event.stepId,
            status: "completed",
            outputRef: event.outputRef,
            usage: mergeUsage(prior?.usage, event.usage),
            finishedAt: prior?.finishedAt ?? event.at,
          },
        },
        updatedAt: event.at,
        seq: event.seq,
      }
    }
    case "interrupted":
      return {
        ...record,
        status: "interrupted",
        finishedAt: record.finishedAt ?? event.at,
        error: event.reason ?? record.error,
        updatedAt: event.at,
        seq: event.seq,
      }
    case "resume":
      return {
        ...record,
        status: "running",
        startedAt: record.startedAt ?? event.at,
        finishedAt: undefined,
        resumeToken: event.fromRunId ?? record.resumeToken,
        error: undefined,
        updatedAt: event.at,
        seq: event.seq,
      }
    case "meta":
      return {
        ...record,
        resumeToken: event.resumeToken ?? record.resumeToken,
        updatedAt: event.at,
        seq: event.seq,
      }
  }
}

const replayEvents = (runId: string, events: RunEvent[]): RunRecord => {
  let record = baseRecord(runId)
  for (const event of events) record = applyEvent(record, event)
  return record
}

const toSummary = (record: RunRecord): RunSummary => ({
  runId: record.runId,
  instanceId: record.instanceId,
  workflow: record.workflow,
  status: record.status,
  fingerprint: record.fingerprint,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  seq: record.seq,
})

const isValidSnapshot = (value: unknown): value is RunRecord => {
  if (!isPlainObject(value)) return false
  return (
    typeof value.runId === "string" &&
    Number.isInteger(value.seq) &&
    (value.seq as number) >= 0 &&
    typeof value.status === "string" &&
    (S.RUN_STATUSES as readonly string[]).includes(value.status) &&
    value.version === S.RUN_RECORD_VERSION
  )
}

/** In-process mutex keyed by a string (run id or cache key). */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = previous.then(() => gate)
    this.tails.set(key, next)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }
}

export class WorkflowStore {
  readonly root: string
  private readonly runsDir: string
  private readonly cacheDir: string
  private readonly projectWorkflowDir: string
  private readonly personalWorkflowDir: string
  private readonly locks = new KeyedMutex()
  private readonly records = new Map<string, RunRecord>()

  constructor(options: WorkflowStoreOptions) {
    this.root = path.resolve(options.root)
    this.runsDir = path.join(this.root, RUN_DIR)
    this.cacheDir = path.join(this.root, CACHE_DIR)
    this.projectWorkflowDir = path.resolve(
      options.projectWorkflowDir ?? path.join(this.root, "workflows", "project"),
    )
    this.personalWorkflowDir = path.resolve(
      options.personalWorkflowDir ?? path.join(this.root, "workflows", "personal"),
    )
  }

  /** Create the store directory tree. Safe to call repeatedly. */
  async init(): Promise<void> {
    await fsp.mkdir(this.runsDir, { recursive: true })
    await fsp.mkdir(this.cacheDir, { recursive: true })
    await fsp.mkdir(this.projectWorkflowDir, { recursive: true })
    await fsp.mkdir(this.personalWorkflowDir, { recursive: true })
  }

  private runDir(runId: string): string {
    return resolveWithin(this.runsDir, runId)
  }

  /** Rebuild the record from the journal (the source of truth). */
  private async rebuildRecord(runId: string): Promise<RunRecord | null> {
    const specFile = resolveWithin(this.runDir(runId), SPEC_FILE)
    const eventsFile = resolveWithin(this.runDir(runId), EVENTS_FILE)
    let raw: string
    try {
      raw = await fsp.readFile(eventsFile, "utf8")
    } catch (error) {
      if (isEnoent(error)) return null
      throw error
    }
    if (!(await exists(specFile))) {
      throw new S.CorruptJournalError(`run ${runId} is missing its immutable ${SPEC_FILE}`)
    }
    const record = replayEvents(runId, parseJournal(raw, runId))
    if (record.seq === 0) {
      throw new S.CorruptJournalError(`run ${runId} journal is empty; missing "created" event`)
    }
    return record
  }

  /** Ensure the snapshot matches the journal, recovering it when needed. */
  private async reconcileSnapshot(runId: string, record: RunRecord): Promise<void> {
    const snapshotFile = resolveWithin(this.runDir(runId), SNAPSHOT_FILE)
    let existing: unknown = null
    try {
      existing = await readJson(snapshotFile, S.CorruptSnapshotError, `run ${runId} snapshot`)
    } catch (error) {
      if (error instanceof S.CorruptSnapshotError) existing = null
      else throw error
    }
    if (isValidSnapshot(existing) && existing.runId === runId && existing.seq === record.seq) return
    if (isValidSnapshot(existing) && existing.runId === runId && existing.seq > record.seq) {
      throw new S.CorruptJournalError(
        `run ${runId} journal is behind its snapshot (journal ${record.seq} < snapshot ${existing.seq})`,
      )
    }
    await writeJsonAtomic(snapshotFile, record)
  }

  /** Append events and advance the in-memory record. Caller holds the lock. */
  private async commitLocked(runId: string, base: RunRecord, inputs: RunEventInput[]): Promise<RunRecord> {
    if (inputs.length === 0) return base
    const events: RunEvent[] = inputs.map((input, index) => ({
      ...input,
      seq: base.seq + 1 + index,
    }))
    const journal = resolveWithin(this.runDir(runId), EVENTS_FILE)
    await repairTornTail(journal)
    await appendLines(journal, events)
    let record = base
    for (const event of events) record = applyEvent(record, event)
    const snapshotFile = resolveWithin(this.runDir(runId), SNAPSHOT_FILE)
    try {
      await writeJsonAtomic(snapshotFile, record)
    } catch (error) {
      this.records.delete(runId)
      throw error
    }
    this.records.set(runId, record)
    return record
  }

  private async writeResultFile(runId: string, instanceKey: string, value: unknown): Promise<string> {
    assertInstanceKey(instanceKey)
    const file = resolveWithin(this.runDir(runId), RESULTS_DIR, `${encodeResultKey(instanceKey)}.json`)
    await writeJsonAtomic(file, value)
    return path.posix.join(RUN_DIR, runId, RESULTS_DIR, `${encodeResultKey(instanceKey)}.json`)
  }

  private cacheKey(instanceId: string, fingerprint: string): { dir: string; file: string } {
    assertInstanceId(instanceId)
    assertFingerprint(fingerprint)
    const digest = createHash("sha256").update(instanceId).digest("hex").slice(0, 32)
    const dir = resolveWithin(this.cacheDir, digest)
    return { dir, file: resolveWithin(dir, `${fingerprint}.json`) }
  }

  /**
   * Create a new run: write the immutable spec, then record the `created`
   * event and initial snapshot.
   */
  async createRun(input: CreateRunInput): Promise<RunRecord> {
    assertWorkflowName(input.workflow)
    assertInstanceId(input.instanceId)
    assertFingerprint(input.fingerprint)
    const normalized = validateWorkflowSpec(input.spec)
    assertNoSecrets(normalized.spec, "workflow spec")
    if (input.metadata !== undefined) assertNoSecrets(input.metadata, "run metadata")
    const runId = randomBytes(16).toString("hex")
    const runDir = this.runDir(runId)
    try {
      await fsp.mkdir(runDir, { recursive: true })
      await fsp.mkdir(resolveWithin(runDir, RESULTS_DIR), { recursive: true })
      await writeJsonAtomic(resolveWithin(runDir, SPEC_FILE), normalized.spec)
      return await this.locks.run(runId, async () => {
        const base = this.records.get(runId) ?? baseRecord(runId)
        return this.commitLocked(runId, base, [
          {
            type: "created",
            at: isoNow(),
            runId,
            instanceId: input.instanceId,
            workflow: input.workflow,
            fingerprint: input.fingerprint,
            status: input.status ?? "queued",
            metadata: input.metadata,
          },
        ])
      })
    } catch (error) {
      await fsp.rm(runDir, { recursive: true, force: true }).catch(() => undefined)
      this.records.delete(runId)
      throw error
    }
  }

  /**
   * Load a run, rebuilding the snapshot from the journal when it is missing,
   * stale, or corrupt. Returns null when the run does not exist.
   */
  async loadRun(runId: string): Promise<RunRecord | null> {
    assertRunId(runId)
    return this.locks.run(runId, async () => {
      const record = await this.rebuildRecord(runId)
      if (record === null) {
        this.records.delete(runId)
        return null
      }
      await this.reconcileSnapshot(runId, record)
      this.records.set(runId, record)
      return record
    })
  }

  /** Read the immutable spec of a run. */
  async loadSpec(runId: string): Promise<WorkflowSpecV1 | null> {
    assertRunId(runId)
    const parsed = await readJson(
      resolveWithin(this.runDir(runId), SPEC_FILE),
      S.CorruptSnapshotError,
      `run ${runId} spec`,
    )
    if (parsed === null) return null
    return validateWorkflowSpec(parsed).spec
  }

  /** Persist immutable invocation context needed to resume a run. */
  async saveContext(runId: string, value: unknown): Promise<void> {
    assertRunId(runId)
    const record = await this.loadRun(runId)
    if (record === null) throw new S.NotFoundError(`run ${runId} does not exist`)
    assertNoSecrets(value, "workflow invocation context")
    const file = resolveWithin(this.runDir(runId), CONTEXT_FILE)
    if (await exists(file)) {
      throw new S.ImmutableSpecError(`run ${runId} invocation context is immutable`)
    }
    await writeJsonAtomic(file, value)
  }

  /** Load the invocation context needed to resume a run. */
  async loadContext(runId: string): Promise<unknown | null> {
    assertRunId(runId)
    return readJson(
      resolveWithin(this.runDir(runId), CONTEXT_FILE),
      S.CorruptSnapshotError,
      `run ${runId} invocation context`,
    )
  }

  /** List all runs as lightweight summaries. */
  async listRuns(): Promise<RunSummary[]> {
    const summaries: RunSummary[] = []
    for (const runId of await this.listRunDirs()) {
      const record = await this.locks.run(runId, async () => {
        const cached = this.records.get(runId)
        if (cached !== undefined) return cached
        const rebuilt = await this.rebuildRecord(runId)
        if (rebuilt === null) return null
        await this.reconcileSnapshot(runId, rebuilt)
        this.records.set(runId, rebuilt)
        return rebuilt
      })
      if (record !== null) summaries.push(toSummary(record))
    }
    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }

  private async listRunDirs(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await fsp.readdir(this.runsDir)
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
    return entries.filter((name) => RUN_ID_RE.test(name)).sort()
  }

  /**
   * Append raw events, assigning contiguous sequence numbers. Events must not
   * carry a `seq`; the store assigns them. Concurrent appends for the same run
   * are serialized in-process. See `UpdateRunOptions.expectedSeq`.
   */
  async appendEvents(runId: string, events: RunEventInput[], options: UpdateRunOptions = {}): Promise<RunRecord> {
    assertRunId(runId)
    return this.locks.run(runId, async () => {
      const base = this.records.get(runId) ?? (await this.rebuildRecord(runId))
      if (base === null) throw new S.NotFoundError(`run ${runId} does not exist`)
      if (!(await this.guardExpectedSeq(runId, base, options.expectedSeq))) return base
      return this.commitLocked(runId, base, events)
    })
  }

  /**
   * High-level mutation over the journal. Applies `patch`, writes any result
   * file, rewrites the snapshot atomically, and populates the result cache
   * when the run completes.
   */
  async updateRun(runId: string, patch: RunPatch, options: UpdateRunOptions = {}): Promise<RunRecord> {
    assertRunId(runId)
    return this.locks.run(runId, async () => {
      const base = this.records.get(runId) ?? (await this.rebuildRecord(runId))
      if (base === null) throw new S.NotFoundError(`run ${runId} does not exist`)
      if (!(await this.guardExpectedSeq(runId, base, options.expectedSeq))) return base

      const inputs: RunEventInput[] = []
      if (patch.status !== undefined) {
        inputs.push({
          type: "status",
          at: isoNow(),
          status: patch.status,
          resumeToken: patch.resumeToken,
          error: patch.error,
        })
      }
      if (patch.usage !== undefined) inputs.push({ type: "usage", at: isoNow(), usage: patch.usage })
      if (patch.node !== undefined) {
        assertInstanceKey(patch.node.instanceKey)
        inputs.push({
          type: "node",
          at: isoNow(),
          instanceKey: patch.node.instanceKey,
          node: patch.node.node,
        })
      }
      if (patch.session !== undefined) inputs.push({ type: "session", at: isoNow(), session: patch.session })
      if (patch.resumeToken !== undefined && patch.status === undefined) {
        inputs.push({ type: "meta", at: isoNow(), resumeToken: patch.resumeToken })
      }
      if (patch.result !== undefined) {
        assertInstanceKey(patch.result.instanceKey)
        const outputRef = await this.writeResultFile(runId, patch.result.instanceKey, patch.result.value)
        inputs.push({
          type: "result",
          at: isoNow(),
          instanceKey: patch.result.instanceKey,
          stepId: patch.result.stepId,
          outputRef,
          usage: patch.result.usage,
        })
      }
      const record = await this.commitLocked(runId, base, inputs)
      if (record.status === "completed") {
        await this.writeCacheIfApplicable(record).catch(() => undefined)
      }
      return record
    })
  }

  /** Read a node instance's separate result file; null when absent. */
  async loadResult(runId: string, instanceKey: string): Promise<unknown | null> {
    assertRunId(runId)
    assertInstanceKey(instanceKey)
    return readJson(
      resolveWithin(this.runDir(runId), RESULTS_DIR, `${encodeResultKey(instanceKey)}.json`),
      S.CorruptSnapshotError,
      `run ${runId} result "${instanceKey}"`,
    )
  }

  /** Mark every active (queued/running) run as interrupted. */
  async markInterrupted(reason = "scheduler terminated without completion"): Promise<RunSummary[]> {
    const changed: RunSummary[] = []
    for (const runId of await this.listRunDirs()) {
      const record = await this.locks.run(runId, async () => {
        const base = this.records.get(runId) ?? (await this.rebuildRecord(runId))
        if (base === null || !S.ACTIVE_STATUSES.has(base.status)) return null
        return this.commitLocked(runId, base, [{ type: "interrupted", at: isoNow(), reason }])
      })
      if (record !== null) changed.push(toSummary(record))
    }
    return changed
  }

  /** Return an interrupted run to `running`. */
  async resumeRun(
    runId: string,
    options: { fromRunId?: string; reason?: string; expectedSeq?: number } = {},
  ): Promise<RunRecord> {
    assertRunId(runId)
    return this.locks.run(runId, async () => {
      const base = this.records.get(runId) ?? (await this.rebuildRecord(runId))
      if (base === null) throw new S.NotFoundError(`run ${runId} does not exist`)
      if (!(await this.guardExpectedSeq(runId, base, options.expectedSeq))) return base
      return this.commitLocked(runId, base, [
        { type: "resume", at: isoNow(), fromRunId: options.fromRunId, reason: options.reason },
      ])
    })
  }

  private async guardExpectedSeq(
    runId: string,
    base: RunRecord,
    expectedSeq: number | undefined,
  ): Promise<boolean> {
    if (expectedSeq === undefined) return true
    const nextSeq = base.seq + 1
    if (expectedSeq < nextSeq) {
      // The caller already committed this batch on a previous attempt.
      return false
    }
    if (expectedSeq > nextSeq) {
      throw new S.SequenceError(`run ${runId} expected sequence ${expectedSeq} but the next sequence is ${nextSeq}`)
    }
    return true
  }

  private async writeCacheIfApplicable(record: RunRecord): Promise<void> {
    if (record.status !== "completed" || record.instanceId === "" || record.fingerprint === "") return
    const resultRefs: Record<string, string> = {}
    for (const [instanceKey, node] of Object.entries(record.nodes)) {
      if (node.outputRef) resultRefs[instanceKey] = node.outputRef
    }
    await this.putCachedResult({
      runId: record.runId,
      instanceId: record.instanceId,
      fingerprint: record.fingerprint,
      status: "completed",
      createdAt: record.updatedAt,
      nodes: record.nodes,
      resultRefs,
      usage: record.usage,
    })
  }

  /** Store a completed-result cache entry keyed by (instanceId, fingerprint). */
  async putCachedResult(entry: CacheEntry): Promise<void> {
    assertRunId(entry.runId)
    assertInstanceId(entry.instanceId)
    assertFingerprint(entry.fingerprint)
    if (typeof entry.createdAt !== "string" || !(S.RUN_STATUSES as readonly string[]).includes(entry.status)) {
      throw new S.CorruptSnapshotError("cache entry has an invalid status or createdAt")
    }
    const { dir, file } = this.cacheKey(entry.instanceId, entry.fingerprint)
    await fsp.mkdir(dir, { recursive: true })
    await writeJsonAtomic(file, entry)
  }

  /** Read a cached completion; null when no cache entry exists. */
  async getCachedResult(instanceId: string, fingerprint: string): Promise<CacheEntry | null> {
    const { file } = this.cacheKey(instanceId, fingerprint)
    const parsed = await readJson(file, S.CorruptSnapshotError, "cached result")
    if (parsed === null) return null
    return parsed as CacheEntry
  }

  /** Read a cached result value by instance key from a cache entry. */
  async readCacheResult(entry: CacheEntry, instanceKey: string): Promise<unknown | null> {
    assertInstanceKey(instanceKey)
    const ref = entry.resultRefs[instanceKey]
    if (typeof ref !== "string") return null
    return readJson(
      resolveWithin(this.root, ...ref.split("/")),
      S.CorruptSnapshotError,
      `cached result "${instanceKey}"`,
    )
  }

  /**
   * Persist a validated workflow spec to a workflow directory. The project
   * directory wins over the personal directory on load.
   */
  async saveWorkflow(name: string, spec: WorkflowSpecV1, source: WorkflowSource = "project"): Promise<void> {
    assertWorkflowName(name)
    const normalized = validateWorkflowSpec(spec)
    assertNoSecrets(normalized.spec, `workflow "${name}"`)
    const dir = source === "project" ? this.projectWorkflowDir : this.personalWorkflowDir
    await fsp.mkdir(dir, { recursive: true })
    await writeJsonAtomic(resolveWithin(dir, `${name}.json`), normalized.spec)
  }

  /**
   * Load a saved workflow with project-directory precedence. JSON is parsed
   * strictly: a malformed file throws instead of being skipped.
   */
  async loadWorkflow(name: string): Promise<WorkflowSpecV1> {
    assertWorkflowName(name)
    for (const [source, dir] of [
      ["project", this.projectWorkflowDir],
      ["personal", this.personalWorkflowDir],
    ] as const) {
      const parsed = await readJson(
        resolveWithin(dir, `${name}.json`),
        S.CorruptWorkflowError,
        `workflow "${name}" (${source})`,
      )
      if (parsed === null) continue
      return validateWorkflowSpec(parsed).spec
    }
    throw new S.NotFoundError(`workflow "${name}" was not found in the project or personal workflow directories`)
  }

  /** Discover saved workflows; project entries shadow personal namesakes. */
  async listWorkflows(): Promise<SavedWorkflow[]> {
    const out: SavedWorkflow[] = []
    const seen = new Set<string>()
    for (const [source, dir] of [
      ["project", this.projectWorkflowDir],
      ["personal", this.personalWorkflowDir],
    ] as const) {
      let names: string[]
      try {
        names = await fsp.readdir(dir)
      } catch (error) {
        if (isEnoent(error)) continue
        throw error
      }
      names.sort()
      for (const name of names) {
        if (!name.endsWith(".json")) continue
        const base = name.slice(0, -".json".length)
        if (seen.has(base)) continue
        seen.add(base)
        const file = resolveWithin(dir, name)
        const parsed = await readJson(file, S.CorruptWorkflowError, `workflow "${base}" (${source})`)
        if (parsed === null) continue
        out.push({ name: base, source, path: file, spec: validateWorkflowSpec(parsed).spec })
      }
    }
    return out
  }
}

const appendLines = async (filePath: string, events: RunEvent[]): Promise<void> => {
  const handle = await fsp.open(filePath, "a")
  try {
    for (const event of events) {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8")
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Before an append, truncate a torn tail (a trailing line without a newline
 * that is not valid JSON) left behind by a crashed append, so the journal
 * never degrades into an unreadable middle corruption on the next write.
 */
const repairTornTail = async (filePath: string): Promise<void> => {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(filePath, "r+")
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return
    const tailBytes = Math.min(size, 65536)
    const buffer = Buffer.alloc(tailBytes)
    await handle.read(buffer, 0, tailBytes, size - tailBytes)
    const text = buffer.toString("utf8")
    if (text.endsWith("\n")) return
    const lastNewline = text.lastIndexOf("\n")
    if (lastNewline === -1) return
    let valid = false
    try {
      JSON.parse(text.slice(lastNewline + 1))
      valid = true
    } catch {
      valid = false
    }
    if (valid) return
    await handle.truncate(size - tailBytes + lastNewline + 1)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
