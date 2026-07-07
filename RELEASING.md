# Releasing cowork-harness

## How publishing works

Pushing a `vX.Y.Z` tag triggers the `.github/workflows/release.yml` workflow, which publishes to
npm via **OIDC Trusted Publishing** (no stored token). Do **not** run `npm publish` manually — it
requires an OTP and is not how this repo ships.

## The preferred three-phase sequence (branch → PR → merge → tag)

CI triggers on pushes to `main`, on pull requests, and via manual `workflow_dispatch`. Pushing a release
branch and opening a PR lets CI prove the exact SHA before anything lands on `main`, keeping the "docs skew" window
(main has ≥X.Y.Z docs but npm still has X.Y-1.Z) as short as possible.

```
Phase 1: git checkout -b release/X.Y.Z
         git push origin release/X.Y.Z
         gh pr create --base main --head release/X.Y.Z --title "release: X.Y.Z"
         # CI runs on the PR. For a same-repo release branch the live scenario stage ALSO runs
         #   (the ANTHROPIC_API_KEY secret is available); it is skipped only on fork PRs.
  ↓  CI passes
Phase 2: gh pr merge <number> --merge   (or merge via GitHub UI)
         git checkout main && git pull origin main
         git push origin main            # no-op fast-forward — main already advanced (and CI ran) at merge
Phase 3: git push origin vX.Y.Z         # triggers release workflow → npm publish + GitHub Release
         # closes the skew window
         git push origin --delete release/X.Y.Z   # clean up remote branch
         git branch -d release/X.Y.Z              # clean up local branch
```

**Why branch-first?** The old two-phase sequence (`push main` → `push tag`) opened the skew window
the moment `main` was pushed and kept it open until CI passed. The branch+PR approach keeps `main`
clean until CI is already green — the merge and tag happen in immediate succession, so the window is
seconds wide rather than minutes.

Never push the tag before CI is green for the exact commit you intend to tag. The release workflow
enforces this (`Require ci.yml success for this commit` step), but don't rely on it — tag a green
SHA.

## Versioning (semver, pre-1.0)

Pre-1.0: **minor** (`0.N+1.0`) = new features and/or behavior changes; **patch** (`0.N.M+1`) =
backwards-compatible bug fixes only. New commands/flags, or changes to existing behavior (e.g. a
stricter privacy gate, a changed cassette/staleness hash), are a **minor**.

From `1.0.0`, semver is enforced against the **covered surfaces enumerated in
[SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)** (CLI + exit codes, the
scenario/session/baseline/run-result/cassette/protocol schemas, the documented env vars, and the
packaged Action's inputs/outputs). Human-readable text output is explicitly NOT covered.

## Version locations — bump ALL of these to the same `X.Y.Z`

1. `package.json` → `"version"` (then run `npm install` to update `package-lock.json`).
2. `.claude-plugin/marketplace.json` → `plugins[0].version`.
3. `.claude/skills/cowork-harness/.claude-plugin/plugin.json` → `"version"`.
4. `.claude/skills/cowork-harness/SKILL.md` → frontmatter `version:`, the `tracks-harness:` line,
   the "**Version note**" block, and the **version floor** in §0 (`needs ≥ X.Y.Z`,
   `npx "cowork-harness@>=X.Y.Z"`).
5. `.claude/skills/cowork-harness/references/scenario-schema.md` → the
   "Tracks `cowork-harness X.Y.Z`" line.
6. `.claude/skills/cowork-harness/references/fidelity-and-answers.md` → the
   "Tracks `cowork-harness X.Y.Z`" line.
7. The baseline these track (`tracks-harness … (baseline desktop-<ver>)`) — keep in sync with the
   newest `baselines/desktop-*.json`.
8. `.claude/skills/cowork-harness/references/ci-recipe.md` → all `npm i -g "cowork-harness@>=X.Y.Z"` floors
   (currently 3 occurrences).
9. `examples/replays/README.md` → the `npm i -g "cowork-harness@>=X.Y.Z"` floor.
10. `README.md` → the three `npx "cowork-harness@>=X.Y.Z"` bootstrap-fallback floors. The
    `check:versions` lockstep guard enforces these match the SKILL.md floor and will red CI otherwise.

## Checklist

- [ ] Decide the version per the semver rule above.
- [ ] **CHANGELOG.md** — move everything under `## [Unreleased]` into a new
      `## [X.Y.Z] — YYYY-MM-DD` section; leave an empty `## [Unreleased]` on top. Include any
      **upgrade notes** (e.g. "re-record cassettes after the staleness-hash change").
- [ ] Bump every version location listed above (items 1–7). `npm install` after bumping `package.json`.
- [ ] `npm run format:check` — fix any issues (`npx prettier --write "src/**/*.ts" "test/**/*.ts"`).
      A format failure is the most common first-pass CI red.
- [ ] `npx tsc -p tsconfig.test.json --noEmit` — typecheck including tests.
- [ ] `npm run ci` (typecheck + build + test) is green locally.
- [ ] `npm pack --dry-run` — confirm the tarball contains `dist/`, `baselines/`, `docker/`, the bundled
      `scenario.py` + `assertion-keys.json` (the skill itself ships via the marketplace, not npm), and no
      internal planning notes.
- [ ] Public export resolves: `node --input-type=module -e "import('cowork-harness/secrets').then(m => {
      if (!m.scrubField || !m.collectSecrets) throw new Error('missing export'); })"` (run from an install of
      the packed tarball, or via self-reference in-repo). Guards the sole programmatic API subpath.
- [ ] Commit everything (`chore: bump to X.Y.Z; sync docs, CHANGELOG, and skill`).
- [ ] **Phase 1 — branch + PR**:
      ```
      git checkout -b release/X.Y.Z
      git push origin release/X.Y.Z
      gh pr create --base main --head release/X.Y.Z --title "release: X.Y.Z"
      gh run watch $(gh run list --branch release/X.Y.Z --limit 1 --json databaseId --jq '.[0].databaseId')
      ```
- [ ] **Wait for CI green** on the PR. Fix any failures on the branch and push again; CI re-runs
      automatically.
- [ ] **Phase 2 — merge**:
      ```
      gh pr merge <number> --merge
      git checkout main && git pull origin main
      git push origin main
      ```
- [ ] **Phase 3 — tag and publish**:
      ```
      git push origin vX.Y.Z
      gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
      ```
- [ ] **Clean up**: `git push origin --delete release/X.Y.Z && git branch -d release/X.Y.Z`
- [ ] Smoke the published artifact: `npx cowork-harness@X.Y.Z --version` and
      `npx cowork-harness@X.Y.Z doctor --tier protocol`.

## Notes

- "Merge is not push." Local merges/commits never imply a release — the steps above are the only
  ones that make anything public; run them only on an explicit decision to release.
- Planning notes belong in a gitignored location excluded from the npm tarball; never commit or publish them.
- If the tag was placed on the wrong commit (e.g. a follow-up fix was needed), delete the local tag
  (`git tag -d vX.Y.Z`), re-create it on the correct commit, and push it.
- The live `scenario suite` CI stage runs on **same-repo** PRs (where the `ANTHROPIC_API_KEY` secret is
  available) and on pushes to `main`; it is skipped only on **fork** PRs (or when the secret is unset). So
  a same-repo release-branch PR DOES exercise the live suite and spend API budget — the `unit` + `boundary`
  stages alone are sufficient to gate a release if you'd rather not.
