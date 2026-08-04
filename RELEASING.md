# Releasing

Releases are **tag-triggered from CI**. There is no local build or publish step —
pushing a `vX.Y.Z` tag runs `.github/workflows/publish.yml`, which publishes to
npm (with provenance) and creates the GitHub Release.

## Steps

1. **Bump the version** in `package.json` (keep `0.x` semver; the version in
   `package-lock.json` is updated by `npm install` or `npm version`).

2. **Add a CHANGELOG entry.** Create a new `## X.Y.Z - YYYY-MM-DD` heading at
   the top of `CHANGELOG.md` (above `## Unreleased`, or move the Unreleased
   content into it). Group changes under `### Added`, `### Fixed`, and
   `### Changed`. For **breaking** changes in 0.x — anything that changes
   default behavior for existing users — use `### Changed (Breaking)`.

3. **Commit** the changes on `main`:

   ```bash
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: release vX.Y.Z"
   git push origin main
   ```

4. **Tag and push the tag:**

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Watch the publish workflow.** It verifies the tag matches `package.json`
   and that `CHANGELOG.md` contains the version, runs `npm run check`,
   inspects the packed tarball, smoke-tests it from a clean consumer install,
   publishes to npm via `NPM_TOKEN` (with npm provenance), and creates a
   GitHub Release whose body is the CHANGELOG section for the version.

## Notes

- The tag must be exactly `v` + the `package.json` version (e.g. version
  `0.5.0` → tag `v0.5.0`); the workflow fails otherwise.
- A local `npm publish` is not the supported flow and will not produce npm
  provenance. `prepublishOnly` runs `npm run check` if you ever do, but prefer
  the tag flow.
- "Unreleased" entries are never tagged; move their content into the dated
  release section before tagging.
