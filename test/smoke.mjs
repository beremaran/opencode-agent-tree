#!/usr/bin/env node
/**
 * Runtime smoke test for the OpenCode 2 plugin.
 *
 * Uses the current `opencode debug agents` command against the checked-in
 * local-checkout config and verifies the generated orchestrator agent.
 * Requires the `opencode` CLI on PATH (override with OPENCODE_BIN).
 */

import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

const run = (command, args, options) =>
    new Promise((resolve_) => {
        const child = spawn(command, args, options);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", (error) => resolve_({code: null, error, stdout, stderr}));
        child.on("close", (code, signal) => resolve_({code, signal, stdout, stderr}));
    });

const hasPermission = (agent, action, effect) =>
    Array.isArray(agent?.permissions) &&
    agent.permissions.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === effect);

const main = async () => {
    const xdgHome = mkdtempSync(join(tmpdir(), "opencode-agent-tree-xdg-"));
    try {
        const result = await run(OPENCODE_BIN, ["debug", "agents"], {
            cwd: REPO_ROOT,
            env: {...process.env, XDG_CONFIG_HOME: xdgHome},
            stdio: ["ignore", "pipe", "pipe"],
        });

        if (result.error || result.code !== 0) {
            throw new Error(result.error?.message ?? (result.stderr.trim() || `exit code ${result.code}`));
        }

        let agents;
        try {
            agents = JSON.parse(result.stdout);
        } catch (error) {
            throw new Error(`opencode debug agents did not return JSON: ${error.message}\n${result.stdout}`);
        }

        if (!Array.isArray(agents)) {
            throw new Error("opencode debug agents returned a non-array result");
        }

        const manager = agents.find((agent) => agent.id === "Manager");
        if (!manager) {
            throw new Error('generated "Manager" agent was not found');
        }
        for (const name of ["general", "explore"]) {
            if (!agents.some((agent) => agent.id === name)) {
                throw new Error(`built-in "${name}" agent was not found`);
            }
        }
        if (manager.mode !== "primary") {
            throw new Error(`Manager mode was ${JSON.stringify(manager.mode)}`);
        }
        if (typeof manager.system !== "string" || !manager.system.includes("# Orchestrator Mode")) {
            throw new Error("Manager system prompt does not contain the orchestrator directive");
        }
        for (const action of ["edit", "shell"]) {
            if (!hasPermission(manager, action, "deny")) {
                throw new Error(`Manager does not deny the ${action} action`);
            }
        }

        console.log("PASS OpenCode 2 local plugin smoke test");
        console.log("Manager: mode=primary, edit=deny, shell=deny");
    } finally {
        rmSync(xdgHome, {recursive: true, force: true});
    }
};

main().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
});
