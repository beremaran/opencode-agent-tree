/**
 * Structural V1 types keep the raw TypeScript entrypoint loadable and
 * type-checkable when a consumer has installed either the OpenCode 1 or the
 * OpenCode 2 plugin package. The implementation only uses this small subset
 * of the legacy host surface.
 */
export type LegacyConfig = {
    model?: unknown;
    default_agent?: unknown;
    subagent_depth?: unknown;
    agent?: Record<string, unknown>;
};

export type LegacyMessage = {role: string};
export type LegacyPart = {type: string; text?: string};

export type LegacyClient = {
    app: {
        log: (entry: unknown) => Promise<void>;
    };
    session: {
        get: (options: {path: {id: string}}) => Promise<{data?: Record<string, unknown>}>;
        messages: (options: {
            path: {id: string};
            query: {limit: number};
        }) => Promise<{data?: Array<{info: LegacyMessage; parts: LegacyPart[]}>}>;
        todo: (options: {path: {id: string}}) => Promise<{data?: unknown[]}>;
    };
};

export type LegacyToolInput = {
    tool: string;
    sessionID: string;
    callID?: string;
};

export type LegacyToolOutput = {
    args?: Record<string, unknown>;
};

export type LegacyHooks = {
    config?: (cfg: LegacyConfig) => Promise<void>;
    "tool.execute.before"?: (input: LegacyToolInput, output: LegacyToolOutput) => Promise<void>;
};

export type LegacyPlugin = (input: {client: LegacyClient}, options?: unknown) => Promise<LegacyHooks>;

export type LogBody = {
    service: string;
    level: "error" | "warn" | "info";
    message: string;
    extra?: Record<string, unknown>;
};

export type LogEntry = {
    body: LogBody;
};

export type LogFn = (entry: LogEntry) => Promise<void>;
