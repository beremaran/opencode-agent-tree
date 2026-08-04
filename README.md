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

> **Runtime:** this package ships **raw TypeScript** (`src/index.ts`) with no build
> step. It runs only under opencode's plugin loader, which executes plugins on
> Bun and strips types at load time. It is **not** importable from plain Node.js
> — the `engines` field (`>=22.6`) exists for tooling compatibility only and is
> not a promise that a plain Node process can load the plugin.

## Getting started: pick your default agent

Installing the plugin **creates the `Manager` agent but does not make it your
default agent**. opencode still starts in whatever mode your config selects
(the built-in `build` agent by default, or whatever `default_agent` names)
until you choose the orchestrator.

To always start in orchestrator mode, set the default agent in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "Manager",
  "plugin": ["@beremaran/opencode-agent-tree", { "subagentModel": "anthropic/claude-sonnet-4-6" }]
}
```

Alternatively, pick `Manager` in the agent picker at the start of each session.
The startup log reports the effective default agent (`defaultAgent` in the
summary entry's extra metadata) so you can confirm which mode a session runs in.

## Options

| Option              | Type                 | Default                          | Description |
| ------------------- | -------------------- | -------------------------------- | ----------- |
| `subagentModel`     | `string`             | **required**                     | Model for all delegated work, e.g. `"anthropic/claude-sonnet-4-6"`. Must be `provider/model` format. Agents with an explicit `model` in `opencode.json` are never overridden. See [Model precedence](#model-precedence). |
| `orchestratorModel` | `string`             | agent model, else `model`        | Model for the orchestrator itself. Unconditionally overrides an explicit model on the orchestrator agent. |
| `orchestratorAgent` | `string`             | `"Manager"`                      | Which agent acts as the orchestrator. Created by the plugin if it does not exist (it shows up in the agent picker under this name). If you name an existing agent, the plugin **converts it** to a primary agent: its `mode` is set to `"primary"` unconditionally, and a warning is logged if it previously had an explicit non-primary mode. Built-in primary agents are left untouched by default. |
| `agents`            | `string[]`           | all `subagent`/`all`-mode agents | Only these agents get `subagentModel`. Disabled agents, primary-mode agents, the built-in primaries (`build`, `plan`, `compaction`, `title`, `summary`), and the orchestrator itself are filtered out even if listed — none of them are ever routed to `subagentModel`, and they never trigger the phantom-name warning. |
| `agentModels`       | `Record<string,string>` | `{}`                          | Per-agent overrides, wins over `subagentModel`. Never applies to the orchestrator agent (it is never routed). |
| `instructions`      | `string`             | —                                | Extra rules appended verbatim to the orchestrator system prompt. |
| `blockedTools`      | `string[]`           | `["edit", "bash"]`               | Tools hard-denied to the orchestrator. `[]` = prompt-only enforcement. Names must match `[a-z0-9_-]+`. |
| `restrictTask`      | `boolean`            | `false`                          | When `true`, the orchestrator's permission gets `task: { "*": "deny", "<target>": "allow" }` for each routed delegation target, so it can only delegate to routed subagents. Closes the "delegate to an unrestricted agent" loophole (see [Security](#security)). |

### Permission keys gate tool families

`permission` values in opencode are keyed by **permission key**, not by every
individual tool name. One key covers a whole tool family, so when you write
`blockedTools` (or any permission config) use the key, not the tool names. For
example, the `edit` permission key covers the `edit`, `write`, and `apply_patch`
tools — denying `edit` denies all three. (The exact tool-to-key mapping is
defined by opencode and can vary across versions, so prefer documented keys
such as `edit`, `bash`, `read`, `task`, `todowrite`, `webfetch`, `websearch`,
and `question`.)

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
- Built-in primary agents (`build`, `plan`, `compaction`, `title`, `summary`)
  are never routed either, so `agentModels` entries for them are never applied.

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
        "orchestratorAgent": "Manager",
        "agents": ["general", "explore", "worker"],
        "agentModels": { "explore": "anthropic/claude-haiku-4-5" },
        "instructions": "Never delegate more than 3 subtasks at once."
      }
    ]
  ]
}
```

> Model IDs in the examples are **illustrative** — substitute real
> `provider/model` IDs that exist in your opencode setup (check your configured
> providers or `opencode models`).

## Validation & warnings

At startup the plugin validates the configuration and reports self-contradictory
setups. There are two distinct failure modes:

- **Factory-level option errors** — a missing `subagentModel`, an invalid
  `provider/model` format, or a malformed `blockedTools` entry is logged at
  `error` level and rethrown, aborting plugin load. opencode surfaces these as
  config errors.
- **Config-hook conditions** — such as a disabled orchestrator agent — **never
  throw**. The plugin logs an `error` and simply does not apply its
  configuration, so opencode continues with the original config. The plugin
  cannot crash opencode through the config hook.

Everything else logs a `warn` message and continues.

