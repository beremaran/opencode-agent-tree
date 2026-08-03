/**
 * Session execution adapter for the workflow engine.
 *
 * `SessionBackend` is the narrow, mockable contract the workflow engine uses
 * to drive a delegated agent run inside its own child session. The single
 * production implementation, {@link OpenCodeSessionBackend}, adapts the
 * opencode v2 client (`@opencode-ai/sdk/v2`) into that contract.
 *
 * A run is strictly asynchronous:
 *
 *  1. `createSession` opens a child session under a parent id, optionally
 *     inside a freshly created git worktree for isolation.
 *  2. `run` prompts the session with plain text and an optional JSON schema,
 *     then waits for the agent loop to become idle via the v2 `session.wait`
 *     endpoint (falling back to `session.status` polling when the endpoint is
 *     absent or not implemented). Completion is never inferred from partial
 *     assistant text.
 *     Structured results are requested in the final response and validated
 *     locally instead of using OpenCode's provider-native output format. This
 *     avoids forcing tool choice on incompatible thinking models and avoids
 *     OpenCode 1.18's persisted-format message decoding failure.
 *  3. Every assistant response that answers the admitted prompt is read back.
 *     The terminal response supplies validated structured output (when
 *     requested) or final text, while cost, tokens, and files are aggregated
 *     across the complete turn.
 *
 * Provider and structured-output failures carried on the completed message are
 * rethrown as typed errors. Timeouts and caller-supplied abort signals cancel
 * the session through `session.interrupt`/`session.abort`. Worktrees created
 * by this backend are removed per-session via `releaseSession` (after a node
 * completes) or all at once on {@link OpenCodeSessionBackend.dispose}.
 *
 * All client responses are unwrapped defensively so both the SDK's
 * `{ data, error }` envelopes and bare values (as mocks typically produce) are
 * tolerated. Types are drawn from the installed `@opencode-ai/sdk/v2` package
 * wherever feasible; the injected client surface is kept narrow and structural
 * so tests can supply a plain mock object.
 */

import type {
  Message,
  ModelRef,
  OpencodeClient,
  OutputFormat,
  Part,
  PatchPart,
  PermissionRuleset,
  PromptInput,
  Session,
  SessionAbortError,
  SessionCreateError,
  SessionInputAdmitted,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessagesError,
  SessionMessagesResponse,
  SessionPromptAsyncError,
  SessionStatus,
  SessionStatusError,
  TextPart,
  TextPartInput,
  V2SessionInterruptError,
  V2SessionMessagesError,
  V2SessionPromptError,
  V2SessionWaitError,
  Worktree,
  WorktreeCreateError,
  WorktreeCreateInput,
  WorktreeRemoveError,
  WorktreeRemoveInput,
} from "@opencode-ai/sdk/v2"
import type { JsonSchema } from "./types.ts"
import { explainJsonSchemaMismatch } from "./json-schema.ts"

/** Default poll interval for the `session.status` idle fallback. */
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_RESULT_WAIT_MS = 10_000
const STRUCTURED_REPAIR_ATTEMPTS = 1

const STRUCTURED_OUTPUT_PREAMBLE = `Complete the task normally, including any tool use. When the task is complete, your final assistant response must contain exactly one JSON value matching the JSON Schema below. Do not wrap the JSON in Markdown or add commentary before or after it.`

/** Token usage reported for one or more completed assistant responses. */
export interface TokenUsage {
  input: number
  output: number
  reasoning?: number
  cache?: { read: number; write: number }
  total?: number
}

/** A git worktree created for a child session. */
export interface WorktreeHandle {
  name: string
  directory: string
  branch?: string
}

/** Input to {@link SessionBackend.createSession}. */
export interface CreateSessionInput {
  /** Id of the parent session this child session is forked under. */
  parentID: string
  /** Agent name to run the child session with. */
  agent: string
  /** Model reference in `provider/model-id` form. */
  model?: string
  /** Model variant/effort. */
  variant?: string
  /** Optional session title. */
  title?: string
  /** Workflow metadata attached to the created session. */
  metadata?: Record<string, unknown>
  /** Optional session permission rules. */
  permission?: PermissionRuleset
  /** Create a git worktree and open the session inside it. */
  worktree?: boolean | { name?: string }
}

/** Handle returned by {@link SessionBackend.createSession}. */
export interface ChildSessionHandle {
  sessionID: string
  /** Directory the session was created in (base dir or worktree). */
  directory: string
  /** Present when a worktree was created for this session. */
  worktree?: WorktreeHandle
}

/** Input to {@link SessionBackend.run}. */
export interface RunInput {
  sessionID: string
  /** Prompt text admitted to the child session. */
  prompt: string
  /** Optional JSON schema; when present, structured output is requested. */
  format?: JsonSchema
  /** Abort the run (and cancel the session) after this many milliseconds. */
  timeoutMs?: number
  /** External cancellation signal; aborting it cancels the session too. */
  signal?: AbortSignal
}

