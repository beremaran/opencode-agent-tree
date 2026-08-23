import {BUILTIN_SUBAGENTS, DIRECTIVE_TOOLS, KNOWN_BUILTINS, PLUGIN_ID} from "../core/constants.ts";
import {hasExplicitScope, levelDirectiveMarker, orchestratorDirective, promptOverlapRatio} from "../core/directives.ts";
import {normalizeOptions, orchestratorLevels} from "../core/options.ts";
import type {AgentLike, NormalizedOptions} from "../core/types.ts";
import {applyBlockedTools, applyTaskRule, taskRuleFor} from "./permissions.ts";
import type {LegacyConfig, LegacyMessage, LegacyPart, LegacyPlugin, LogFn} from "./types.ts";

const isSubagentLike = (agent: AgentLike | undefined) =>
    !agent || agent.mode === undefined || agent.mode === "subagent" || agent.mode === "all";

/**
 * Reads `cfg.default_agent` defensively for the summary log. Returns the
 * value only when it is a non-empty string, otherwise "(unset)". Never
 * throws if the field is missing or has an unexpected shape.
 */
const defaultAgentOf = (cfg: LegacyConfig): string => {
    const value = cfg.default_agent;
    return typeof value === "string" && value.trim() !== "" ? value : "(unset)";
};

/**
 * Reads opencode's `subagent_depth` config defensively for the chain-depth
 * warning. The `Config` type from @opencode-ai/plugin may not expose the field
 * (the SDK declares `subagent_depth?: number`), so it is
 * read via an intersection cast. Mirrors opencode's `?? 1` default: only an
 * integer number >= 0 counts as an explicit limit; anything else (missing,
 * string, fractional, negative) falls back to 1. An explicit `0` is a real
 * limit of 0.
 */
const subagentDepthOf = (cfg: LegacyConfig): number => {
    const value = cfg.subagent_depth;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 1;
};

// Extract user text from the most recent user message parts
const userTextFromMessages = (messages: Array<{info: LegacyMessage; parts: LegacyPart[]}> | undefined): string => {
    if (!messages) {
        return "";
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const {info, parts} = messages[i];
        if (info.role !== "user") {
            continue;
        }
        const texts = parts
            .filter((part): part is LegacyPart & {type: "text"; text: string} => part.type === "text" && !!part.text)
            .map((part) => part.text);
        return texts.join(" ").trim();
    }
    return "";
};

