# Contributing

Contributions to `@beremaran/opencode-agent-tree` are welcome.

## Local setup

1. Fork the repository and clone your fork.
2. Install dependencies with `npm ci`.
3. Run the checks with `npm run check`.

The package has no bundled runtime dependencies or build step. It uses peer dependencies supplied by opencode and ships TypeScript/TSX source that opencode loads with Bun. The optional TUI entrypoint also uses OpenTUI and Solid peers.

## Architecture

The server plugin registers these surfaces:

- `config` creates orchestrator/worker agents, applies permissions, configures routing, and installs workflow commands.
- `tool` exposes workflow start, status, result, cancel, resume, save, and list operations.
- `command.execute.before` validates and applies `/subagent-model` changes.
- `chat.message` selects routed models and prevents completion notifications from recursively starting workflows.
- `dispose` cancels owned runs and cleans up sessions/worktrees.

Workflow modules are separated by responsibility:

- `schema.ts` validates and normalizes Workflow IR v1.
- `scheduler.ts` interprets the IR and owns concurrency, retries, limits, cancellation, and resume.
- `backend.ts` adapts OpenCode child sessions, structured output, completion correlation, interrupts, and worktrees.
- `store.ts` persists immutable specs, invocation context, append-only journals, snapshots, and result files.
- `runtime.ts` lazily wires OpenCode paths and SDK clients into the scheduler.
- `tools.ts` provides the model-facing workflow management surface.
- `src/tui.tsx` is a separate target-only TUI plugin with the workflow dashboard.

The controller never executes model-generated JavaScript. Workflow plans are strict data and agents perform all filesystem/shell operations through their normal OpenCode permissions.

Tests cover routing, option validation, schema safety, scheduler semantics, concurrency, resume, persistence, backend API behavior, cancellation, budgets, worktree integration, and tool behavior.

## Manual testing

The repository's `opencode.json` loads `./src/index.ts` directly. Start opencode from the repository root, then submit a request that requires file changes, such as:

> Create a file named `test.txt` containing `hello`.

Verify that:

1. The `orchestrator` delegates the task instead of editing the file.
2. The `worker` performs the requested change.
3. The worker uses the model configured in `subagentModel`.
4. The startup logs include `Enabled orchestrator "orchestrator" with default subagent model "<subagentModel>".`

Run `/subagent-model provider/model-id` and submit another delegated task to verify runtime model switching.

Then run a read-only workflow:

> `/workflow Inspect this repository in parallel and return one verified architecture report.`

Verify that:

1. `workflow_start` requests approval.
2. `/workflows` shows the background run.
3. Child sessions appear under the parent.
4. The completion notification returns to the parent session.
5. The run journal is created under the opencode state directory.

For write isolation, run a small workflow with an `isolation: true` agent step and verify that the integration worker applies the isolated diff before the worktree is removed.

For an end-to-end completion smoke test, start a one-step workflow with `wait=true` whose worker must return a unique marker. Verify the tool reports `completed`, the marker is written under `runs/<run-id>/results/`, and node/session/run usage in `snapshot.json` matches exactly.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Run `npm run check` before pushing. CI runs the same command.
- Keep user-facing documentation synchronized with option, prompt, command, and log changes.
- Do not update the version in `package.json` unless the change is part of a release.

## Releases

Publishing is handled by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) through npm trusted publishing.

1. Update the version in `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md` and user-facing documentation.
3. Run `npm run check`, `npm pack --dry-run`, and `npm audit --omit=dev`.
4. Commit and push the release changes.
5. Push a tag that exactly matches the package version, such as `v0.3.0`, and create the matching GitHub release.

The workflow verifies the tag, runs the checks, inspects the package contents, and publishes with npm provenance.
