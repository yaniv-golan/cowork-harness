# Maintenance: parity across Claude Desktop releases

A core design goal is that keeping up with Claude Desktop is **cheap and visible**. Release-specific facts live in one JSON file per release (`baselines/desktop-<ver>.json`); the orchestration code rides the stable Agent SDK stream-json protocol.

## The seam

```
STABLE (in code, rarely changes)        VOLATILE (in baselines/, sync-regenerated per release)
  - stream-json control protocol          - agentVersion
  - scenario / session schemas            - network.allowDomains + network.mode
  - runtime selector, egress proxy        - gates
                                          - asarFingerprint (drift tripwire)

HAND-AUTHORED (in baselines/, drift-guarded — sync does NOT extract these)
  - mountLayout (mount modes)
  - bg-env-strip list
```

## Per-release runbook

When Claude Desktop updates (on a machine that has the app installed):

```bash
cowork-harness sync --diff      # show what moved vs the committed baseline
```

`sync` reads the live install (`claude-code-vm/.sdk-version`, `config.json`) and the `app.asar`, re-derives the volatile fields, and **merges them onto the latest committed baseline** so the stable structural fields carry over. Review the diff:

```
=== diff vs committed baseline ===
  capturedAt: "2026-06-10" -> "2026-06-25"
  appVersion: "1.11847.5" -> "1.12603.1"
  agentVersion: "2.1.170" -> "2.1.177"
  network: {...} -> {...}
```

(`capturedAt` is rewritten to today on every `sync`, so it always shows in the diff even when nothing
substantive moved — ignore it as noise.)

Then commit:

```bash
cowork-harness sync             # writes baselines/desktop-<new>.json
git add baselines/desktop-<new>.json
git commit -m "parity: sync to Desktop <new>"
cowork-harness run examples/scenarios/   # regression — drift now shows as test diffs (this repo's scenarios live under examples/)
```

If the agent version bumped, there is no image rebuild: the agent ELF is bind-mounted at runtime from the staged Desktop install (`resolveAgentBinary`, `src/baseline.ts`), not baked into the container image. A bumped `agentVersion` only updates `agentBinary.stagedPath` in the baseline (`src/cli.ts`); the container picks up the new binary from that path.

`sync` refuses to write a baseline in **two** cases: (a) an empty `allowDomains` allowlist — an empty egress allowlist is a safety tripwire (it would silently produce a baseline that permits nothing/everything rather than the real Desktop set); and (b) `⚠ unknown deltas` (see below). `--allow-empty` (alias `--force`) overrides **both** refusals and force-writes the baseline anyway — use it only when you understand the impact:

```bash
cowork-harness sync --allow-empty   # force-write past an empty allowlist or unknown deltas
```

**Hard-failure exit codes (for CI scripts):** `sync` exits **1** (not 2) on its hard failures — including (a) a missing required version field in the Desktop install it derives from, (b) a refused empty allowlist, and (c) a `⚠ unknown deltas` refusal. (b) and (c) are overridable with `--allow-empty`.

## Drift detection — two independent signals

1. **Extractor failures → `⚠ unknown deltas`.** When `sync` can't find what it expects in the asar — the
   domain regex matches nothing, the asar is missing, or extraction throws — it reports each as an unknown
   delta and the affected field is left empty/stale rather than silently wrong:

   ```
   ⚠ unknown deltas (extend src/sync/cowork-sync.ts):
      - egress.allowDomains: the domain regex in extractFromAsar() matched nothing — the asar layout
        moved, so the synced allowlist is EMPTY. Fix the regex (maintainer), or hand-edit
        network.allowDomains in the written baseline (bridge)
   ```

2. **`asarFingerprint` → a `--diff` tripwire (separate).** `sync` also records a fingerprint over the
   cowork-relevant code regions (`sliceCowork` tokens). It does **not** itself raise an unknown delta — a
   change just surfaces as a field diff under `sync --diff`, a hint to re-verify the extractor even when
   extraction still *succeeded* (the layout near a token shifted; the regex might be matching the wrong
   thing now).

### Maintainer fix
Extraction broke because Anthropic moved something the extractor parses. Update the relevant part of
`src/sync/cowork-sync.ts` (the domain regex / the `sliceCowork` tokens in `extractFromAsar`), re-run
`sync --diff` to confirm, then `sync` + commit the new `baselines/desktop-<ver>.json`.

