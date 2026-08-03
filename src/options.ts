import { DEFAULTS, PLUGIN_ID } from "./constants.ts"
import type { ModelReference, NormalizedOptions, NormalizedWorkflowOptions } from "./types.ts"

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const invalidOption = (name: string, expected: string): never => {
  throw new Error(`[${PLUGIN_ID}] The \`${name}\` option must be ${expected}.`)
}

export const nonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== "string") invalidOption(name, "a non-empty string")
  const trimmed = (value as string).trim()
  if (trimmed === "") invalidOption(name, "a non-empty string")
  return trimmed
}

export const modelReference = (value: unknown, name: string): ModelReference => {
  const raw = nonEmptyString(value, name)
  const separator = raw.indexOf("/")
  if (separator <= 0 || separator === raw.length - 1) {
    invalidOption(name, 'a model reference in "provider/model-id" format')
  }

  return {
    raw,
    providerID: raw.slice(0, separator),
    modelID: raw.slice(separator + 1),
  }
}

export const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === "") return undefined
  return nonEmptyString(value, name)
}

export const stringArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value)) invalidOption(name, "an array of non-empty strings")
  const entries = value as unknown[]
  return [...new Set(entries.map((entry: unknown) => nonEmptyString(entry, `${name} entries`)))]
}

export const stringRecord = (
  value: unknown,
  name: string,
  parseValue: (value: unknown, name: string) => string = nonEmptyString,
): Record<string, string> => {
  if (!isRecord(value)) invalidOption(name, "an object with non-empty string values")
  const record = value as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      nonEmptyString(key, `${name} keys`),
      parseValue(entry, `${name} values`),
    ]),
  )
}

export const REQUIRED_MODEL_MESSAGE =
  `[${PLUGIN_ID}] The \`subagentModel\` option is required. Configure the plugin as ["${PLUGIN_ID}", { "subagentModel": "anthropic/claude-sonnet-4-6" }].`

const positiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalidOption(name, "an integer greater than zero")
  }
  return value as number
}

const nonNegativeNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalidOption(name, "a finite non-negative number")
  }
  return value as number
}

const booleanOption = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") invalidOption(name, "a boolean")
  return value as boolean
}

const normalizeWorkflows = (value: unknown): NormalizedWorkflowOptions => {
  if (value === false) return { ...DEFAULTS.workflows, enabled: false }
  if (value !== undefined && !isRecord(value)) invalidOption("workflows", "false or an object")
  const input = (value ?? {}) as Record<string, unknown>
  const allowed = new Set([
    "enabled",
    "approval",
    "maxParallel",
    "maxAgents",
    "maxIterations",
    "stepTimeout",
    "maxTokens",
    "maxCost",
    "autoResume",
    "notifyParent",
  ])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalidOption(`workflows.${key}`, "a supported workflow option")
  }
  const approval = input.approval ?? DEFAULTS.workflows.approval
  if (approval !== "always" && approval !== "never") {
    invalidOption("workflows.approval", '"always" or "never"')
  }
  return {
    enabled: input.enabled === undefined ? DEFAULTS.workflows.enabled : booleanOption(input.enabled, "workflows.enabled"),
    approval: approval as "always" | "never",
    maxParallel: input.maxParallel === undefined ? DEFAULTS.workflows.maxParallel : positiveInteger(input.maxParallel, "workflows.maxParallel"),
    maxAgents: input.maxAgents === undefined ? DEFAULTS.workflows.maxAgents : positiveInteger(input.maxAgents, "workflows.maxAgents"),
    maxIterations: input.maxIterations === undefined ? DEFAULTS.workflows.maxIterations : positiveInteger(input.maxIterations, "workflows.maxIterations"),
    stepTimeout: input.stepTimeout === undefined ? DEFAULTS.workflows.stepTimeout : positiveInteger(input.stepTimeout, "workflows.stepTimeout"),
    maxTokens: input.maxTokens === undefined ? undefined : positiveInteger(input.maxTokens, "workflows.maxTokens"),
    maxCost: input.maxCost === undefined ? undefined : nonNegativeNumber(input.maxCost, "workflows.maxCost"),
    autoResume: input.autoResume === undefined ? DEFAULTS.workflows.autoResume : booleanOption(input.autoResume, "workflows.autoResume"),
    notifyParent: input.notifyParent === undefined ? DEFAULTS.workflows.notifyParent : booleanOption(input.notifyParent, "workflows.notifyParent"),
  }
}

export const normalizeOptions = (rawOptions: unknown): NormalizedOptions => {
  const candidate = rawOptions == null ? {} : rawOptions
  if (!isRecord(candidate)) invalidOption("options", "an object")
  const options = candidate as Record<string, unknown>

  if (options.subagentModel === undefined || options.subagentModel === "") {
    throw new Error(REQUIRED_MODEL_MESSAGE)
  }

  const blockedTools =
    options.blockedTools === undefined ? [...DEFAULTS.blockedTools] : stringArray(options.blockedTools, "blockedTools")
  const agents = options.agents === undefined ? undefined : stringArray(options.agents, "agents")

  return {
    subagentModel: modelReference(options.subagentModel, "subagentModel").raw,
    subagentEffort: optionalString(options.subagentEffort, "subagentEffort"),
    orchestratorModel: optionalString(options.orchestratorModel, "orchestratorModel"),
    orchestratorAgent:
      options.orchestratorAgent === undefined
        ? DEFAULTS.orchestratorAgent
        : nonEmptyString(options.orchestratorAgent, "orchestratorAgent"),
    agents,
    agentModels:
      options.agentModels === undefined
        ? {}
        : stringRecord(options.agentModels, "agentModels", (entry, entryName) => modelReference(entry, entryName).raw),
    agentEfforts: options.agentEfforts === undefined ? {} : stringRecord(options.agentEfforts, "agentEfforts"),
    instructions: optionalString(options.instructions, "instructions"),
    blockedTools,
    workflows: normalizeWorkflows(options.workflows),
  }
}
