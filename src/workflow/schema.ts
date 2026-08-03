/**
 * Strict runtime validation and normalization for the workflow IR v1.
 *
 * `validateWorkflowSpec` performs a full static pass over a JSON-serializable
 * spec: shape and allowlisted keys, globally unique step ids, reference
 * existence and "prior value" rules (no self/ancestor/descendant references),
 * dependency cycle detection, numeric bounds, safe prompt templates, phase and
 * label checks, and optional policy constraints. The normalized result is
 * deeply frozen so it can be shared across runtimes without mutation.
 *
 * No arbitrary code is ever executed: templates only interpolate `{{ ref }}`
 * tokens and conditions are a closed operator set resolved through
 * `resolveReference`.
 */

import type {
  AgentStep,
  BranchCase,
  BranchStep,
  Condition,
  JsonSchema,
  LoopStep,
  MapStep,
  NormalizedWorkflow,
  Operand,
  ParallelStep,
  ParsedReference,
  Policy,
  RefOperand,
  ResolvedLimits,
  SequenceStep,
  Step,
  StepType,
  SynthesizeStep,
  WorkflowLimits,
  WorkflowSpecV1,
} from "./types.ts"
import { STEP_TYPES, WORKFLOW_VERSION, WorkflowValidationError } from "./types.ts"
import { compileJsonSchema } from "./json-schema.ts"
export { WorkflowValidationError } from "./types.ts"

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/
const INDEX = /^[0-9]+$/
const MAX_REF_LENGTH = 256
const MAX_REF_DEPTH = 32
const ISO_DEADLINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/

const DEFAULT_LIMITS = { maxParallel: 4, maxAgents: 8, maxIterations: 100 } as const

const JSON_SCHEMA_TYPES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "string",
  "integer",
])

const STEP_KEYS_BY_TYPE: Record<StepType, ReadonlyArray<string>> = {
  agent: [
    "id",
    "type",
    "label",
    "phase",
    "labels",
    "dependsOn",
    "agent",
    "model",
    "variant",
    "prompt",
    "outputSchema",
    "retry",
    "timeout",
    "isolation",
  ],
  sequence: ["id", "type", "label", "phase", "labels", "dependsOn", "steps"],
  parallel: ["id", "type", "label", "phase", "labels", "dependsOn", "steps", "maxParallel"],
  map: ["id", "type", "label", "phase", "labels", "dependsOn", "over", "as", "maxParallel", "steps"],
  loop: ["id", "type", "label", "phase", "labels", "dependsOn", "over", "as", "until", "maxIterations", "steps"],
  branch: ["id", "type", "label", "phase", "labels", "dependsOn", "cases", "otherwise"],
  synthesize: [
    "id",
    "type",
    "label",
    "phase",
    "labels",
    "dependsOn",
    "prompt",
    "agent",
    "model",
    "variant",
    "input",
    "outputSchema",
    "retry",
    "timeout",
    "isolation",
  ],
}

const COMMON_KEYS = [
  "id",
  "type",
  "label",
  "phase",
  "labels",
  "dependsOn",
] as const

const TOP_LEVEL_KEYS = [
  "version",
  "name",
  "description",
  "phases",
  "labels",
  "limits",
  "steps",
] as const

const LIMIT_KEYS = [
  "maxParallel",
  "maxAgents",
  "maxIterations",
  "maxTokens",
  "maxCost",
  "deadline",
] as const

const PHASE_KEYS = ["label", "description"] as const

const POLICY_KEYS = [
  "agents",
  "models",
  "maxParallel",
  "maxAgents",
  "maxIterations",
  "maxTokens",
  "maxCost",
] as const

const CONDITION_KEYS = [
  "$ref",
  "$eq",
  "$ne",
  "$lt",
  "$lte",
  "$gt",
  "$gte",
  "$and",
  "$or",
  "$not",
] as const

const ORDERING_OPS = new Set(["$lt", "$lte", "$gt", "$gte"])

// Function declaration (not an arrow) so callers' control-flow analysis can
// narrow on `if (!ok) fail(...)`.
function fail(path: string, message: string): never {
  throw new WorkflowValidationError(path, message)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== ""

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

/** Validates an id/name against the identifier grammar. */
const checkIdentifier = (value: string, path: string, what: string): void => {
  if (!IDENTIFIER.test(value)) {
    fail(path, `${what} must match ${IDENTIFIER}`)
  }
}

/** Validates a plain-array-of-strings field and returns the unique entries. */
const checkStringList = (
  value: unknown,
  path: string,
  what: string,
  allowEmpty: boolean,
): string[] => {
  if (!Array.isArray(value)) fail(path, `${what} must be an array of non-empty strings`)
  const entries: string[] = []
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!isNonEmptyString(entry)) {
      fail(`${path}[${i}]`, `${what} entries must be non-empty strings`)
    }
    entries.push(entry.trim())
  }
  if (!allowEmpty && entries.length === 0) fail(path, `${what} must not be empty`)
  const unique = new Set(entries)
  if (unique.size !== entries.length) fail(path, `${what} must not contain duplicates`)
  return entries
}

/**
 * Parses a restricted reference of the form
 * `root(.segment|\[index\])*` where `root` and `segment` are identifiers and
 * `index` is a non-negative integer.
 */
export const parseReference = (ref: string): ParsedReference => {
  return parseReferenceAt(ref, "$")
}

const parseReferenceAt = (ref: string, path: string): ParsedReference => {
  if (!isNonEmptyString(ref)) fail(path, "reference must be a non-empty string")
  if (ref !== ref.trim()) fail(path, `reference must not have leading or trailing whitespace`)
  if (ref.length > MAX_REF_LENGTH) {
    fail(path, `reference exceeds ${MAX_REF_LENGTH} characters`)
  }

  let i = 0
  let j = i
  while (j < ref.length && ref[j] !== "." && ref[j] !== "[") j++
  const root = ref.slice(0, j)
  if (!IDENTIFIER.test(root)) {
    fail(path, `invalid reference root "${root}" in "${ref}"`)
  }
  i = j

  const segments: string[] = []
  while (i < ref.length) {
    const char = ref[i]
    if (char === ".") {
      i++
      let end = i
      while (end < ref.length && ref[end] !== "." && ref[end] !== "[") end++
      if (end === i) fail(path, `empty path segment in reference "${ref}"`)
      const segment = ref.slice(i, end)
      if (!SEGMENT.test(segment)) {
        fail(path, `invalid path segment "${segment}" in reference "${ref}"`)
      }
      segments.push(segment)
      i = end
    } else if (char === "[") {
      i++
      let end = ref.indexOf("]", i)
      if (end === -1) fail(path, `unterminated array index in reference "${ref}"`)
      const index = ref.slice(i, end)
      if (index === "" || !INDEX.test(index)) {
        fail(path, `invalid array index "${index}" in reference "${ref}"`)
      }
      segments.push(String(parseInt(index, 10)))
      i = end + 1
    } else {
      fail(path, `unexpected character "${char}" in reference "${ref}"`)
    }
    if (segments.length > MAX_REF_DEPTH) {
      fail(path, `reference exceeds ${MAX_REF_DEPTH} path segments`)
    }
  }

  return { root, segments, raw: ref }
}

