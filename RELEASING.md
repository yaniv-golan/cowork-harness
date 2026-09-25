# Releasing cowork-harness

## How publishing works

Pushing a `vX.Y.Z` tag triggers the `.github/workflows/release.yml` workflow, which publishes to
npm via **OIDC Trusted Publishing** (no stored token). Do **not** run `npm publish` manually — it
requires an OTP and is not how this repo ships.

## The live scenario suite is best-effort (not a publish gate)

The live scenario suite (the `scenarios` job in `ci.yml`) runs live inference only when
`ANTHROPIC_API_KEY` is available to the runner. Without the key the whole job is **skipped**, on every
event, pushes to `main` included. It shows as *skipped*, not green. The small `live-key` job before it
makes that decision and carries the `⚠️ NOT live-validated` warning and run-summary marker.

It is **not** a publish gate. `release.yml`'s `require-ci-success` requires the `ci.yml` run for the
tagged commit to conclude `success`, and a skipped job leaves the run `success`. So a release can still
ship without live CI validation. The difference is that the check no longer pretends otherwise. (A live
run that actually executes and FAILS does make the run `failure`, which blocks the release.)

**Setting the `ANTHROPIC_API_KEY` repo secret is NOT enough to run the live suite in CI.** The
`scenarios` job never stages the agent binary on the runner. A run with the key path forced on
(2026-09-25, no real key) built the image and then failed its first scenario with `Staged agent binary
not found at …/claude-code-vm/<ver>/claude`, before inference was reached. Set the key only together with
a step that stages and sha256-verifies the agent ELF (see the self-hosted example in
[docs/ci.md](./docs/ci.md)). Otherwise the job turns red, the `ci.yml` run concludes `failure`, and
`require-ci-success` blocks the release. There is no `SKIP_LIVE_SCENARIOS` override, because the suite
never hard-fails on a missing key.

**Do not add `scenario suite` to the branch ruleset's required checks without setting the key first.**
GitHub counts a job skipped by a conditional as **passing** a required-status rule, so a required but
key-less live job would satisfy the rule while validating nothing.

> **Ran a live pass? Re-stamp `DESIGN.md`'s "Scope of that claim" note — it is the single authority for
> the live pin,** naming the baseline, the agent version, which suites and which tiers. Nothing enforces
> this, and that is deliberate: a cross-file "these three strings match" check is satisfiable by pasting
> a digit without re-running anything, which is the copy-paste-satisfiable guard this repo has already
> been burned by twice (see the reasoning at the top of `scripts/check-claims.ts`). The pin is stated
> **once**; dated mentions elsewhere — a `CHANGELOG.md` release note, a `docs/protocol.md` changelog entry
> — record what was true on their own date and are never restamped.

## The preferred three-phase sequence (branch → PR → merge → tag)

CI triggers on pushes to `main`, on pull requests, and via manual `workflow_dispatch`. Pushing a release
branch and opening a PR lets CI prove the exact SHA before anything lands on `main`, keeping the "docs skew" window
(main has ≥X.Y.Z docs but npm still has X.Y-1.Z) as short as possible.

