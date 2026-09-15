# Releasing

Releases are versioned Git tags and GitHub Releases. The plugin is installed
directly from its GitHub repository.

## Steps

1. **Bump the version** in `package.json` (keep `0.x` semver).

2. **Add a CHANGELOG entry.** Create a new `## X.Y.Z - YYYY-MM-DD` heading at
   the top of `CHANGELOG.md`. Group changes under `### Added`, `### Fixed`, and
   `### Changed`. For **breaking** changes in 0.x — anything that changes
   default behavior for existing users — use `### Changed (Breaking)`.

3. **Commit** the changes on `main`:

   ```bash
   git add package.json bun.lock CHANGELOG.md
   git commit -m "chore: release vX.Y.Z"
   git push origin main
   ```

4. **Tag and push the tag:**

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Create the GitHub Release.** Use the GitHub UI or `gh release create` with
   the matching tag and the corresponding CHANGELOG section as its notes.

## Notes

- The tag must be exactly `v` + the `package.json` version (e.g. version
  `0.5.0` → tag `v0.5.0`); the workflow fails otherwise.
- Run `bun run check` before tagging.
- The CHANGELOG requirement predates v0.3.0. Versions released before that
  (`v0.1.1`, `v0.2.0`) were released without a changelog and therefore have no
  entries — this is expected, not an oversight.
