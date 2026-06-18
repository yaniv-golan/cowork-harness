# Releasing cowork-harness

## The one rule: publish and push together

The repo's `main` tracks the **next** release — its README, `docs/`, and the bundled companion skill
(`.claude/skills/cowork-harness/`) describe commands and a version floor (`npx cowork-harness@>=X.Y.Z`)
that may not be on npm yet. That's fine **as long as `main` is not public ahead of the npm release**.

So the release is **atomic**: bump → tag → `npm publish` → push `main` + tag **in one go**. Never push the
0.X docs/skill to a public `main` without publishing 0.X to npm in the same step — otherwise a visitor who
reads `main` and runs `npm install`/the companion skill hits "unknown command" / an `@>=X.Y.Z` E404. (This
is the skew a funnel review flagged; it's a sequencing constraint, not a code bug.)

## Versioning (semver, pre-1.0)

The CHANGELOG header states it: pre-1.0, **minor** (`0.N+1.0`) = new features and/or behavior changes;
**patch** (`0.N.M+1`) = backwards-compatible bug fixes only. New commands/flags, or changes to existing
behavior (e.g. a stricter privacy gate, a changed cassette/staleness hash), are a **minor**.

## Version locations — bump ALL of these to the same `X.Y.Z`

1. `package.json` → `"version"`.
2. `.claude/skills/cowork-harness/SKILL.md` → frontmatter `version:`, the `tracks-harness:` line, the
   "**Version note**" block, and the **version floor** in §0 (`needs ≥ X.Y.Z`, `npx cowork-harness@>=X.Y.Z`).
3. `.claude/skills/cowork-harness/references/scenario-schema.md` → the "Tracks `cowork-harness X.Y.Z`" line.
4. The baseline these track (`tracks-harness … (baseline desktop-<ver>)`) — keep in sync with the newest
   `baselines/desktop-*.json`.

## Checklist

- [ ] Decide the version per the semver rule above.
- [ ] **CHANGELOG.md** — move everything under `## [Unreleased]` into a new `## [X.Y.Z] — YYYY-MM-DD`
      section; leave an empty `## [Unreleased]` on top. Include any **upgrade notes** (e.g. "re-record
      cassettes after the staleness-hash change").
- [ ] Bump every version location listed above.
- [ ] `npm run ci` (typecheck + build + test) is green locally.
- [ ] **Verify CI is green for the exact release SHA** on GitHub Actions — the publish gate is weaker than
      full CI, so confirm `ci.yml` passed for this commit before tagging (don't tag a red SHA).
- [ ] Commit the release (`release: X.Y.Z — <one-line summary>`), on `main`.
- [ ] Tag `vX.Y.Z` at that commit.
- [ ] `npm publish` (confirm the tarball contents: `npm pack --dry-run` — no `docs/internal/`, includes
      `dist/`, `baselines/`, `docker/`, the skill).
- [ ] **Push `main` and the tag together** (`git push origin main --follow-tags`).
- [ ] Smoke the published artifact: `npx cowork-harness@X.Y.Z --version` and `… doctor --tier protocol`.

## Notes

- "Merge is not push." Local merges/commits never imply a release — the steps above are the only ones that
  make anything public; run them only on an explicit decision to release.
- `docs/internal/` is gitignored and excluded from the npm tarball — keep planning notes there.