| Condition | Result |
| --------- | ------ |
| The orchestrator agent named by `orchestratorAgent` is disabled | Error logged; the plugin's config is **not applied**; opencode continues with the original config |
| `subagentModel`, `orchestratorModel`, or an `agentModels` value is not `provider/model` format (exactly one `/`, non-empty on both sides, no whitespace; dots, dashes, underscores, and colons are allowed in the model part, but not further slashes) | Config error, plugin load aborts |
| A `blockedTools` name does not match `[a-z0-9_-]+` (lowercase letters, digits, underscore, hyphen) | Config error, plugin load aborts |
| `blockedTools` includes a directive-dependent tool (`task`, `todowrite`, `question`, `read`, `glob`, `grep`, `webfetch`, `websearch`) | Warning: the orchestrator is told to delegate with a tool it cannot use |
| A blocked tool's existing permission on the orchestrator agent is a plain value other than `deny` and is overwritten with `deny` | Warning naming the tool and agent (an existing value that is already `deny` is not warned about) |
| A blocked tool's existing permission on the orchestrator agent is command-scoped (an object of rules) and is replaced by a blanket `deny` | Separate warning naming the tool and agent |
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
- **The "delegate to an unrestricted agent" loophole.** Because subagents keep
  their tools, a prompt that is not following the directive could try to
  delegate to an agent the plugin did not restrict, bypassing the block. Set
  `restrictTask: true` to close this: the orchestrator's permission then only
  allows `task` toward the plugin's routed delegation targets (`task` is denied
  for everything else), so it physically cannot delegate to an unrestricted
  agent.
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
  `Orchestrator "Manager" enabled; subagents -> <subagentModel>`, with extra
  metadata (`routedAgents`, `orchestratorModel`, `blockedTools`,
  `defaultAgent`) naming what was routed and which agent is the session
  default.
- **`The orchestrator agent "Manager" is disabled`** is logged as an error and
  the plugin's configuration is **not applied** — but opencode continues
  normally with the rest of your config. Enable the agent, or choose another
  orchestrator, to get the plugin's behavior back.
- **A warning you did not expect** — the warning cases above log at `warn`
  level naming the offending tool, agent, or config value; the config is
  probably not doing what you intend.
- **"My explicitly-configured agent model is not used"** — for the orchestrator
  this is expected: `orchestratorModel` unconditionally overrides it, and
  `agentModels` entries keyed to it are ignored. For subagents, an explicit
  `model` in `opencode.json` wins over `agentModels` and `subagentModel` by
  design. Built-in primaries (`build`, `plan`, `compaction`, `title`,
  `summary`) are never routed, so configuring a model for them has no effect
  either. See [Model precedence](#model-precedence).

## Notes

- Subagents keep their default tools; only the orchestrator is restricted. Switch to the `plan` agent or another primary anytime.
- The directive is installed on the orchestrator agent only — subagents never receive it.
- The directive is appended only once: the `# Orchestrator Mode` marker in the
  prompt prevents re-appending if the config hook re-runs or opencode reloads
  the plugin. This is deliberate.
- By default the orchestrator agent is **created by the plugin** as `Manager`
  (visible in the agent picker under that name); no built-in agent is touched.
  If you set `orchestratorAgent` to an existing agent (e.g. `build`), the plugin
  converts that agent into the orchestrator instead: its `mode` is forced to
  `"primary"` and a warning is logged if it previously had an explicit
  non-primary mode.
- **Migrating from <=0.4.x:** older versions converted the built-in `build`
  agent by default. That conversion is not undone on upgrade — `build` keeps the
  `# Orchestrator Mode` directive in its prompt because the marker only prevents
  re-appending, never removes. Either switch to the new `Manager` agent, or
  remove the directive from `build`'s prompt manually in your opencode config.

## Development

```bash
npm install
npm run check   # typecheck + lint + tests
```

The plugin is a single `config` hook (`src/index.ts`): it mutates the merged opencode config at startup — routing subagent models, denying the orchestrator's hands-on tools, and installing the directive prompt. To verify against a live opencode, run from this repo (its `opencode.json` is pre-wired) and watch for the startup log line:

```
Orchestrator "Manager" enabled; subagents -> <subagentModel>
```

See [RELEASING.md](RELEASING.md) for the release process.

## Publishing

Releases are **tag-triggered from CI**, not local `npm publish`:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag runs `.github/workflows/publish.yml`, which:

1. Verifies the tag matches `package.json` and that `CHANGELOG.md` documents
   the released version.
2. Installs dependencies and runs the full check suite (`npm run check`).
3. Inspects the packed tarball and asserts it contains exactly the expected
   files (`LICENSE`, `README.md`, `CHANGELOG.md`, `package.json`,
   `src/index.ts`).
4. Smoke-tests the tarball from a clean consumer install — a temp directory
   with `npm init -y` + `npm install <tarball>` — importing **by package name**
   under **Bun** (the same runtime opencode uses to load plugins) and asserting
   the default and named exports are functions.
5. Publishes to npm using the `NPM_TOKEN` secret with **npm provenance**
   (`publishConfig.provenance` + `id-token: write`).
6. Creates a GitHub Release (via `softprops/action-gh-release`) whose body is
   the CHANGELOG section for the released version.

**npm provenance requires the CI path.** A local `npm publish` is not the
supported flow: it will not produce provenance and bypasses the release
checks. If you do run it, `prepublishOnly` runs `npm run check` first, but
prefer the tag flow.

The `types` entry (`./src/index.ts`) is intentionally the raw TypeScript
source: opencode loads plugins with Bun, so the published package ships `.ts`
directly with no build step. The same applies to `main`. The `./package.json`
export is included so consumers can read package metadata without a resolver
round-trip.

## License

MIT — see [LICENSE](LICENSE).