const describeValue = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object"
  return typeof value
}

/**
 * Resolves a reference against a value store keyed by step id (the store may
 * also carry loop-variable entries). Throws a descriptive
 * `WorkflowValidationError` for unknown roots, missing keys, and out-of-range
 * indices. Never evaluates code.
 */
export const resolveReference = (valueStore: unknown, ref: string): unknown => {
  if (!isPlainObject(valueStore)) {
    throw new WorkflowValidationError("$", "valueStore must be a plain object")
  }
  const parsed = parseReferenceAt(ref, "$")
  const root = parsed.root
  if (!Object.prototype.hasOwnProperty.call(valueStore, root)) {
    throw new WorkflowValidationError(
      `$.${root}`,
      `reference "${ref}" does not match any step id in the value store`,
    )
  }

  let value: unknown = (valueStore as Record<string, unknown>)[root]
  let at = `$.${root}`
  for (const segment of parsed.segments) {
    const next = Array.isArray(value)
      ? `${at}[${segment}]`
      : isPlainObject(value)
        ? `${at}.${segment}`
        : `${at}.${segment}`
    if (Array.isArray(value)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= value.length) {
        throw new WorkflowValidationError(
          `${at}[${index}]`,
          `array index ${index} is out of range (length ${value.length}) for reference "${ref}"`,
        )
      }
      value = value[index]
    } else if (isPlainObject(value)) {
      if (!Object.prototype.hasOwnProperty.call(value, segment)) {
        throw new WorkflowValidationError(
          `${at}.${segment}`,
          `value does not have a property "${segment}" for reference "${ref}"`,
        )
      }
      value = value[segment]
    } else {
      throw new WorkflowValidationError(
        `${at}.${segment}`,
        `cannot access "${segment}" on ${describeValue(value)} for reference "${ref}"`,
      )
    }
    at = next
  }
  return value
}

/**
 * Scans a prompt template for `{{ token }}` interpolations, rejecting nested
 * openers, unterminated tokens, and empty tokens. Closing braces are ordinary
 * literal text unless they close a matched opener. Each token is handed
 * to `onToken` for reference validation.
 */
const scanTemplate = (
  template: string,
  path: string,
  onToken: (token: string, tokenPath: string) => void,
): void => {
  let i = 0
  const length = template.length
  while (i < length) {
    const open = template.indexOf("{{", i)
    if (open === -1) {
      return
    }
    const close = template.indexOf("}}", open + 2)
    if (close === -1) fail(path, 'unterminated "{{" in prompt template')
    const inner = template.slice(open + 2, close)
    if (inner.includes("{{")) {
      fail(path, 'nested "{{" in prompt template')
    }
    const token = inner.trim()
    if (token === "") fail(path, 'empty "{{ }}" token in prompt template')
    onToken(token, path)
    i = close + 2
  }
}

/** Internal step record produced while walking the spec. */
type StepInfo = {
  id: string
  path: string
  parent: StepInfo | null
  step: Step
  children: StepInfo[]
  ancestors: Set<string>
  /**
   * Id of the implicitly-ordered sibling group this step belongs to, or null
   * when the step carries no implicit sibling ordering (parallel children and
   * alternatives across branch cases).
   */
  orderGroupId: string | null
}

type PendingRef = {
  info: StepInfo
  ref: string
  path: string
  local: boolean
  /** Descendant references are permitted (used only by an enclosing loop's `until`). */
  allowDescendant: boolean
}

type PendingDepends = {
  info: StepInfo
  id: string
  path: string
}

type ValidationContext = {
  byId: Map<string, StepInfo>
  phases: Map<string, string> | null
  pendingRefs: PendingRef[]
  pendingDepends: PendingDepends[]
  limits: ResolvedLimits
  agentAllow: Set<string> | null
  modelAllow: Set<string> | null
}

/** Deep-copies plain JSON values so the normalized spec never aliases input. */
const copyJson = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((entry) => copyJson(entry)) as T
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) copy[key] = copyJson(entry)
    return copy as T
  }
  return value
}

const checkLiteralOperand = (operand: unknown, path: string): void => {
  if (operand === null || typeof operand === "boolean") return
  if (typeof operand === "number") {
    if (!Number.isFinite(operand)) fail(path, "numeric operand must be finite")
    return
  }
  if (typeof operand === "string") return
  fail(path, `operand must be a scalar or a {$ref} object, got ${describeValue(operand)}`)
}

const isRefOperand = (value: unknown): value is RefOperand =>
  isPlainObject(value) &&
  Object.keys(value).length === 1 &&
  typeof value.$ref === "string"

