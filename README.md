# @beremaran/opencode-agent-tree

An [opencode](https://opencode.ai) plugin that turns the model into an **orchestrator**: every request is decomposed into **small subtasks** and **delegated to subagents via the `task` tool**, never done by the orchestrator itself. You decide which model powers the subagents and which powers the orchestrator.

> **Renamed:** this package was previously published as `opencode-agent-tree`. It is now `@beremaran/opencode-agent-tree`; the old name is deprecated on npm.

- Zero-config setup: one plugin entry, one required option.
- Works with built-in subagents (`general`, `explore`) and any user-defined agents.
- Enforcement is layered: prompt directive + hard tool block.
- Supports both the OpenCode 1 server plugin API and the OpenCode 2 Promise plugin API.

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
1. Treat every user request as a project: decompose it into discrete, independently verifiable subtasks before touching anything.
2. Keep subtasks SMALL. A subtask is one concern: one file or a small cluster of related files, one bug, one component, one test area. If a brief needs many steps, spans unrelated areas, or would produce a report as long as the original request, split it further — never hand a monolithic task to a single subagent.
3. Delegate EVERY subtask with the `task` tool to a subagent. Never bundle several subtasks into one delegation, and never perform implementation work yourself.
4. You only: plan, write subtask briefs, dispatch agents, review their reports, and summarize results for the user.
5. Fan out: dispatch independent subtasks as several small `task` calls in a single message — more, smaller subagents in parallel beats one big delegation. Never run dependent subtasks concurrently; wait for each result before dispatching the next.
6. Give each subagent a complete, self-contained brief: goal, constraints, files involved, verification steps, and exactly what to report back.
7. Review every subagent report. If work is incomplete or wrong, delegate the fix to a subagent — never fix it yourself.
8. Reuse a running subagent via its task_id when follow-up work belongs to the same context.
9. Keep the user informed: report what was delegated to whom, the results, blockers, and the final state.

## Mandatory execution flow
1. **DISCOVER**: Use `explore`, `glob`, `grep`, or `read` to identify all affected files. Do NOT delegate implementation until file paths are known.
2. **PLAN**: Write a list of 2+ atomic subtasks into `todowrite`, assigning exact files to each subtask.
3. **DISPATCH**: Call `task` once per subtask in parallel (or sequentially if dependent). Each brief must include explicit file paths or module boundaries.

## Subtask sizing
- Split a request along its seams: separate files, functions, concerns, or verification steps each become their own subtask.
- A subtask is TOO BIG if: it touches many unrelated files, its brief runs more than a few paragraphs, a subagent could not finish and report back in one focused pass, or you cannot verify its result in isolation.
- When in doubt, split again — an extra small subagent costs less than one bloated delegation.

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

## Compatibility and installation

The package has two loader-compatible entrypoints:

- OpenCode 1 resolves the callable server plugin through `main`/`./server` and uses the legacy `plugin` configuration field.
- OpenCode 2 resolves the package root as a `{ id, setup }` plugin and uses the plural `plugins` field with an object entry.

For OpenCode 2:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "Manager",
  "plugins": [
    {
      "package": "@beremaran/opencode-agent-tree",
      "options": { "subagentModel": "anthropic/claude-sonnet-4-6" }
    }
  ]
}
```

For OpenCode 1:

### OpenCode 1 installation

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

From npm on OpenCode 1:

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

For a local OpenCode 2 plugin file, point the `plugins` entry at `src/v2.ts`.
For a local OpenCode 1 plugin file, point the legacy `plugin` entry at
`src/index.ts` (or `src/v1.ts`).

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

In OpenCode 2 the same `default_agent` setting is translated by OpenCode's V2
agent config layer; the plugin itself still creates `Manager` without changing
your default unless you opt into it.

## Options

| Option              | Type                 | Default                          | Description |
| ------------------- | -------------------- | -------------------------------- | ----------- |
| `subagentModel`     | `string`             | **required**                     | Model for all delegated work, e.g. `"anthropic/claude-sonnet-4-6"`. Must be `provider/model` format. Agents with an explicit `model` in `opencode.json` are never overridden. See [Model precedence](#model-precedence). |
| `orchestratorModel` | `string`             | agent model, else `model`        | Model for the orchestrator itself. Unconditionally overrides an explicit model on the orchestrator agent. |
| `orchestratorAgent` | `string`             | `"Manager"`                      | Which agent acts as the orchestrator. Created by the plugin if it does not exist (it shows up in the agent picker under this name). If you name an existing agent, the plugin **converts it** to a primary agent: its `mode` is set to `"primary"` unconditionally, and a warning is logged if it previously had an explicit non-primary mode. Built-in primary agents are left untouched by default. |
| `orchestratorDepth` | `number`             | `1`                              | How many orchestrator levels form the delegation chain. With `N`, the levels are `<orchestratorAgent>`, `<orchestratorAgent>-2`, ..., `<orchestratorAgent>-N`. Intermediate levels can only delegate to the next level (their `task` permission is structurally pinned); only the final level's subagents (`general`, `explore`) have hands-on tools. Every level defaults to `orchestratorModel` (or a per-level `orchestratorModels` entry) and the blocked hands-on tools. Must be a positive integer. See [Deep orchestration](#deep-orchestration). |
| `orchestratorModels` | `string[]`           | —                                | Per-level orchestrator models. Entry `i` applies to level `i+1` (`[0]` → "Manager", `[1]` → "Manager-2", ...). A shorter array leaves deeper levels on `orchestratorModel`. Entries must be `provider/model` format; length must not exceed `orchestratorDepth`. |
| `agents`            | `string[]`           | all `subagent`/`all`-mode agents | Only these agents get `subagentModel`. Disabled agents, primary-mode agents, the built-in primaries (`build`, `plan`, `compaction`, `title`, `summary`), and the orchestrator level agents are filtered out even if listed — none of them are ever routed to `subagentModel`, and they never trigger the phantom-name warning. |
| `agentModels`       | `Record<string,string>` | `{}`                          | Per-agent overrides, wins over `subagentModel`. Never applies to the orchestrator agent (it is never routed). |
| `instructions`      | `string`             | —                                | Extra rules appended verbatim to the orchestrator system prompt. |
| `blockedTools`      | `string[]`           | `["edit", "bash"]`               | Tools hard-denied to the orchestrator. `[]` = prompt-only enforcement. Names must match `[a-z0-9_-]+`. |
| `restrictTask`      | `boolean`            | `false`                          | When `true`, the orchestrator's permission gets `task: { "*": "deny", "<target>": "allow" }` for each routed delegation target, so it can only delegate to routed subagents. Closes the "delegate to an unrestricted agent" loophole (see [Security](#security)). Without it, single-level orchestrators have no `task` rule, while final levels of chains (`orchestratorDepth > 1`) get a blanket `task: { "*": "allow" }` — required so opencode does not strip the `task` tool from the subagent session. |

On OpenCode 2, the adapter writes the equivalent normalized fields: `prompt`
becomes `system`, `permission` becomes ordered `permissions`, `bash` maps to
the `shell` action, and `task` maps to the `subagent` action. The user-facing
options stay the same across both APIs.

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
- With `orchestratorDepth > 1`, each level's model resolves as
  `orchestratorModels[i]` → `orchestratorModel` → the level agent's
  existing/default model. `orchestratorModels[0]` is the top level (e.g.
  "Manager"), `orchestratorModels[1]` is "Manager-2", and so on; a level
  without an array entry falls back to `orchestratorModel`.
- `agentModels` is **never** applied to orchestrator levels — per-level
  orchestrator models come from `orchestratorModels`, not `agentModels`.
- An `agentModels` entry keyed to an orchestrator agent name is silently
  ignored — orchestrator levels are never routed.
- Built-in primary agents (`build`, `plan`, `compaction`, `title`, `summary`)
  are never routed either, so `agentModels` entries for them are never applied.

## Deep orchestration

With `orchestratorDepth: 1` (the default) a single orchestrator delegates
directly to the routed subagents:

```
user prompt -> Manager -> general / explore (hands-on tools)
```

With `orchestratorDepth: N` the plugin creates a strict chain of N
orchestrator-only agents. Level 1 is `<orchestratorAgent>` (a primary agent
you interact with), and each further level is named
`<orchestratorAgent>-<i>` (a subagent). Only the final level delegates to the
routed subagents; every orchestrator level has hands-on tools denied.

```
orchestratorDepth: 3

