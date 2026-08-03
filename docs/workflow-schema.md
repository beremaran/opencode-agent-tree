# Workflow IR v1

Workflow IR v1 is a strict, JSON-serializable execution plan interpreted by `WorkflowScheduler`. Unknown keys, unsafe references, dependency cycles, invalid bounds, and disallowed agents or models are rejected before a run is created.

## Top Level

```ts
type WorkflowSpecV1 = {
  version: 1
  name?: string
  description?: string
  labels?: string[]
  phases?: Record<string, { label: string; description?: string }>
  limits?: WorkflowLimits
  steps: Step[]
}
```

Root steps execute in sequence.

## Limits

```ts
type WorkflowLimits = {
  maxParallel?: number
  maxAgents?: number
  maxIterations?: number
  maxTokens?: number
  maxCost?: number
  deadline?: string
}
```

Plugin configuration provides hard policy ceilings. A specification may lower those values but cannot exceed them.

`maxAgents` counts every child session, including retry attempts and worktree integration workers. `maxTokens` counts input, output, and reasoning tokens reported by completed sessions.

These six names are the complete top-level limit contract. `maxSteps` and `maxDurationMin` are not supported.

## Common Step Fields

```ts
type StepBase = {
  id: string
  label?: string
  phase?: string
  labels?: string[]
  dependsOn?: string[]
}
```

Step IDs are globally unique. `input` is reserved for invocation data.

## Agent

```ts
type AgentStep = StepBase & {
  type: "agent"
  agent: string
  prompt: string
  model?: string
  variant?: string
  outputSchema?: Record<string, unknown>
  retry?: number
  timeout?: number
  isolation?: boolean
}
```

`timeout` is seconds. `retry` is the number of fresh-session retries after the first attempt. `isolation` creates a worktree; changed worktrees are integrated serially before the step completes.

## Synthesize

```ts
type SynthesizeStep = StepBase & {
  type: "synthesize"
  prompt: string
  agent?: string
  model?: string
  variant?: string
  input?: string[]
  outputSchema?: Record<string, unknown>
  retry?: number
  timeout?: number
  isolation?: boolean
}
```

`input` contains explicit prior-result references. Prompt references are also tracked as dependencies.

## Structured Outputs

`outputSchema` must be a complete, valid JSON Schema object with a top-level string `type`. A shorthand field map such as `{ "profile": "object" }` is not a schema and is rejected during workflow validation.

The plugin appends the schema as a final-response contract, parses the completed response as JSON, and validates the value locally. It deliberately does not use OpenCode's provider-native `json_schema` output mode, which keeps structured workflow steps compatible with thinking models that reject forced tool choice. A non-JSON response or schema mismatch raises a structured-output error and participates in the step's normal `retry` policy.

## Sequence And Parallel

```ts
type SequenceStep = StepBase & {
  type: "sequence"
  steps: Step[]
}

type ParallelStep = StepBase & {
  type: "parallel"
  steps: Step[]
  maxParallel?: number
}
```

Sequence children are ordered. Parallel children run concurrently unless an explicit dependency or prompt reference requires a sibling result.

## Map

```ts
type MapStep = StepBase & {
  type: "map"
  over: string
  as: string
  maxParallel?: number
  steps: Step[]
}
```

`over` must resolve to an array. Each iteration receives its item through `as`. Body steps are sequential within one iteration, while iterations fan out under the map and workflow concurrency caps.

Repeated body results are aggregated by static step ID in source-array order.

## Branch

```ts
type BranchStep = StepBase & {
  type: "branch"
  cases: Array<{ id: string; when: Condition; steps: Step[] }>
  otherwise?: Step[]
}
```

Cases are checked in order. Only the first matching case executes.

## Loop

```ts
type LoopStep = StepBase & {
  type: "loop"
  over?: string
  as?: string
  until?: Condition
  maxIterations?: number
  steps: Step[]
}
```

With `over`, loop iterations consume an array sequentially. Without `over`, the body repeats up to `maxIterations`. `until` is checked after each body and may reference body outputs. An unmet `until` or oversized input fails rather than silently truncating work.

## References

References use a restricted path grammar:

```text
root.segment[0].nested
```

Valid roots are prior step IDs, `input`, or an in-scope map/loop variable. References cannot execute expressions.

Prompt interpolation stringifies values safely:

```text
Audit {{ item.path }} for {{ input.issueType }}.
```

Strings are inserted directly. Scalars use their string form. Objects and arrays use JSON.

## Conditions

Exactly one operator is allowed per condition object:

```json
{ "$ref": "classify.accepted" }
{ "$eq": [{ "$ref": "classify.kind" }, "bug"] }
{ "$gte": [{ "$ref": "attempt.score" }, 8] }
{ "$and": [{ "$ref": "a" }, { "$not": { "$ref": "b" } }] }
```

Supported operators are `$ref`, `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$and`, `$or`, and `$not`. Equality is strict structural JSON equality. Ordering requires finite numbers.

## Resume Fingerprints

Agent leaves are cached within a run using an execution fingerprint derived from:

- Static step ID.
- Fully rendered prompt.
- Effective agent, model, and variant.
- Output schema.
- Isolation mode.
- Invocation input.

A completed instance is replayed only when its fingerprint matches exactly. Dynamic map and loop instances use deterministic instance keys, so completed iterations survive interruption.
