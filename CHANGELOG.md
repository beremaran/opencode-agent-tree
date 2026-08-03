# Changelog

## Unreleased

## 0.3.1 - 2026-08-03

### Fixed

- Selected the terminal child response instead of an earlier progress message, rejected empty terminal text, and accumulated cost/token usage across every response in the child turn.
- Recovered a single schema-valid fenced JSON value and added one bounded in-session structured-format repair before fresh-session retries.
- Waited for child sessions to confirm they stopped before workflow failure/cancellation completed.
- Reset unfinished node states and stale node errors atomically on resume.
- Treated unmatched closing braces as literal prompt text, so inline JSON no longer collides with workflow interpolation.
- Made `/workflow` wait in the foreground to keep one-shot `opencode run` processes alive, while retaining explicit background starts through `workflow_start`.
- Added canonical agent and reference examples to model-facing authoring guidance and exposed limits plus child-permission behavior in workflow approval metadata.
- Rejected incomplete or malformed `outputSchema` objects during workflow validation and documented the exact start-source and limit contracts in model-facing guidance.
- Enforced structured workflow results through final-response JSON plus local JSON Schema validation, avoiding OpenCode 1.18 message decoding failures and forced tool choice on incompatible thinking models.
- Retried transient child-message reads while asynchronous prompt status is still being registered, preserving the real provider error when startup races occur.
- Clarified that `workflow_start` is intentionally unavailable during background completion/failure notification turns and is restored by the next explicit user message.

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
