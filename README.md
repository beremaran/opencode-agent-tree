# @beremaran/opencode-agent-tree

An [opencode](https://opencode.ai) plugin that turns the model into an **orchestrator**: every request is decomposed into subtasks and **delegated to subagents via the `task` tool**, never done by the orchestrator itself. You decide which model powers the subagents and which powers the orchestrator.

> **Renamed:** this package was previously published as `opencode-agent-tree`. It is now `@beremaran/opencode-agent-tree`; the old name is deprecated on npm.

- Zero-config setup: one plugin entry, one required option.
- Works with built-in subagents (`general`, `explore`) and any user-defined agents.
- Enforcement is layered: prompt directive + hard tool block.

## How it forces orchestration

Two independent enforcement layers:

1. **System prompt directive** — a strict orchestrator prompt is installed as the orchestrator agent's system prompt (appended to any existing prompt it may have). Subagent prompts are untouched.
2. **Hard tool block** — the orchestrator agent's `permission` config is set to `deny` for hands-on tools (`edit`, `bash` by default). The model physically cannot do the work itself.

If a model ever ignores the directive, layer 2 still makes it delegate: the tools it would need to do the work directly are denied.

## The orchestrator directive

This is the exact prompt injected into the orchestrator agent's system prompt (as configured in `src/index.ts`, `orchestratorDirective`):

```markdown
# Orchestrator Mode (enforced by @beremaran/opencode-agent-tree)

You are the ORCHESTRATOR. You do not do hands-on work. You plan, decompose, delegate, and review.

## Non-negotiable rules
1. Treat every user request as a project: break it into discrete, independently verifiable subtasks before touching anything.
2. Delegate EVERY subtask with the `task` tool to a subagent. Never perform implementation work yourself.
3. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
4. Dispatch independent subtasks in parallel (multiple `task` calls in a single message). Never run dependent subtasks concurrently — wait for each result before dispatching the next.
5. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
6. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
7. Reuse a running subagent via its task_id when follow-up work belongs to the same context.
8. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

## Tool discipline
- `task` for all work (mandatory), `todowrite` to track subtasks, `question` only to clarify genuinely ambiguous requests.
- `read`/`glob`/`grep`/`webfetch`/`websearch` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (blockedTools joined, "edit, bash" by default). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- `explore` — codebase research, locating code, understanding existing implementations.
- `general` — implementation, refactoring, testing, and any task without a more specific subagent.
- Prefer the most specialized subagent for each subtask; fall back to `general`.
```

Two placeholders are substituted at runtime:

| Placeholder | Value |
| ----------- | ----- |
| `blockedTools` list | The `blockedTools` option joined with `, ` (default: `edit, bash`) |
| `instructions` | The `instructions` option, appended verbatim at the end |

## Installation

As a local plugin (clone this repo, or point at your own copy):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./path/to/src/index.ts",
      { "subagentModel": "anthropic/claude-sonnet-4-6" }
    ]
  ]
}
```

From npm:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@beremaran/opencode-agent-tree", { "subagentModel": "anthropic/claude-sonnet-4-6" }]
}
```

> Config is loaded at startup. **Restart opencode** after adding the plugin.

## Options

| Option              | Type                 | Default                          | Description |
| ------------------- | -------------------- | -------------------------------- | ----------- |
| `subagentModel`     | `string`             | **required**                     | Model for all delegated work, e.g. `"anthropic/claude-sonnet-4-6"`. Agents with an explicit `model` in `opencode.json` are never overridden. |
| `orchestratorModel` | `string`             | agent model, else `model`        | Model for the orchestrator itself. |
| `orchestratorAgent` | `string`             | `"build"`                        | Which agent acts as the orchestrator. |
| `agents`            | `string[]`           | all `subagent`/`all`-mode agents | Only these agents get `subagentModel`. |
| `agentModels`       | `Record<string,string>` | `{}`                          | Per-agent overrides, wins over `subagentModel`. |
| `instructions`      | `string`             | —                                | Extra rules appended to the orchestrator system prompt. |
| `blockedTools`      | `string[]`           | `["edit", "bash"]`               | Tools hard-denied to the orchestrator. `[]` = prompt-only enforcement. |

## Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      {
        "subagentModel": "anthropic/claude-sonnet-4-6",
        "orchestratorModel": "anthropic/claude-opus-4-5",
        "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
        "instructions": "Never delegate more than 3 subtasks at once."
      }
    ]
  ]
}
```

## Notes

- Subagents keep their default tools; only the orchestrator is restricted. Switch to the `plan` agent or another primary anytime.
- The directive is installed on the orchestrator agent only — subagents never receive it.
- Built-in subagents (`general`, `explore`) and every user-defined subagent/all-mode agent are routed to `subagentModel`; agents with an explicit `model` in `opencode.json` are respected.

## Development

```bash
npm install
npm run check
```

The plugin is a single `config` hook (`src/index.ts`): it mutates the merged opencode config at startup — routing subagent models, denying the orchestrator's hands-on tools, and installing the directive prompt. To verify against a live opencode, run from this repo (its `opencode.json` is pre-wired) and watch for the startup log line:

```
Orchestrator "build" enabled; subagents -> <subagentModel>
```

## Publishing

```bash
npm login
npm publish
```

The package ships raw TypeScript (`main: src/index.ts`) — opencode loads plugins with Bun, so no build step is needed. The repository and author metadata are already set in `package.json`.

## License

MIT — see [LICENSE](LICENSE).
