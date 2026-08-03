# @beremaran/opencode-agent-tree

An [opencode](https://opencode.ai) plugin for durable multi-agent orchestration.

It keeps the original agent-tree behavior, where a dedicated `orchestrator` plans and reviews while subagents perform hands-on work, and adds dynamic workflows for jobs that need enforced fan-out, structured branching, verification, budgets, cancellation, and resume.

- Keeps the built-in `build` and `plan` agents unchanged.
- Adds a `worker` subagent for implementation, testing, and verification.
- Blocks the orchestrator from implementation tools by default.
- Routes subagents to configurable models and effort levels.
- Executes model-authored workflow plans as validated data, never arbitrary JavaScript.
- Persists workflow journals, results, usage, and session state.
- Supports structured outputs, parallel maps, branches, bounded loops, retries, worktrees, and serial integration.
- Includes an optional workflow dashboard for opencode's TUI.

## Installation

Add the server plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      { "subagentModel": "openai/gpt-5.6-luna" }
    ]
  ]
}
```

`opencode-go/deepseek-v4-flash` is a good lower-cost alternative:

```json
{
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      { "subagentModel": "opencode-go/deepseek-v4-flash" }
    ]
  ]
}
```

To enable the optional TUI dashboard, add the package to `tui.json`. The TUI loader resolves the package's separate `./tui` entrypoint automatically:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@beremaran/opencode-agent-tree"]
}
```

The `opencode plugin @beremaran/opencode-agent-tree` installer can detect and configure both package targets. Restart opencode after changing plugin or TUI configuration.

### Compatibility

- Requires opencode `>=1.18.11 <2`.
- The server plugin reuses opencode's injected transport and authentication headers, so child sessions work in local CLI/TUI processes and authenticated server deployments without a second server connection.
- The optional dashboard requires OpenTUI `>=0.4.5` and Solid `1.9.12`; these peers are optional for server-only installations.
- Plugin configuration is loaded at startup. Restart opencode after installing, upgrading, or changing options.

## Quick Start

Ask for a workflow explicitly:

```text
/workflow Audit every route under src/routes for missing authorization. Verify every finding independently.
```

The orchestrator creates a strict workflow specification and calls `workflow_start` with `wait=true`. The `/workflow` command runs in the foreground so a one-shot `opencode run` process stays alive until the workflow finishes. Direct `workflow_start` calls may omit `wait` to run in the background; background work lives only as long as its OpenCode server process, returns a run id immediately, and notifies the parent on completion or failure. Canceled runs remain canceled and do not produce failure notifications.

Useful commands:

```text
/workflows
/workflow-resume <run-id>
/workflow-dashboard
```

The dashboard command requires the TUI plugin entrypoint.

## When To Use A Workflow

Use ordinary `task` delegation for a few small subtasks. Use a workflow when the task needs one or more of these properties:

- The same operation must run across many files or records.
- Independent agents should work concurrently under an enforced cap.
- Findings need adversarial verification before reporting.
- Work must branch based on structured results.
- A check/fix cycle must repeat until a condition is satisfied.
- The run needs durable status, cancellation, or restart recovery.
- Editing agents need isolated worktrees and serial integration.

## How It Works

```text
User request
    |
    v
orchestrator creates validated Workflow IR v1
    |
    v
workflow_start requests approval and journals the run
    |
    v
WorkflowScheduler interprets sequence / parallel / map / branch / loop
    |
    v
OpenCode child sessions run agent leaves with structured outputs
    |
    v
results, usage, sessions, and node state are persisted
    |
    v
final result returns to the parent session
```

The scheduler, not the model, owns concurrency, retries, limits, cancellation, and resume. Child prompts use OpenCode's asynchronous session API with the exact selected agent, model, and variant. For `outputSchema` steps, the plugin requests JSON in the final response and validates it locally; it does not rely on provider-native structured-output tool choice, so thinking models such as DeepSeek remain compatible. A single fenced JSON value embedded in otherwise non-JSON prose is recovered only when it validates, and one bounded in-session format-repair prompt is attempted before the step's fresh-session retry policy applies. Completion selects the last assistant response in the correlated turn, rejects an empty terminal response, and aggregates usage across every model response in that turn. Status polling handles OpenCode versions where the newer wait endpoint is unavailable. Intermediate results remain in result files and child sessions, so the parent receives the final result instead of every transcript.

