# @beremaran/opencode-agent-tree

An [OpenCode](https://opencode.ai) plugin for **recursive decomposition delegation**. The public package name is retained, but the runtime no longer builds an agent tree or assigns models.

```text
user request -> Manager -> general -> general / explore / custom workers
```

`Manager` is the fixed, toolless root. Workers inspect the task, delegate any independently verifiable pieces through OpenCode's native `task` tool, or execute the task when it is atomic.

## Install

```json
{
    "$schema": "https://opencode.ai/config.json",
    "default_agent": "Manager",
    "plugins": [{"package": "github:beremaran/opencode-agent-tree"}]
}
```

For a local checkout, use the absolute repository directory instead of the GitHub package. Restart OpenCode after changing the plugin configuration.

The plugin is zero-config. Models, agent definitions, and the default agent remain OpenCode configuration concerns.
Remove older entries for this package from other OpenCode config sources before enabling this revision.

## Enforcement

The plugin transforms the fixed `Manager` agent:

- `Manager` is set to `primary`, denies wildcard actions, and only allows `subagent` calls to `general`.
- Direct actions such as reading, editing, shell commands, web access, and planning tools are denied.
- The first handoff is one broad task to `general`, which owns repository discovery.
- Existing enabled non-primary agents, plus the built-in `general` and `explore`, become recursive workers.
- Each worker keeps its existing prompt and model, receives a short recursive-delegation directive, and may call `task` for other workers.
- A worker cannot target `Manager`, a primary/system agent, or itself.

The plugin appends directives once and preserves user-authored prompts. It does not add evaluation instructions or invoke a second model. The current OpenCode API cannot determine semantic task complexity, so recursive decomposition below `Manager` is prompt-guided; the root boundary is permission-enforced.

## Worker protocol

Each worker follows this compact loop:

1. Inspect the task and relevant code.
2. If the work can be split into independently verifiable pieces, delegate those pieces with `task` before making changes.
3. Otherwise perform the atomic task directly.
4. Verify the result and report status, changed files, checks, and blockers.

Long recursive delegation briefs must include an explicit file, directory, or module scope. The root's initial broad handoff is exempt from this check.

## Configuration

The plugin accepts no options. Remove legacy options such as `subagentModel`, `orchestratorDepth`, `agents`, `agentModels`, `instructions`, `blockedTools`, and `restrictTask`; supplying any options causes a clear zero-config error.

Set `default_agent` to `Manager` if every interactive session should start at the delegation root. The plugin does not change OpenCode's default agent itself.

## Runtime

OpenCode 2 is the supported runtime. The package ships raw TypeScript and OpenCode loads the package root through its V2 export with Bun. The `engines.node` requirement is for local tooling and tests.

## Development

```bash
bun install
bun run check
bun run test:smoke
```

The local `opencode.json` is a minimal zero-config fixture for loading the local checkout.
