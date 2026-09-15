import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/v2.ts";
import {PLUGIN_ID} from "../src/core/constants.ts";
import type {V2Agent, V2AgentDraft} from "../src/v2/types.ts";

type ToolEvent = {tool: string; agent: string; input: unknown};

const createAgent = (id: string, mode: V2Agent["mode"] = "subagent"): V2Agent => ({
    id,
    mode,
    permissions: [],
});

const apply = async (options: Record<string, unknown>, initial: V2Agent[] = []) => {
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

test("exports the OpenCode 2 plugin contract", () => {
    assert.equal(plugin.id, PLUGIN_ID);
    assert.equal(typeof plugin.setup, "function");
});

test("translates agent config and permissions", async () => {
    const {agents} = await apply(
        {
            subagentModel: "worker/fast",
            orchestratorModel: "manager/strong",
            agents: ["general", "explore"],
            restrictTask: true,
        },
        [createAgent("general"), createAgent("explore")],
    );
    const manager = agents.get("Manager");
    const general = agents.get("general");

    assert.ok(manager);
    assert.ok(general);
    assert.equal(manager.mode, "primary");
    assert.deepEqual(manager.model, {providerID: "manager", id: "strong"});
    assert.match(manager.system ?? "", /# Orchestrator Mode \(enforced by @beremaran\/opencode-agent-tree\)/);
    assert.deepEqual(general.model, {providerID: "worker", id: "fast"});
    assert.ok(manager.permissions.some((rule) => rule.action === "edit" && rule.effect === "deny"));
    assert.ok(manager.permissions.some((rule) => rule.action === "shell" && rule.effect === "deny"));
    assert.ok(
        manager.permissions.some(
            (rule) => rule.action === "subagent" && rule.resource === "general" && rule.effect === "allow",
        ),
    );
    assert.equal(
        manager.permissions.some((rule) => rule.action === "bash" || rule.action === "task"),
        false,
    );
});

test("deep orchestration creates subagent levels", async () => {
    const {agents} = await apply({subagentModel: "worker/fast", orchestratorDepth: 2}, [
        createAgent("general"),
        createAgent("explore"),
    ]);
    const manager2 = agents.get("Manager-2");

    assert.ok(manager2);
    assert.equal(manager2.mode, "subagent");
    assert.match(manager2.system ?? "", /level 2\/2/);
    assert.ok(
        manager2.permissions.some(
            (rule) => rule.action === "subagent" && rule.resource === "*" && rule.effect === "allow",
        ),
    );
    assert.ok(
        manager2.permissions.some(
            (rule) => rule.action === "todowrite" && rule.resource === "*" && rule.effect === "allow",
        ),
    );
});

test("runtime guard rejects an unscoped long subagent brief", async () => {
    const {runtimeHook} = await apply({subagentModel: "worker/fast"});
    assert.ok(runtimeHook);
    await assert.rejects(
        async () => runtimeHook?.({tool: "subagent", agent: "Manager", input: {prompt: "x".repeat(201)}}),
        /lacks explicit target file/,
    );
    await assert.doesNotReject(async () => {
        await runtimeHook?.({
            tool: "subagent",
            agent: "Manager",
            input: {prompt: `${"x".repeat(201)} in src/app.ts`},
        });
    });
});

test("requires a delegated-work model", async () => {
    await assert.rejects(() => apply({}), /subagentModel.*required/);
});
