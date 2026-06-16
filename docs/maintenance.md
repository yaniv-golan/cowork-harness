# Maintenance: parity across Claude Desktop releases

A core design goal is that keeping up with Claude Desktop is **cheap and visible**. Release-specific facts live in one JSON file per release (`baselines/desktop-<ver>.json`); the orchestration code rides the stable Agent SDK stream-json protocol.

## The seam

```
STABLE (in code, rarely changes)        VOLATILE (in baselines/, regenerated per release)
  - stream-json control protocol          - agentVersion
  - scenario / session schemas            - egress allowDomains + networkMode
  - runtime selector, egress proxy        - bg-env-strip list
                                          - mountLayout
                                          - asarFingerprint (drift tripwire)
```

## Per-release runbook

When Claude Desktop updates (on a machine that has the app installed):

```bash
cowork-harness sync --diff      # show what moved vs the committed baseline
```

`sync` reads the live install (`claude-code-vm/.sdk-version`, `config.json`) and the `app.asar`, re-derives the volatile fields, and **merges them onto the latest committed baseline** so the stable structural fields carry over. Review the diff:

```
=== diff vs committed baseline ===
  appVersion: "1.11847.5" -> "1.12603.1"
  network.allowDomains: [...] -> [... +newhost.anthropic.com]
```

Then commit:

```bash
cowork-harness sync             # writes baselines/desktop-<new>.json
git add baselines/desktop-<new>.json
git commit -m "parity: sync to Desktop <new>"
cowork-harness run examples/scenarios/   # regression — drift now shows as test diffs (this repo's scenarios live under examples/)
```

If the agent version bumped, the container image rebuilds against the new pin automatically (CI derives `AGENT_VERSION` from the baseline).

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
**If `sync` prints `⚠ unknown deltas`** the synced baseline is partial (e.g. an empty `allowDomains`) —
until a maintainer extends the extractor, bridge it temporarily:
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

Versioning follows [SemVer](https://semver.org/); pre-1.0 minor bumps may include breaking changes
(baseline-schema or CLI-contract changes count as breaking). A parity-baseline *content* update (a new
Desktop release) is **not** a package version bump on its own — it ships in a normal patch/minor.

Release flow (CD via `.github/workflows/release.yml`):

```bash
# 1. land changes on main (CI green); add a new version heading to CHANGELOG.md
# 2. bump + tag (creates a vX.Y.Z tag matching package.json)
npm version patch        # or minor | major
# 3. push the commit + tag
git push --follow-tags
```

Pushing the `vX.Y.Z` tag triggers `release.yml`, which verifies the tag matches `package.json`, runs
`npm run ci` (typecheck + tests + build), `npm publish --provenance --access public`, and opens a
GitHub Release. `prepublishOnly` re-runs CI so a manual `npm publish` is guarded too.

**One-time setup:** add an `NPM_TOKEN` repository secret (an npm automation token with publish rights);
the workflow already requests `id-token: write` for npm provenance.