const collectConditionRefs = (
  condition: unknown,
  path: string,
  ctx: ValidationContext,
  info: StepInfo,
  scope: ReadonlyArray<string>,
  allowDescendant = false,
): void => {
  if (!isPlainObject(condition)) fail(path, "condition must be a plain object")
  const keys = Object.keys(condition)
  if (keys.length !== 1) {
    fail(path, `condition must have exactly one operator, got [${keys.join(", ")}]`)
  }
  const operator = keys[0]
  if (!(CONDITION_KEYS as readonly string[]).includes(operator)) {
    fail(path, `unknown condition operator "${operator}"`)
  }
  const value = condition[operator]

  if (operator === "$ref") {
    if (!isNonEmptyString(value)) fail(path, '$ref must be a non-empty string')
    queueRef(ctx, info, value as string, path, scope, allowDescendant)
    return
  }
  if (operator === "$not") {
    collectConditionRefs(value, `${path}.$not`, ctx, info, scope, allowDescendant)
    return
  }
  if (operator === "$and" || operator === "$or") {
    if (!Array.isArray(value) || value.length === 0) {
      fail(path, `${operator} must be a non-empty array of conditions`)
    }
    for (let i = 0; i < value.length; i++) {
      collectConditionRefs(value[i], `${path}.${operator}[${i}]`, ctx, info, scope, allowDescendant)
    }
    return
  }
  if (operator === "$eq" || operator === "$ne" || ORDERING_OPS.has(operator)) {
    if (!Array.isArray(value) || value.length !== 2) {
      fail(path, `${operator} must be a 2-element [operand, operand] array`)
    }
    for (let i = 0; i < 2; i++) {
      const operand = value[i]
      const operandPath = `${path}.${operator}[${i}]`
      if (isRefOperand(operand)) {
        queueRef(ctx, info, operand.$ref, operandPath, scope, allowDescendant)
      } else {
        checkLiteralOperand(operand, operandPath)
        if (ORDERING_OPS.has(operator) && typeof operand !== "number") {
          fail(operandPath, `${operator} requires numeric operands`)
        }
      }
    }
    return
  }
  fail(path, `unhandled condition operator "${operator}"`)
}

const queueRef = (
  ctx: ValidationContext,
  info: StepInfo,
  ref: string,
  path: string,
  scope: ReadonlyArray<string>,
  allowDescendant = false,
): void => {
  const parsed = parseReferenceAt(ref, path)
  const local = scope.includes(parsed.root)
  ctx.pendingRefs.push({ info, ref, path, local, allowDescendant })
}

const queueTemplate = (
  ctx: ValidationContext,
  info: StepInfo,
  template: string,
  path: string,
  scope: ReadonlyArray<string>,
): void => {
  scanTemplate(template, path, (token, tokenPath) => queueRef(ctx, info, token, tokenPath, scope))
}

const checkOptionalString = (
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined => {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!isNonEmptyString(value)) fail(`${path}.${key}`, "must be a non-empty string")
  return value.trim()
}

const checkOptionalModel = (
  raw: Record<string, unknown>,
  key: string,
  path: string,
  policyModels: Set<string> | null,
): string | undefined => {
  const value = checkOptionalString(raw, key, path)
  if (value !== undefined && policyModels && !policyModels.has(value)) {
    fail(`${path}.${key}`, `model "${value}" is not allowed by policy`)
  }
  return value
}

