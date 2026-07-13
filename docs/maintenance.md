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

`sync` reads the live install (`claude-code-vm/.sdk-version`, `config.json`) and the `app.asar`, re-derives the volatile fields, and **merges them onto the latest committed baseline** so the stable structural fields carry over. Review the diff — this is an actual historical `sync --diff` output kept only to illustrate the format; a run today would diff against the repo's current latest baseline, not these two, which are now the oldest on record:

```
=== diff vs latest committed baseline (desktop-1.11847.5) ===
  $comment: "…Captured 2026-06-10…" -> "…Captured 2026-06-25…"
  capturedAt: "2026-06-10" -> "2026-06-25"
  appVersion: "1.11847.5" -> "1.12603.1"
  agentVersion: "2.1.170" -> "2.1.177"
  network: {...} -> {...}
```

(`capturedAt` is rewritten to today on every `sync`, and `$comment` embeds that same date, so both always
show in the diff even when nothing substantive moved — ignore them as noise.)

**`--diff` interactions worth knowing:**
- It is a pure preview: even when the sync would hit `⚠ unknown deltas` (below), `--diff` prints the deltas and exits **0** without writing anything — the hard exit-1 refusal only applies to a real (non-`--diff`) write.
- It does **not** bypass the empty-`allowDomains` refusal: an empty derived allowlist still hard-fails (exit 1) with `--diff` passed. You still need `--allow-empty` to force through that specific case (the empty-allowlist check runs before, and independently of, the diff/write branch).

Then commit:

```bash
cowork-harness sync             # writes baselines/desktop-<new>.json
git add baselines/desktop-<new>.json
git commit -m "parity: sync to Desktop <new>"
cowork-harness run examples/scenarios/   # regression — drift now shows as test diffs (this repo's scenarios live under examples/)
```

If the agent version bumped, there is no image rebuild: the agent ELF is bind-mounted at runtime from the staged Desktop install (`resolveAgentBinary`, `src/baseline.ts`), not baked into the container image. A bumped `agentVersion` only updates `agentBinary.stagedPath` in the baseline (`src/cli.ts`); the container picks up the new binary from that path.

### Agent-binary provenance (`sha256`)

`sync` records the Linux/arm64 ELF's SHA-256 in the baseline's `agentBinary`:

- `sha256` + `shaProvenance: "measured-local"` — hashed from the staged binary on the syncing machine (the trustworthy point-of-truth), plus `manifestChecksumMatch` (whether it equalled Anthropic's official per-version release checksum; `"unknown"` if the manifest was unreachable). `sync` stays offline-capable — a missing manifest never fails it.
- `sha256` + `shaProvenance: "official-manifest"` — for a version **not** staged on this machine (e.g. a back-filled older baseline), copied from Anthropic's release manifest. Staging-identity is **unverified**: it's the official release hash, not confirmed byte-identical to what Cowork stages for that version (byte-identity is confirmed only for versions actually measured).

There is deliberately **no `nativeSha256`**: the signed+notarized native `.app` inner Mach-O embeds an `LC_CODE_SIGNATURE` and never equals any manifest hash.

The resolved ELF is verified against the recorded `sha256` at run time **by default** (ELF only; opt out with `COWORK_HARNESS_VERIFY_AGENT_SHA=0`). A mismatch **hard-fails** only at the baseline's own staged path against a `measured-local` hash (the binary provably isn't what the baseline was synced against); it **advisory-warns** against an `official-manifest` hash (Desktop may repack what it stages) or when you deliberately supplied the binary via `COWORK_AGENT_BINARY` / the newest-sibling fallback (an intentional substitution is never hard-stopped). The check costs one hash per resolve (once per run) and no-ops when the baseline has no `sha256`.

Another runtime knob in the same family: `COWORK_HARNESS_RESOURCE_INTERVAL_MS` sets the resource-sampler's polling cadence in milliseconds (`resolveIntervalMs()` in `src/runtime/resource-sampler.ts`; default `1000`). A set-but-invalid value (non-integer or non-positive) warns and falls back to the default rather than silently sampling on the wrong cadence.

### Recovering an old agent version

Old staged binaries are re-downloadable from Anthropic's own release channel. For the **container/microvm** tiers the harness needs the **Linux/arm64 ELF**, so download it directly and point the resolver at it:

