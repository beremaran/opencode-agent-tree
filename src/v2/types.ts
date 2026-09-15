/** Structural OpenCode 2 types; no runtime SDK import is needed at load time. */
type V2PermissionEffect = "allow" | "deny" | "ask";

export type V2PermissionRule = {
    action: string;
    resource: string;
    effect: V2PermissionEffect;
};

export type V2Agent = {
    id: string;
    model?: {
        id: string;
        providerID: string;
        variant?: string;
    };
    system?: string;
    description?: string;
    mode: string;
    permissions: V2PermissionRule[];
};

export type V2AgentDraft = {
    list: () => readonly V2Agent[];
    get: (id: string) => V2Agent | undefined;
    update: (id: string, update: (agent: V2Agent) => void) => void;
};

type V2ToolEvent = {
    tool: string;
    agent: string;
    input: unknown;
};

export type V2Context = {
    options?: unknown;
    agent: {
        transform: (callback: (draft: V2AgentDraft) => void) => Promise<unknown> | unknown;
    };
    tool?: {
        hook?: (name: string, callback: (event: V2ToolEvent) => Promise<void> | void) => Promise<unknown>;
    };
};

export type V2Plugin = {
    readonly id: string;
    readonly setup: (context: V2Context) => Promise<void>;
};