export const OrchestratorPlugin: LegacyPlugin = async ({client}, options = {}) => {
    let opts: NormalizedOptions;
    try {
        opts = normalizeOptions(options);
    } catch (error) {
        const message = error instanceof Error ? error.message : `[${PLUGIN_ID}] Invalid plugin options.`;
        await client.app.log({body: {service: PLUGIN_ID, level: "error", message}});
        throw error;
    }

    const log: LogFn = async (entry) => {
        await client.app.log(entry);
    };

    return {
        config: async (cfg) => {
            try {
                if (cfg.agent == null) {
                    cfg.agent = {};
                }
                const agent = cfg.agent as Record<string, AgentLike>;
                const hasAgent = (name: string) => Object.hasOwn(agent, name);
                const getAgent = (name: string) => (hasAgent(name) ? agent[name] : undefined);
                const ensureAgent = (name: string) => {
                    if (!hasAgent(name) || agent[name] == null) {
                        Object.defineProperty(agent, name, {
                            configurable: true,
                            enumerable: true,
                            value: {},
                            writable: true,
                        });
                    }
                    return agent[name];
                };

                const levels = orchestratorLevels(opts);
                const levelNames = new Set(levels);

                const inScope = (name: string, def: AgentLike | undefined) =>
                    !KNOWN_BUILTINS.includes(name) && !def?.disable && isSubagentLike(def) && !levelNames.has(name);

                // Every orchestrator level must be enabled; a disabled level aborts
                // the whole configuration (mirrors the single-orchestrator behavior).
                for (const name of levels) {
                    if (getAgent(name)?.disable) {
                        await log({
                            body: {
                                service: PLUGIN_ID,
                                level: "error",
                                message: `The orchestrator agent \`${name}\` is disabled; plugin will not apply its configuration.`,
                            },
                        });
                        return;
                    }
                }

                const blockedDirectiveTools = DIRECTIVE_TOOLS.filter((tool) => opts.blockedTools.includes(tool));
                if (blockedDirectiveTools.length > 0) {
                    await log({
                        body: {
                            service: PLUGIN_ID,
                            level: "warn",
                            message: `Orchestrator relies on blocked tool(s): ${blockedDirectiveTools.join(", ")}`,
                            extra: {blockedTools: opts.blockedTools},
                        },
                    });
                }

                // A chain of depth N performs N-1 nested task hops, so opencode's
                // `subagent_depth` (default 1) must be >= N. Warn before configuring
                // anything so the user can fix opencode.json up front.
                const subagentDepth = subagentDepthOf(cfg);
                if (opts.orchestratorDepth > subagentDepth) {
                    await log({
                        body: {
                            service: PLUGIN_ID,
                            level: "warn",
                            message: `orchestratorDepth (${opts.orchestratorDepth}) exceeds opencode's subagent_depth (${subagentDepth}); set "subagent_depth": ${opts.orchestratorDepth} in opencode.json or delegation beyond the first hop will fail with "Subagent depth limit reached"`,
                            extra: {orchestratorDepth: opts.orchestratorDepth, subagentDepth},
                        },
                    });
                }

                const candidates = opts.agents ?? [...BUILTIN_SUBAGENTS, ...Object.keys(agent)];
                const targets = [...new Set(candidates)].filter((name) => inScope(name, getAgent(name)));

                if (opts.agents !== undefined && !BUILTIN_SUBAGENTS.some((name) => targets.includes(name))) {
                    await log({
                        body: {
                            service: PLUGIN_ID,
                            level: "warn",
                            message:
                                "Explicit agents list excludes built-in subagents (general, explore); the orchestrator directive still instructs delegation to them.",
                            extra: {agents: opts.agents, targets},
                        },
                    });
                }

                // Route every delegation target to the user-chosen model. Known
                // built-in primaries (build, plan, compaction, title, summary) were
                // already filtered out by inScope and never reach this loop.
                for (const name of targets) {
                    const existed = hasAgent(name);
                    const def = ensureAgent(name);
                    if (!existed && !BUILTIN_SUBAGENTS.includes(name) && !KNOWN_BUILTINS.includes(name)) {
                        await log({
                            body: {
                                service: PLUGIN_ID,
                                level: "warn",
                                message: `Creating agent entry for unknown name "${name}" (typo in agents list?)`,
                            },
                        });
                    }
                    const model = Object.hasOwn(opts.agentModels, name) ? opts.agentModels[name] : opts.subagentModel;
                    if (!def.model) {
                        def.model = model;
                    }
                }

                // Configure every orchestrator level in the chain. Levels 1..N-1 may
                // only delegate to the next level (structural task pinning);
                // level N delegates to the routed subagents. Every level defaults to
                // the orchestrator model (or its `orchestratorModels[i]` entry) and
                // the blocked hands-on tools.
                let topOrchestrator: AgentLike | undefined;
                const effectiveModels: string[] = [];
                for (let index = 0; index < levels.length; index += 1) {
                    const name = levels[index];
                    const level = index + 1;
                    const depth = opts.orchestratorDepth;
                    const isFinal = level === depth;
                    // Per-level model resolution: `orchestratorModels[level - 1]` wins,
                    // then `orchestratorModel`, then the agent's existing/default model.
                    const levelModel = opts.orchestratorModels?.[level - 1] ?? opts.orchestratorModel;

                    const existed = hasAgent(name) && getAgent(name) != null;
                    const entry = ensureAgent(name);
                    if (index === 0) {
                        topOrchestrator = entry;
                    }
                    if (!existed) {
                        await log({
                            body: {
                                service: PLUGIN_ID,
                                level: "info",
                                message: `Creating orchestrator agent "${name}"`,
                            },
                        });
                    }
                    if (!entry.description) {
                        entry.description =
                            level === 1
                                ? "Orchestrator agent: decomposes every request and delegates to subagents."
                                : isFinal
                                  ? `Orchestrator agent (level ${level}/${depth}): decomposes requests from the level above and delegates to the routed subagents.`
                                  : `Orchestrator agent (level ${level}/${depth}): decomposes requests from the level above and delegates to the next level.`;
                    }
                    const targetMode = level === 1 ? "primary" : "subagent";
                    const previousMode = entry.mode;
                    if (entry.mode !== targetMode) {
                        entry.mode = targetMode;
                        if (previousMode !== undefined) {
                            await log({
                                body: {
                                    service: PLUGIN_ID,
                                    level: "warn",
                                    message: `Converting agent "${name}" mode "${previousMode}" to "${targetMode}" for orchestrator use`,
                                },
                            });
                        }
                    }
                    if (levelModel) {
                        entry.model = levelModel;
                    }
                    await applyBlockedTools(entry, name, opts.blockedTools, log);
                    if (isFinal) {
                        // The final level of a chain with depth >= 2 runs as a subagent.
                        // opencode injects `task: deny *` into the session of any
                        // subagent whose own permission declares no task rule, and a
                        // blanket deny hides the task tool entirely — so without an
                        // explicit rule the final orchestrator cannot delegate at all.
                        // `restrictTask` pins the rule to the routed targets; otherwise
                        // a blanket allow preserves prompt-only enforcement while
                        // keeping the tool available.
                        const pinToTargets = opts.restrictTask && targets.length > 0;
                        if (depth > 1 || pinToTargets) {
                            await applyTaskRule(entry, name, pinToTargets ? taskRuleFor(targets) : {"*": "allow"}, log);
                        }
                    } else {
                        // Structural chain enforcement, independent of restrictTask.
                        await applyTaskRule(entry, name, taskRuleFor([levels[index + 1]]), log);
                    }
                    if (level > 1) {
                        // opencode strips todowrite from subagent sessions the same way
                        // it strips task; every level's directive relies on it to track
                        // subtasks, so subagent levels must declare it explicitly. Note:
                        // opencode's config schema only accepts a plain action for
                        // todowrite (no pattern-object form), hence the string.
                        await applyTaskRule(entry, name, "allow", log, "todowrite");
                    }
                    const marker = levelDirectiveMarker(level, depth);
                    if (!entry.prompt?.includes(marker)) {
                        const directive = orchestratorDirective(
                            opts,
                            level,
                            depth,
                            isFinal ? undefined : levels[index + 1],
                        );
                        entry.prompt = entry.prompt ? `${entry.prompt}\n\n${directive}` : directive;
                    }
                    effectiveModels.push(levelModel ?? "(default)");
                }

                await log({
                    body: {
                        service: PLUGIN_ID,
                        level: "info",
                        message: `Orchestrator "${opts.orchestratorAgent}" enabled; subagents -> ${opts.subagentModel}`,
                        extra: {
                            routedAgents: targets,
                            orchestratorModel: topOrchestrator?.model ?? cfg.model ?? "(default)",
                            orchestratorModels: effectiveModels,
                            blockedTools: [...opts.blockedTools],
                            defaultAgent: defaultAgentOf(cfg),
                            orchestratorDepth: opts.orchestratorDepth,
                            orchestratorLevels: levels,
                        },
                    },
                });
            } catch (error) {
                await client.app.log({
                    body: {
                        service: PLUGIN_ID,
                        level: "error",
                        message: `[${PLUGIN_ID}] Unexpected error in opencode-agent-tree config hook (this is a plugin bug; please report it)`,
                        extra: {error},
                    },
                });
            }
        },

        "tool.execute.before": async (input, output) => {
            if (input.tool !== "task") {
                return;
            }

            // Only enforce for orchestrator agents (any level created by this plugin)
            const levelNames = new Set(orchestratorLevels(opts));
            let agentName: string | undefined;
            try {
                const sessionResult = await client.session.get({path: {id: input.sessionID}});
                const session = sessionResult.data;
                if (session && typeof session === "object" && "agent" in session && typeof session.agent === "string") {
                    agentName = session.agent;
                }
            } catch {
                // fall back to inferring from messages
            }
            if (!agentName) {
                try {
                    const messagesResult = await client.session.messages({
                        path: {id: input.sessionID},
                        query: {limit: 5},
                    });
                    const messages = messagesResult.data;
                    if (messages) {
                        for (let i = messages.length - 1; i >= 0; i--) {
                            const {info} = messages[i];
                            if ("agent" in info && typeof info.agent === "string") {
                                agentName = info.agent;
                                break;
                            }
                        }
                    }
                } catch {
                    // ignore
                }
            }
            if (!agentName || !levelNames.has(agentName)) {
                return;
            }

            const subtaskPrompt = typeof output.args?.prompt === "string" ? output.args.prompt : "";
            const rootPrompt = await (async () => {
                try {
                    const messagesResult = await client.session.messages({
                        path: {id: input.sessionID},
                        query: {limit: 50},
                    });
                    return userTextFromMessages(messagesResult.data);
                } catch {
                    return "";
                }
            })();

            // 1. Reject monolithic copy (>75% word overlap with root user prompt)
            if (promptOverlapRatio(subtaskPrompt, rootPrompt) > 0.75) {
                const message = `[${PLUGIN_ID}] Delegation rejected: subtask prompt is a monolithic copy of the user's request. Decompose into atomic subtasks covering specific files or components.`;
                await client.app.log({body: {service: PLUGIN_ID, level: "warn", message}});
                throw new Error(message);
            }

            // 2. Reject long briefs without explicit file/module scope
            if (subtaskPrompt.length > 200 && !hasExplicitScope(subtaskPrompt)) {
                const message = `[${PLUGIN_ID}] Delegation rejected: subtask brief lacks explicit target file, directory, or module scope. Specify exact paths or boundaries for the worker subagent.`;
                await client.app.log({body: {service: PLUGIN_ID, level: "warn", message}});
                throw new Error(message);
            }

            // 3. Require at least 2 TODO items before first delegation
            try {
                const todoResult = await client.session.todo({path: {id: input.sessionID}});
                const todos = todoResult.data || [];
                if (todos.length < 2) {
                    const message = `[${PLUGIN_ID}] Delegation rejected: you must decompose the request into at least 2 TODO items using \`todowrite\` before dispatching subagents.`;
                    await client.app.log({body: {service: PLUGIN_ID, level: "warn", message}});
                    throw new Error(message);
                }
            } catch (error) {
                if (error instanceof Error && error.message.includes("Delegation rejected")) {
                    throw error;
                }
                // If TODO API is unavailable, log and allow (fail-open to avoid breaking)
                await client.app.log({
                    body: {
                        service: PLUGIN_ID,
                        level: "warn",
                        message: `[${PLUGIN_ID}] Could not verify TODO prerequisite for session ${input.sessionID}`,
                        extra: {error},
                    },
                });
            }
        },
    };
};

export default OrchestratorPlugin;