### Between releases — you can resync yourself (you don't need to wait for the repo)
`sync` is **user-runnable**: it reads *your* installed Desktop, so you don't have to wait for a maintainer
to commit a baseline for a new Desktop version.

```bash
cowork-harness sync --diff   # preview what changed vs the committed baseline
cowork-harness sync          # write baselines/desktop-<newver>.json from your install
```

The new file becomes `latest` automatically, so `baseline: latest` scenarios pick it up immediately.
**If `sync` prints `⚠ unknown deltas`** it refuses to write and exits 1 — nothing is committed. To get a
working baseline before a maintainer extends the extractor, either pin the last-good baseline (below), or
force the partial write with `--allow-empty` and then bridge the missing field:
- add any now-missing hosts via `session.egress.extra_allow` (additive), **or**
- hand-edit the one wrong field in `baselines/desktop-<newver>.json` (plain JSON — e.g. copy
  `network.allowDomains` from the prior baseline), **or**
- pin the last-good baseline (`baseline: desktop-<oldver>`) + `COWORK_AGENT_BINARY=<new staged path>` to
  keep a verified allowlist with the new agent, **or**
- run the test at `protocol`/`container` fidelity where the exact allowlist doesn't decide the result.

Then please file the unknown delta upstream so the extractor catches up.

## Why CI can't sync for you

`sync` needs the installed desktop app + its `app.asar`, which isn't present on CI runners. So syncing is a
**local developer step** when Desktop updates. The `parity-drift` CI job is just a reminder; the committed
baselines are the source of truth CI builds against.

## Platforms

The sync extractor currently targets macOS paths (`~/Library/Application Support/Claude`, `/Applications/Claude.app`). Windows/Linux Desktop paths are `TODO` branches in `src/sync/cowork-sync.ts` — contributions welcome.

## Releasing (npm)

> **Scope:** this section is a short pointer, not the runbook. The full release procedure (version
> locations, the branch → PR → tag → publish flow, the checklist) lives in [RELEASING.md](../RELEASING.md).
> The notes here only cover how a *parity sync* relates to versioning.

