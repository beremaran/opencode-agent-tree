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

1. The orchestrator (`build`) does **not** edit the file itself.
2. It delegates the work to a subagent via the `task` tool — in opencode the
   work appears as a delegated task from the orchestrator, not as direct work
   by the `build` agent.
3. The subagent runs with the model configured in `subagentModel`
   (check `opencode run --print-logs` for the `stream` lines).

Verify the startup log line is present:

```
Orchestrator "build" enabled; subagents -> <subagentModel>
```

## Pull requests

- Keep changes minimal and scoped.
- Run `npm run check` before pushing; CI enforces it.
- If you change the directive prompt (`orchestratorDirective` in `src/index.ts`),
  update the copy in `README.md` to match.
- Update `package.json` `version` only when asked to prepare a release.
