# Releasing cowork-harness

## How publishing works

Pushing a `vX.Y.Z` tag triggers the `.github/workflows/release.yml` workflow, which publishes to
npm via **OIDC Trusted Publishing** (no stored token). Do **not** run `npm publish` manually — it
requires an OTP and is not how this repo ships.

## The two-phase sequence

The release is split into two pushes to close the "docs skew" window as tightly as possible:

```
Phase 1: git push origin main     # triggers CI; begins skew window
                                   # (main has >=X.Y.Z docs but npm only has X.Y-1.Z)
  ↓  CI passes (unit + boundary gate)
Phase 2: git push origin vX.Y.Z   # triggers release workflow → npm publish + GitHub Release
                                   # closes skew window
```

Never push the tag before CI is green for the exact commit you intend to tag. The release workflow
enforces this (`Require ci.yml success for this commit` step), but don't rely on it — tag a green
SHA.

## Versioning (semver, pre-1.0)

Pre-1.0: **minor** (`0.N+1.0`) = new features and/or behavior changes; **patch** (`0.N.M+1`) =
backwards-compatible bug fixes only. New commands/flags, or changes to existing behavior (e.g. a
stricter privacy gate, a changed cassette/staleness hash), are a **minor**.

## Version locations — bump ALL of these to the same `X.Y.Z`

1. `package.json` → `"version"`.
2. `.claude/skills/cowork-harness/SKILL.md` → frontmatter `version:`, the `tracks-harness:` line,
   the "**Version note**" block, and the **version floor** in §0 (`needs ≥ X.Y.Z`,
   `npx cowork-harness@>=X.Y.Z`).
3. `.claude/skills/cowork-harness/references/scenario-schema.md` → the
   "Tracks `cowork-harness X.Y.Z`" line.
4. The baseline these track (`tracks-harness … (baseline desktop-<ver>)`) — keep in sync with the
   newest `baselines/desktop-*.json`.

## Checklist

- [ ] Decide the version per the semver rule above.
- [ ] **CHANGELOG.md** — move everything under `## [Unreleased]` into a new
      `## [X.Y.Z] — YYYY-MM-DD` section; leave an empty `## [Unreleased]` on top. Include any
      **upgrade notes** (e.g. "re-record cassettes after the staleness-hash change").
- [ ] Bump every version location listed above.
- [ ] `npm run format:check` — fix any issues before the release commit (a format failure is the
      most common CI red on a release push).
- [ ] `npm run ci` (typecheck + build + test) is green locally.
- [ ] `npm pack --dry-run` — confirm the tarball contains `dist/`, `baselines/`, `docker/`, the
      skill, and no `docs/internal/`.
- [ ] Commit the release (`release: X.Y.Z — <one-line summary>`), on `main`.
- [ ] **Phase 1 — push `main`**: `git push origin main`
- [ ] **Wait for CI green** (`gh run watch` or check GitHub Actions). Do not proceed until the
      `unit` job passes for this exact commit.
- [ ] **Tag the green commit**: `git tag vX.Y.Z` (if not already tagged).
- [ ] **Phase 2 — push the tag**: `git push origin vX.Y.Z`
      The release workflow runs automatically: build + test → npm publish (OIDC) → GitHub Release.
      Watch with `gh run list` / `gh run watch`.
- [ ] Smoke the published artifact: `npx cowork-harness@X.Y.Z --version` and
      `npx cowork-harness@X.Y.Z doctor --tier protocol`.

## Notes

- "Merge is not push." Local merges/commits never imply a release — the steps above are the only
  ones that make anything public; run them only on an explicit decision to release.
- `docs/internal/` is gitignored and excluded from the npm tarball — keep planning notes there.
- If the tag was placed on the wrong commit (e.g. a follow-up fix was needed), delete the local tag
  (`git tag -d vX.Y.Z`), re-create it on the correct commit, and push it.
