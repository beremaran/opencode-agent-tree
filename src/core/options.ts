import {BLOCKED_TOOL_PATTERN, DEFAULTS, MODEL_PATTERN, PLUGIN_ID} from "./constants.ts";
import type {NormalizedOptions} from "./types.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const invalidOption = (name: string, expected: string): never => {
    throw new Error(`[${PLUGIN_ID}] The \`${name}\` option must be ${expected}.`);
};

const nonEmptyString = (value: unknown, name: string): string => {
    if (typeof value !== "string") {
        invalidOption(name, "a non-empty string");
    }
    const trimmed = (value as string).trim();
    if (trimmed === "") {
        invalidOption(name, "a non-empty string");
    }
    return trimmed;
};

const booleanOption = (value: unknown, name: string): boolean => {
    if (typeof value !== "boolean") {
        invalidOption(name, "a boolean");
    }
    return value as boolean;
};

const positiveIntegerOption = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        invalidOption(name, "a positive integer");
    }
    return value as number;
};

const optionalString = (value: unknown, name: string): string | undefined => {
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
        return undefined;
    }
    return nonEmptyString(value, name);
};

const stringArray = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value)) {
        invalidOption(name, "an array of non-empty strings");
    }
    const entries = value as unknown[];
    return [...new Set(entries.map((entry: unknown) => nonEmptyString(entry, `${name} entries`)))];
};

const stringRecord = (value: unknown, name: string): Record<string, string> => {
    if (!isRecord(value)) {
        invalidOption(name, "an object with non-empty string values");
    }
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [
            nonEmptyString(key, `${name} keys`),
            nonEmptyString(entry, `${name} values`),
        ]),
    );
};

const modelString = (value: unknown, name: string): string => {
    const model = nonEmptyString(value, name);
    if (!MODEL_PATTERN.test(model)) {
        invalidOption(name, `a model id like "provider/model" (got \`${model}\`)`);
    }
    return model;
};

/**
 * Normalizes the optional `orchestratorModels` option: an array of
 * `provider/model` strings, one per orchestrator level. `undefined` and an
 * empty array are both treated as "not provided" (no per-level overrides).
 * Entries are validated with `stringArray` (rejects non-arrays and
 * empty/non-string entries) then `modelString` (rejects malformed model ids).
 * The array length must not exceed `orchestratorDepth`.
 */
const normalizeOrchestratorModels = (value: unknown, orchestratorDepth: number): string[] | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const models = stringArray(value, "orchestratorModels").map((model) => modelString(model, "orchestratorModels"));
    if (models.length === 0) {
        return undefined;
    }
    if (models.length > orchestratorDepth) {
        throw new Error(
            `[${PLUGIN_ID}] The \`orchestratorModels\` option has ${models.length} entries but \`orchestratorDepth\` is ${orchestratorDepth}.`,
        );
    }
    return models;
};

const validateBlockedTools = (names: string[]): string[] => {
    for (const name of names) {
        if (!BLOCKED_TOOL_PATTERN.test(name)) {
            invalidOption("blockedTools entries", `tool names matching /^[a-z0-9_-]+$/ (got \`${name}\`)`);
        }
    }
    return names;
};

const REQUIRED_MODEL_MESSAGE = `[${PLUGIN_ID}] The \`subagentModel\` option is required, e.g. ["${PLUGIN_ID}", { "subagentModel": "anthropic/claude-sonnet-4-6" }]`;

export const normalizeOptions = (rawOptions: unknown): NormalizedOptions => {
    const candidate = rawOptions == null ? {} : rawOptions;
    if (!isRecord(candidate)) {
        invalidOption("options", "an object");
    }
    const options = candidate as Record<string, unknown>;

    if (
        options.subagentModel === undefined ||
        options.subagentModel === null ||
        (typeof options.subagentModel === "string" && options.subagentModel.trim() === "")
    ) {
        throw new Error(REQUIRED_MODEL_MESSAGE);
    }

    const blockedTools = validateBlockedTools(
        options.blockedTools === undefined
            ? [...DEFAULTS.blockedTools]
            : stringArray(options.blockedTools, "blockedTools"),
    );
    const agents = options.agents === undefined ? undefined : stringArray(options.agents, "agents");
    const restrictTask =
        options.restrictTask === undefined ? false : booleanOption(options.restrictTask, "restrictTask");
    const orchestratorDepth =
        options.orchestratorDepth === undefined
            ? 1
            : positiveIntegerOption(options.orchestratorDepth, "orchestratorDepth");
    const orchestratorModels = normalizeOrchestratorModels(options.orchestratorModels, orchestratorDepth);
    const orchestratorModel =
        options.orchestratorModel === undefined ||
        options.orchestratorModel === null ||
        options.orchestratorModel === ""
            ? undefined
            : modelString(options.orchestratorModel, "orchestratorModel");
    const agentModels = options.agentModels === undefined ? {} : stringRecord(options.agentModels, "agentModels");
    for (const model of Object.values(agentModels)) {
        modelString(model, "agentModels values");
    }

    return {
        subagentModel: modelString(options.subagentModel, "subagentModel"),
        orchestratorModel,
        orchestratorAgent:
            options.orchestratorAgent === undefined
                ? DEFAULTS.orchestratorAgent
                : nonEmptyString(options.orchestratorAgent, "orchestratorAgent"),
        orchestratorDepth,
        orchestratorModels,
        agents,
        agentModels,
        instructions: optionalString(options.instructions, "instructions"),
        blockedTools,
        restrictTask,
    };
};

/**
 * Ordered list of orchestrator level agent names for the normalized options:
 * `["Manager"]` for depth 1, `["Manager", "Manager-2", "Manager-3"]` for
 * depth 3.
 */
export const orchestratorLevels = (opts: NormalizedOptions): string[] => {
    const names = [opts.orchestratorAgent];
    for (let level = 2; level <= opts.orchestratorDepth; level += 1) {
        names.push(`${opts.orchestratorAgent}-${level}`);
    }
    return names;
};
