/**
 * Workflow IR v1 type definitions.
 *
 * The workflow intermediate representation is a JSON-serializable description
 * of a multi-step agent pipeline. Steps compose: leaf steps (`agent`,
 * `synthesize`) invoke an agent, container steps (`sequence`, `parallel`,
 * `map`, `loop`, `branch`) hold child steps, and `synthesize` aggregates the
 * outputs of prior steps. Steps reference prior values with a restricted
 * dotted/index path syntax (see `parseReference` in schema.ts).
 *
 * Everything in this file is a type-only module. It is imported by
 * `schema.ts` and can be consumed by callers of `validateWorkflowSpec`.
 */

export const WORKFLOW_VERSION = 1 as const
export type WorkflowVersion = typeof WORKFLOW_VERSION

export const STEP_TYPES = [
  "agent",
  "sequence",
  "parallel",
  "map",
  "loop",
  "branch",
  "synthesize",
] as const
export type StepType = (typeof STEP_TYPES)[number]

/** A light structural description of an agent's expected output. */
export type JsonSchema = Record<string, unknown>

/** Top-level execution limits shared by the whole workflow. */
export interface WorkflowLimits {
  /** Maximum steps of a single container (or the root) running concurrently. */
  maxParallel?: number
  /** Maximum number of agents active at once across the workflow. */
  maxAgents?: number
  /** Upper bound for `loop` iterations and `map` element expansion. */
  maxIterations?: number
  /** Optional total token budget for the workflow. */
  maxTokens?: number
  /** Optional total cost budget for the workflow. */
  maxCost?: number
  /** Optional absolute deadline as an ISO 8601 date-time string. */
  deadline?: string
}

/** A declared, named phase that steps may belong to. */
export interface PhaseSpec {
  label: string
  description?: string
}

/**
 * Hard constraints applied by the host embedding the workflow. An optional
 * argument to `validateWorkflowSpec`; it narrows allowed agents/models and
 * caps the top-level limits.
 */
export interface Policy {
  /** If set, `agent` steps may only name agents in this list. */
  agents?: string[]
  /** If set, steps may only name models in this list. */
  models?: string[]
  maxParallel?: number
  maxAgents?: number
  maxIterations?: number
  maxTokens?: number
  maxCost?: number
}

/** Fields every step shares regardless of its `type`. */
export interface StepBase {
  /** Globally unique step id, also the root of references to this step. */
  id: string
  /** Human-readable label shown in traces. */
  label?: string
  /** Optional declared phase (see `WorkflowSpecV1.phases`). */
  phase?: string
  /** Optional free-form labels attached to the step. */
  labels?: string[]
  /** Explicit ids of steps that must complete before this step runs. */
  dependsOn?: string[]
}

/**
 * A reference operand inside a condition: a restricted path to a prior value.
 */
export interface RefOperand {
  $ref: string
}

/**
 * Operand of a binary comparison: either a literal JSON scalar or a reference
 * to a prior value.
 */
export type Operand = null | boolean | number | string | RefOperand

/**
 * A restricted, JSON-serializable predicate used by `branch` (per case) and
 * `loop` (`until`). Exactly one operator key is present on a condition object.
 * No arbitrary expressions or code are allowed.
 */
export interface Condition {
  /** Truthiness of the referenced value. */
  $ref?: string
  $eq?: [Operand, Operand]
  $ne?: [Operand, Operand]
  $lt?: [Operand, Operand]
  $lte?: [Operand, Operand]
  $gt?: [Operand, Operand]
  $gte?: [Operand, Operand]
  /** All sub-conditions must hold. */
  $and?: Condition[]
  /** At least one sub-condition must hold. */
  $or?: Condition[]
  /** Negation of a single sub-condition. */
  $not?: Condition
}

/** Runs a single agent with the given prompt and metadata. */
export interface AgentStep extends StepBase {
  type: "agent"
  /** Agent name to dispatch; policy-constrained when a policy is supplied. */
  agent: string
  /** Optional explicit model reference (e.g. "provider/model-id"). */
  model?: string
  /** Optional model variant/effort. */
  variant?: string
  /** Prompt template; may embed `{{ reference }}` tokens. */
  prompt: string
  /** Optional expected-output schema, validated structurally. */
  outputSchema?: JsonSchema
  /** Number of retries after a failed run (>= 0). */
  retry?: number
  /** Per-step timeout in seconds (> 0). */
  timeout?: number
  /** Run the agent in an isolated session/context. */
  isolation?: boolean
}