/** Result of a completed delegated run. */
export interface RunResult {
  sessionID: string
  /** Final assistant text of the completed message. */
  text: string
  /** Structured output when the model produced one for the requested schema. */
  structured?: unknown
  /** Provider cost aggregated across every assistant response in the turn. */
  cost?: number
  /** Token usage aggregated across every assistant response in the turn. */
  tokens?: TokenUsage
  /** Provider finish reason of the completed message. */
  finish?: string
  /** Files touched during the turn (deduplicated). */
  files: string[]
}

/**
 * Narrow contract consumed by the workflow engine. Implementations must be
 * safe to dispose and must tolerate concurrent `run` calls on distinct
 * sessions.
 */
export interface SessionBackend {
  /** Create a child session, optionally inside a fresh worktree. */
  createSession(input: CreateSessionInput): Promise<ChildSessionHandle>

  /** Prompt a child session asynchronously and wait for terminal completion. */
  run(input: RunInput): Promise<RunResult>

  /** Explicitly cancel an in-flight run (abort/interrupt the session). */
  cancel(sessionID: string): Promise<void>

  /**
   * Release a single child session after its node completes: cancel any
   * in-flight run and remove the session's worktree (when one was created),
   * without disposing the whole backend. Accepts either the handle returned
   * by `createSession` or a session id. Idempotent and non-throwing.
   */
  releaseSession(handleOrSessionID: ChildSessionHandle | string): Promise<void>

  /**
   * Release resources: abort any in-flight runs and remove every worktree
   * created by this backend. Idempotent and non-throwing.
   */
  dispose(): Promise<void>
}

/** Base class for all errors raised by the session backend. */
export class SessionBackendError extends Error {
  partialResult?: RunResult

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SessionBackendError"
  }

  withPartialResult(result: RunResult): this {
    this.partialResult = result
    return this
  }
}

/** A delegated run failed; carries the provider/engine error code. */
export class SessionRunError extends SessionBackendError {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = "SessionRunError"
    this.code = code
    this.details = details
  }
}

/** The model could not produce output matching the requested JSON schema. */
export class StructuredOutputError extends SessionBackendError {
  readonly retries?: number

  constructor(message: string, retries?: number) {
    super(message)
    this.name = "StructuredOutputError"
    this.retries = retries
  }
}

/** A run was cancelled (externally or by this backend). */
export class SessionCancelledError extends SessionBackendError {
  constructor(message = "session run cancelled") {
    super(message)
    this.name = "SessionCancelledError"
  }
}

/** A run exceeded its configured timeout and was cancelled. */
export class SessionTimeoutError extends SessionBackendError {
  readonly sessionID: string
  readonly timeoutMs: number

  constructor(sessionID: string, timeoutMs: number) {
    super(`session "${sessionID}" did not complete within ${timeoutMs}ms`)
    this.name = "SessionTimeoutError"
    this.sessionID = sessionID
    this.timeoutMs = timeoutMs
  }
}

/**
 * A structural result of any SDK call. The real `OpencodeClient` resolves each
 * call to `{ data, error, request, response }` (plus extra fields), while mocks
 * may return `{ data }`, `{ data, error }`, or a bare value. The backend
 * unwraps all of these before use.
 */
export interface EnvelopeResult<TError = unknown> {
  data?: unknown
  error?: TError
}

/** Parameters accepted by `session.create`. */
export interface SessionCreateParams {
  directory?: string
  workspace?: string
  parentID?: string
  title?: string
  agent?: string
  model?: ModelRef
  metadata?: Record<string, unknown>
  permission?: PermissionRuleset
  workspaceID?: string
}

/** Parameters accepted by `session.status`. */
export interface SessionStatusParams {
  directory?: string
  workspace?: string
}

/** Parameters accepted by `session.messages`. */
export interface SessionMessagesParams {
  sessionID: string
  directory?: string
  workspace?: string
  limit?: number
  before?: string
}

/** Parameters accepted by `session.abort`. */
export interface SessionAbortParams {
  sessionID: string
  directory?: string
  workspace?: string
}

/** Parameters accepted by the async prompt endpoint (`session.promptAsync`). */
export interface SessionPromptAsyncParams {
  sessionID: string
  directory?: string
  workspace?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  variant?: string
  format?: OutputFormat
  parts?: Array<TextPartInput>
}

/** Parameters accepted by the v2 `session.prompt` endpoint. */
export interface V2SessionPromptParams {
  sessionID: string
  id?: string
  prompt?: PromptInput
  delivery?: "steer" | "queue"
  resume?: boolean
  format?: OutputFormat
}

/** Parameters accepted by the v2 `session.messages` endpoint. */
export interface V2SessionMessagesParams {
  sessionID: string
  limit?: number
  order?: "asc" | "desc"
}

/** Parameters accepted by `worktree.create`. */
export interface WorktreeCreateParams {
  directory?: string
  workspace?: string
  worktreeCreateInput?: WorktreeCreateInput
}

/** Parameters accepted by `worktree.remove`. */
export interface WorktreeRemoveParams {
  directory?: string
  workspace?: string
  worktreeRemoveInput?: WorktreeRemoveInput
}

