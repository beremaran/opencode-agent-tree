import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/v2.ts";
import {
    FIRST_WORKER_AGENT,
    KNOWN_PRIMARY_AGENTS,
    MANAGER_AGENT,
    MANAGER_DIRECTIVE_MARKER,
    PLUGIN_ID,
    ROOT_BLOCKED_ACTION,
    WORKER_DIRECTIVE_MARKER,
} from "../src/core/constants.ts";
import type {V2Agent, V2AgentDraft} from "../src/v2/types.ts";

type ToolEvent = {tool: string; agent: string; input: unknown};

const createAgent = (id: string, mode: V2Agent["mode"] = "subagent", system?: string): V2Agent => ({
    id,
    mode,
    ...(system ? {system} : {}),
    permissions: [],
});

const apply = async (options: unknown = {}, initial: V2Agent[] = []) => {
    const agents = new Map(initial.map((agent) => [agent.id, agent]));
    let runtimeHook: ((event: ToolEvent) => Promise<void> | void) | undefined;
    const draft: V2AgentDraft = {
        list: () => [...agents.values()],
        get: (id) => agents.get(id),
        update: (id, update) => {
            const agent = agents.get(id) ?? createAgent(id);
            agents.set(id, agent);
            update(agent);
        },
    };

    await plugin.setup({
        options,
        agent: {transform: async (callback) => callback(draft)},
        tool: {
            hook: async (_name, callback) => {
                runtimeHook = callback;
            },
        },
    });

    return {agents, runtimeHook};
};

const hasRule = (agent: V2Agent, action: string, resource: string, effect: string): boolean =>
    agent.permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect);

test("exports the OpenCode 2 plugin contract", () => {
    assert.equal(plugin.id, PLUGIN_ID);
    assert.equal(typeof plugin.setup, "function");
});

test("creates a toolless Manager and recursive workers", async () => {
    const managerModel = {providerID: "manager", id: "configured"};
    const generalModel = {providerID: "worker", id: "configured"};
    const {agents} = await apply({}, [
        {...createAgent(MANAGER_AGENT, "primary"), model: managerModel},
        {...createAgent("general"), model: generalModel},
        createAgent("explore", "subagent", "Keep this prompt."),
    ]);
    const manager = agents.get(MANAGER_AGENT);
    const general = agents.get("general");
    const explore = agents.get("explore");

    assert.ok(manager);
    assert.ok(general);
    assert.ok(explore);
    assert.equal(manager.mode, "primary");
    assert.deepEqual(manager.model, managerModel);
    assert.deepEqual(general.model, generalModel);
    assert.equal(manager.system?.includes(MANAGER_DIRECTIVE_MARKER), true);
    assert.equal(explore.system?.includes(`Keep this prompt.\n\n${WORKER_DIRECTIVE_MARKER}`), true);
    assert.ok(hasRule(manager, "subagent", "*", "deny"));
    assert.ok(hasRule(manager, "subagent", FIRST_WORKER_AGENT, "allow"));
    assert.equal(hasRule(manager, "subagent", "explore", "allow"), false);
    assert.ok(hasRule(manager, ROOT_BLOCKED_ACTION, "*", "deny"));
    assert.ok(hasRule(general, "subagent", "*", "deny"));
    assert.ok(hasRule(general, "subagent", "explore", "allow"));
    assert.ok(hasRule(explore, "subagent", "*", "deny"));
    assert.ok(hasRule(explore, "subagent", "general", "allow"));
    assert.equal(agents.has("Manager-2"), false);
});

test("routes every enabled non-primary agent and excludes primary agents", async () => {
    const {agents} = await apply({}, [
        createAgent("worker"),
        createAgent("primary-worker", "primary"),
        ...KNOWN_PRIMARY_AGENTS.map((name) => createAgent(name, "primary")),
    ]);
    const manager = agents.get(MANAGER_AGENT);
    const worker = agents.get("worker");

    assert.ok(manager);
    assert.ok(worker);
    assert.ok(hasRule(worker, "subagent", "general", "allow"));
    assert.ok(hasRule(worker, "subagent", "explore", "allow"));
    assert.ok(hasRule(worker, "subagent", "*", "deny"));
    assert.equal(hasRule(worker, "subagent", "worker", "allow"), false);
    assert.equal(hasRule(worker, "subagent", "primary-worker", "allow"), false);
    assert.equal(hasRule(manager, "subagent", "worker", "allow"), false);
});

test("root handoff is broad but recursive child briefs need scope", async () => {
    const {runtimeHook} = await apply();
    assert.ok(runtimeHook);
    const broadBrief = {prompt: "x".repeat(201)};

    await assert.doesNotReject(async () => runtimeHook?.({tool: "subagent", agent: MANAGER_AGENT, input: broadBrief}));
    await assert.rejects(
        async () => runtimeHook?.({tool: "read", agent: MANAGER_AGENT, input: {}}),
        /Manager is delegation-only/,
    );
    await assert.rejects(
        async () => runtimeHook?.({tool: "subagent", agent: FIRST_WORKER_AGENT, input: broadBrief}),
        /Recursive delegation rejected: brief lacks explicit target file/,
    );
    await assert.doesNotReject(async () =>
        runtimeHook?.({tool: "task", agent: FIRST_WORKER_AGENT, input: {prompt: `${"x".repeat(201)} in src/app.ts`}}),
    );
    await assert.doesNotReject(async () => runtimeHook?.({tool: "read", agent: FIRST_WORKER_AGENT, input: broadBrief}));
});

test("rejects plugin options", async () => {
    await assert.rejects(() => apply({subagentModel: "worker/fast"}), /zero-config.*subagentModel/);
});

test("is idempotent for existing directives", async () => {
    const managerSystem = `${MANAGER_DIRECTIVE_MARKER}\nmanager rules`;
    const workerSystem = `${WORKER_DIRECTIVE_MARKER}\nworker rules`;
    const {agents} = await apply({}, [
        {...createAgent(MANAGER_AGENT, "primary"), system: managerSystem},
        {...createAgent("general"), system: workerSystem},
    ]);

    assert.equal(agents.get(MANAGER_AGENT)?.system, managerSystem);
    assert.equal(agents.get("general")?.system, workerSystem);
});
