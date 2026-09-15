#!/usr/bin/env node
/** Runtime smoke test for the OpenCode 2 plugin. */

import {spawn} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

const hasPermission = (agent, action, resource, effect) =>
    Array.isArray(agent?.permissions) &&
    agent.permissions.some((rule) => rule.action === action && rule.resource === resource && rule.effect === effect);

const startServer = (cwd, configDir) => {
    const env = {...process.env, OPENCODE_CONFIG_DIR: configDir};
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_CONTENT;
    const server = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    return new Promise((resolve_, reject) => {
        let output = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            server.kill();
            reject(new Error(`OpenCode server did not start${output ? `:\n${output}` : ""}`));
        }, 15_000);
        const onOutput = (chunk) => {
            output += chunk;
            const match = output.match(/server listening on (https?:\/\/[^\s]+)[\r\n]+server password ([^\s]+)/);
            if (!match || settled) return;
            settled = true;
            clearTimeout(timer);
            resolve_({server, url: match[1], password: match[2]});
        };
        server.stdout.on("data", onOutput);
        server.stderr.on("data", onOutput);
        server.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        server.once("exit", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`OpenCode server exited with code ${code}${output ? `:\n${output}` : ""}`));
        });
    });
};

const stopServer = async (server) => {
    if (server.exitCode !== null) return;
    server.kill();
    await new Promise((resolve_) => server.once("exit", resolve_));
};

const getAgent = async (url, password, id) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await fetch(`${url}/api/agent/${encodeURIComponent(id)}`, {
            headers: {authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`},
        });
        const body = await response.text();
        if (response.ok) return JSON.parse(body).data;
        if (response.status !== 404) {
            throw new Error(`OpenCode agent request failed (${response.status}): ${body}`);
        }
        await new Promise((resolve_) => setTimeout(resolve_, 100));
    }
    throw new Error(`OpenCode agent "${id}" was not available after plugin activation`);
};

const main = async () => {
    const configDir = mkdtempSync(join(tmpdir(), "opencode-agent-tree-config-"));
    const workspace = mkdtempSync(join(tmpdir(), "opencode-agent-tree-workspace-"));
    let server;
    try {
        writeFileSync(
            join(workspace, "opencode.json"),
            JSON.stringify(
                {
                    $schema: "https://opencode.ai/config.json",
                    default_agent: "Manager",
                    plugins: [{package: REPO_ROOT}],
                },
                null,
                2,
            ),
        );
        const started = await startServer(workspace, configDir);
        server = started.server;

        const manager = await getAgent(started.url, started.password, "Manager");
        const general = await getAgent(started.url, started.password, "general");
        const explore = await getAgent(started.url, started.password, "explore");

        if (manager.mode !== "primary") throw new Error(`Manager mode was ${JSON.stringify(manager.mode)}`);
        if (!manager.system?.includes("# Recursive Decomposition Delegation")) {
            throw new Error("Manager system prompt does not contain the delegation directive");
        }
        if (!hasPermission(manager, "*", "*", "deny")) {
            throw new Error("Manager does not deny wildcard actions");
        }
        if (!hasPermission(manager, "subagent", "general", "allow")) {
            throw new Error("Manager cannot delegate to general");
        }
        if (
            !general.system?.includes("# Recursive Worker Mode") ||
            !hasPermission(general, "subagent", "explore", "allow")
        ) {
            throw new Error("general does not have recursive worker delegation enabled");
        }
        if (
            !explore.system?.includes("# Recursive Worker Mode") ||
            !hasPermission(explore, "subagent", "general", "allow")
        ) {
            throw new Error("explore does not have recursive worker delegation enabled");
        }

        console.log("PASS OpenCode 2 local plugin smoke test");
        console.log("Manager: mode=primary, wildcard actions=deny, subagent=general");
    } finally {
        if (server) await stopServer(server);
        rmSync(workspace, {recursive: true, force: true});
        rmSync(configDir, {recursive: true, force: true});
    }
};

main().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
});
