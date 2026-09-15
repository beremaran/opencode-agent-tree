import {BUILTIN_SUBAGENTS, KNOWN_BUILTINS, PLUGIN_ID} from "../core/constants.ts";
import {hasExplicitScope, levelDirectiveMarker, orchestratorDirective} from "../core/directives.ts";
import {isRecord, normalizeOptions, orchestratorLevels} from "../core/options.ts";
import type {NormalizedOptions} from "../core/types.ts";
import type {V2Agent, V2AgentDraft, V2PermissionRule, V2Context, V2Plugin} from "./types.ts";

const V2_ACTIONS: Record<string, string> = {
    bash: "shell",
    task: "subagent",
};

const v2Action = (name: string): string => V2_ACTIONS[name] ?? name;

const v2Model = (model: string, existing: V2Agent["model"]): NonNullable<V2Agent["model"]> => {
    const separator = model.indexOf("/");
    return {
        providerID: model.slice(0, separator),
        id: model.slice(separator + 1),
        ...(existing?.variant ? {variant: existing.variant} : {}),
    };
};

const v2EnsureAgent = (draft: V2AgentDraft, name: string): V2Agent => {
    let entry: V2Agent | undefined;
    draft.update(name, (agent) => {
        entry = agent;
    });
    const resolved = entry ?? draft.get(name);
    if (!resolved) {
        throw new Error(`[${PLUGIN_ID}] OpenCode 2 could not create agent "${name}".`);
    }
    resolved.permissions ??= [];
    return resolved;
};

const v2AddPermission = (entry: V2Agent, rule: V2PermissionRule): void => {
    entry.permissions ??= [];
    if (
        entry.permissions.some(
            (existing) =>
                existing.action === rule.action &&
                existing.resource === rule.resource &&
                existing.effect === rule.effect,
        )
    ) {
        return;
    }
    entry.permissions.push(rule);
};

const v2DenyTools = (entry: V2Agent, blockedTools: string[]): void => {
    for (const tool of blockedTools) {
        v2AddPermission(entry, {action: v2Action(tool), resource: "*", effect: "deny"});
    }
};

const v2TaskRule = (entry: V2Agent, targets: string[], restrict: boolean): void => {
    v2AddPermission(entry, {action: "subagent", resource: "*", effect: "deny"});
    if (!restrict) {
        v2AddPermission(entry, {action: "subagent", resource: "*", effect: "allow"});
        return;
    }
    for (const target of targets) {
        v2AddPermission(entry, {action: "subagent", resource: target, effect: "allow"});
    }
};

const v2InScope = (name: string, entry: V2Agent | undefined, levelNames: Set<string>): boolean =>
    !KNOWN_BUILTINS.includes(name) && entry?.mode !== "primary" && !levelNames.has(name);

const v2ApplyConfig = (draft: V2AgentDraft, opts: NormalizedOptions): void => {
    const levels = orchestratorLevels(opts);
    const levelNames = new Set(levels);
    const candidates = opts.agents ?? [...BUILTIN_SUBAGENTS, ...draft.list().map((entry) => entry.id)];
    const targets = [...new Set(candidates)].filter((name) => v2InScope(name, draft.get(name), levelNames));

    for (const name of targets) {
        const entry = v2EnsureAgent(draft, name);
        if (!entry.model) {
            entry.model = v2Model(
                Object.hasOwn(opts.agentModels, name) ? opts.agentModels[name] : opts.subagentModel,
                entry.model,
            );
        }
    }

    for (let index = 0; index < levels.length; index += 1) {
        const name = levels[index];
        const level = index + 1;
        const depth = opts.orchestratorDepth;
        const isFinal = level === depth;
        const entry = v2EnsureAgent(draft, name);
        const levelModel = opts.orchestratorModels?.[level - 1] ?? opts.orchestratorModel;

        if (!entry.description) {
            entry.description =
                level === 1
                    ? "Orchestrator agent: decomposes every request and delegates to subagents."
                    : isFinal
                      ? `Orchestrator agent (level ${level}/${depth}): decomposes requests from the level above and delegates to the routed subagents.`
                      : `Orchestrator agent (level ${level}/${depth}): decomposes requests from the level above and delegates to the next level.`;
        }
        entry.mode = level === 1 ? "primary" : "subagent";
        if (levelModel) {
            entry.model = v2Model(levelModel, entry.model);
        }
        v2DenyTools(entry, opts.blockedTools);

        if (isFinal) {
            if (depth > 1 || (opts.restrictTask && targets.length > 0)) {
                v2TaskRule(entry, targets, opts.restrictTask && targets.length > 0);
            }
        } else {
            v2TaskRule(entry, [levels[index + 1]], true);
        }
        if (level > 1) {
            v2AddPermission(entry, {action: "todowrite", resource: "*", effect: "allow"});
        }

        const marker = levelDirectiveMarker(level, depth);
        if (!entry.system?.includes(marker)) {
            const directive = orchestratorDirective(opts, level, depth, isFinal ? undefined : levels[index + 1]);
            entry.system = entry.system ? `${entry.system}\n\n${directive}` : directive;
        }
    }
};

const v2RuntimeGuard = async (context: V2Context, opts: NormalizedOptions): Promise<void> => {
    const hook = context.tool?.hook;
    if (!hook) {
        return;
    }

    await hook("execute.before", async (event) => {
        if (event.tool !== "task" && event.tool !== "subagent") {
            return;
        }
        if (!orchestratorLevels(opts).includes(event.agent)) {
            return;
        }

        const input = isRecord(event.input) ? event.input : {};
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        if (prompt.length <= 200 || hasExplicitScope(prompt)) {
            return;
        }

        const message = `[${PLUGIN_ID}] Delegation rejected: subtask brief lacks explicit target file, directory, or module scope. Specify exact paths or boundaries for the worker subagent.`;
        throw new Error(message);
    });
};

const V2_PLUGIN: V2Plugin = {
    id: PLUGIN_ID,
    setup: async (context) => {
        const opts = normalizeOptions(context.options ?? {});
        await context.agent.transform((draft) => v2ApplyConfig(draft, opts));
        await v2RuntimeGuard(context, opts);
    },
};

export type {V2Context, V2Plugin} from "./types.ts";
export default V2_PLUGIN;