const checkOptionalInt = (
  raw: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
): number | undefined => {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${path}.${key}`, `must be an integer >= ${min}`)
  }
  return value
}

const checkOptionalPositiveNumber = (
  raw: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined => {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!isFiniteNumber(value) || value <= 0) {
    fail(`${path}.${key}`, "must be a finite number > 0")
  }
  return value
}

const checkOutputSchema = (raw: Record<string, unknown>, path: string): JsonSchema | undefined => {
  const value = raw.outputSchema
  if (value === undefined) return undefined
  if (!isPlainObject(value)) fail(`${path}.outputSchema`, "must be a plain object")
  if (value.type === undefined) {
    fail(`${path}.outputSchema.type`, "is required; outputSchema must be a complete JSON Schema")
  }
  if (typeof value.type !== "string") {
    fail(`${path}.outputSchema.type`, "must be a string")
  }
  if (!JSON_SCHEMA_TYPES.has(value.type)) {
    fail(`${path}.outputSchema.type`, `unknown JSON Schema type "${value.type}"`)
  }
  const schema = copyJson(value as JsonSchema)
  try {
    compileJsonSchema(schema)
  } catch (error) {
    fail(
      `${path}.outputSchema`,
      error instanceof Error ? error.message : "must be a valid JSON Schema",
    )
  }
  return schema
}

const checkAgentMetadata = (
  raw: Record<string, unknown>,
  path: string,
  ctx: ValidationContext,
): { agent?: string; model?: string; variant?: string } => {
  let agent: string | undefined
  let model: string | undefined
  let variant: string | undefined
  if (raw.agent !== undefined) {
    if (!isNonEmptyString(raw.agent)) fail(`${path}.agent`, "must be a non-empty string")
    if (ctx.agentAllow && !ctx.agentAllow.has(raw.agent.trim())) {
      fail(`${path}.agent`, `agent "${raw.agent}" is not allowed by policy`)
    }
    agent = raw.agent.trim()
  }
  model = checkOptionalModel(raw, "model", path, ctx.modelAllow)
  variant = checkOptionalString(raw, "variant", path)
  checkOptionalInt(raw, "retry", path, 0)
  checkOptionalPositiveNumber(raw, "timeout", path)
  if (raw.isolation !== undefined && typeof raw.isolation !== "boolean") {
    fail(`${path}.isolation`, "must be a boolean")
  }
  return { agent, model, variant }
}

/** Normalizes a step (validating shape) and records its StepInfo. */
const walkStep = (
  raw: unknown,
  path: string,
  parent: StepInfo | null,
  scope: ReadonlyArray<string>,
  ctx: ValidationContext,
  orderGroup: string | null = null,
): { norm: Step; info: StepInfo } => {
  if (!isPlainObject(raw)) fail(path, "step must be a plain object")
  const rawStep = raw as Record<string, unknown>

  const type = rawStep.type
  if (typeof type !== "string" || !(STEP_TYPES as readonly string[]).includes(type)) {
    fail(`${path}.type`, `must be one of ${STEP_TYPES.join(", ")}`)
  }
  const stepType = type as StepType

  const allowed = STEP_KEYS_BY_TYPE[stepType]
  for (const key of Object.keys(rawStep)) {
    if (!allowed.includes(key)) fail(path, `unknown key "${key}"`)
  }

  const id = rawStep.id
  if (!isNonEmptyString(id)) fail(`${path}.id`, "must be a non-empty string")
  const stepId = id.trim()
  checkIdentifier(stepId, `${path}.id`, "step id")

  if (ctx.byId.has(stepId)) {
    fail(path, `duplicate step id "${stepId}"`)
  }

  const info: StepInfo = {
    id: stepId,
    path,
    parent,
    step: {} as Step,
    children: [],
    ancestors: parent ? new Set([parent.id, ...parent.ancestors]) : new Set(),
    orderGroupId: orderGroup,
  }
  ctx.byId.set(stepId, info)

  if (parent) parent.children.push(info)

  const norm: Record<string, unknown> = { id: stepId, type: stepType }

  for (const key of COMMON_KEYS) {
    if (key === "id" || key === "type") continue
    const value = rawStep[key]
    if (value === undefined) continue
    if (key === "label" || key === "phase") {
      const text = checkOptionalString(rawStep, key, path)
      if (key === "phase" && text !== undefined && ctx.phases && !ctx.phases.has(text)) {
        fail(`${path}.phase`, `phase "${text}" is not declared in "phases"`)
      }
      norm[key] = text
    } else if (key === "labels") {
      norm[key] = checkStringList(value, `${path}.labels`, "labels", true)
    } else if (key === "dependsOn") {
      const entries = checkStringList(value, `${path}.dependsOn`, "dependsOn", true)
      norm[key] = entries
      for (const entry of entries) {
        checkIdentifier(entry, `${path}.dependsOn`, "dependency id")
        ctx.pendingDepends.push({ info, id: entry, path: `${path}.dependsOn` })
      }
    }
  }

  const buildChildren = (listPath: string, group: string | null): unknown[] => {
    const value = rawStep.steps
    if (!Array.isArray(value) || value.length === 0) {
      fail(`${path}.steps`, "must be a non-empty array of steps")
    }
    const childScope = scope
    return value.map((childRaw, i) => {
      const childPath = `${listPath}[${i}]`
      const child = walkStep(childRaw, childPath, info, childScope, ctx, group)
      return child.norm
    })
  }

  switch (stepType) {
    case "agent": {
      const agent = rawStep.agent
      if (!isNonEmptyString(agent)) fail(`${path}.agent`, "must be a non-empty string")
      if (ctx.agentAllow && !ctx.agentAllow.has(agent.trim())) {
        fail(`${path}.agent`, `agent "${agent}" is not allowed by policy`)
      }
      norm.agent = agent.trim()
      const agentModel = checkOptionalModel(rawStep, "model", path, ctx.modelAllow)
      if (agentModel !== undefined) norm.model = agentModel
      const agentVariant = checkOptionalString(rawStep, "variant", path)
      if (agentVariant !== undefined) norm.variant = agentVariant
      const prompt = rawStep.prompt
      if (!isNonEmptyString(prompt)) fail(`${path}.prompt`, "must be a non-empty string")
      norm.prompt = prompt.trim()
      queueTemplate(ctx, info, prompt.trim(), `${path}.prompt`, scope)
      const schema = checkOutputSchema(rawStep, path)
      if (schema !== undefined) norm.outputSchema = schema
      const retry = checkOptionalInt(rawStep, "retry", path, 0)
      if (retry !== undefined) norm.retry = retry
      const timeout = checkOptionalPositiveNumber(rawStep, "timeout", path)
      if (timeout !== undefined) norm.timeout = timeout
      if (rawStep.isolation !== undefined) {
        if (typeof rawStep.isolation !== "boolean") fail(`${path}.isolation`, "must be a boolean")
        norm.isolation = rawStep.isolation
      }
      break
    }
    case "sequence":
    case "parallel": {
      if (stepType === "parallel") {
        const maxParallel = checkOptionalInt(rawStep, "maxParallel", path, 1)
        if (maxParallel !== undefined) {
          if (maxParallel > ctx.limits.maxParallel) {
            fail(
              `${path}.maxParallel`,
              `must not exceed the workflow maxParallel of ${ctx.limits.maxParallel}`,
            )
          }
          norm.maxParallel = maxParallel
        }
      }
      const group = stepType === "parallel" ? null : `${path}#order`
      norm.steps = buildChildren(`${path}.steps`, group)
      break
    }
    case "map": {
      const maxParallel = checkOptionalInt(rawStep, "maxParallel", path, 1)
      if (maxParallel !== undefined) {
        if (maxParallel > ctx.limits.maxParallel) {
          fail(
            `${path}.maxParallel`,
            `must not exceed the workflow maxParallel of ${ctx.limits.maxParallel}`,
          )
        }
        norm.maxParallel = maxParallel
      }
      const over = rawStep.over
      if (!isNonEmptyString(over)) fail(`${path}.over`, "must be a reference to an array step")
      const overText = over.trim()
      norm.over = overText
      const as = rawStep.as
      if (!isNonEmptyString(as)) fail(`${path}.as`, "must be a non-empty loop variable name")
      const asName = as.trim()
      checkIdentifier(asName, `${path}.as`, "loop variable name")
      norm.as = asName
      queueRef(ctx, info, overText, `${path}.over`, scope)
      const childScope = [...scope, asName]
      norm.steps = (() => {
        const value = rawStep.steps
        if (!Array.isArray(value) || value.length === 0) {
          fail(`${path}.steps`, "must be a non-empty array of steps")
        }
        return value.map((child, i) =>
          walkStep(child, `${path}.steps[${i}]`, info, childScope, ctx, `${path}#order`).norm,
        )
      })()
      break
    }
    case "loop": {
      const maxIterations = checkOptionalInt(rawStep, "maxIterations", path, 1)
      if (maxIterations !== undefined) {
        if (maxIterations > ctx.limits.maxIterations) {
          fail(
            `${path}.maxIterations`,
            `must not exceed the workflow maxIterations of ${ctx.limits.maxIterations}`,
          )
        }
        norm.maxIterations = maxIterations
      }
      const over = rawStep.over
      if (over !== undefined) {
        if (!isNonEmptyString(over)) fail(`${path}.over`, "must be a reference to an array step")
        const overText = over.trim()
        norm.over = overText
        queueRef(ctx, info, overText, `${path}.over`, scope)
      }
      const as = rawStep.as
      const asName = as !== undefined ? (isNonEmptyString(as) ? as.trim() : undefined) : undefined
      if (as !== undefined && !isNonEmptyString(as)) {
        fail(`${path}.as`, "must be a non-empty loop variable name")
      }
      if (asName !== undefined) {
        checkIdentifier(asName, `${path}.as`, "loop variable name")
        if (over === undefined) fail(`${path}.as`, '"as" requires "over" to be set')
        norm.as = asName
      }
      const until = rawStep.until
      if (until !== undefined) {
        const conditionPath = `${path}.until`
        const conditionScope = asName !== undefined ? [...scope, asName] : scope
        collectConditionRefs(until, conditionPath, ctx, info, conditionScope, true)
        norm.until = copyJson(until)
      }
      norm.steps = (() => {
        const value = rawStep.steps
        if (!Array.isArray(value) || value.length === 0) {
          fail(`${path}.steps`, "must be a non-empty array of steps")
        }
        const childScope = asName !== undefined ? [...scope, asName] : scope
        return value.map((child, i) =>
          walkStep(child, `${path}.steps[${i}]`, info, childScope, ctx, `${path}#order`).norm,
        )
      })()
      break
    }
    case "branch": {
      const cases = rawStep.cases
      if (!Array.isArray(cases) || cases.length === 0) {
        fail(`${path}.cases`, "must be a non-empty array of branch cases")
      }
      const caseIds = new Set<string>()
      const normCases: BranchCase[] = []
      for (let i = 0; i < cases.length; i++) {
        const caseRaw = cases[i]
        const casePath = `${path}.cases[${i}]`
        if (!isPlainObject(caseRaw)) fail(casePath, "branch case must be a plain object")
        const caseKeys = Object.keys(caseRaw)
        for (const key of caseKeys) {
          if (key !== "id" && key !== "when" && key !== "steps") {
            fail(casePath, `unknown key "${key}"`)
          }
        }
        const caseId = caseRaw.id
        if (!isNonEmptyString(caseId)) fail(`${casePath}.id`, "must be a non-empty string")
        const caseIdText = caseId.trim()
        checkIdentifier(caseIdText, `${casePath}.id`, "case id")
        if (caseIds.has(caseIdText)) {
          fail(`${casePath}.id`, `duplicate case id "${caseIdText}" within branch "${stepId}"`)
        }
        caseIds.add(caseIdText)
        collectConditionRefs(caseRaw.when, `${casePath}.when`, ctx, info, scope)
        const steps = caseRaw.steps
        if (!Array.isArray(steps) || steps.length === 0) {
          fail(`${casePath}.steps`, "must be a non-empty array of steps")
        }
        const normCaseSteps = steps.map((child, childIdx) =>
          walkStep(child, `${casePath}.steps[${childIdx}]`, info, scope, ctx, `${casePath}#order`).norm,
        )
        normCases.push({
          id: caseIdText,
          when: copyJson(caseRaw.when) as Condition,
          steps: normCaseSteps,
        })
      }
      norm.cases = normCases
      const otherwise = rawStep.otherwise
      if (otherwise !== undefined) {
        if (!Array.isArray(otherwise) || otherwise.length === 0) {
          fail(`${path}.otherwise`, "must be a non-empty array of steps")
        }
        norm.otherwise = otherwise.map((child, childIdx) =>
          walkStep(child, `${path}.otherwise[${childIdx}]`, info, scope, ctx, `${path}#otherwise`).norm,
        )
      }
      break
    }
    case "synthesize": {
      const prompt = rawStep.prompt
      if (!isNonEmptyString(prompt)) fail(`${path}.prompt`, "must be a non-empty string")
      norm.prompt = prompt.trim()
      queueTemplate(ctx, info, prompt.trim(), `${path}.prompt`, scope)
      const metadata = checkAgentMetadata(rawStep, path, ctx)
      if (metadata.agent !== undefined) norm.agent = metadata.agent
      if (metadata.model !== undefined) norm.model = metadata.model
      if (metadata.variant !== undefined) norm.variant = metadata.variant
      const input = rawStep.input
      if (input !== undefined) {
        if (!Array.isArray(input) || input.length === 0) {
          fail(`${path}.input`, "must be a non-empty array of references")
        }
        const entries = input.map((entry, i) => {
          if (!isNonEmptyString(entry)) fail(`${path}.input[${i}]`, "must be a non-empty string")
          const entryText = entry.trim()
          queueRef(ctx, info, entryText, `${path}.input[${i}]`, scope)
          return entryText
        })
        norm.input = entries
      }
      const schema = checkOutputSchema(rawStep, path)
      if (schema !== undefined) norm.outputSchema = schema
      const retry = checkOptionalInt(rawStep, "retry", path, 0)
      if (retry !== undefined) norm.retry = retry
      const timeout = checkOptionalPositiveNumber(rawStep, "timeout", path)
      if (timeout !== undefined) norm.timeout = timeout
      if (rawStep.isolation !== undefined) {
        if (typeof rawStep.isolation !== "boolean") fail(`${path}.isolation`, "must be a boolean")
        norm.isolation = rawStep.isolation
      }
      break
    }
  }

  const step = norm as unknown as Step
  info.step = step
  return { norm: step, info }
}

