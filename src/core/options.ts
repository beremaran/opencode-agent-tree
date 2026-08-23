import {z} from "zod";
import {BLOCKED_TOOL_PATTERN, DEFAULTS, MODEL_PATTERN, PLUGIN_ID} from "./constants.ts";
import type {NormalizedOptions} from "./types.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const mustBe = (name: string, expected: string): string => `[${PLUGIN_ID}] The \`${name}\` option must be ${expected}.`;

/** Maps `undefined`, `null`, and whitespace-only strings to `undefined`. */
const blankToUndefined = (value: unknown): unknown =>
    value == null || (typeof value === "string" && value.trim() === "") ? undefined : value;

/** Maps whitespace-only strings to `undefined` (other blanks still fail validation). */
const whitespaceToUndefined = (value: unknown): unknown =>
    typeof value === "string" && value.trim() === "" ? undefined : value;

/** Trims string input up front, then rejects values empty after trimming. */
const nonEmptyString = (name: string) =>
    z.preprocess(
        (value) => (typeof value === "string" ? value.trim() : value),
        z.string({error: mustBe(name, "a non-empty string")}).min(1, {error: mustBe(name, "a non-empty string")}),
    );

/** Non-empty trimmed string constrained to `provider/model` ids. */
const modelString = (name: string) =>
    nonEmptyString(name).superRefine((model, ctx) => {
        if (!MODEL_PATTERN.test(model)) {
            ctx.addIssue({
                code: "custom",
                message: mustBe(name, `a model id like "provider/model" (got \`${model}\`)`),
            });
        }
    });

/** Array of non-empty trimmed strings, de-duplicated. */
const stringArray = (name: string) =>
    z
        .array(nonEmptyString(`${name} entries`), {
            error: mustBe(name, "an array of non-empty strings"),
        })
        .transform((entries) => [...new Set(entries)]);

/** `blockedTools` entries must look like tool names. */
const validateBlockedToolNames = (names: string[], ctx: z.RefinementCtx): void => {
    for (const name of names) {
        if (!BLOCKED_TOOL_PATTERN.test(name)) {
            ctx.addIssue({
                code: "custom",
                message: mustBe("blockedTools entries", `tool names matching /^[a-z0-9_-]+$/ (got \`${name}\`)`),
            });
        }
    }
};

const REQUIRED_MODEL_MESSAGE = `[${PLUGIN_ID}] The \`subagentModel\` option is required, e.g. ["${PLUGIN_ID}", { "subagentModel": "anthropic/claude-sonnet-4-6" }]`;

const OPTIONS_SCHEMA = z
    .object(
        {
            subagentModel: z.preprocess(blankToUndefined, modelString("subagentModel").optional()),
            orchestratorModel: z.preprocess(blankToUndefined, modelString("orchestratorModel").optional()),
            orchestratorAgent: nonEmptyString("orchestratorAgent").default(DEFAULTS.orchestratorAgent),
            orchestratorDepth: z
                .number({error: mustBe("orchestratorDepth", "a positive integer")})
                .int(mustBe("orchestratorDepth", "a positive integer"))
                .min(1, mustBe("orchestratorDepth", "a positive integer"))
                .default(1),
            orchestratorModels: z
                .array(modelString("orchestratorModels"), {
                    error: mustBe("orchestratorModels", "an array of `provider/model` ids"),
                })
                .transform((models) => [...new Set(models)])
                .transform((models) => (models.length === 0 ? undefined : models))
                .optional(),
            agents: stringArray("agents").optional(),
            agentModels: z
                .record(z.string(), modelString("agentModels values"), {
                    error: mustBe("agentModels", "an object with non-empty string values"),
                })
                .superRefine((record, ctx) => {
                    for (const key of Object.keys(record)) {
                        if (key.trim() === "") {
                            ctx.addIssue({
                                code: "custom",
                                message: mustBe("agentModels keys", "a non-empty string"),
                            });
                            return;
                        }
                    }
                })
                .transform((record) =>
                    Object.fromEntries(Object.entries(record).map(([key, value]) => [key.trim(), value])),
                )
                .default({}),
            instructions: z.preprocess(whitespaceToUndefined, nonEmptyString("instructions").optional()),
            blockedTools: stringArray("blockedTools")
                .superRefine(validateBlockedToolNames)
                .default([...DEFAULTS.blockedTools]),
            restrictTask: z.boolean({error: mustBe("restrictTask", "a boolean")}).default(false),
        },
        {error: mustBe("options", "an object")},
    )
    .superRefine((opts, ctx) => {
        if (opts.subagentModel === undefined) {
            ctx.addIssue({code: "custom", message: REQUIRED_MODEL_MESSAGE});
        }
        const models = opts.orchestratorModels;
        if (models !== undefined && models.length > opts.orchestratorDepth) {
            ctx.addIssue({
                code: "custom",
                message: `[${PLUGIN_ID}] The \`orchestratorModels\` option has ${models.length} entries but \`orchestratorDepth\` is ${opts.orchestratorDepth}.`,
            });
        }
    });

/**
 * Parses and validates the plugin's factory options. Throws an `Error` whose
 * message describes the first offending option; see `OrchestratorOptions`.
 */
export const normalizeOptions = (rawOptions: unknown): NormalizedOptions => {
    const result = OPTIONS_SCHEMA.safeParse(rawOptions == null ? {} : rawOptions);
    if (!result.success) {
        throw new Error(result.error.issues[0]?.message ?? `[${PLUGIN_ID}] Invalid plugin options.`);
    }
    const {subagentModel, ...rest} = result.data;
    if (subagentModel === undefined) {
        // Unreachable: the schema refinement above enforces this; kept as a type guard.
        throw new Error(REQUIRED_MODEL_MESSAGE);
    }
    return {...rest, subagentModel};
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