/**
 * The minimal opencode v2 client surface the backend depends on. Every member
 * is structural and optional except the core `session` group, so a plain mock
 * object satisfies it; a real {@link OpencodeClient} is assignable too (see the
 * compile-time assertion at the bottom of this file).
 */
export interface OpenCodeClientLike {
  /** v1-style session API exposed by the v2 client as `client.session`. */
  session: {
    create(params: SessionCreateParams): Promise<EnvelopeResult<SessionCreateError>>
    status(params?: SessionStatusParams): Promise<EnvelopeResult<SessionStatusError>>
    messages(params: SessionMessagesParams): Promise<EnvelopeResult<SessionMessagesError>>
    abort(params: SessionAbortParams): Promise<EnvelopeResult<SessionAbortError>>
    promptAsync?(params: SessionPromptAsyncParams): Promise<EnvelopeResult<SessionPromptAsyncError>>
  }
  /** v2 session API exposed by the v2 client as `client.v2.session`. */
  v2?: {
    session?: {
      prompt?(params: V2SessionPromptParams): Promise<EnvelopeResult<V2SessionPromptError>>
      wait?(params: { sessionID: string }): Promise<EnvelopeResult<V2SessionWaitError>>
      interrupt?(params: { sessionID: string }): Promise<EnvelopeResult<V2SessionInterruptError>>
      messages?(params: V2SessionMessagesParams): Promise<EnvelopeResult<V2SessionMessagesError>>
    }
  }
  /** Worktree API exposed by the v2 client as `client.worktree`. */
  worktree?: {
    create?(params: WorktreeCreateParams): Promise<EnvelopeResult<WorktreeCreateError>>
    remove?(params: WorktreeRemoveParams): Promise<EnvelopeResult<WorktreeRemoveError>>
  }
}

export interface OpenCodeSessionBackendOptions {
  /** Base project directory child sessions (and worktrees) live under. */
  directory: string
  /** Poll interval for the `session.status` idle fallback, in milliseconds. */
  pollIntervalMs?: number
  /** Grace period after idle for the completed message projection to appear. */
  resultWaitMs?: number
}

/** Admission record produced by the async prompt step. */
interface AdmissionInfo {
  transport: "queue" | "async"
  /** Id of the admitted user message, when the prompt API reports one. */
  messageID?: string
  /** Server-side admission timestamp (epoch ms), when reported. */
  timeCreated?: number
  /** Message ids that existed before a legacy prompt with no admission id. */
  priorMessageIDs?: Set<string>
}

interface SessionExecutionConfig {
  agent: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

/** Normalized view of a session message used for correlation. */
interface BackendMessage {
  id: string
  role: string
  created: number
  completed?: number
  text: string
  files: string[]
  parentID?: string
  cost?: number
  tokens?: TokenUsage
  finish?: string
  structured?: unknown
  error?: unknown
}

interface CompletedTurn {
  user?: BackendMessage
  assistants: BackendMessage[]
  assistant: BackendMessage
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const describeError = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

const requestStructuredOutput = (prompt: string, schema: JsonSchema): string =>
  `${prompt}\n\n<workflow-output-contract>\n${STRUCTURED_OUTPUT_PREAMBLE}\nJSON Schema:\n${JSON.stringify(schema, null, 2)}\n</workflow-output-contract>`

const structuredRepairPrompt = (error: StructuredOutputError): string =>
  `Repair only the format of your previous final response. Do not repeat the task or call tools again. The previous response failed validation with: ${error.message}`

const parseJsonResponse = (text: string): unknown => {
  const trimmed = text.trim()
  if (trimmed === "") {
    throw new StructuredOutputError("agent returned an empty final response; expected JSON")
  }

  const candidates = [trimmed]
  const wholeFence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (wholeFence?.[1] !== undefined) candidates.unshift(wholeFence[1].trim())
  const embeddedFences = [
    ...trimmed.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi),
  ]
  if (wholeFence === null && embeddedFences.length === 1 && embeddedFences[0][1] !== undefined) {
    candidates.push(embeddedFences[0][1].trim())
  }