const validatePolicy = (rawPolicy: unknown): Policy => {
  if (rawPolicy === undefined || rawPolicy === null) return {}
  if (!isPlainObject(rawPolicy)) fail("policy", "must be a plain object")
  const policy = rawPolicy as Record<string, unknown>
  for (const key of Object.keys(policy)) {
    if (!(POLICY_KEYS as readonly string[]).includes(key)) {
      fail(`policy.${key}`, "is not a supported policy option")
    }
  }
  const normalized: Record<string, unknown> = {}
  if (policy.agents !== undefined) {
    const agents = checkStringList(policy.agents, "policy.agents", "agents", true)
    for (const entry of agents) checkIdentifier(entry, "policy.agents", "agents")
    normalized.agents = agents
  }
  if (policy.models !== undefined) {
    normalized.models = checkStringList(policy.models, "policy.models", "models", true)
  }
  for (const key of ["maxParallel", "maxAgents", "maxIterations", "maxTokens"] as const) {
    if (policy[key] !== undefined) {
      if (!Number.isInteger(policy[key]) || (policy[key] as number) < 1) {
        fail(`policy.${key}`, "must be an integer >= 1")
      }
      normalized[key] = policy[key]
    }
  }
  if (policy.maxCost !== undefined) {
    if (!isFiniteNumber(policy.maxCost) || policy.maxCost < 0) {
      fail("policy.maxCost", "must be a finite number >= 0")
    }
    normalized.maxCost = policy.maxCost
  }
  return normalized as Policy
}

const checkLimitNumber = (
  rawLimits: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  integer: boolean,
): void => {
  const value = rawLimits[key]
  if (value === undefined) return
  if (integer) {
    if (!Number.isInteger(value) || (value as number) < min) {
      fail(`${path}.${key}`, `must be an integer >= ${min}`)
    }
  } else if (!isFiniteNumber(value) || (value as number) < min) {
    fail(`${path}.${key}`, `must be a finite number >= ${min}`)
  }
}

