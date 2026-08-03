# Changelog

## 0.3.0 - 2026-08-03

### Added

- Validated Workflow IR v1 with agent, synthesize, sequence, parallel, map, branch, and bounded loop operations.
- Durable workflow journals, snapshots, result files, resume fingerprints, usage budgets, deadlines, cancellation, and saved workflows.
- Model-facing workflow management tools and `/workflow`, `/workflows`, and `/workflow-resume` commands.
- Optional OpenTUI dashboard through the separate `@beremaran/opencode-agent-tree/tui` export.
- Isolated editing worktrees with serialized integration before dependent work continues.

### Changed

- Split the server plugin into focused routing, option, prompt, backend, scheduler, schema, store, runtime, and tool modules.
- Declared support for opencode `>=1.18.11 <2` and optional OpenTUI peer dependencies.
- Runtime model changes now update workflow policy immediately, including after lazy runtime initialization.
- Background completion notifications preserve the parent execution selection; synchronous workflows return results directly.

### Fixed

- Reused opencode's injected in-process SDK transport and authentication headers for child sessions.
- Added compatibility fallbacks for unavailable session-wait endpoints and status maps that omit idle sessions.
- Preserved SDK service bindings and propagated child agent, model, and variant through asynchronous prompts.
- Waited for completed correlated assistant messages instead of accepting partial output.
- Distinguished canceled runs from failures and aborted/joined parallel siblings after terminal errors.
- Avoided retrying permanent backend, missing-session, authentication, and model-availability errors.
- Corrected workflow node usage accounting so node, session, and run totals are not double-counted.
