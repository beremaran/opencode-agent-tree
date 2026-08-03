/**
 * Durable workflow persistence state types.
 *
 * The store is built around a write-ahead journal of immutable events plus a
 * materialized snapshot. The journal is append-only and is the source of
 * truth; a snapshot is a recovered view that is rebuilt from the journal
 * whenever it is missing, stale, or corrupt. Every event carries a monotonically
 * increasing, idempotent `seq` number so replays and caller retries never
 * double-apply a mutation.
 *
 * Run records reference the immutable `spec.json` and result files through
 * relative, POSIX-style paths that are resolved only against the store root.
 * Nothing here contains secret material by design; see the secrets guard in
 * `store.ts`.
 */

import type { WorkflowSpecV1 } from "./types.ts"

/** Version of the `RunRecord` / snapshot schema. */
export const RUN_RECORD_VERSION = 1 as const

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
  "canceled",
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "running"])
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "canceled",
])

/** Aggregated resource usage attributed to a run, node, or session. */
export interface RunUsage {
  tokensIn?: number
  tokensOut?: number
  cost?: number
  durationMs?: number
}

export const RUN_NODE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "cached",
] as const
export type RunNodeStatus = (typeof RUN_NODE_STATUSES)[number]

/** Progress of a single workflow step instance inside a run. */
export interface RunNode {
  /**
   * Instance-scoped key (e.g. `audit~0~check`) unique within a run. Static
   * step ids are not unique once a step runs inside a map or loop, so nodes
   * and results are keyed by this instance key.
   */
  instanceKey?: string
  /** Static step id the instance belongs to (retained metadata). */
  stepId: string
  status: RunNodeStatus
  /**
   * Fingerprint of the exact execution parameters. Resume only reuses a
   * cached node when the fingerprint matches the pending execution.
   */
  executionFingerprint?: string
  /** Agent instance/session that executed this step, when applicable. */
  instanceId?: string
  sessionId?: string
  /** Isolated worktree retained until its changes are integrated. */
  worktree?: { directory: string; branch?: string }
  /** Relative path to the step's result file (see `results/`). */
  outputRef?: string
  /** True when this node was satisfied from the result cache. */
  cached?: boolean
  usage?: RunUsage
  startedAt?: string
  finishedAt?: string
  attempts?: number
  error?: string
}

export const SESSION_STATUSES = ["open", "closed", "failed"] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** A persisted agent session used by one or more nodes of a run. */
export interface SessionState {
  sessionId: string
  agent: string
  model?: string
  status: SessionStatus
  startedAt?: string
  endedAt?: string
  usage?: RunUsage
}

export const EVENT_TYPES = [
  "created",
  "status",
  "usage",
  "node",
  "session",
  "result",
  "interrupted",
  "resume",
  "meta",
] as const
export type RunEventType = (typeof EVENT_TYPES)[number]

/** Fields every journal event shares. */
export interface RunEventBase {
  /** Idempotent, monotonically increasing sequence number, starting at 1. */
  seq: number
  /** ISO 8601 timestamp at which the event was recorded. */
  at: string
}

/** The first event of a run; carries the immutable creation context. */
export interface CreatedEvent extends RunEventBase {
  type: "created"
  runId: string
  instanceId: string
  workflow: string
  fingerprint: string
  status: RunStatus
  metadata?: Record<string, string>
}

/** Transitions the run status; optional resume token or terminal error. */
export interface StatusEvent extends RunEventBase {
  type: "status"
  status: RunStatus
  resumeToken?: string
  error?: string
}

/** Aggregates usage into the run total. */
export interface UsageEvent extends RunEventBase {
  type: "usage"
  usage: RunUsage
}

/** Upserts a step node instance in `nodes`, keyed by `instanceKey`. */
export interface NodeEvent extends RunEventBase {
  type: "node"
  instanceKey: string
  node: RunNode
}

/** Upserts a session in `sessions`. */
export interface SessionEvent extends RunEventBase {
  type: "session"
  session: SessionState
}

