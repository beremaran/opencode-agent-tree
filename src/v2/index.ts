import {
    BUILTIN_WORKERS,
    FIRST_WORKER_AGENT,
    KNOWN_PRIMARY_AGENTS,
    MANAGER_AGENT,
    MANAGER_DIRECTIVE_MARKER,
    PLUGIN_ID,
    ROOT_BLOCKED_ACTION,
    WORKER_DIRECTIVE_MARKER,
} from "../core/constants.ts";
import {hasExplicitScope, managerDirective, workerDirective} from "../core/delegation.ts";
import type {V2Agent, V2AgentDraft, V2PermissionRule, V2Context, V2Plugin} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

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

const v2TaskRule = (entry: V2Agent, targets: readonly string[]): void => {
    v2AddPermission(entry, {action: "subagent", resource: "*", effect: "deny"});
    for (const target of targets) {
        v2AddPermission(entry, {action: "subagent", resource: target, effect: "allow"});
    }
};

const appendDirective = (entry: V2Agent, directive: string, marker: string): void => {
    if (entry.system?.includes(marker)) {
        return;
    }
    entry.system = entry.system ? `${entry.system}\n\n${directive}` : directive;
};

const isEligibleWorker = (name: string, entry: V2Agent | undefined): boolean =>
    name !== MANAGER_AGENT &&
    !KNOWN_PRIMARY_AGENTS.includes(name as (typeof KNOWN_PRIMARY_AGENTS)[number]) &&
    entry?.mode !== "primary" &&
    entry?.mode !== "disabled";

const workerNames = (draft: V2AgentDraft): string[] => {
    const names = [...BUILTIN_WORKERS, ...draft.list().map((entry) => entry.id)];
    return [...new Set(names)].filter((name) => isEligibleWorker(name, draft.get(name)));
};

const v2ApplyConfig = (draft: V2AgentDraft): string[] => {
    const workers = workerNames(draft);
    const manager = v2EnsureAgent(draft, MANAGER_AGENT);
    manager.mode = "primary";
    manager.description ??= "Root agent that delegates every actionable request to recursive workers.";
    appendDirective(manager, managerDirective(), MANAGER_DIRECTIVE_MARKER);
    v2AddPermission(manager, {action: ROOT_BLOCKED_ACTION, resource: "*", effect: "deny"});
    v2TaskRule(manager, [FIRST_WORKER_AGENT]);

    for (const name of workers) {
        const worker = v2EnsureAgent(draft, name);
        worker.mode ??= "subagent";
        appendDirective(worker, workerDirective(), WORKER_DIRECTIVE_MARKER);
        v2TaskRule(
            worker,
            workers.filter((target) => target !== name),
        );
    }

    return workers;
};

const assertZeroConfig = (options: unknown): void => {
    if (options == null) {
        return;
    }
    if (!isRecord(options)) {
        throw new Error(`[${PLUGIN_ID}] This plugin is zero-config and does not accept options.`);
    }
    const keys = Object.keys(options);
    if (keys.length > 0) {
        throw new Error(
            `[${PLUGIN_ID}] This plugin is zero-config; remove unsupported option${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}.`,
        );
    }
};

const v2RuntimeGuard = async (context: V2Context, workers: readonly string[]): Promise<void> => {
    const hook = context.tool?.hook;
    if (!hook) {
        return;
    }

    const workerSet = new Set(workers);
    await hook("execute.before", async (event) => {
        if (event.agent === MANAGER_AGENT && event.tool !== "task" && event.tool !== "subagent") {
            throw new Error(`[${PLUGIN_ID}] Manager is delegation-only and cannot execute "${event.tool}".`);
        }
        if ((event.tool !== "task" && event.tool !== "subagent") || !workerSet.has(event.agent)) {
            return;
        }

        const input = isRecord(event.input) ? event.input : {};
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        if (prompt.length <= 200 || hasExplicitScope(prompt)) {
            return;
        }

        throw new Error(
            `[${PLUGIN_ID}] Recursive delegation rejected: brief lacks explicit target file, directory, or module scope.`,
        );
    });
};

const V2_PLUGIN: V2Plugin = {
    id: PLUGIN_ID,
    setup: async (context) => {
        assertZeroConfig(context.options);
        let workers: string[] = [];
        await context.agent.transform((draft) => {
            workers = v2ApplyConfig(draft);
        });
        await v2RuntimeGuard(context, workers);
    },
};

export type {V2Context, V2Plugin} from "./types.ts";
export default V2_PLUGIN;
