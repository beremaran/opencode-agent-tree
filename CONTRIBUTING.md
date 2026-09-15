# Contributing

Thanks for contributing to @beremaran/opencode-agent-tree.

## Getting started

1. Fork and clone the repository.
2. Run `bun install`.
3. Run `bun run check`.

The plugin is zero-config. The root agent is always `Manager`; models and worker definitions come from OpenCode.

## Manual testing

Run `bun run test:smoke`. It starts an isolated OpenCode 2 server with this
checkout as the only plugin and verifies that:

1. `Manager` exists with `mode: "primary"`.
2. `Manager` has the recursive-delegation directive.
3. `Manager` denies wildcard actions and allows `subagent` delegation to `general`.
4. `general` and `explore` have recursive worker guidance and can delegate to each other.

## Tests

Tests live in `test/index.test.ts` and use Node's built-in test runner:

```bash
bun run test
bun run test:smoke
```

Update tests for every observable behavior change. Keep assertions focused on behavior rather than array positions or prompt formatting that is not part of the contract.

## Documentation

Update `README.md` when the delegation policy changes. Keep historical release notes in `CHANGELOG.md`; add a new entry for observable changes.

## Releases

See `RELEASING.md` for the tag-based release flow. Do not change the package version unless preparing a release.
