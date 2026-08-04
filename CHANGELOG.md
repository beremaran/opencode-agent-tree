# Changelog

## Unreleased

### Changed

- Built-in primary agents (`build`, `plan`, `compaction`, `title`, `summary`) are never routed to `subagentModel` and never trigger the phantom-agent warning, even when listed in `agents`. `general` and `explore` remain the routable built-in subagents.
- An existing `orchestratorAgent` is converted to primary mode unconditionally; a warning is logged when it previously had an explicit non-primary mode.
- The config hook no longer throws: a disabled orchestrator agent logs an error and the plugin's configuration is not applied, but opencode continues with the original config. Factory-level invalid options still raise a config error that aborts plugin load.
- Permission merging is hardened: overwriting an existing non-`deny` plain permission warns; command-scoped (object) rules replaced by a blanket `deny` warn separately; values already set to `deny` are not re-warned; and a non-object `permission` is replaced with an empty object (with a warning).
- The startup summary log now reports the effective `defaultAgent` in its extra metadata.

### Fixed

- Validation is now consistent: empty-string handling for `subagentModel`, `orchestratorModel`, and `instructions` matches across the factory and the config hook.
- The README's claim that disabled agents, primary-mode agents, and the orchestrator itself are filtered out of an explicit `agents` list even if listed is now accurate and stays.

### Added

- Exported `OrchestratorOptions` type in `src/index.ts` for typed plugin options.
- Biome linting (`npm run lint` runs `biome check src test`); `npm run check` now runs typecheck, lint, and tests; CI runs lint and runs the test suite under Bun.
- `prepublishOnly` runs the full check suite before publishing.
- `sideEffects: false`, `homepage`, `bugs`, and a `./package.json` export in `package.json`, plus `@types/node` and `@biomejs/biome` dev dependencies.
- `RELEASING.md` documenting the tag-triggered release flow.
- Dependabot batching (`open-pull-requests-limit: 5` and update groups), and `*.tgz` in `.gitignore`.
- The publish workflow verifies the CHANGELOG entry for the released version, asserts the packed file list, smoke-tests the tarball from a clean consumer install, and creates a GitHub Release from the CHANGELOG section.
- Tests were converted to TypeScript and expanded to cover the new routing, conversion, permission, and config-hook behaviors.

## 0.5.0 - 2026-08-04

### Changed (Breaking)

- The default orchestrator agent is now `Manager`, created by the plugin when it does not exist; built-in agents (`build`, `plan`) are no longer modified by default.
- When the orchestrator agent does not exist, startup logs `Creating orchestrator agent "Manager"` (idempotent across config-hook re-runs).

### Notes

- Migration: installs that previously converted `build` keep the `# Orchestrator Mode` directive on `build`. Use the new `Manager` agent, or clean up `build`'s prompt manually in your opencode config.

## 0.4.1 - 2026-08-04

### Fixed

- Config-hook errors (e.g. a disabled orchestrator agent) are now logged through `client.app.log` before rethrowing, so startup failures surface in the log instead of failing silently.
- `agentModels` lookups are prototype-safe (`Object.hasOwn`), so agent names colliding with `Object.prototype` keys no longer break model routing.

### Added

- Model options (`subagentModel`, `orchestratorModel`, `agentModels` values) are validated as `provider/model` at startup, producing a useful config error instead of a later model-not-found failure.
- `blockedTools` entries are validated as tool names (`[a-z0-9_-]+`), preventing malformed entries from being interpolated into the orchestrator's system prompt.
- Warnings for likely misconfigurations: blocking tools the orchestrator directive depends on, overwriting existing non-`deny` permissions, explicit `agents` lists that omit the built-in subagents, and agent names that do not exist (typo protection).
- `engines` (`>=22.6`), a `types` entry, a narrowed peer range (`>=1.18.11 <2`), and a `funding` field in package.json.
- CI: node 22/24 matrix, Bun smoke test, peer-drift check, and Dependabot; the publish workflow now authenticates via `NPM_TOKEN` and smoke-tests the packed tarball.
- `SECURITY.md` and `CODE_OF_CONDUCT.md`, plus expanded README sections (validation & warnings, security, limitations, troubleshooting, model precedence).

## 0.4.0 - 2026-08-03

### Changed

- Rolled the plugin back to its delegation enforcer roots. Removed the durable workflow engine, dedicated orchestrator/worker agents, subagent effort controls, runtime model command, and optional TUI dashboard. The plugin is again a single `src/index.ts`: it installs the orchestrator directive on the `build` agent, hard-blocks its hands-on tools, and routes all subagents to the configured `subagentModel`. Dropped the `@beremaran/opencode-agent-tree/tui` and `@beremaran/opencode-agent-tree/server` exports along with the ajv and OpenTUI dependencies.

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
