# @beremaran/opencode-agent-tree

An [opencode](https://opencode.ai) plugin that enforces delegation. It adds a dedicated `orchestrator` agent that plans and reviews work while subagents handle implementation, research, testing, and verification.

- Keeps the built-in `build` and `plan` agents unchanged.
- Adds a `worker` subagent for hands-on tasks.
- Blocks the orchestrator from using implementation tools directly.
- Routes subagents to configurable models and effort levels.
- Changes the default subagent model at runtime with `/subagent-model`.
- Respects models and variants configured directly on agents.

## Installation

Add the plugin to your `opencode.json` and set the required `subagentModel` option:

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

Restart opencode after changing the configuration. The plugin selects its `orchestrator` agent by default unless `default_agent` is already set. Select `build` or `plan` whenever you want to use those agents directly.

## How it works

The plugin configures two complementary agents:

1. `orchestrator` is a primary agent that decomposes requests, delegates every subtask through the `task` tool, reviews the results, and reports back to the user.
2. `worker` is a subagent for implementation, refactoring, testing, and verification. The orchestrator can also delegate to `explore`, `general`, and user-defined subagents.

Delegation is enforced in two layers:

1. The orchestrator receives a system prompt that requires delegation.
2. Its hands-on tools are denied through agent permissions. By default, those tools are `edit`, `write`, `apply_patch`, and `bash`.

Subagents keep their normal tool access. The plugin does not add the orchestrator prompt or its tool restrictions to any subagent.

## Runtime model switching

Change the default model for subsequent delegated tasks without restarting opencode:

```text
/subagent-model openai/gpt-5.2
```

The change lasts for the current opencode process. It applies only to agents using `subagentModel`; agents with an explicit `model` or an `agentModels` override are unchanged. Restart opencode to restore the configured default.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `subagentModel` | `string` | Required | Default model for routed subagents, in `provider/model-id` format. |
| `subagentEffort` | `string` | Model default | Default model variant for routed subagents that do not define one. |
| `orchestratorModel` | `string` | Existing agent or top-level model | Model used by the orchestrator. |
| `orchestratorAgent` | `string` | `"orchestrator"` | Name of the primary agent configured as the orchestrator. |
| `agents` | `string[]` | All eligible subagents | Limits model and effort routing to the listed agents. |
| `agentModels` | `Record<string, string>` | `{}` | Per-agent model overrides. |
| `agentEfforts` | `Record<string, string>` | `{}` | Per-agent model variant overrides. |
| `instructions` | `string` | None | Additional rules appended to the orchestrator prompt. |
| `blockedTools` | `string[]` | `["edit", "write", "apply_patch", "bash"]` | Tools denied to the orchestrator. Use `[]` for prompt-only enforcement. |

For agents without an explicit `model`, `agentModels` takes precedence over `subagentModel`. For model variants, an agent's explicit `variant` takes precedence over `agentEfforts`, which takes precedence over `subagentEffort`.

The effort options map to opencode's agent `variant` field. Variant names are provider-specific; values such as `low`, `medium`, and `high` are passed to opencode without provider-specific validation.

### Example

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
        "agentModels": {
          "explore": "anthropic/claude-haiku-4-5"
        },
        "agentEfforts": {
          "explore": "low"
        },
        "instructions": "Never delegate more than three subtasks at once."
      }
    ]
  ]
}
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, testing, and release instructions.

## License

[MIT](LICENSE)