  let lastError: unknown
  for (const candidate of [...new Set(candidates)]) {
    if (candidate === "") continue
    try {
      return JSON.parse(candidate)
    } catch (error) {
      lastError = error
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new StructuredOutputError(`agent final response was not valid JSON: ${detail}`)
}

const aggregateTokens = (entries: readonly (TokenUsage | undefined)[]): TokenUsage | undefined => {
  const values = entries.flatMap((entry) => entry === undefined ? [] : [entry])
  if (values.length === 0) return undefined
  const total: TokenUsage = {
    input: values.reduce((sum, value) => sum + value.input, 0),
    output: values.reduce((sum, value) => sum + value.output, 0),
  }
  if (values.some((value) => value.reasoning !== undefined)) {
    total.reasoning = values.reduce((sum, value) => sum + (value.reasoning ?? 0), 0)
  }
  if (values.some((value) => value.cache !== undefined)) {
    total.cache = {
      read: values.reduce((sum, value) => sum + (value.cache?.read ?? 0), 0),
      write: values.reduce((sum, value) => sum + (value.cache?.write ?? 0), 0),
    }
  }
  if (values.some((value) => value.total !== undefined)) {
    total.total = values.reduce(
      (sum, value) => sum + (value.total ?? value.input + value.output + (value.reasoning ?? 0)),
      0,
    )
  }
  return total
}

const aggregateCost = (values: readonly (number | undefined)[]): number | undefined =>
  values.some((value) => value !== undefined)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined

const mergeRunResults = (results: readonly RunResult[]): RunResult => {
  const final = results.at(-1)
  if (final === undefined) throw new SessionBackendError("cannot merge an empty run result list")
  return {
    ...final,
    cost: aggregateCost(results.map((result) => result.cost)),
    tokens: aggregateTokens(results.map((result) => result.tokens)),
    files: [...new Set(results.flatMap((result) => result.files))],
  }
}

const validateStructuredOutput = (
  schema: JsonSchema,
  text: string,
  nativeValue: unknown,
): unknown => {
  const value = nativeValue === undefined ? parseJsonResponse(text) : nativeValue
  let mismatch: string | undefined
  try {
    mismatch = explainJsonSchemaMismatch(schema, value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SessionBackendError(`invalid structured output schema: ${detail}`, { cause: error })
  }
  if (mismatch !== undefined) {
    throw new StructuredOutputError(`agent JSON did not match outputSchema: ${mismatch}`)
  }
  return value
}

const isUnavailableEndpoint = (error: unknown): boolean =>
  /not available yet|not implemented|unsupported/i.test(describeError(error))

/**
 * Turns a raw error value (SDK error object, thrown value, or error envelope)
 * into a typed {@link SessionBackendError}.
 */
const toRunError = (raw: unknown): SessionBackendError => {
  const record = isRecord(raw) ? raw : undefined
  const name = typeof record?.name === "string" ? record.name : undefined
  const tag = typeof record?._tag === "string" ? record._tag : undefined
  const data = isRecord(record?.data) ? record.data : undefined
  const detail = data?.message ?? record?.message
  const text = typeof detail === "string" && detail !== "" ? detail : describeError(raw)
  if (name === "StructuredOutputError") {
    return new StructuredOutputError(text, typeof data?.retries === "number" ? data.retries : undefined)
  }
  return new SessionRunError(name ?? tag ?? "run-error", text, raw)
}

/**
 * Unwraps an SDK response envelope `{ data, error }` (possibly double-nested as
 * `{ data: { data: ... } }`), tolerating bare values from mocks. Throws a typed
 * {@link SessionBackendError} when the envelope carries a non-null `error`.
 */
const unwrapPayload = <T>(response: unknown): T => {
  let current: unknown = response
  for (let depth = 0; depth < 3; depth++) {
    if (!isRecord(current)) break
    if (current.error !== undefined && current.error !== null) {
      throw toRunError(current.error)
    }
    if ("data" in current) {
      current = current.data
      continue
    }
    break
  }
  return current as T
}

/** Returns the abort reason as an Error, wrapping non-Error reasons. */
const reasonOf = (signal: AbortSignal): Error => {
  const reason = signal.reason
  return reason instanceof Error ? reason : new SessionCancelledError("session run aborted")
}

/**
 * Runs `task` and rejects with the abort reason if `signal` aborts first.
 * Resolves only when the task itself settles.
 */
const abortable = <T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reasonOf(signal))
    if (signal.aborted) {
      reject(reasonOf(signal))
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
    let settled = false
    task().then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })

/** Sleeps for `ms`, resolving early (not rejecting) when `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })

/** Builds an SDK {@link ModelRef} from a `provider/model-id` string. */
const toModelRef = (model: string | undefined, variant: string | undefined): ModelRef | undefined => {
  if (model === undefined) return undefined
  const sep = model.indexOf("/")
  if (sep <= 0 || sep === model.length - 1) {
    throw new SessionBackendError(`invalid model reference "${model}" (expected provider/model-id)`)
  }
  // The SDK's ModelRef splits the reference: `id` is the model id only (text
  // after the first slash, which itself may contain slashes for gateway
  // routes) and `providerID` is the text before the first slash.
  const ref: ModelRef = { id: model.slice(sep + 1), providerID: model.slice(0, sep) }
  if (variant !== undefined) ref.variant = variant
  return ref
}

const isTextPart = (part: Part): part is TextPart => part.type === "text"
const isPatchPart = (part: Part): part is PatchPart => part.type === "patch"

type V2ContentPart = SessionMessageAssistant["content"][number]

const isV2TextPart = (part: V2ContentPart): part is SessionMessageAssistantText => part.type === "text"

/** Normalizes v1 `session.messages` entries (`{ info, parts }`). */
const normalizeV1Messages = (raw: Array<{ info: Message; parts: Part[] }>): BackendMessage[] =>
  raw.map(({ info, parts }) => {
    const text = parts.filter(isTextPart).map((part) => part.text).join("")
    if (info.role === "user") {
      const diffs = info.summary?.diffs ?? []
      return {
        id: info.id,
        role: "user",
        created: info.time.created,
        text,
        files: [
          ...new Set(
            diffs
              .map((diff) => diff.file)
              .filter((file): file is string => file !== undefined),
          ),
        ],
      }
    }
    return {
      id: info.id,
      role: "assistant",
      created: info.time.created,
      completed: info.time.completed,
      text,
      files: [...new Set(parts.filter(isPatchPart).flatMap((part) => part.files))],
      parentID: info.parentID,
      cost: info.cost,
      tokens: info.tokens,
      finish: info.finish,
      structured: info.structured,
      error: info.error,
    }
  })

/** Normalizes v2 `session.messages` entries into the internal message shape. */
const normalizeV2Messages = (raw: SessionMessagesResponse): BackendMessage[] =>
  raw.data.map((message: SessionMessage) => {
    if (message.type === "assistant") {
      const text = message.content.filter(isV2TextPart).map((part) => part.text).join("")
      return {
        id: message.id,
        role: "assistant",
        created: message.time.created,
        completed: message.time.completed,
        text,
        files: [...new Set(message.snapshot?.files ?? [])],
        cost: message.cost,
        tokens: message.tokens,
        finish: message.finish,
        error: message.error,
      }
    }
    const text = message.type === "user" ? message.text : ""
    return { id: message.id, role: message.type, created: message.time.created, text, files: [] }
  })

/**
 * The production {@link SessionBackend} backed by an injected opencode v2
 * client-like object.
 */
export class OpenCodeSessionBackend implements SessionBackend {
  private readonly client: OpenCodeClientLike
  private readonly options: { directory: string; pollIntervalMs: number; resultWaitMs: number }
  private readonly worktrees = new Map<string, WorktreeHandle>()
  private readonly sessionDirs = new Map<string, string>()
  private readonly sessionExecution = new Map<string, SessionExecutionConfig>()
  private readonly promptedSessions = new Set<string>()
  private readonly running = new Set<string>()
  private disposed = false