Versioning follows [SemVer](https://semver.org/); pre-1.0 minor bumps may include breaking changes
(baseline-schema or CLI-contract changes count as breaking). A parity-baseline *content* update (a new
Desktop release) is **not** a package version bump on its own — it ships in a normal patch/minor.

Release flow — CD via `.github/workflows/release.yml`, published with **npm Trusted Publishing (OIDC)**
(no stored token):

```bash
# 1. land changes on main (CI green); add a new version heading to CHANGELOG.md
# 2. bump + tag (creates a vX.Y.Z tag matching package.json)
npm version patch        # or minor | major
# 3. push the commit + tag
git push --follow-tags
```

Pushing the `vX.Y.Z` tag triggers `release.yml`, which (in order) **waits for `ci.yml` to have succeeded
for that commit**, verifies the tag matches `package.json`, checks `CHANGELOG.md` has a `## [X.Y.Z]`
heading, runs the **version-lockstep guard** (`npm run check:versions`), runs `npm run ci`, then
`npm publish --provenance --access public`. Auth is **OIDC**: the workflow's `id-token: write` is exchanged
for a short-lived publish credential — there is **no `NPM_TOKEN`**. A GitHub Release is opened from the tag,
and `prepublishOnly` re-runs CI so a manual publish is guarded too. A published version is **immutable** —
the same `X.Y.Z` can never be re-published, so a botched run needs a new patch (not a re-run against the
same version).

The `ci.yml`-success gate matters because `release.yml`'s own `npm run ci` is **TypeScript-only**, while
`ci.yml` also runs pytest (the Python helper lane), `format:check`, the replay gate, and the boundary +
scenario suites. Without the gate, a tag could publish a build that `main`'s CI would have rejected. The
gate polls (~30 min) so `git push --follow-tags` works even when the commit's CI is still running.

**Version-lockstep guard (`scripts/check-versions.ts`, run in both `ci.yml` and `release.yml`).** Fails
loud unless all version strings agree: `package.json` == `package-lock.json`; the three skill versions
(`marketplace.json`, the skill `plugin.json`, `SKILL.md` frontmatter) == each other; the `SKILL.md`
bootstrap floor `@>=X.Y.Z` == its `tracks-harness:` version; and that floor is `<=` `package.json` (the
skill can't demand a harness newer than this repo publishes). This enforces the lockstep the next section
describes, so a hand-edited bump can't silently drift.

**One-time setup (on npmjs.com):** configure a Trusted Publisher on the `cowork-harness` package →
provider GitHub Actions, repo `yaniv-golan/cowork-harness`, workflow filename `release.yml`,
**environment blank**, allowed action **`npm publish`**. Recommended: *Publishing access → require 2FA and
disallow tokens* (OIDC keeps working and the long-lived-token surface is gone). The workflow upgrades npm
(`npm i -g npm@latest`) because OIDC publishing needs npm ≥ 11.5.1.

### The companion skill versions independently

The Claude Code skill under `.claude/skills/cowork-harness/` carries its **own** version, separate from the
npm package. When you change the skill, bump it in lockstep across **`SKILL.md`** (frontmatter `version:`
and `tracks-harness:`), **`.claude/skills/cowork-harness/.claude-plugin/plugin.json`**, and the entry in
**`.claude-plugin/marketplace.json`**, then run `claude plugin validate .`. The marketplace only delivers a
skill update to already-installed users when this `version` changes — an unbumped edit is invisible to them.

**Invariant — the skill must NOT lead the npm release.** The marketplace serves the skill from this repo's
default branch, so **pushing `main` makes the skill live** — independent of any npm tag. So if a skill
release documents features that are only in an unpublished npm version, a user who updates the skill gets
instructions for a CLI they can't install yet. Therefore: **when a skill bump documents new CLI features,
push it only WITH or AFTER the npm release that ships those features** (publish the `vX.Y.Z` tag first, then
push the skill commit — or push both together). The skill's `tracks-harness:` line names the harness version
it assumes; that version must be published before the skill goes public. A skill bump that only touches
skill-internal wording (no new CLI dependency) is exempt and can ship anytime.

**Bootstrap version floor — keep it in lockstep with `tracks-harness`.** The skill's Preflight bootstraps
the CLI with a version FLOOR (`npx cowork-harness@>=X.Y.Z`), not `@latest`. `@>=X.Y.Z` still resolves to the
newest published version, but **fails loud** if none satisfies the floor — so a too-old CLI (or a skill
accidentally pushed ahead of npm) surfaces as a clear "no matching version" instead of a silent "unknown
command." When a skill bump starts depending on new CLI features, bump this floor (in `SKILL.md` Preflight)
together with `tracks-harness:` so the two can't drift — both name the minimum harness version the skill
needs.

## Abuse & moderation runbook

The repo's standing protections live in GitHub settings and `.github/` (branch ruleset with
the owner as bypass actor, fork-PR workflow approval, SHA-pinned actions + Dependabot, secret
scanning + push protection). Those are always-on. The controls below are **break-glass** —
turn them on only while an abuse wave is active, then turn them back off so the repo stays
welcoming.

### Spam / drive-by issue & PR floods

Temporarily limit interactions to existing users (GitHub caps each call's duration — re-run to
extend):

```sh
# Limit to existing users for 7 days (one_day | three_days | one_week | one_month | six_months).
gh api -X PUT repos/yaniv-golan/cowork-harness/interaction-limits \
  -f limit=existing_users -f expiry=one_week
# Inspect / clear:
gh api repos/yaniv-golan/cowork-harness/interaction-limits
gh api -X DELETE repos/yaniv-golan/cowork-harness/interaction-limits
```

Other levers: `collaborators_only` (hardest), `contributors_only` (only past contributors).

### A malicious PR is opened

Fork PRs already require approval before any workflow runs (so untrusted code never touches
CI minutes or — guarded separately — secrets). Don't click **Approve and run** on a PR you
haven't read. Close + lock + report the PR; block the account if needed:

```sh
gh pr close <N> -R yaniv-golan/cowork-harness
gh api -X PUT repos/yaniv-golan/cowork-harness/issues/<N>/lock -f lock_reason=spam
gh api -X PUT user/blocks/<username>   # block the account
```

### A secret may have leaked

Push protection blocks known secret formats on push. If something slipped through: rotate the
credential first (the local `.env` OAuth token / `ANTHROPIC_API_KEY`), then purge history. The
GitHub **Secret scanning** alerts tab lists detections.