user prompt -> Manager -> Manager-2 -> Manager-3 -> general / explore (hands-on tools)
```

Enforcement in the chain:

- **Intermediate levels (1..N-1) are structurally pinned to the next level.**
  Their `permission.task` is always `{ "*": "deny", "<next-level>": "allow" }`
  — regardless of `restrictTask` — so they physically cannot delegate to
  workers or any other agent. Their directive instructs them to decompose the
  request from the level above, delegate every subtask only to the next level,
  and never do hands-on work.
- **`restrictTask` controls the final level's task pinning.** Level N
  delegates to the routed subagents. `restrictTask: true` pins its `task`
  permission to exactly those routed targets (`general`, `explore`, ...);
  without it, the final level gets a blanket `task: { "*": "allow" }` rule so
  its directive guides delegation without pinning. Either way the final level
  of a chain **must** declare a `task` permission: opencode injects
  `task: deny *` into the session of any subagent that declares no task rule,
  which removes the `task` tool from its toolset entirely (delegation becomes
  impossible — the model sees "unavailable tool 'task'"). Subagent levels also
  declare `todowrite` for the same reason.
- **Every level defaults to `orchestratorModel`** and the blocked hands-on
  tools, unless a per-level `orchestratorModels[i]` entry overrides its model;
  all level agents appear in the agent picker/`/agent`.

**Cost caveat:** every added level multiplies LLM model calls and tokens —
each level re-plans, writes briefs, and reviews the level below it. Depth 3+
should be reserved for genuinely large decompositions, and each level should
be pointed at a model cheap enough to justify the overhead.

**opencode nesting limit:** opencode's `subagent_depth` config controls how
deeply subagents can spawn further subagents (default `1`). A chain of depth
`N` performs `N-1` nested `task` hops, so it requires
`subagent_depth >= N` in `opencode.json` — see [Limitations](#limitations).

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

Deep orchestration with a three-level chain (requires
`"subagent_depth": 3` — see [Limitations](#limitations)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "Manager",
  "subagent_depth": 3,
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      {
        "subagentModel": "anthropic/claude-haiku-4-5",
        "orchestratorModel": "anthropic/claude-sonnet-4-5",
        "orchestratorDepth": 3,
        "restrictTask": true
      }
    ]
  ]
}
```

