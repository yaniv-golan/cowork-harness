# Releasing cowork-harness

## How publishing works

Pushing a `vX.Y.Z` tag triggers the `.github/workflows/release.yml` workflow, which publishes to
npm via **OIDC Trusted Publishing** (no stored token). Do **not** run `npm publish` manually — it
requires an OTP and is not how this repo ships.

## Admin override — deliberately skipping the live scenario suite for one release

The live scenario suite is part of the publish gate: on a canonical-repo push to `main` (the SHA
`release.yml` gates on), `ci.yml` **hard-fails** if `ANTHROPIC_API_KEY` is missing, so a release can
never silently publish without it. When you must ship a release without running the live suite (e.g.
the key is temporarily unavailable), override it **explicitly and per-commit** — never by weakening the
gate:

1. Set a repository **variable** (not a secret) named `SKIP_LIVE_SCENARIOS` to the **exact full commit
   SHA** you are releasing:
   ```
   gh variable set SKIP_LIVE_SCENARIOS --repo yaniv-golan/cowork-harness --body "<full-40-char-SHA>"
   ```
   The `ci.yml` guard skips the live suite (loud `::warning::ADMIN OVERRIDE`) **only** when this
   variable equals the running commit's SHA. Because it is pinned to one SHA, a later commit can never
   inherit the skip — the override auto-expires. Setting a repo variable requires admin, so the bypass
   is admin-gated and auditable in the run log.
2. Push that commit / re-run `ci.yml`; the scenario job now passes, so `require-ci-success` (the publish
   gate) is satisfied and the tag can publish.
3. **Unset it afterward** so the next release runs the live suite normally:
   ```
   gh variable delete SKIP_LIVE_SCENARIOS --repo yaniv-golan/cowork-harness
   ```

This keeps the gate strict by default (a missing key still reds every un-overridden publish) while
giving an admin a deliberate, one-release, logged escape hatch.

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

**Tag the MERGE COMMIT (main HEAD after the merge), never the release-branch head — and here's why.**
The publish gate (`require-ci-success`) queries `ci.yml` runs with `--event push` for the tagged SHA.
`ci.yml` only triggers `on: push` for **`main`** (plus `pull_request` / `workflow_dispatch`), so a
release-branch/PR head has *only* a `pull_request` run — which the `--event push` filter ignores.
Tagging that SHA makes the gate poll ~30 min and then FAIL. Only the merge commit (produced by
`gh pr merge`, then `git pull`ed onto `main`) has a push-event `ci.yml` run. This is why Phase 3 tags
`main` HEAD after the merge — do **not** "optimize" by tagging the branch commit whose PR CI you just
watched go green.

When you query runs by SHA, use the **full 40-char SHA** (`git rev-parse HEAD`) —
`gh run list --commit <short-sha>` silently returns empty. If you mis-tag: `git push origin
:refs/tags/vX.Y.Z && git tag -d vX.Y.Z`, re-tag on `main` HEAD, re-push, and cancel the misfired
release run. Running `npm run preflight -- --for-tag` right before the tag push mechanically catches
this (it asserts `HEAD == origin/main` and that a push-event `ci.yml` run succeeded for `HEAD`).

## Versioning (semver)

As of `1.0.0`, semver is enforced against the **covered surfaces enumerated in
[SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)** (CLI + exit codes, the
scenario/session/baseline/run-result/cassette/protocol schemas, the documented env vars, and the
packaged Action's inputs/outputs): a backwards-incompatible change to a covered surface is a
**major**; a new command/flag or other additive change is a **minor**; a backwards-compatible bug
fix is a **patch**. Human-readable text output is explicitly NOT covered.

**Surface drift is partly automated.** `test/surface-contract.test.ts` snapshots the *structured*
surfaces — every `schema/*.json` (field paths + enums, including exit-code enums), `action.yml`
inputs/outputs, and the documented `COWORK_*` env-var set — into `test/fixtures/surface-baseline.json`.
Any change to those reds CI until you regenerate (`npm run gen:surface`) and review the diff; at `1.0.0`
a *removal or type/enum change* means a **major** bump. `npm run check:surface` prints the
added/removed/changed breakdown.

**1.0.0 surface-freeze review (one-time, MANUAL — the surfaces the snapshot can't cover).** Before
tagging `1.0.0`, deliberately review and freeze the surfaces with no machine-readable source:
- **CLI command + flag surface** — walk `cowork-harness --help` per command; confirm no command/flag is
  removed or repurposed vs `0.x` intent. (No structured source exists — `cli-structural-guard`'s `CASES`
  and `cli-help`'s pinned strings are hand-maintained.)
- **Per-command exit-code semantics** (SPEC §11) — confirm the documented meanings are the ones you
  intend to hold stable.
- **The `PlatformBaseline` shape** (Zod in `src/types.ts`; no `schema/*.json`).

## Version locations — bump ALL of these to the same `X.Y.Z`

> **`npm run bump -- X.Y.Z --write` automates this whole section** (targeted patterns + lockfile +
> `check:versions`). The list below documents *what it touches* — keep it accurate if you add a new
> version-bearing string, and add that string to `scripts/bump-version.ts` too.

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
10. `README.md` → every `cowork-harness@>=X.Y.Z` floor (the bootstrap-fallback `npx`/`npm i -g` lines
    plus the Action-inputs "companion skill's floor guidance" mention). The `check:versions` lockstep
    guard enforces these match the SKILL.md floor and will red CI otherwise.

## Checklist

- [ ] Decide the version per the semver rule above.
- [ ] **CHANGELOG.md** — move everything under `## [Unreleased]` into a new
      `## [X.Y.Z] — YYYY-MM-DD` section; leave an empty `## [Unreleased]` on top. Include any
      **upgrade notes** (e.g. "re-record cassettes after the staleness-hash change").
- [ ] Bump every version location (items 1–10) with **`npm run bump -- X.Y.Z --write`** — it rewrites all
      of them via targeted patterns and updates the lockfile + self-checks `check:versions` (run without
      `--write` first to preview the diff; dry-run is the default). It deliberately does **not** touch the
      CHANGELOG or add the SKILL.md `- **X.Y.Z:**` release-note bullet — do the CHANGELOG move (above) and
      add that bullet by hand.
- [ ] `npm run preflight` — local pre-release gate (`check:versions`, CHANGELOG heading present + non-empty,
      tag `vX.Y.Z` not already used, clean tree; warns if the `ANTHROPIC_API_KEY` repo secret is missing so
      the push-to-main live suite would need the `SKIP_LIVE_SCENARIOS` override — see §9).
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
- [ ] **Phase 3 — tag and publish** (tag the MERGE COMMIT = current `main` HEAD, per the "why" above):
      ```
      git checkout main && git pull origin main
      npm run preflight -- --for-tag   # asserts HEAD==origin/main AND a green push-event ci.yml run for HEAD
      git tag vX.Y.Z                   # on main HEAD (the merge commit)
      git push origin vX.Y.Z
      gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
      ```
- [ ] **Clean up**: `git push origin --delete release/X.Y.Z && git branch -d release/X.Y.Z`
- [ ] **Move the major/minor tags** (so `uses: yaniv-golan/cowork-harness@v1` and `@v1.0` resolve to
      this release — the packaged Action's Marketplace consumers pin those):
      ```
      git tag -f vX vX.Y.Z && git tag -f vX.Y vX.Y.Z   # e.g. v1 and v1.0 → v1.2.3
      git push -f origin vX vX.Y
      ```
      (Force-moving these ALIAS tags is expected; never force-move the immutable `vX.Y.Z` release tag.)
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