```bash
V=2.1.205   # your baseline's agentVersion (read it from baselines/desktop-<latest>.json)
curl -fSL "https://downloads.claude.ai/claude-code-releases/$V/linux-arm64/claude" -o "claude-$V"
# verify against the committed baseline sha256 (== manifest platforms["linux-arm64"].checksum):
shasum -a 256 "claude-$V"
COWORK_AGENT_BINARY="$PWD/claude-$V" cowork-harness run <scenario>.yaml   # scenario baseline pins $V
```

Note: `install.sh <version>` installs the **host CLI for the running platform** into `~/.local/bin` (clobbering an existing one) — it does **not** produce the Linux ELF the container tier bind-mounts, so recovering the ELF is the direct download above.

For the `hostloop` tier's separate **native macOS** binary (`claude-code/<ver>/claude.app/Contents/MacOS/claude`, distinct from the Linux ELF above), the equivalent override is `COWORK_HOST_AGENT_BINARY=<path>` (checked before `baseline.agentBinary.nativeStagedPath`; `resolveHostAgentBinary` in `src/baseline.ts`). Since the native binary carries no sha256 pin, a **same-major.minor PATCH** drift of the staged native binary is auto-tolerated by default now — no `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1` needed — with a loud stderr note naming the pinned and substituted versions; `doctor`'s native-binary check surfaces the same substitution as an `ok` status with a version-substitution note, sharing one classifier with the resolver. A **major/minor** drift still needs the env-gated fallback (or a hard throw without it).

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

   **Includes the Cowork system-prompt drift guard.** Alongside the asar-structure checks above, `sync`
   also fingerprints the Cowork system-prompt append itself (a minifier-independent content hash plus a
   `{{placeholder}}` / `<section>` inventory — `src/prompt.ts`'s `MODELED_PLACEHOLDER_NAMES` /
   `INTENTIONALLY_UNMODELED_PLACEHOLDERS`) and feeds two more cases into the same unknown-deltas list: a
   sha drift against the newest entry in `baselines/prompts/cowork-system-prompt-fingerprints.json`
   (confirm the *rendered*-prompt impact — a placeholder may be deployment-gated/stripped like
   `{{modelIdentity}}` — then add a new fingerprint entry), and any `{{placeholder}}` the renderer neither
   substitutes nor explicitly allowlists. This catches a class the coarse `asarFingerprint` below can
   miss, since a deployment-gated placeholder can leave the *rendered* prompt byte-identical while the
   prompt *source* still changed.

   **Includes the two-branch sub-agent append sentinel.** `checkSubagentPromptFacts` pins the
   `subagent_env_hl`/`subagent_env_vm` key pair, the `hostLoopMode` branch ternary, a normalized
   two-branch content fingerprint (`subagentAppendVersions` in
   `baselines/prompts/cowork-system-prompt-fingerprints.json`), the substitution-map keys **and values**
   (a host/VM cwd swap fails), the `resolveSection` gate shape, and the delivery-call argument list. On a
   *legitimate* sub-agent append text change the fingerprint drifts and `sync` refuses to write. To
   re-derive the two `sha16`s, after `npm run build` extract the new asar and feed the **per-file map**
   (not the joined bundle) through the exported helpers:

   ```bash
   TMP=$(mktemp -d) && npx --yes @electron/asar extract <path-to>/app.asar "$TMP" \
   && node -e "import('./dist/sync/cowork-sync.js').then(m => { const f = m.readMainBundleFiles('$TMP'); const s = m.extractSubagentBranchSlices(f); console.log({ hl: m.subagentBranchFingerprint(s.hl), vm: m.subagentBranchFingerprint(s.vm) }); })" \
   && rm -rf "$TMP"
   ```

   Update the paraphrase asset(s) if the branch *semantics* moved, append a new `subagentAppendVersions`
   entry (BOTH `hl` and `vm` are mandatory — a partial entry is itself a hard-fail), then re-run
   `cowork-harness sync`.

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
(no stored token). Follow the branch → PR → tag sequence in [RELEASING.md](../RELEASING.md) — do not
push a version bump + tag directly to `main`; the direct `npm version` + `git push --follow-tags` flow
below is superseded by RELEASING.md's branch+PR approach and is shown here only for the OIDC/CI-gate
mechanics, not as the sequence to actually run:

```bash
# (on the release branch, after the PR is merged to main)
npm version patch        # or minor | major — bumps + tags in one step
git push origin main --follow-tags
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
the CLI with a version FLOOR (`npx "cowork-harness@>=X.Y.Z"`), not `@latest`. `@>=X.Y.Z` still resolves to the
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
