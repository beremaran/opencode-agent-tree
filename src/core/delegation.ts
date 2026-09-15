import {MANAGER_DIRECTIVE_MARKER, WORKER_DIRECTIVE_MARKER} from "./constants.ts";

/** Detect explicit file, directory, or module scope in a delegation brief. */
export const hasExplicitScope = (text: string): boolean =>
    /[\w-]+\.(ts|js|tsx|jsx|py|rs|go|java|kt|swift|json|md|css|html|yaml|yml)|\b(src|test|tests|lib|bin|app|public|private|internal|components?|utils?|helpers?|hooks?|types?|config|scripts|docs|examples|fixtures|mocks|packages|workspaces)\/|file:|path:|module:|directory:/i.test(
        text,
    );

export const managerDirective = (): string => `${MANAGER_DIRECTIVE_MARKER}

You are the toolless root agent. For every actionable request, delegate exactly one initial task to \`general\` with the user's goal and constraints. Do not inspect, edit, execute, or take any other action yourself. Wait for the worker's report, review it, delegate any needed fixes, and summarize only after the work is verified.`;

export const workerDirective = (): string => `${WORKER_DIRECTIVE_MARKER}

Inspect each task before acting. If it contains independently verifiable work that can be split, delegate the pieces through \`task\` before changing anything. Otherwise execute the atomic task directly. Verify the result and report status, changed files, checks, and blockers.`;