const validateLimitsShape = (rawLimits: unknown, path: string): void => {
  if (rawLimits === undefined) return
  if (!isPlainObject(rawLimits)) fail(path, "must be a plain object")
  const limits = rawLimits as Record<string, unknown>
  for (const key of Object.keys(limits)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      fail(`${path}.${key}`, "is not a supported limit")
    }
  }
  checkLimitNumber(limits, "maxParallel", path, 1, true)
  checkLimitNumber(limits, "maxAgents", path, 1, true)
  checkLimitNumber(limits, "maxIterations", path, 1, true)
  checkLimitNumber(limits, "maxTokens", path, 1, true)
  checkLimitNumber(limits, "maxCost", path, 0, false)
  const deadline = limits.deadline
  if (deadline !== undefined) {
    if (!isNonEmptyString(deadline)) fail(`${path}.deadline`, "must be an ISO 8601 date-time string")
    if (!ISO_DEADLINE.test(deadline) || Number.isNaN(Date.parse(deadline))) {
      fail(`${path}.deadline`, "must be a valid ISO 8601 date-time string")
    }
  }
}

const resolveLimits = (
  rawLimits: unknown,
  policy: Policy,
): { limits: ResolvedLimits; normLimits: WorkflowLimits } => {
  validateLimitsShape(rawLimits, "limits")
  const raw = isPlainObject(rawLimits) ? (rawLimits as Record<string, unknown>) : {}
  const rawLimitsObj = isPlainObject(rawLimits) ? (rawLimits as WorkflowLimits) : {}

  const clampOrCheck = (
    key: "maxParallel" | "maxAgents" | "maxIterations" | "maxTokens" | "maxCost",
    fallback: number | undefined,
  ): number | undefined => {
    const explicit = raw[key]
    const cap = policy[key]
    if (explicit === undefined) {
      if (cap === undefined) return fallback
      return cap
    }
    if (cap !== undefined && (explicit as number) > cap) {
      fail(`limits.${key}`, `exceeds the policy hard maximum of ${cap}`)
    }
    return explicit as number
  }

  const maxParallel = clampOrCheck("maxParallel", DEFAULT_LIMITS.maxParallel) as number
  const maxAgents = clampOrCheck("maxAgents", DEFAULT_LIMITS.maxAgents) as number
  const maxIterations = clampOrCheck("maxIterations", DEFAULT_LIMITS.maxIterations) as number
  const maxTokens = clampOrCheck("maxTokens", undefined)
  const maxCost = clampOrCheck("maxCost", undefined)

  const limits: ResolvedLimits = { maxParallel, maxAgents, maxIterations }
  if (maxTokens !== undefined) limits.maxTokens = maxTokens
  if (maxCost !== undefined) limits.maxCost = maxCost
  if (rawLimitsObj.deadline !== undefined) limits.deadline = rawLimitsObj.deadline

  const normLimits: WorkflowLimits = {}
  if (rawLimitsObj.maxParallel !== undefined) normLimits.maxParallel = limits.maxParallel
  if (rawLimitsObj.maxAgents !== undefined) normLimits.maxAgents = limits.maxAgents
  if (rawLimitsObj.maxIterations !== undefined) normLimits.maxIterations = limits.maxIterations
  if (limits.maxTokens !== undefined) normLimits.maxTokens = limits.maxTokens
  if (limits.maxCost !== undefined) normLimits.maxCost = limits.maxCost
  if (limits.deadline !== undefined) normLimits.deadline = limits.deadline

  return { limits, normLimits }
}

const buildAdjacency = (
  ctx: ValidationContext,
): { edges: Set<string>; nodeIds: string[] } => {
  const edges = new Set<string>()

  const addEdge = (from: string, to: string): void => {
    if (from !== to) edges.add(`${from}\u0000${to}`)
  }

  // Explicit dependsOn edges and reference edges: from must complete first.
  for (const dep of ctx.pendingDepends) addEdge(dep.id, dep.info.id)
  for (const ref of ctx.pendingRefs) {
    if (ref.local) continue
    const root = parseReferenceAt(ref.ref, ref.path).root
    addEdge(root, ref.info.id)
  }

  // Implicit sibling ordering applies only inside ordered containers: root,
  // sequence, map bodies, loop bodies, and the steps of a single branch case
  // or of `otherwise`. Parallel children and steps of different branch cases
  // are alternatives and carry no implicit dependency.
  const groups = new Map<string, StepInfo[]>()
  for (const info of ctx.byId.values()) {
    if (info.orderGroupId === null) continue
    const list = groups.get(info.orderGroupId) ?? []
    list.push(info)
    groups.set(info.orderGroupId, list)
  }
  for (const list of groups.values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      addEdge(list[i].id, list[i + 1].id)
    }
  }

  return { edges, nodeIds: [...ctx.byId.keys()] }
}

const findCycle = (nodeIds: string[], edges: ReadonlySet<string>): string[] | null => {
  const adjacency = new Map<string, string[]>()
  for (const id of nodeIds) adjacency.set(id, [])
  for (const edge of edges) {
    const sep = edge.indexOf("\u0000")
    const from = edge.slice(0, sep)
    const to = edge.slice(sep + 1)
    adjacency.get(from)?.push(to)
  }

  const state = new Map<string, number>() // 1 = visiting, 2 = done
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) ?? []) {
      const nextState = state.get(next)
      if (nextState === 1) {
        const start = stack.indexOf(next)
        return [...stack.slice(start), next]
      }
      if (nextState === undefined) {
        const cycle = visit(next)
        if (cycle) return cycle
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }

  for (const id of nodeIds) {
    if (state.get(id) === undefined) {
      const cycle = visit(id)
      if (cycle) return cycle
    }
  }
  return null
}

const topologicalOrder = (
  nodeIds: string[],
  edges: ReadonlySet<string>,
): string[] => {
  const indexOf = new Map<string, number>()
  nodeIds.forEach((id, index) => indexOf.set(id, index))
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const id of nodeIds) {
    indegree.set(id, 0)
    adjacency.set(id, [])
  }
  for (const edge of edges) {
    const sep = edge.indexOf("\u0000")
    const from = edge.slice(0, sep)
    const to = edge.slice(sep + 1)
    adjacency.get(from)?.push(to)
    indegree.set(to, (indegree.get(to) ?? 0) + 1)
  }
  const ready = nodeIds
    .filter((id) => indegree.get(id) === 0)
    .sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0))
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift() as string
    order.push(id)
    const newlyReady: string[] = []
    for (const next of adjacency.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 1) - 1
      indegree.set(next, remaining)
      if (remaining === 0) newlyReady.push(next)
    }
    ready.push(...newlyReady)
    ready.sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0))
  }
  return order
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      deepFreeze(record[key])
    }
  }
  return value
}

