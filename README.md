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

This is the directive template rendered into the orchestrator's system prompt (as configured in `src/index.ts`, `orchestratorDirective`). The block below is the rendered form with default settings (no `instructions`); the two runtime substitutions are listed after it.

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
- Hands-on tools are hard-blocked for you (edit, bash). If a subagent lacks a tool it needs, tell the user instead of doing it yourself.

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
| `subagentModel`     | `string`             | **required**                     | Model for all delegated work, e.g. `"anthropic/claude-sonnet-4-6"`. Must be `provider/model` format. Agents with an explicit `model` in `opencode.json` are never overridden. See [Model precedence](#model-precedence). |
| `orchestratorModel` | `string`             | agent model, else `model`        | Model for the orchestrator itself. Unconditionally overrides an explicit model on the orchestrator agent. |
| `orchestratorAgent` | `string`             | `"build"`                        | Which agent acts as the orchestrator. |
| `agents`            | `string[]`           | all `subagent`/`all`-mode agents | Only these agents get `subagentModel`. Disabled agents, primary-mode agents, and the orchestrator itself are filtered out even if listed. |
| `agentModels`       | `Record<string,string>` | `{}`                          | Per-agent overrides, wins over `subagentModel`. Never applies to the orchestrator agent (it is never routed). |
| `instructions`      | `string`             | —                                | Extra rules appended verbatim to the orchestrator system prompt. |
| `blockedTools`      | `string[]`           | `["edit", "bash"]`               | Tools hard-denied to the orchestrator. `[]` = prompt-only enforcement. Names must match `[a-z0-9_-]+`. |

### Model precedence

The effective model for a delegated subagent is resolved in this order:

1. An explicit `model` set on the agent in `opencode.json`
2. `agentModels[name]`
3. `subagentModel`

The orchestrator is asymmetric:

- `orchestratorModel` **unconditionally** overrides an explicit `model` on the
  orchestrator agent.
- An `agentModels` entry keyed to the orchestrator agent name is silently
  ignored — the orchestrator is never routed.

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
        "agents": ["general", "explore", "worker"],
        "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
        "instructions": "Never delegate more than 3 subtasks at once."
      }
    ]
  ]
}
```

## Validation & warnings

At startup the plugin validates the configuration and reports self-contradictory
setups. Invalid configuration raises a config error (logged at `error` level via
`app.log`, then rethrown); the remaining cases log a `warn` message and
continue.

| Condition | Result |
| --------- | ------ |
| The orchestrator agent named by `orchestratorAgent` is disabled | Config error |
| `subagentModel`, `orchestratorModel`, or an `agentModels` value is not `provider/model` format (at least one `/`, non-empty on both sides; further slashes are allowed in the model part) | Config error |
| A `blockedTools` name does not match `[a-z0-9_-]+` (lowercase letters, digits, underscore, hyphen) | Config error |
| `blockedTools` includes a directive-dependent tool (`task`, `todowrite`, `question`, `read`, `glob`, `grep`, `webfetch`, `websearch`) | Warning: the orchestrator is told to delegate with a tool it cannot use |
| A blocked tool's existing permission on the orchestrator agent is overwritten with `deny` | Warning naming the tool and agent |
| An explicit `agents` list omits both built-in subagents (`general`, `explore`) | Warning: routing and the directive diverge |
| `agents` contains a name that is neither a built-in subagent nor an agent in `opencode.json` | Warning: a phantom agent entry is created (typo protection) |

## Security

The plugin enforces behavior through configuration, so its security surface is
the configuration it runs with. Only use this plugin with config you control.

- **`instructions` is injected verbatim** into the orchestrator's system
  prompt. An untrusted config can append arbitrary prompt rules that the model
  may follow.
- **The tool block is an explicit allow/deny list, not categorical.** A renamed
  upstream tool, or a future mutating tool the plugin does not know about,
  would not be auto-blocked.
- **Subagents keep their hands-on tools.** Delegation does not remove tools
  from subagents; the plugin constrains the orchestrator, not the subagents. A
  delegated subagent can still `edit` and `bash`.
- **`orchestratorModel` can override an explicitly configured model** on the
  orchestrator agent.

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Limitations

- Enforcement is prompt + permission based. Non-compliant models can still cut
  corners — for example doing their own research instead of delegating — where
  the permission block does not forbid the action.
- The `task` tool is assumed to be available to the orchestrator.
- Once work is delegated to a subagent, the plugin cannot stop it from doing
  that work.
- Supported opencode range: `>=1.18.11 <2` (per `peerDependencies`).

## Troubleshooting

- **Restart after config changes.** Options are read at startup; edit
  `opencode.json` and restart opencode to apply them.
- **Check the startup log line.** A healthy load logs
  `Orchestrator "build" enabled; subagents -> <subagentModel>`.
- **`The orchestrator agent "X" is disabled`** is a config error: the agent
  named by `orchestratorAgent` has `disable: true`. Enable it or choose another
  orchestrator.
- **A warning you did not expect** — the four warning cases above log at
  `warn` level naming the offending tool, agent, or config value; the config is
  probably not doing what you intend.
- **"My explicitly-configured agent model is not used"** — for the orchestrator
  this is expected: `orchestratorModel` unconditionally overrides it, and
  `agentModels` entries keyed to it are ignored. For subagents, an explicit
  `model` in `opencode.json` wins over `agentModels` and `subagentModel` by
  design. See [Model precedence](#model-precedence).

## Notes

- Subagents keep their default tools; only the orchestrator is restricted. Switch to the `plan` agent or another primary anytime.
- The directive is installed on the orchestrator agent only — subagents never receive it.
- The directive is appended only once: the `# Orchestrator Mode` marker in the
  prompt prevents re-appending if the config hook re-runs or opencode reloads
  the plugin. This is deliberate.

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
