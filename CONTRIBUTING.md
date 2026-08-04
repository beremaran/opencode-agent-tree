# Contributing

Thanks for contributing to @beremaran/opencode-agent-tree!

## Getting started

1. Fork the repository and clone your fork.
2. `npm install`
3. `npm run check`

The plugin has no runtime dependencies — it runs as a single `config` hook
loaded by opencode (Bun runtime). There is no build step.

## Manual testing

The repo root ships an `opencode.json` pre-wired to load `./src/index.ts`.
Run `opencode` from the repo root, then ask something that requires a tool,
e.g.:

> Create a file named test.txt containing "hello".

Expected behavior:

1. The orchestrator agent (`Manager`, created by the plugin) does **not** edit
   the file itself.
2. It delegates the work to a subagent via the `task` tool — in opencode the
   work appears as a delegated task from the orchestrator, not as direct work
   by the `Manager` agent.
3. The subagent runs with the model configured in `subagentModel`
   (check `opencode run --print-logs` for the `stream` lines).

Verify the startup log line is present:

```
Orchestrator "Manager" enabled; subagents -> <subagentModel>
```

## Writing tests

- Tests live in a single file: `test/index.test.ts`. It uses `node:test`
  (run via `npm test`, which invokes
  `node --experimental-strip-types --test test/index.test.ts`; use
  `npm run test:coverage` for coverage).
- Keep log assertions **filter-based, not positional**. The test helpers
  collect the plugin's `client.app.log` calls; match the log you care about by
  filtering on message content (e.g. `warnMatching(logs, /blocked tool/)`),
  never by assuming an index like `logs[0]` — a new warning added earlier in
  the config hook would silently break it.
- Add a test for any behavior you change, and run `npm run check`
  (typecheck + lint + tests) before pushing; CI enforces it.

## Pull requests

- Keep changes minimal and scoped.
- Run `npm run check` before pushing; CI enforces it.
- If you change the directive prompt (`orchestratorDirective` in `src/index.ts`),
  update the copy in `README.md` to match. The rendered directive block in the
  README is asserted byte-for-byte against the code's rendered directive, so a
  prompt change **must** update both.
- If you change observable behavior, update `CHANGELOG.md` under
  `## [Unreleased]` and the README where relevant.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, …); releases use
  `chore: release vX.Y.Z` (see [RELEASING.md](RELEASING.md)).
- Update `package.json` `version` only when asked to prepare a release.

## Repository layout notes

- `.opencode/` is intentionally **untracked**: it carries its own self-ignoring
  `.gitignore` (ignoring itself), so a fresh clone will not contain it. It is a
  local working area (e.g. saved workflows), not part of the published package.

## Releases

Releases are tag-triggered from CI — see [RELEASING.md](RELEASING.md) for the
full flow (bump version, add a CHANGELOG entry, tag `vX.Y.Z`, push the tag).