/**
 * Records that a node instance result was written to a separate result file.
 * The payload lives in the file; the journal only carries the auditable
 * reference and the static `stepId` metadata.
 */
export interface ResultEvent extends RunEventBase {
  type: "result"
  instanceKey: string
  stepId: string
  outputRef: string
  usage?: RunUsage
}

/** Marks an active run as interrupted (e.g. after a scheduler restart). */
export interface InterruptedEvent extends RunEventBase {
  type: "interrupted"
  reason?: string
}

/** Returns an interrupted run to `running`. */
export interface ResumeEvent extends RunEventBase {
  type: "resume"
  fromRunId?: string
  reason?: string
}

/** Small out-of-band metadata updates (e.g. an updated resume token). */
export interface MetaEvent extends RunEventBase {
  type: "meta"
  resumeToken?: string
}

export type RunEvent =
  | CreatedEvent
  | StatusEvent
  | UsageEvent
  | NodeEvent
  | SessionEvent
  | ResultEvent
  | InterruptedEvent
  | ResumeEvent
  | MetaEvent

/** A journal event without its store-assigned `seq`. */
export type RunEventInput = DistributiveOmit<RunEvent, "seq">

/** A durable, auditable run record (the shape of `snapshot.json`). */
export interface RunRecord {
  runId: string
  instanceId: string
  workflow: string
  fingerprint: string
  /** Relative path to the immutable spec file, resolved against the root. */
  specPath: string
  status: RunStatus
  version: typeof RUN_RECORD_VERSION
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  /** Highest event sequence number applied to this record. */
  seq: number
  metadata?: Record<string, string>
  usage?: RunUsage
  nodes: Record<string, RunNode>
  sessions: SessionState[]
  resumeToken?: string
  error?: string
}

/** Lightweight listing entry; safe for scheduler dashboards. */
export interface RunSummary {
  runId: string
  instanceId: string
  workflow: string
  status: RunStatus
  fingerprint: string
  createdAt: string
  updatedAt: string
  seq: number
}

/**
 * A cached completion for an (instance, execution fingerprint) pair. Results
 * are not copied here; `resultRefs` point at the original run's result files.
 */
export interface CacheEntry {
  runId: string
  instanceId: string
  fingerprint: string
  status: RunStatus
  createdAt: string
  nodes: Record<string, RunNode>
  resultRefs: Record<string, string>
  usage?: RunUsage
}

/** Which workflow directory a saved spec was discovered in. */
export type WorkflowSource = "project" | "personal"

/** A discovered saved workflow spec. */
export interface SavedWorkflow {
  name: string
  source: WorkflowSource
  /** Absolute path the spec was loaded from. */
  path: string
  spec: WorkflowSpecV1
}

/** Base class for all store failures; carries a stable machine-readable code. */
export class StoreError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

export class TraversalError extends StoreError {
  constructor(message: string) {
    super("E_TRAVERSAL", message)
  }
}

export class NotFoundError extends StoreError {
  constructor(message: string) {
    super("E_NOT_FOUND", message)
  }
}

/** An out-of-order / gapped idempotent event sequence was requested. */
export class SequenceError extends StoreError {
  constructor(message: string) {
    super("E_SEQUENCE", message)
  }
}

export class CorruptJournalError extends StoreError {
  constructor(message: string) {
    super("E_CORRUPT_JOURNAL", message)
  }
}

export class CorruptSnapshotError extends StoreError {
  constructor(message: string) {
    super("E_CORRUPT_SNAPSHOT", message)
  }
}

export class CorruptWorkflowError extends StoreError {
  constructor(message: string) {
    super("E_CORRUPT_WORKFLOW", message)
  }
}

export class SecretPolicyError extends StoreError {
  constructor(message: string) {
    super("E_SECRET", message)
  }
}

export class ImmutableSpecError extends StoreError {
  constructor(message: string) {
    super("E_IMMUTABLE_SPEC", message)
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