  constructor(client: OpenCodeClientLike, options: OpenCodeSessionBackendOptions) {
    if (!client || typeof client !== "object" || !client.session || typeof client.session !== "object") {
      throw new SessionBackendError(
        "OpenCodeSessionBackend requires a client-like object exposing session methods",
      )
    }
    if (typeof options.directory !== "string" || options.directory === "") {
      throw new SessionBackendError("OpenCodeSessionBackend requires a non-empty base directory")
    }
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
      throw new SessionBackendError(`pollIntervalMs must be a positive number, got ${options.pollIntervalMs}`)
    }
    const resultWaitMs = options.resultWaitMs ?? DEFAULT_RESULT_WAIT_MS
    if (!Number.isFinite(resultWaitMs) || resultWaitMs < 1) {
      throw new SessionBackendError(`resultWaitMs must be a positive number, got ${options.resultWaitMs}`)
    }
    this.client = client
    this.options = { directory: options.directory, pollIntervalMs, resultWaitMs }
  }

  async createSession(input: CreateSessionInput): Promise<ChildSessionHandle> {
    this.assertActive()
    const { parentID, agent, model, variant, title, metadata, permission } = input
    if (typeof parentID !== "string" || parentID === "") {
      throw new SessionBackendError("createSession requires a non-empty parentID")
    }
    if (typeof agent !== "string" || agent === "") {
      throw new SessionBackendError("createSession requires a non-empty agent")
    }

    let directory = this.options.directory
    let worktreeHandle: WorktreeHandle | undefined
    if (input.worktree !== undefined && input.worktree !== false) {
      worktreeHandle = await this.createWorktree(input.worktree === true ? {} : input.worktree)
      directory = worktreeHandle.directory
    }

    try {
      const modelRef = toModelRef(model, variant)
      const session = unwrapPayload<Session>(
        await this.client.session.create({
          directory,
          parentID,
          title,
          agent,
          model: modelRef,
          metadata,
          permission,
        }),
      )
      if (!session || typeof session.id !== "string" || session.id === "") {
        throw new SessionBackendError("session.create returned no session id")
      }
      this.sessionDirs.set(session.id, directory)
      this.sessionExecution.set(session.id, {
        agent,
        model: modelRef ? { providerID: modelRef.providerID, modelID: modelRef.id } : undefined,
        variant,
      })
      return { sessionID: session.id, directory, worktree: worktreeHandle }
    } catch (error) {
      if (worktreeHandle) {
        try {
          await this.removeWorktree(worktreeHandle)
        } catch {
          // Best-effort: the session create failed; do not mask that failure.
        }
        this.worktrees.delete(worktreeHandle.directory)
      }
      throw error
    }
  }

