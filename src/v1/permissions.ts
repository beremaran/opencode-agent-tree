import {PLUGIN_ID} from "../core/constants.ts";
import {isRecord} from "../core/options.ts";
import type {AgentLike} from "../core/types.ts";
import type {LogFn} from "./types.ts";

/**
 * Builds the `task` permission rule for a delegation target: deny delegation
 * to every agent except the allowed ones (e.g.
 * `{ "*": "deny", "Manager-2": "allow" }` or, for restrictTask,
 * `{ "*": "deny", "general": "allow", "explore": "allow" }`).
 */
export const taskRuleFor = (targets: string[]): Record<string, "deny" | "allow"> => {
    const rule: Record<string, "deny" | "allow"> = {"*": "deny"};
    for (const name of targets) {
        rule[name] = "allow";
    }
    return rule;
};

/**
 * Structural equality check used to keep permission rules idempotent. Rules
 * may be the object form `{ "<target>": "allow" | "deny" }` (pattern-scoped
 * tools like `task`) or a plain action string (tools like `todowrite`, whose
 * opencode schema only accepts an action).
 */
const sameTaskRule = (value: unknown, expected: Record<string, "deny" | "allow"> | string): boolean => {
    if (typeof expected === "string") {
        return value === expected;
    }
    if (!isRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    if (keys.length !== Object.keys(expected).length) {
        return false;
    }
    return keys.every((key) => value[key] === expected[key]);
};

/**
 * Returns a fresh, shallow-copied permission object for the agent, logging a
 * warning when an existing non-object permission is replaced (mirrors the
 * historical behavior of treating a missing or malformed permission as an
 * empty object).
 */
const permissionFor = async (entry: AgentLike, name: string, log: LogFn): Promise<Record<string, unknown>> => {
    const rawPermission = entry.permission;
    if (!isRecord(rawPermission)) {
        await log({
            body: {
                service: PLUGIN_ID,
                level: "warn",
                message: `Orchestrator agent "${name}" has a non-object permission; replacing it with an empty permission object`,
            },
        });
        return {};
    }
    return {...rawPermission};
};

/** Merges the blocked-tools denies into the agent's permission object. */
export const applyBlockedTools = async (
    entry: AgentLike,
    name: string,
    blockedTools: string[],
    log: LogFn,
): Promise<void> => {
    if (blockedTools.length === 0) {
        return;
    }
    const permission = await permissionFor(entry, name, log);
    for (const tool of blockedTools) {
        if (permission[tool] !== undefined && permission[tool] !== "deny") {
            await log({
                body: {
                    service: PLUGIN_ID,
                    level: "warn",
                    message: isRecord(permission[tool])
                        ? `Overwriting existing command-scoped rules for tool "${tool}" on agent "${name}" with blanket "deny"`
                        : `Overwriting existing permission for tool "${tool}" on agent "${name}" with "deny"`,
                },
            });
        }
        permission[tool] = "deny";
    }
    entry.permission = permission;
};

/**
 * Sets (or preserves) the agent's permission rule for `toolName` (default
 * `task`), warning on clobber. Rule values are either the object form
 * `{ "<target>": "allow" | "deny" }` for pattern-scoped tools (`task`) or a
 * plain action string for tools whose opencode schema only accepts an action
 * (`todowrite`).
 */
export const applyTaskRule = async (
    entry: AgentLike,
    name: string,
    rule: Record<string, "deny" | "allow"> | string,
    log: LogFn,
    toolName = "task",
): Promise<void> => {
    const permission = await permissionFor(entry, name, log);
    const existing = permission[toolName];
    if (existing !== undefined && !sameTaskRule(existing, rule)) {
        await log({
            body: {
                service: PLUGIN_ID,
                level: "warn",
                message: isRecord(existing)
                    ? `Overwriting existing command-scoped rules for tool "${toolName}" on agent "${name}" with the delegation rule`
                    : `Overwriting existing permission for tool "${toolName}" on agent "${name}" with the delegation rule`,
            },
        });
        permission[toolName] = rule;
    } else if (existing === undefined) {
        permission[toolName] = rule;
    }
    entry.permission = permission;
};
