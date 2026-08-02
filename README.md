# @beremaran/opencode-agent-tree

An [opencode](https://opencode.ai) plugin that turns the model into an **orchestrator**: every request is decomposed into subtasks and **delegated to subagents via the `task` tool**, never done by the orchestrator itself. You decide which model powers the subagents and which powers the orchestrator.

> **Renamed:** this package was previously published as `opencode-agent-tree`. It is now `@beremaran/opencode-agent-tree`; the old name is deprecated on npm.

- Dedicated `orchestrator` primary agent and `worker` subagent; the built-in `build` and `plan` agents stay untouched.
- Change the delegated model from chat with `/subagent-model provider/model`.
- Set a default effort/variant and per-agent overrides for delegated models.
- Simple setup: one plugin entry, one required option.
- Works with the dedicated `worker`, built-in subagents (`general`, `explore`), and any user-defined agents.
- Enforcement is layered: prompt directive + hard tool block.

## How it forces orchestration

Two independent enforcement layers:

1. **System prompt directive** — a strict orchestrator prompt is installed on a dedicated `orchestrator` primary agent (appended to any existing prompt it may have). Subagent prompts and the built-in `build` and `plan` agents are untouched, except for the plugin-created `worker` prompt.
2. **Hard tool block** — the orchestrator agent's `permission` config is set to `deny` for hands-on tools (`edit`, `write`, `apply_patch`, and `bash` by default). The model physically cannot do the work itself.

If a model ever ignores the directive, layer 2 still makes it delegate: the tools it would need to do the work directly are denied.

The plugin creates a dedicated `worker` subagent when one is not already defined. It receives `subagentModel` by default and is the preferred target for hands-on implementation, testing, and verification. The existing `general` and `explore` routing remains available for compatibility.

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
- Keep the task list current so the user can see what is active, completed, or blocked.
- `read`/`glob`/`grep`/`webfetch`/`websearch` only when needed to write a better brief or verify a result.
- Hands-on tools are hard-blocked for you (blockedTools joined, "edit, write, apply_patch, bash" by default). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

## Default delegation
- `worker` — hands-on implementation, refactoring, testing, and verification.
- `explore` — codebase research, locating code, understanding existing implementations.
- `general` — complex research or any task without a more specific subagent.
- Prefer `worker` for hands-on work and the most specialized subagent for each other subtask; fall back to `general`.
```

Two placeholders are substituted at runtime:

| Placeholder | Value |
| ----------- | ----- |
| `blockedTools` list | The `blockedTools` option joined with `, ` (default: `edit, write, apply_patch, bash`) |
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
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      { "subagentModel": "anthropic/claude-sonnet-4-6" }
    ]
  ]
}
```

> Config is loaded at startup. **Restart opencode** after adding the plugin.

The plugin adds and selects a dedicated `orchestrator` agent unless you already set `default_agent`. You can switch to `build` whenever you want to work directly.

## Change the subagent model from chat

Use the command added by the plugin:

```text
/subagent-model openai/gpt-5.2
```

The change applies immediately to subsequent delegations in the running opencode workspace process. It updates agents inheriting `subagentModel`; models explicitly set in `opencode.json` and `agentModels` overrides remain unchanged. Restarting opencode restores the configured `subagentModel`.

## Options

| Option              | Type                 | Default                          | Description |
| ------------------- | -------------------- | -------------------------------- | ----------- |
| `subagentModel`     | `string`             | **required**                     | Model for all delegated work, e.g. `"anthropic/claude-sonnet-4-6"`. Agents with an explicit `model` in `opencode.json` are never overridden. |
| `subagentEffort`    | `string`             | model default                    | Default OpenCode variant/effort for delegated agents that do not define one, e.g. `"high"`. |
| `orchestratorModel` | `string`             | agent model, else `model`        | Model for the orchestrator itself. |
| `orchestratorAgent` | `string`             | `"orchestrator"`                 | Name of the dedicated primary agent that acts as the orchestrator. |
| `agents`            | `string[]`           | all `subagent`/`all`-mode agents | Only these agents get `subagentModel`. |
| `agentModels`       | `Record<string,string>` | `{}`                          | Per-agent overrides, wins over `subagentModel`. |
| `agentEfforts`      | `Record<string,string>` | `{}`                          | Per-agent OpenCode variant/effort overrides, wins over `subagentEffort`. Explicit agent `variant` values still take precedence. |
| `instructions`      | `string`             | —                                | Extra rules appended to the orchestrator system prompt. |
| `blockedTools`      | `string[]`           | `["edit", "write", "apply_patch", "bash"]` | Tools hard-denied to the orchestrator. `[]` = prompt-only enforcement. |

## Example

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      {
        "subagentModel": "anthropic/claude-sonnet-4-6",
        "subagentEffort": "high",
        "orchestratorModel": "anthropic/claude-opus-4-5",
        "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
        "agentEfforts": { "explore": "low" },
        "instructions": "Never delegate more than 3 subtasks at once."
      }
    ]
  ]
}
```

## Notes

- The orchestrator explicitly keeps `task`, `todowrite`, and `question` access so it can delegate, maintain a visible task list, and clarify blockers.
- Subagents keep their default tools; only the dedicated orchestrator's hands-on tools are restricted. The dedicated `worker` is the preferred implementation target, while the built-in `build` and `plan` agents remain available unchanged.
- The directive is installed on the orchestrator agent only — subagents never receive it.
- The dedicated `worker`, built-in subagents (`general`, `explore`), and every user-defined subagent/all-mode agent are routed to `subagentModel`; agents with an explicit `model` in `opencode.json` are respected.
- `subagentEffort` and `agentEfforts` map to OpenCode's agent `variant` field. Values such as `low`, `medium`, and `high` are model/provider-specific; the plugin only validates that they are non-empty strings.
- An agent's explicit `variant` in `opencode.json` takes precedence over plugin effort settings.

## Development

```bash
npm install
npm run check
```

The plugin configures agents at startup and uses chat/command hooks for runtime model switching. To verify against a live opencode, run from this repo (its `opencode.json` is pre-wired) and watch for the startup log line:

```
Orchestrator "orchestrator" enabled; subagents -> <subagentModel>
```

## Publishing

Publishing is handled by [`.github/workflows/publish.yml`](.github/workflows/publish.yml). Set that workflow as the trusted publisher for this package on npm, update `package.json` to the release version, then push the matching tag (for example, `v0.2.0`). The workflow rejects a tag that does not exactly match the package version, runs all checks, inspects the tarball, and publishes with npm OIDC/provenance.

The package ships raw TypeScript (`main: src/index.ts`) — opencode loads plugins with Bun, so no build step is needed. The repository and author metadata are already set in `package.json`.

## License

MIT — see [LICENSE](LICENSE).