/** Runs child steps in order, each waiting on the previous one. */
export interface SequenceStep extends StepBase {
  type: "sequence"
  steps: Step[]
}

/** Runs child steps concurrently, up to `maxParallel` at a time. */
export interface ParallelStep extends StepBase {
  type: "parallel"
  steps: Step[]
  /** Per-node concurrency cap, bounded by the workflow `maxParallel`. */
  maxParallel?: number
}

/** Maps over the array produced by a prior step, running `steps` per element. */
export interface MapStep extends StepBase {
  type: "map"
  /** Reference to the array to iterate. */
  over: string
  /** Loop variable name usable in body templates. */
  as: string
  steps: Step[]
  /** Per-map concurrency cap, bounded by the workflow `maxParallel`. */
  maxParallel?: number
}

/** Loops over an array, or until a condition holds, running `steps` per pass. */
export interface LoopStep extends StepBase {
  type: "loop"
  /** Reference to the array to iterate; required when `as` is set. */
  over?: string
  /** Loop variable name usable in body templates. */
  as?: string
  /** Optional stop condition evaluated with the loop variable in scope. */
  until?: Condition
  steps: Step[]
  /** Per-loop iteration cap, bounded by the workflow `maxIterations`. */
  maxIterations?: number
}

/** A single guarded case of a `branch` step. */
export interface BranchCase {
  /** Id unique within the enclosing branch. */
  id: string
  /** Guard evaluated against prior values; cases run in order. */
  when: Condition
  steps: Step[]
}

/** Evaluates `cases` in order, running the first matching case's steps. */
export interface BranchStep extends StepBase {
  type: "branch"
  cases: BranchCase[]
  /** Steps run when no case matches. */
  otherwise?: Step[]
}

/** Aggregates prior values into a final artifact through an agent. */
export interface SynthesizeStep extends StepBase {
  type: "synthesize"
  /** Prompt template; may embed `{{ reference }}` tokens. */
  prompt: string
  /** Optional agent name to dispatch the aggregation to. */
  agent?: string
  model?: string
  variant?: string
  /** Explicit references to the values being synthesized. */
  input?: string[]
  outputSchema?: JsonSchema
  retry?: number
  timeout?: number
  isolation?: boolean
}

export type Step =
  | AgentStep
  | SequenceStep
  | ParallelStep
  | MapStep
  | LoopStep
  | BranchStep
  | SynthesizeStep

/** The top-level, JSON-serializable workflow specification (v1). */
export interface WorkflowSpecV1 {
  version: 1
  /** Optional workflow name. */
  name?: string
  /** Optional workflow description. */
  description?: string
  /** Declared phases that steps may reference via their `phase` field. */
  phases?: Record<string, PhaseSpec>
  /** Optional free-form labels for the workflow as a whole. */
  labels?: string[]
  limits?: WorkflowLimits
  /** Root steps; run in order. */
  steps: Step[]
}

/** A successfully parsed reference, split into its root and path segments. */
export interface ParsedReference {
  /** First path segment: a step id or an in-scope loop variable. */
  root: string
  /** Remaining object-key/index segments (numeric strings for indices). */
  segments: string[]
  /** The original reference text. */
  raw: string
}

/** Limits after defaults are applied and policy caps are enforced. */
export interface ResolvedLimits {
  maxParallel: number
  maxAgents: number
  maxIterations: number
  maxTokens?: number
  maxCost?: number
  deadline?: string
}

/**
 * The immutable normalized result of `validateWorkflowSpec`. Every nested
 * object and array is deeply frozen.
 */
export interface NormalizedWorkflow {
  /** Deep-frozen spec copy with defaults filled in. */
  spec: Readonly<WorkflowSpecV1>
  version: 1
  /** All steps (nested included), in definition order. */
  steps: ReadonlyArray<Readonly<Step>>
  /** Lookup of every step by id. */
  byId: Readonly<Record<string, Readonly<Step>>>
  /** A valid execution order produced by topological sort of dependencies. */
  order: ReadonlyArray<string>
  /** For each step id, the ids of steps that must complete before it. */
  dependencies: Readonly<Record<string, ReadonlyArray<string>>>
  /** Reverse of `dependencies`. */
  dependents: Readonly<Record<string, ReadonlyArray<string>>>
  /** Resolved top-level limits (defaults filled, policy caps applied). */
  limits: Readonly<ResolvedLimits>
}

/** Thrown for any invalid spec, reference, or resolve operation. */
export class WorkflowValidationError extends Error {
  /** JSON-ish path of the offending value (e.g. "steps[2].prompt"). */
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "WorkflowValidationError"
    this.path = path
  }
}