const formatCycle = (cycle: string[]): string => cycle.join(" -> ")

/**
 * Validates, normalizes, and freezes a workflow spec v1. Returns a deeply
 * immutable {@link NormalizedWorkflow} or throws a {@link WorkflowValidationError}
 * describing the first offending path. The optional `policy` constrains
 * allowed agents/models and caps the top-level limits.
 */
export const validateWorkflowSpec = (
  raw: unknown,
  rawPolicy?: unknown,
): NormalizedWorkflow => {
  const policy = validatePolicy(rawPolicy)
  const policyModels =
    policy.models !== undefined ? new Set(policy.models) : null
  const agentAllow = policy.agents !== undefined ? new Set(policy.agents) : null

  if (!isPlainObject(raw)) fail("$", "workflow spec must be a plain object")
  const spec = raw as Record<string, unknown>

  for (const key of Object.keys(spec)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      fail(`$.${key}`, "is not a supported top-level key")
    }
  }

  if (spec.version !== WORKFLOW_VERSION) {
    fail("$.version", `must be exactly ${WORKFLOW_VERSION}`)
  }

  const { limits, normLimits } = resolveLimits(spec.limits, policy)

  const norm: Record<string, unknown> = { version: WORKFLOW_VERSION, limits: normLimits }

  const name = checkOptionalString(spec, "name", "$")
  if (name !== undefined) norm.name = name
  const description = checkOptionalString(spec, "description", "$")
  if (description !== undefined) norm.description = description

  const phases = spec.phases
  let phaseMap: Map<string, string> | null = null
  if (phases !== undefined) {
    if (!isPlainObject(phases)) fail("$.phases", "must be a plain object")
    const normPhases: Record<string, unknown> = {}
    phaseMap = new Map()
    for (const [id, phaseRaw] of Object.entries(phases as Record<string, unknown>)) {
      const phasePath = `$.phases.${id}`
      checkIdentifier(id, phasePath, "phase id")
      if (!isPlainObject(phaseRaw)) fail(phasePath, "phase must be a plain object")
      for (const key of Object.keys(phaseRaw)) {
        if (!(PHASE_KEYS as readonly string[]).includes(key)) {
          fail(`${phasePath}.${key}`, "is not a supported phase key")
        }
      }
      const label = checkOptionalString(phaseRaw, "label", phasePath)
      if (label === undefined) fail(`${phasePath}.label`, "is required")
      const descriptionText = checkOptionalString(phaseRaw, "description", phasePath)
      const normPhase: Record<string, unknown> = { label }
      if (descriptionText !== undefined) normPhase.description = descriptionText
      normPhases[id] = normPhase
      phaseMap.set(id, label)
    }
    norm.phases = normPhases
  }

  const labels = spec.labels
  if (labels !== undefined) {
    norm.labels = checkStringList(labels, "$.labels", "labels", true)
  }

  const stepsRaw = spec.steps
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    fail("$.steps", "must be a non-empty array of steps")
  }

  const ctx: ValidationContext = {
    byId: new Map(),
    phases: phaseMap,
    pendingRefs: [],
    pendingDepends: [],
    limits,
    agentAllow,
    modelAllow: policyModels,
  }

  const rootSteps = stepsRaw.map((step, i) =>
    walkStep(step, `$.steps[${i}]`, null, ["input"], ctx, "$#order").norm,
  )
  norm.steps = rootSteps

  // Ensure loop-variable names never collide with a step id.
  for (const info of ctx.byId.values()) {
    if (info.id === "input") {
      fail(`${info.path}.id`, 'step id "input" is reserved for workflow invocation input')
    }
    if (info.step.type === "map") {
      const as = (info.step as MapStep).as
      if (ctx.byId.has(as)) {
        fail(`${info.path}.as`, `loop variable "${as}" collides with step id "${as}"`)
      }
    }
    if (info.step.type === "loop") {
      const as = (info.step as LoopStep).as
      if (as !== undefined && ctx.byId.has(as)) {
        fail(`${info.path}.as`, `loop variable "${as}" collides with step id "${as}"`)
      }
    }
  }

  // Validate references and dependencies against the known step ids.
  for (const ref of ctx.pendingRefs) {
    const parsed = parseReferenceAt(ref.ref, ref.path)
    if (ref.local) continue
    const target = ctx.byId.get(parsed.root)
    if (!target) {
      fail(ref.path, `reference "${ref.ref}" does not match any step id or loop variable`)
    }
    if (parsed.root === ref.info.id) {
      fail(ref.path, `step "${ref.info.id}" cannot reference itself`)
    }
    if (ref.info.ancestors.has(parsed.root)) {
      fail(ref.path, `step "${ref.info.id}" cannot reference its ancestor step "${parsed.root}"`)
    }
    // Only an enclosing loop's `until` may reference its own body outputs.
    if (target.ancestors.has(ref.info.id) && !ref.allowDescendant) {
      fail(ref.path, `step "${ref.info.id}" cannot reference its descendant step "${parsed.root}"`)
    }
  }

  const dependsById = new Map<string, PendingDepends[]>()
  for (const dep of ctx.pendingDepends) {
    const list = dependsById.get(dep.info.id) ?? []
    list.push(dep)
    dependsById.set(dep.info.id, list)
  }
  for (const [stepId, deps] of dependsById) {
    const info = ctx.byId.get(stepId) as StepInfo
    for (const dep of deps) {
      const target = ctx.byId.get(dep.id)
      if (!target) {
        fail(dep.path, `dependency "${dep.id}" does not match any step id`)
      }
      if (dep.id === stepId) fail(dep.path, `step "${stepId}" cannot depend on itself`)
      if (info.ancestors.has(dep.id)) {
        fail(dep.path, `step "${stepId}" cannot depend on its ancestor step "${dep.id}"`)
      }
      if (target.ancestors.has(stepId)) {
        fail(dep.path, `step "${stepId}" cannot depend on its descendant step "${dep.id}"`)
      }
    }
  }

  const { edges, nodeIds } = buildAdjacency(ctx)

  const cycle = findCycle(nodeIds, edges)
  if (cycle) {
    fail("$", `dependency cycle detected: ${formatCycle(cycle)}`)
  }

  const order = topologicalOrder(nodeIds, edges)
  if (order.length !== nodeIds.length) {
    fail("$", "dependency graph is inconsistent (could not compute a total order)")
  }

  const dependencies: Record<string, string[]> = {}
  const dependents: Record<string, string[]> = {}
  for (const id of nodeIds) {
    dependencies[id] = []
    dependents[id] = []
  }
  for (const edge of edges) {
    const sep = edge.indexOf("\u0000")
    const from = edge.slice(0, sep)
    const to = edge.slice(sep + 1)
    dependencies[to].push(from)
    dependents[from].push(to)
  }
  for (const id of nodeIds) {
    dependencies[id].sort()
    dependents[id].sort()
  }

  const byId: Record<string, Step> = {}
  for (const info of ctx.byId.values()) byId[info.id] = info.step

  const normalized: NormalizedWorkflow = {
    spec: norm as unknown as WorkflowSpecV1,
    version: WORKFLOW_VERSION,
    steps: Object.values(byId),
    byId: byId as Record<string, Step>,
    order,
    dependencies,
    dependents,
    limits,
  }

  deepFreeze(normalized)
  return normalized
}