This creates `Manager`, `Manager-2`, and `Manager-3`. `Manager` and
`Manager-2` can only delegate to the next level; `Manager-3` delegates to
`general`/`explore` (and, with `restrictTask`, to nothing else).

Per-level models keep deep chains affordable — point the top level at the
strongest model and drop to cheaper models deeper in the chain
(`orchestratorModels[0]` = "Manager", `[1]` = "Manager-2", ...). Levels
without an entry fall back to `orchestratorModel`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "Manager",
  "subagent_depth": 3,
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      {
        "subagentModel": "anthropic/claude-haiku-4-5",
        "orchestratorDepth": 3,
        "orchestratorModels": [
          "anthropic/claude-opus-4-5",
          "anthropic/claude-sonnet-4-5",
          "anthropic/claude-haiku-4-5"
        ]
      }
    ]
  ]
}
```

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
| `orchestratorDepth` is not a positive integer (`0`, `-1`, `1.5`, `"3"`, `null`, `NaN`) | Config error, plugin load aborts |
| `orchestratorModels` has more entries than `orchestratorDepth`, or an entry is not `provider/model` format | Config error, plugin load aborts (the length error names both options) |
| `orchestratorDepth` exceeds opencode's `subagent_depth` (default `1`) | Warning naming both values and the fix: set `"subagent_depth": N` in `opencode.json`, or delegation beyond the first hop fails with `Subagent depth limit reached` |
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
- **Intermediate chain levels cannot delegate to arbitrary agents — even
  without `restrictTask`.** With `orchestratorDepth > 1`, every intermediate
  level's `task` permission is structurally pinned to `{ "*": "deny",
  "<next-level>": "allow" }`, so a misbehaving intermediate prompt cannot
  delegate to an unrestricted agent. The final level still needs
  `restrictTask: true` to close the same loophole for the worker hop (without
  it, its `task` permission is a blanket `{ "*": "allow" }`, which keeps the
  tool available but does not restrict delegation).
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
- **Each added orchestrator level multiplies LLM cost and latency.** Every
  level re-plans the request, writes briefs, and reviews the level below it, so
  `orchestratorDepth: N` performs roughly N times the orchestrator-level model
  calls of depth 1.
- **OpenCode 1 limits agent nesting via `subagent_depth`.** opencode's
  `subagent_depth` option (default `1`) controls how deeply subagents can spawn
  further subagents: with the default, "primary agents can launch subagents but
  prevents those subagents from launching additional subagents" (per opencode's
  config docs). A delegation chain of depth `N` needs `N-1` nested `task`
  hops, so it requires `"subagent_depth": N` (e.g. `3` for
  `orchestratorDepth: 3`) in `opencode.json`. Without it, the final hop fails
  with `Subagent depth limit reached` at runtime.
- Supported OpenCode range: `>=1.18.11 <3` (per `engines.opencode`). OpenCode 1
  uses the legacy callable entrypoint; OpenCode 2 uses the Promise transform
  entrypoint. OpenCode 2 does not use the V1 `subagent_depth` warning.

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
- **With `orchestratorDepth > 1`, `Manager-2`/`Manager-3` show up in the agent
  picker (`/agent`).** That is expected: every orchestrator level is a real
  agent entry, defaults to `orchestratorModel` (or its `orchestratorModels[i]`
  entry), and has its hands-on tools denied. All level names are excluded from
  routing, so they never receive `subagentModel` and never trigger phantom-name
  warnings.
- **`orchestratorDepth (N) exceeds opencode's subagent_depth (M)`** means your
  chain is deeper than opencode allows subagents to nest (default `1`). Fix it
  by setting `"subagent_depth": N` in `opencode.json` (or lowering
  `orchestratorDepth`). Without it, delegation beyond the first hop fails at
  runtime with `Subagent depth limit reached`.