  async run(input: RunInput): Promise<RunResult> {
    this.assertActive()
    const { sessionID, prompt, format, timeoutMs, signal } = input
    if (typeof sessionID !== "string" || sessionID === "") {
      throw new SessionBackendError("run requires a non-empty sessionID")
    }
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new SessionBackendError(`timeoutMs must be a non-negative finite number, got ${timeoutMs}`)
    }

    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort(new SessionTimeoutError(sessionID, timeoutMs))
      }, timeoutMs)
    }
    const onExternalAbort = () => {
      if (controller.signal.aborted) return
      const reason = signal?.reason
      controller.abort(reason instanceof Error ? reason : new SessionCancelledError("run cancelled by caller"))
    }
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener("abort", onExternalAbort, { once: true })
    }

    this.running.add(sessionID)
    try {
      const directory = this.sessionDirs.get(sessionID) ?? this.options.directory
      const results: RunResult[] = []
      let nextPrompt = format === undefined ? prompt : requestStructuredOutput(prompt, format)
      for (let repairAttempt = 0; ; repairAttempt++) {
        const turn = await this.executePrompt(sessionID, nextPrompt, directory, controller.signal)
        const result = this.buildResult(sessionID, turn)
        results.push(result)
        try {
          this.throwIfFailed(turn.assistant)
          if (format !== undefined) {
            result.structured = validateStructuredOutput(format, result.text, result.structured)
          } else if (result.text.trim() === "") {
            throw new SessionRunError(
              "empty-final-response",
              `agent returned an empty terminal response for session "${sessionID}"`,
            )
          }
          return mergeRunResults(results)
        } catch (error) {
          if (
            format === undefined ||
            !(error instanceof StructuredOutputError) ||
            repairAttempt >= STRUCTURED_REPAIR_ATTEMPTS
          ) {
            if (error instanceof SessionBackendError && results.length > 0) {
              error.withPartialResult(mergeRunResults(results))
            }
            throw error
          }
          nextPrompt = requestStructuredOutput(structuredRepairPrompt(error), format)
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await this.cancel(sessionID).catch(() => {})
        const reason = controller.signal.reason
        if (reason instanceof Error) throw reason
        if (timedOut) throw new SessionTimeoutError(sessionID, timeoutMs ?? 0)
        throw new SessionCancelledError("session run cancelled")
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onExternalAbort)
      this.running.delete(sessionID)
    }
  }

  async cancel(sessionID: string): Promise<void> {
    if (typeof sessionID !== "string" || sessionID === "") {
      throw new SessionBackendError("cancel requires a non-empty sessionID")
    }
    const v2 = this.client.v2?.session
    if (v2?.interrupt) {
      await unwrapPayload<void>(await v2.interrupt({ sessionID }))
    } else {
      await unwrapPayload<boolean>(
        await this.client.session.abort({
          sessionID,
          directory: this.sessionDirs.get(sessionID) ?? this.options.directory,
        }),
      )
    }
    await this.waitForStopped(sessionID, this.sessionDirs.get(sessionID) ?? this.options.directory)
  }

  async releaseSession(handleOrSessionID: ChildSessionHandle | string): Promise<void> {
    const sessionID =
      typeof handleOrSessionID === "string" ? handleOrSessionID : handleOrSessionID.sessionID
    const directory =
      typeof handleOrSessionID === "string"
        ? this.sessionDirs.get(handleOrSessionID)
        : handleOrSessionID.directory
    const worktree =
      typeof handleOrSessionID === "object" && handleOrSessionID.worktree
        ? handleOrSessionID.worktree
        : directory !== undefined
          ? this.worktrees.get(directory)
          : undefined
    if (this.running.has(sessionID)) {
      try {
        await this.cancel(sessionID)
      } catch {
        // Best-effort cancellation when releasing a session.
      }
    }
    if (worktree) {
      try {
        await this.removeWorktree(worktree)
      } catch {
        // Best-effort cleanup when releasing a session.
      }
      this.worktrees.delete(worktree.directory)
    }
    if (sessionID !== "") {
      this.sessionDirs.delete(sessionID)
      this.sessionExecution.delete(sessionID)
      this.promptedSessions.delete(sessionID)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const sessionID of [...this.running]) {
      try {
        await this.cancel(sessionID)
      } catch {
        // Best-effort cancellation during teardown.
      }
    }
    for (const handle of [...this.worktrees.values()]) {
      try {
        await this.removeWorktree(handle)
      } catch {
        // Best-effort cleanup during teardown.
      }
    }
    this.running.clear()
    this.worktrees.clear()
    this.sessionDirs.clear()
    this.sessionExecution.clear()
    this.promptedSessions.clear()
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new SessionBackendError("OpenCodeSessionBackend has been disposed")
    }
  }

  private async createWorktree(input: { name?: string }): Promise<WorktreeHandle> {
    const worktreeClient = this.client.worktree
    if (!worktreeClient?.create) {
      throw new SessionBackendError(
        "worktree isolation requested but the OpenCode client has no worktree.create",
      )
    }
    const worktree = unwrapPayload<Worktree>(
      await worktreeClient.create({
        directory: this.options.directory,
        worktreeCreateInput: input.name !== undefined ? { name: input.name } : {},
      }),
    )
    if (!worktree || typeof worktree.directory !== "string" || worktree.directory === "") {
      throw new SessionBackendError("worktree.create returned no worktree directory")
    }
    const handle: WorktreeHandle = { name: worktree.name, directory: worktree.directory }
    if (worktree.branch !== undefined) handle.branch = worktree.branch
    this.worktrees.set(handle.directory, handle)
    return handle
  }

  private async removeWorktree(handle: WorktreeHandle): Promise<void> {
    const worktreeClient = this.client.worktree
    if (!worktreeClient?.remove) return
    await unwrapPayload<void>(
      await worktreeClient.remove({
        directory: this.options.directory,
        worktreeRemoveInput: { directory: handle.directory },
      }),
    )
  }

  private async waitForStopped(sessionID: string, directory: string): Promise<void> {
    const deadline = Date.now() + this.options.resultWaitMs
    const signal = new AbortController().signal
    for (;;) {
      const statuses = unwrapPayload<Record<string, SessionStatus>>(
        await this.client.session.status({ directory }),
      )
      const status = statuses?.[sessionID]
      if (status === undefined || status.type === "idle") return
      if (Date.now() >= deadline) {
        throw new SessionBackendError(
          `session "${sessionID}" did not confirm cancellation within ${this.options.resultWaitMs}ms`,
        )
      }
      await sleep(this.options.pollIntervalMs, signal)
    }
  }

  private async promptAsync(
    sessionID: string,
    text: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<AdmissionInfo> {
    const execution = this.sessionExecution.get(sessionID)
    const legacyPrompt = async () => {
      if (!this.client.session.promptAsync) {
        throw new SessionBackendError(
          "OpenCode client exposes no session.promptAsync endpoint",
        )
      }
      await abortable(
        async () => {
          unwrapPayload<void>(await this.client.session.promptAsync!({
            sessionID,
            directory,
            agent: execution?.agent,
            model: execution?.model,
            variant: execution?.variant,
            parts: [{ type: "text", text }],
          }))
        },
        signal,
      )
      return { transport: "async" } as AdmissionInfo
    }
    // OpenCode 1.18's queued v2 prompt does not carry child agent/model
    // selection. For sessions created here, use promptAsync so execution uses
    // the exact configured agent, model, and variant.
    if (execution && this.client.session.promptAsync) {
      return legacyPrompt()
    }
    const v2 = this.client.v2?.session
    if (v2?.prompt) {
      const admitted = await abortable(
        async () =>
          unwrapPayload<SessionInputAdmitted>(
            await v2.prompt!({ sessionID, prompt: { text }, delivery: "queue" }),
          ),
        signal,
      )
      return { transport: "queue", messageID: admitted?.id, timeCreated: admitted?.timeCreated }
    }
    if (this.client.session.promptAsync) return legacyPrompt()
    throw new SessionBackendError(
      "OpenCode client exposes no asynchronous prompt API (v2 session.prompt or session.promptAsync)",
    )
  }

  private async executePrompt(
    sessionID: string,
    prompt: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<CompletedTurn> {
    const usesLegacyPrompt =
      (this.sessionExecution.has(sessionID) && this.client.session.promptAsync !== undefined) ||
      !this.client.v2?.session?.prompt
    const needsBaseline = this.promptedSessions.has(sessionID) && usesLegacyPrompt
    const priorMessageIDs = needsBaseline
      ? new Set((await this.readMessages(sessionID, directory, signal)).map((message) => message.id))
      : undefined
    this.promptedSessions.add(sessionID)
    const admission = await this.promptAsync(sessionID, prompt, directory, signal)
    admission.priorMessageIDs = priorMessageIDs
    await this.waitForIdle(sessionID, directory, admission, signal)
    return this.readCompletedTurn(sessionID, directory, admission, signal)
  }

  private async waitForIdle(
    sessionID: string,
    directory: string,
    admission: AdmissionInfo,
    signal: AbortSignal,
  ): Promise<void> {
    const v2 = this.client.v2?.session
    if (admission.transport === "queue" && v2?.wait) {
      try {
        await abortable(async () => {
          await unwrapPayload<void>(await v2.wait!({ sessionID }))
        }, signal)
        return
      } catch (error) {
        if (!isUnavailableEndpoint(error)) throw error
      }
    }
    let observedRunning = false
    const startupDeadline = Date.now() + this.options.resultWaitMs
    let firstMissingStatus = true
    let lastReadError: unknown
    for (;;) {
      if (signal.aborted) throw reasonOf(signal)
      const statuses = await abortable(
        async () =>
          unwrapPayload<Record<string, SessionStatus>>(
            await this.client.session.status({ directory }),
          ),
        signal,
      )
      const status = statuses?.[sessionID]
      if (status?.type === "idle") return
      if (status !== undefined) {
        observedRunning = true
      } else if (observedRunning) {
        return
      } else {
        // promptAsync returns before OpenCode necessarily registers the child
        // as busy. Give status one poll to catch up, then use messages as the
        // terminal signal. Projection/decoding failures during this startup
        // window are transient and retried for the same bounded grace period.
        if (firstMissingStatus) {
          firstMissingStatus = false
        } else {
          try {
            const turn = this.correlate(await this.readMessages(sessionID, directory, signal), admission)
            if (turn.assistant?.completed !== undefined) return
            lastReadError = undefined
          } catch (error) {
            lastReadError = error
          }
        }
        if (Date.now() >= startupDeadline) {
          if (lastReadError !== undefined) throw lastReadError
          return
        }
      }
      await sleep(this.options.pollIntervalMs, signal)
    }
  }

  private async readMessages(
    sessionID: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<BackendMessage[]> {
    if (this.client.session.messages) {
      const raw = await abortable(
        async () =>
          unwrapPayload<Array<{ info: Message; parts: Part[] }>>(
            await this.client.session.messages({ sessionID, directory }),
          ),
        signal,
      )
      return normalizeV1Messages(raw)
    }
    if (!this.client.v2?.session?.messages) {
      throw new SessionBackendError("OpenCode client exposes no session.messages API")
    }
    const raw = await abortable(
      async () => unwrapPayload<SessionMessagesResponse>(await this.client.v2!.session!.messages!({ sessionID })),
      signal,
    )
    return normalizeV2Messages(raw)
  }

  private async readCompletedTurn(
    sessionID: string,
    directory: string,
    admission: AdmissionInfo,
    signal: AbortSignal,
  ): Promise<CompletedTurn> {
    const deadline = Date.now() + this.options.resultWaitMs
    let lastReadError: unknown
    for (;;) {
      try {
        const messages = await this.readMessages(sessionID, directory, signal)
        const turn = this.correlate(messages, admission)
        if (
          turn.assistant?.completed !== undefined &&
          !admission.priorMessageIDs?.has(turn.assistant.id)
        ) {
          return { user: turn.user, assistants: turn.assistants, assistant: turn.assistant }
        }
        lastReadError = undefined
      } catch (error) {
        lastReadError = error
      }
      if (Date.now() >= deadline) {
        if (lastReadError !== undefined) throw lastReadError
        throw new SessionBackendError(
          `no completed assistant message found for session "${sessionID}" after prompt`,
        )
      }
      await sleep(this.options.pollIntervalMs, signal)
    }
  }

  /**
   * Correlates the assistant message that answers the admitted prompt. The
   * admitted user message is located by id (when the prompt API reports one),
   * then by admission time, then by falling back to the most recent user
   * message. The terminal assistant message is the last response before the
   * next user message; all responses in that turn are retained for usage.
   */
  private correlate(messages: BackendMessage[], admission: AdmissionInfo): {
    user?: BackendMessage
    assistants: BackendMessage[]
    assistant?: BackendMessage
  } {
    let userIndex = -1
    if (admission.messageID !== undefined) {
      userIndex = messages.findIndex((m) => m.role === "user" && m.id === admission.messageID)
    }
    const admissionTime = admission.timeCreated
    if (userIndex === -1 && admissionTime !== undefined) {
      userIndex = messages.findIndex((m) => m.role === "user" && m.created >= admissionTime)
    }
    if (userIndex === -1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          userIndex = i
          break
        }
      }
    }
    const user = userIndex >= 0 ? messages[userIndex] : undefined

    let assistants: BackendMessage[] = []
    if (user !== undefined) {
      let end = messages.length
      for (let i = userIndex + 1; i < messages.length; i++) {
        if (messages[i].role === "user") {
          end = i
          break
        }
      }
      assistants = messages.slice(userIndex + 1, end).filter((m) => m.role === "assistant")
    }
    if (assistants.length === 0) {
      const floor = admission.timeCreated ?? user?.created ?? 0
      assistants = messages.filter((m) => m.role === "assistant" && m.created >= floor)
    }
    return { user, assistants, assistant: assistants.at(-1) }
  }

  private throwIfFailed(message: BackendMessage): void {
    if (message.error !== undefined && message.error !== null) {
      throw toRunError(message.error)
    }
    if (message.finish === "error") {
      throw new SessionRunError(
        "message-error",
        `agent finished with an error for session "${message.id}"`,
      )
    }
  }

  private buildResult(
    sessionID: string,
    turn: CompletedTurn,
  ): RunResult {
    const assistant = turn.assistant
    const files = [...new Set([
      ...(turn.user?.files ?? []),
      ...turn.assistants.flatMap((message) => message.files),
    ])]
    return {
      sessionID,
      text: assistant.text,
      structured: assistant.structured,
      cost: aggregateCost(turn.assistants.map((message) => message.cost)),
      tokens: aggregateTokens(turn.assistants.map((message) => message.tokens)),
      finish: assistant.finish,
      files,
    }
  }
}

/**
 * Compile-time assertion that the real opencode v2 client keeps satisfying the
 * narrow {@link OpenCodeClientLike} surface. If the SDK drifts, this fails the
 * typecheck instead of failing at runtime.
 */
type AssertClientAssignable<C extends true> = C
type _Check = AssertClientAssignable<[OpencodeClient] extends [OpenCodeClientLike] ? true : false>