```
Phase 1: git checkout -b release/X.Y.Z
         git push origin release/X.Y.Z
         gh pr create --base main --head release/X.Y.Z --title "release: X.Y.Z"
         # CI runs on the PR. The live scenario job is SKIPPED whenever ANTHROPIC_API_KEY is
         #   unavailable — which is the case today; see "best-effort (not a publish gate)" above.
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

> **Tag the MERGE COMMIT (main HEAD after the merge), never the release-branch head — and here's why.**
> The publish gate (`require-ci-success`) queries `ci.yml` runs with `--event push` for the tagged SHA.
> `ci.yml` only triggers `on: push` for **`main`** (plus `pull_request` / `workflow_dispatch`), so a
> release-branch/PR head has *only* a `pull_request` run — which the `--event push` filter ignores.
> Tagging that SHA makes the gate poll ~30 min and then FAIL. Only the merge commit (produced by
> `gh pr merge`, then `git pull`ed onto `main`) has a push-event `ci.yml` run. This is why Phase 3 tags
> `main` HEAD after the merge — do **not** "optimize" by tagging the branch commit whose PR CI you just
> watched go green.

When you query runs by SHA, use the **full 40-char SHA** (`git rev-parse HEAD`) —
`gh run list --commit <short-sha>` silently returns empty. If you mis-tag: `git push origin
:refs/tags/vX.Y.Z && git tag -d vX.Y.Z`, re-tag on `main` HEAD, re-push, and cancel the misfired
release run. Running `npm run preflight -- --for-tag` right before the tag push mechanically catches
this (it asserts `HEAD == origin/main` and that a push-event `ci.yml` run succeeded for `HEAD`).

> **A merge-commit run could be CANCELLED, not just red — fixed in 1.21.1, and the rule still stands.**
> `ci.yml` used to set `concurrency: cancel-in-progress: true` for every ref, so merging a second PR while
> the first merge's `main` run was still going killed the earlier run. Observed 2026-08-06: merging #104
> then #105 two minutes apart left `c2f2688` with `conclusion: cancelled` and only `75b3b6c` green. The
> publish gate requires `conclusion == success` for the *tagged* SHA, so tagging that earlier commit would
> poll ~30 min and then fail. As of 1.21.1 cancellation is scoped to pull-request refs
> (`cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`), so a `main` run now always runs to
> completion; `test/workflow-structure.test.ts` keeps it that way. Tagging `main` HEAD after the last merge
> (Phase 3 above) remains correct regardless — it avoids the whole class by construction. Note `ci.yml`
> grew an arm64 image build in `ee0b21f`, which widens the window a `main` run occupies.

## The `main` ruleset, and the one drift it can hide

A branch ruleset lives in GitHub settings, not in the repo, so nothing here can catch it drifting.
Renaming a CI job orphans any required-check context pinned to the old name, and a required check that no
job reports **never resolves** — every PR stays `BLOCKED` no matter how green CI is. That happened once:
`0ead103` renamed the python job on 2026-07-08 and the ruleset kept the old name for 676 commits.

`npm run preflight` now warns when a required context matches no job. It is WARN-only and SKIPs without
`gh`/admin scope, so it never blocks a release on a read it could not perform.

**Merge expectations, by who is opening the PR:**

- **Non-admin PR** — requires an approving code-owner review. Working as intended.
- **Admin's own PR** — cannot be self-approved (GitHub forbids it), so it merges through the admin-role
  bypass on the ruleset. If a plain `gh pr merge <n> --merge` is refused, use
  `gh pr merge <n> --merge --admin`. The bypass is keyed on the **admin role**, not on any username, so it
  survives adding or changing admins.

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
   `npx "cowork-harness@^X.Y.Z"`).
5. `.claude/skills/cowork-harness/references/scenario-schema.md` → the
   "Tracks `cowork-harness X.Y.Z`" line.
6. `.claude/skills/cowork-harness/references/fidelity-and-answers.md`,
   `.claude/skills/cowork-harness/references/task-recipes.md` and
   `.claude/skills/cowork-harness/references/critique.md` → the
   "Tracks `cowork-harness X.Y.Z`" line in each.
7. The baseline these track (`tracks-harness … (baseline desktop-<ver>)`) — keep in sync with the
   newest `baselines/desktop-*.json`. The `check:versions` guard enforces this for SKILL.md, every
   `references/*.md` baseline pin, and DESIGN.md's current-state sentence — a lagging pin reds CI.
8. `.claude/skills/cowork-harness/references/ci-recipe.md` → all `npm i -g "cowork-harness@^X.Y.Z"` floors
   (currently 3 occurrences).
9. `examples/replays/README.md` → the `npm i -g "cowork-harness@^X.Y.Z"` floor.
10. `README.md` → every `cowork-harness@^X.Y.Z` floor (the bootstrap-fallback `npx`/`npm i -g` lines
    plus the Action-inputs "companion skill's floor guidance" mention). The `check:versions` lockstep
    guard enforces these match the SKILL.md floor and will red CI otherwise.

## Checklist

- [ ] Decide the version per the semver rule above.
- [ ] **Does this release add or change a user-facing CLI flag, assertion key, cassette field, message,
      top-level scenario key, or version coupling?** If so update **CHANGELOG.md + README.md +
      `.claude/skills/cowork-harness/SKILL.md` + `references/`** — a version bump is NOT documentation.
      Only *some* of this is guarded (the assertion-key catalog and cassette schema fields, by
      `test/skill-docs-sync.test.ts`); a new **flag** or **message** is guarded by nothing and is on you.
      Two consecutive consumer adoption reports spent ~40% of their findings on exactly this.
- [ ] **New top-level scenario key?** Then the docs above MUST also state **the version floor and what an
      older CLI does with the key** — the loader is `z.strictObject`, so an unknown key is a hard error
      (`Unrecognized key: "<k>"`, exit 2), never a silent fallback to the default. Adopting the key is a
      floor bump for every consumer, and "it just means the default on older versions" is the wrong guess
      a reader makes when you don't say. This category was added after `lane:` (1.14.0) cleared every
      machine-enumerable guard — schema, `lint`'s valid-key list, the surface snapshot — and still shipped
      with no floor documented anywhere, which cost a consumer a wrong conclusion and a wasted test cycle.
- [ ] **Agent image: is `docker/agent-image.json` still the image you want consumers on?** Tagging a
      release publishes a `:2-<version>` co-tag but deliberately does **not** move the floating `:2` —
      `:2` is a curated pointer, moved only by an explicit `workflow_dispatch` with `immutable_only`
      unchecked, in the same release that ships the updated pin (see `docs/maintenance.md`). So the
      default answer here is "yes, unchanged, nothing to do". Act only if you actually intend consumers
      to get a new image: bump `revision`, dispatch with `immutable_only` to publish `:2-r<N>`,
      transcribe the `PINNABLE` digests into `docker/agent-image.json`, and move `:2` in this release.
      Note the recipe is not the whole story — `Dockerfile.agent` installs unpinned apt/pip/npm
      packages, so an unchanged Dockerfile still yields different bytes on every rebuild.
- [ ] **CHANGELOG.md** — move everything under `## [Unreleased]` into a new
      `## [X.Y.Z] — YYYY-MM-DD` section; leave an empty `## [Unreleased]` on top. Include any
      **upgrade notes** (e.g. "re-record cassettes after the staleness-hash change").
- [ ] **State the cassette re-record verdict in the upgrade notes — positively, every release.** Either
      `Cassettes: no re-record needed` (name the evidence: nothing under `src/runtime`, `src/hostloop`,
      `src/staging`, `src/session.ts`, the spawn path, `baselines/`, or the cassette constants moved) or
      `Cassettes: re-record — <what moved>`. Never leave it to absence: [docs/cassette.md](./docs/cassette.md#upgrading-cowork-harness)
      tells consumers to re-record when the changelog *reports* a tool-surface/spawn-env/prompt change, so
      a release that reports nothing reads as "unchanged" whether or not anyone checked — the same
      silence-is-not-a-verdict failure the 3.8.0 corpus preview exists to close. A consumer diffed two
      tags' `src/` by hand and still had to ask (2026-09-21) because the 3.7.0 notes said nothing either way.
- [ ] Bump every version location (items 1–10) with **`npm run bump -- X.Y.Z --write`** — it rewrites all
      of them via targeted patterns and updates the lockfile + self-checks `check:versions` (run without
      `--write` first to preview the diff; dry-run is the default). It deliberately does **not** touch the
      CHANGELOG — do the CHANGELOG move (above) by hand. (It also does not add a SKILL.md
      `- **X.Y.Z:**` release-note bullet, and you should NOT add one: that per-release section was removed
      in 1.10.0 because SKILL.md is loaded into an agent's context on every invocation and the history
      could never change its behaviour. The CHANGELOG is the release record.)
- [ ] `npm run preflight` — local pre-release gate (`check:versions`, CHANGELOG heading present + non-empty,
      tag `vX.Y.Z` not already used, clean tree; warns if the `ANTHROPIC_API_KEY` repo secret is missing so
      the push-to-main live suite will be skipped and this release won't be live-validated in CI; warns if a
      ruleset **required status check** names no job in `ci.yml`; fails if the newest baseline's
      `provenance.desktopInitSurface` is unobserved — start one Cowork session and re-run `sync`, or pass
      `--allow-unobserved-init-surface` for an emergency release).
- [ ] `npm run format:check` — fix any issues (`npm run format:write`).
      A format failure is the most common first-pass CI red.
- [ ] `npx tsc -p tsconfig.test.json --noEmit` — typecheck including tests.
- [ ] `npm run ci` (typecheck + build + test) is green locally.
- [ ] `npm pack --dry-run` — confirm the tarball contains `dist/`, `baselines/`, `docker/`, the companion
      skill (`SKILL.md`, `references/`, the bundled `scenario.py` + `assertion-keys.json`), and no internal
      planning notes. The skill ships on BOTH channels: npm carries it alongside everything else, while a
      marketplace install materializes only `.claude/skills/cowork-harness/**`. npm is the wider payload,
      not the one without the skill.
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
- [x] **Move the major/minor tags** — **AUTOMATED** by `release.yml`'s last step, which points `vX` and
      `vX.Y` at the release it just published. It skips a prerelease tag entirely, and never moves an alias
      backwards (re-releasing an older patch on a line moves `vX.Y` but leaves `vX` where it is). Left as a
      checklist item, it lapsed: `v1` sat at 1.24.0 through two releases. Note what these tags do NOT do:
      they select the ACTION, never the CLI. A consumer who leaves the `version:` input at its `latest`
      default already tracks CLI majors regardless of which alias they pin, so moving `vX` neither causes
      nor prevents a cross-major CLI upgrade for them. Manual fallback, if the step ever needs redoing:
      ```
      git tag -f vX vX.Y.Z && git tag -f vX.Y vX.Y.Z   # e.g. v1 and v1.0 → v1.2.3
      git push -f origin vX vX.Y
      ```
      (Force-moving these ALIAS tags is expected; never force-move the immutable `vX.Y.Z` release tag.
      As of 1.0.4 the alias tags do NOT trigger `release.yml` / `publish-image.yml` — their `on.push.tags`
      globs match full `vX.Y.Z` semver only — so pushing them produces no workflow runs at all.)
- [ ] **Smoke the published artifact — and use THIS invocation, not a bare `npx`:**
      ```
      # 1. version — from OUTSIDE the repo (see "cwd matters", below)
      (cd /tmp && npx -y --package=cowork-harness@X.Y.Z -- cowork-harness --version)   # must print X.Y.Z
      # 2. install the published artifact, then smoke it from the repo root
      npm i -g cowork-harness@X.Y.Z && cowork-harness --version                        # must print X.Y.Z
      cd <repo root>
      cowork-harness doctor --tier protocol
      cowork-harness replay examples/replays/example-pdf-skill.cassette.json
      ```
      **`--package=` is necessary but NOT sufficient — cwd matters too.** Observed releasing 3.2.0:
      run from the repo root, `npx -y --package=cowork-harness@3.2.0 -- cowork-harness --version` printed
      **3.1.0** (the stale Homebrew global); the identical command from `/tmp` printed 3.2.0. So inside
      the repo, npx still resolves the bin off PATH and the `--package=` pin buys you nothing — the same
      false smoke `--package=` was added to prevent, one release later. Hence the split above: take the
      `--version` reading from outside the repo, then `npm i -g` the published version so the binary on
      PATH *is* the artifact under test, and run the repo-root checks against that.
      **`npx cowork-harness@X.Y.Z …` is NOT good enough, and fails silently.** If a `cowork-harness` is
      already on PATH (a global `npm i -g`, Homebrew shim, …), npx runs THAT binary and ignores the
      `@X.Y.Z` spec entirely — no warning. Observed 2026-08-31 releasing 3.1.0: the smoke printed `3.0.1`
      for a correctly-published 3.1.0, and the release was ~30 seconds from being declared broken. Note
      `npx --ignore-existing` does **not** fix this: npm 11 removed that flag (`npx: the
      --ignore-existing argument has been removed`). `--package=` is what actually pins the fetch.
      **Run the replay from the repo root.** A cassette resolves its session file *relative to its own
      location* (`../sessions/default.yaml`), so a copy in `/tmp` exits 1 with "skill dirs not resolvable
      … cannot verify skill staleness" — a test-setup artifact that is indistinguishable at a glance from
      the 2.0.0 regression this gate exists to catch. (The harness is right to refuse: can't verify ⇒ not
      green.) The replay is the load-bearing check — `--version` only proves the tarball's `package.json`.
      Afterwards, keep your own global in step (`npm i -g cowork-harness@X.Y.Z`) or the next release's
      smoke reads stale again.
- [ ] **Promote to `latest`** — CI publishes to the **`next`** dist-tag, never `latest`
      (`release.yml`, "staged publish"). Until you run this, the release is installable only as
      `cowork-harness@next` or by exact version; a bare `npm i cowork-harness` and the Action's
      `version: latest` default still resolve to the PREVIOUS release. That is deliberate: it puts a
      human between a green CI run and every unpinned consumer.

      Smoke the staged artifact first (the step above), then:
      ```
      npm dist-tag add cowork-harness@X.Y.Z latest
      npm dist-tag ls cowork-harness          # MUST show latest: X.Y.Z — verify, don't assume
      ```
      **Run this in a real terminal, not a non-TTY shell.** It needs a 2FA challenge, and
      `npm/lib/utils/auth.js` re-throws `EOTP` outright unless both stdin and stdout are TTYs. On a
      passkey/WebAuthn account npm opens a browser ("Authenticate your account at…") and **no `--otp`
      flag is needed** — passing one forces the TOTP branch, which a passkey cannot satisfy.
      Concretely: an agent session's shell is not a TTY (Claude Code's `!` prefix included — `[ -t 0 ]`
      and `[ -t 1 ]` both fail there), so this step is the user's, at a real terminal window. The failure
      is `npm error code EOTP … requires a one-time password`, and npm's own advice to pass `--otp=<code>`
      is the wrong fix on a passkey account — it is npm's generic message, not a read of your 2FA mode.

      *Why this step exists:* 2.0.0 became the default install for every unpinned consumer the moment CI
      went green — a breaking hash-format epoch plus a flagship replay that exits 1 from an npm install —
      and `latest` had to be rolled back to 1.25.0 by hand (2026-08-22).

## Notes

- "Merge is not push." Local merges/commits never imply a release — the steps above are the only
  ones that make anything public; run them only on an explicit decision to release.
- Planning notes belong in a gitignored location excluded from the npm tarball; never commit or publish them.
- If the tag was placed on the wrong commit (e.g. a follow-up fix was needed), delete the local tag
  (`git tag -d vX.Y.Z`), re-create it on the correct commit, and push it.
- The live `scenario suite` CI job is skipped on **fork** PRs and, independently, whenever
  `ANTHROPIC_API_KEY` is unset. In both cases the check shows as **skipped**, never green. The
  `live-key` job logs `##[warning]ANTHROPIC_API_KEY not set — the live scenario suite is SKIPPED`,
  which is the authoritative evidence that the key was absent (`gh secret list` sees only repo-level
  Actions secrets, so absence there alone would not prove it). Until 2026-09 the job instead ran with
  every real step skipped and reported **success**; a green `scenario suite` check from before then is
  NOT evidence of live validation. `npm run preflight` raises its own `live-suite key reminder` WARN for
  the same reason.
  Re-read this bullet if a key is ever added; the `build` + `test` + `image-recipe` + `boundary` stages
  are what actually gate a release today.