### Workflow Tools

The orchestrator receives these tools when workflows are enabled:

| Tool | Purpose |
| --- | --- |
| `workflow_start` | Validate and start an inline or saved workflow. |
| `workflow_status` | Show one run or list recent runs. |
| `workflow_result` | Read a run's final result. |
| `workflow_cancel` | Cancel the run and all active child sessions. |
| `workflow_resume` | Resume from matching completed node results. |
| `workflow_save` | Save a reusable project or personal workflow. |
| `workflow_list_saved` | List reusable workflow definitions. |

Launches require approval by default. Background completion notifications preserve the parent agent/model selection and disable `workflow_start` for that message so they cannot recursively spawn workflows.

## Workflow Specification

Workflow plans are strict JSON-compatible data. They cannot import modules, access the filesystem, run shell commands, use `eval`, or execute JavaScript.

```json
{
  "version": 1,
  "name": "route-auth-audit",
  "limits": {
    "maxParallel": 4,
    "maxAgents": 30,
    "maxIterations": 10,
    "maxTokens": 500000
  },
  "steps": [
    {
      "id": "discover",
      "type": "agent",
      "agent": "explore",
      "prompt": "List route files under src/routes.",
      "outputSchema": {
        "type": "object",
        "required": ["files"],
        "properties": {
          "files": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    {
      "id": "audit",
      "type": "map",
      "over": "discover.files",
      "as": "file",
      "maxParallel": 4,
      "steps": [
        {
          "id": "finding",
          "type": "agent",
          "agent": "worker",
          "prompt": "Audit {{ file }} for missing authorization."
        }
      ]
    },
    {
      "id": "report",
      "type": "synthesize",
      "agent": "general",
      "input": ["finding"],
      "prompt": "Verify, deduplicate, and rank these findings: {{ finding }}"
    }
  ]
}
```

Supported operations:

- `agent`: run one child session.
- `synthesize`: aggregate prior results through an agent.
- `sequence`: run child steps in order.
- `parallel`: run independent child steps concurrently.
- `map`: fan out over an array from a prior structured result.
- `branch`: run the first case whose closed condition matches.
- `loop`: repeat a body under a hard iteration bound.

Prompts interpolate restricted references such as `{{ input.issue }}`, `{{ discover.files }}`, and `{{ item }}`. In a `synthesize` step, `input` contains raw reference tokens such as `"input": ["audit"]`; braces belong only in prompt text such as `"prompt": "Review {{ audit }}"`. Literal closing braces outside a matched `{{ reference }}` are left untouched, so inline JSON is safe. Conditions support `$ref`, `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$and`, `$or`, and `$not`.

Every `outputSchema` must be a complete JSON Schema object with a top-level string `type`; shorthand maps such as `{ "profile": "object" }` are rejected before the run is created. Supported top-level limits are `maxParallel`, `maxAgents`, `maxIterations`, `maxTokens`, `maxCost`, and `deadline`. Fields such as `maxSteps` and `maxDurationMin` are not part of Workflow IR v1.

See [docs/workflow-schema.md](docs/workflow-schema.md) for the complete contract.

## Persistence And Resume

Run data lives under opencode's state directory:

```text
<opencode-state>/opencode-agent-tree/workflows/
  runs/<run-id>/
    spec.json
    context.json
    events.jsonl
    snapshot.json
    results/*.json
```

The append-only journal is the source of truth. Snapshots are rebuilt when missing, stale, or corrupt. Result files use hashed names and instance-scoped keys so dynamic map and loop executions do not collide.

Run, node, and child-session usage is persisted from every completed model response captured for a child attempt, including structured-format repair responses and attempts whose terminal result is rejected. Token, cost, and duration totals therefore remain consistent across status views, snapshots, and resume.

On resume:

- A completed agent result is reused only when its execution fingerprint matches.
- Fingerprints include the rendered prompt, effective agent/model/variant, schema, isolation, and invocation input.
- Changed inputs or execution parameters rerun the affected leaf.
- Interrupted and unfinished leaves run again.
- Nonterminal node status and stale node errors are reset atomically before resumed work is exposed as running.
- Completed matching leaves return from the journal without another model call.

Saved workflows use these locations:

- Project: `.opencode/workflows/<name>.json`
- Personal: `<opencode-config>/workflows/<name>.json`

Project definitions win name collisions.

## Editing And Worktrees

An agent step with `"isolation": true` runs in an OpenCode-managed git worktree. If it changes files, the scheduler retains that worktree and runs a serial integration worker before dependent work continues. The integration worker inspects the isolated diff, applies equivalent changes to the primary workspace, and runs focused verification. The source worktree is removed only after integration.

Read-only exploration normally should not request worktree isolation.

## Runtime Model Switching

Change the default model for subsequent delegated tasks and new workflow leaves:

```text
/subagent-model openai/gpt-5.6-luna
```

The change lasts for the current opencode process. The workflow model policy updates immediately, including when the runtime was already initialized. Agents with an explicit model or `agentModels` override are unchanged.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `subagentModel` | `string` | Required | Default delegated model in `provider/model-id` format. |
| `subagentEffort` | `string` | Model default | Default delegated model variant. |
| `orchestratorModel` | `string` | Existing/top-level model | Orchestrator model. |
| `orchestratorAgent` | `string` | `"orchestrator"` | Primary orchestrator agent name. |
| `agents` | `string[]` | Eligible subagents | Restrict routed and workflow agents. |
| `agentModels` | `Record<string,string>` | `{}` | Per-agent model overrides. |
| `agentEfforts` | `Record<string,string>` | `{}` | Per-agent variant overrides. |
| `instructions` | `string` | None | Extra orchestrator rules. |
| `blockedTools` | `string[]` | edit/write/apply_patch/bash | Tools denied to the orchestrator. |
| `workflows` | `false` or object | Enabled | Disable or configure the workflow runtime. |

Workflow options:

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Register workflow tools and commands. |
| `approval` | `"always"` | `"always"` requests launch approval; `"never"` starts immediately. |
| `maxParallel` | `4` | Hard concurrent-agent cap. |
| `maxAgents` | `50` | Hard total agent cap, including retries and integration workers. |
| `maxIterations` | `10` | Hard map/loop expansion bound. |
| `stepTimeout` | `1800` | Default timeout for one agent step, in seconds. |
| `maxTokens` | Unset | Optional total token threshold. |
| `maxCost` | Unset | Optional total provider-cost threshold. |
| `autoResume` | `false` | Automatically resume runs interrupted by a prior process. |
| `notifyParent` | `true` | Queue completion/failure notification to the parent session. |

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@beremaran/opencode-agent-tree",
      {
        "subagentModel": "openai/gpt-5.6-luna",
        "subagentEffort": "high",
        "agentModels": {
          "explore": "opencode-go/deepseek-v4-flash"
        },
        "workflows": {
          "maxParallel": 4,
          "maxAgents": 30,
          "maxIterations": 8,
          "stepTimeout": 1200,
          "approval": "always"
        }
      }
    ]
  ]
}
```

## Limits And Safety

- Workflow control code has no filesystem, network, process, shell, import, or evaluation capability.
- Agents still have the permissions of their configured OpenCode agent/session. Workflow approval displays the selected agents and limits, but a parent CLI `--auto` choice is not inherited by child sessions; configure bounded child-agent permissions explicitly.
- Worktrees isolate repository edits, not processes, network access, CPU, or external directories.
- Agent, concurrency, iteration, timeout, and deadline limits are hard scheduler limits.
- Token and cost thresholds stop new work and cancel active work after usage is reported. Concurrent agents can cause bounded overshoot.
- Invocation context containing secret-bearing fields is rejected rather than written to disk.
- Workflows do not currently pause for arbitrary mid-run user input. Split approval-sensitive stages into separate runs.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Run all checks with:

```bash
npm run check
```

## License

[MIT](LICENSE)
