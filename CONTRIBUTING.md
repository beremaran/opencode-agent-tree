# Contributing

Contributions to `@beremaran/opencode-agent-tree` are welcome.

## Local setup

1. Fork the repository and clone your fork.
2. Install dependencies with `npm ci`.
3. Run the checks with `npm run check`.

The package has no production dependencies or build step. It uses the opencode plugin API and ships TypeScript source that opencode loads with Bun.

## Architecture

The plugin registers three opencode hooks:

- `config` creates the orchestrator and worker agents, applies permissions, and configures model routing.
- `command.execute.before` validates and applies `/subagent-model` changes.
- `chat.message` selects the active model for routed subagents.

Unit tests cover option validation, agent routing, prompt installation, permissions, and runtime model changes.

## Manual testing

The repository's `opencode.json` loads `./src/index.ts` directly. Start opencode from the repository root, then submit a request that requires file changes, such as:

> Create a file named `test.txt` containing `hello`.

Verify that:

1. The `orchestrator` delegates the task instead of editing the file.
2. The `worker` performs the requested change.
3. The worker uses the model configured in `subagentModel`.
4. The startup logs include `Enabled orchestrator "orchestrator" with default subagent model "<subagentModel>".`

Run `/subagent-model provider/model-id` and submit another delegated task to verify runtime model switching.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Run `npm run check` before pushing. CI runs the same command.
- Keep user-facing documentation synchronized with option, prompt, command, and log changes.
- Do not update the version in `package.json` unless the change is part of a release.

## Releases

Publishing is handled by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) through npm trusted publishing.

1. Update the version in `package.json` and `package-lock.json`.
2. Run `npm run check` and `npm pack --dry-run`.
3. Push a tag that exactly matches the package version, such as `v0.2.0`.

The workflow verifies the tag, runs the checks, inspects the package contents, and publishes with npm provenance.