/**
 * Resolves a reference against a value store, preferring a local scope entry
 * when the reference root names a loop variable. Falls through to the step-id
 * value store otherwise.
 */
const resolveWithScope = (
  valueStore: unknown,
  localScope: Record<string, unknown> | undefined,
  ref: string,
): unknown => {
  const parsed = parseReference(ref)
  if (localScope !== undefined && Object.prototype.hasOwnProperty.call(localScope, parsed.root)) {
    return resolveReference(localScope, ref)
  }
  return resolveReference(valueStore, ref)
}

/** Renders a resolved value for template interpolation. */
const renderValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === null) return "null"
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  return JSON.stringify(value)
}

/**
 * Interpolates a prompt template, replacing every `{{ ref }}` token with the
 * referenced value. Strings interpolate verbatim; scalars are stringified;
 * objects and arrays are JSON-encoded. Never executes code. Throws a
 * {@link WorkflowValidationError} for malformed templates and unresolvable
 * references.
 */
export const renderTemplate = (
  template: string,
  valueStore: unknown,
  localScope?: Readonly<Record<string, unknown>>,
): string => {
  if (typeof template !== "string") fail("$", "template must be a string")
  const scope =
    localScope !== undefined && isPlainObject(localScope)
      ? (localScope as Record<string, unknown>)
      : undefined
  let output = ""
  let i = 0
  const length = template.length
  while (i < length) {
    const open = template.indexOf("{{", i)
    if (open === -1) {
      output += template.slice(i)
      break
    }
    output += template.slice(i, open)
    const close = template.indexOf("}}", open + 2)
    if (close === -1) fail("$", 'unterminated "{{" in template')
    const inner = template.slice(open + 2, close)
    if (inner.includes("{{")) {
      fail("$", 'nested "{{" in template')
    }
    const token = inner.trim()
    if (token === "") fail("$", 'empty "{{ }}" token in template')
    output += renderValue(resolveWithScope(valueStore, scope, token))
    i = close + 2
  }
  return output
}

const resolveOperand = (
  operand: unknown,
  valueStore: unknown,
  localScope: Record<string, unknown> | undefined,
): unknown => {
  if (isRefOperand(operand)) return resolveWithScope(valueStore, localScope, operand.$ref)
  return operand
}

/** Closed deep equality over JSON values (objects compare by structure). */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((entry, index) => deepEqual(entry, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

/**
 * Evaluates a closed, JSON-serializable condition against a value store and an
 * optional local scope. Comparisons are strict: `$eq`/`$ne` use structural
 * equality with no coercion, ordering operators require finite numeric
 * operands (throwing {@link WorkflowValidationError} otherwise), and `$and`,
 * `$or`, and `$not` compose sub-conditions. Never executes code.
 */
export const evaluateCondition = (
  condition: unknown,
  valueStore: unknown,
  localScope?: Readonly<Record<string, unknown>>,
): boolean => {
  const scope =
    localScope !== undefined && isPlainObject(localScope)
      ? (localScope as Record<string, unknown>)
      : undefined
  if (!isPlainObject(condition)) fail("$", "condition must be a plain object")
  const keys = Object.keys(condition)
  if (keys.length !== 1) {
    fail("$", `condition must have exactly one operator, got [${keys.join(", ")}]`)
  }
  const operator = keys[0]
  if (!(CONDITION_KEYS as readonly string[]).includes(operator)) {
    fail("$", `unknown condition operator "${operator}"`)
  }
  const value = condition[operator]

  if (operator === "$ref") {
    if (!isNonEmptyString(value)) fail("$", '$ref must be a non-empty string')
    return Boolean(resolveWithScope(valueStore, scope, value as string))
  }
  if (operator === "$not") {
    return !evaluateCondition(value, valueStore, localScope)
  }
  if (operator === "$and" || operator === "$or") {
    if (!Array.isArray(value) || value.length === 0) {
      fail("$", `${operator} must be a non-empty array of conditions`)
    }
    const results = value.map((entry) => evaluateCondition(entry, valueStore, localScope))
    return operator === "$and" ? results.every(Boolean) : results.some(Boolean)
  }
  if (operator === "$eq" || operator === "$ne" || ORDERING_OPS.has(operator)) {
    if (!Array.isArray(value) || value.length !== 2) {
      fail("$", `${operator} must be a 2-element [operand, operand] array`)
    }
    const left = resolveOperand(value[0], valueStore, scope)
    const right = resolveOperand(value[1], valueStore, scope)
    if (operator === "$eq") return deepEqual(left, right)
    if (operator === "$ne") return !deepEqual(left, right)
    if (!isFiniteNumber(left) || !isFiniteNumber(right)) {
      fail("$", `${operator} requires numeric operands`)
    }
    if (operator === "$lt") return (left as number) < (right as number)
    if (operator === "$lte") return (left as number) <= (right as number)
    if (operator === "$gt") return (left as number) > (right as number)
    return (left as number) >= (right as number)
  }
  fail("$", `unhandled condition operator "${operator}"`)
}