- **OpenCode 2 shows no V1 startup summary log.** The V2 transform API has no
  equivalent `client.app.log` hook in the compatibility surface; inspect the
  generated `Manager` agent and its `permissions` instead.
- **"My explicitly-configured agent model is not used"** — for the orchestrator
  this is expected: `orchestratorModel` unconditionally overrides it, and
  `agentModels` entries keyed to it are ignored. For subagents, an explicit
  `model` in `opencode.json` wins over `agentModels` and `subagentModel` by
  design. Built-in primaries (`build`, `plan`, `compaction`, `title`,
  `summary`) are never routed, so configuring a model for them has no effect
  either. See [Model precedence](#model-precedence).

## Notes

- Subagents keep their default tools; only the orchestrator is restricted. Switch to the `plan` agent or another primary anytime.
- The directive is installed on orchestrator level agents only (level 1 and,
  with `orchestratorDepth > 1`, the `-2`/`-3`/... levels) — worker subagents
  (`general`, `explore`) never receive it.
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

The OpenCode 1 adapter is a `config` hook (`src/index.ts`); the OpenCode 2
adapter is an `agent.transform` registration (`src/v2.ts`). Both route
subagent models, deny the orchestrator's hands-on tools, and install the
directive prompt. To verify the legacy adapter against a live opencode, run
from this repo (its `opencode.json` is pre-wired) and watch for the startup log
line:

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
   files, including the shared implementation and both entrypoints.
4. Smoke-tests the tarball from a clean consumer install — a temp directory
   with `npm init -y` + `npm install <tarball>` — importing **by package name**
   under **Bun** and asserting the root OpenCode 2 export is an `id`/`setup`
   object while `./server` remains a callable OpenCode 1 export.
5. Publishes to npm using the `NPM_TOKEN` secret with **npm provenance**
   (`publishConfig.provenance` + `id-token: write`).
6. Creates a GitHub Release (via `softprops/action-gh-release`) whose body is
   the CHANGELOG section for the released version.

**npm provenance requires the CI path.** A local `npm publish` is not the
supported flow: it will not produce provenance and bypasses the release
checks. If you do run it, `prepublishOnly` runs `npm run check` first, but
prefer the tag flow.

The `types` and entrypoint fields intentionally point at raw TypeScript source:
opencode loads plugins with Bun, so the published package ships `.ts` directly
with no build step. The package root is the OpenCode 2 entrypoint; `main` and
`./server` preserve the OpenCode 1 callable entrypoint. The `./package.json`
export is included so consumers can read package metadata without a resolver
round-trip.

## License

MIT — see [LICENSE](LICENSE).
