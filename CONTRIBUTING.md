# Contributing

Thanks for contributing to @beremaran/opencode-agent-tree!

## Getting started

1. Fork the repository and clone your fork.
2. `bun install`
3. `bun run check`

The plugin has one runtime dependency (`zod`) and ships raw TypeScript. OpenCode
loads the V2 plugin with Bun; there is no build step.

## Manual testing

The repo root ships an `opencode.json` pre-wired to load the local checkout as
an OpenCode 2 plugin. Run `opencode debug agents` from the repo root.

Expected behavior:

1. The generated `Manager` agent exists with `mode: "primary"`.
2. Its system prompt contains the orchestrator directive.
3. Its `edit` and `shell` permissions are denied, while the built-in `general`
   and `explore` agents remain available.

## Writing tests

- Tests live in a single file: `test/index.test.ts`. It uses `node:test`
  (run via `bun run test`, which invokes
  `node --experimental-strip-types --test test/index.test.ts`; use
  `bun run test:coverage` for coverage).
- Keep log assertions **filter-based, not positional**. The test helpers
  collect the plugin's `client.app.log` calls; match the log you care about by
  filtering on message content (e.g. `warnMatching(logs, /blocked tool/)`),
  never by assuming an index like `logs[0]` — a new warning added earlier in
  the config hook would silently break it.
- Add a test for any behavior you change, and run `bun run check`
  (typecheck + lint + format + tests) before pushing; CI enforces it.

## Pull requests

- Keep changes minimal and scoped.
- Run `bun run check` before pushing; CI enforces it.
- If you change the directive prompt (`orchestratorDirective` in
  `src/core/directives.ts`),
  update the copy in `README.md` to match. The rendered directive block in the
  README is asserted byte-for-byte against the code's rendered directive, so a
  prompt change **must** update both.
- If you change observable behavior, update `CHANGELOG.md` under
  a new version heading and the README where relevant.
- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, …); releases use
  `chore: release vX.Y.Z` (see [RELEASING.md](RELEASING.md)).
- Update `package.json` `version` only when asked to prepare a release.

## Repository layout notes

- `.opencode/` is intentionally **untracked**: it carries its own self-ignoring
  `.gitignore` (ignoring itself), so a fresh clone will not contain it. It is a
  local working area (e.g. saved workflows), not part of the package.

## Releases

See [RELEASING.md](RELEASING.md) for the release flow (bump version, add a
CHANGELOG entry, tag `vX.Y.Z`, and create the GitHub Release).
