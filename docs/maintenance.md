# Maintenance: parity across Claude Desktop releases

A core design goal is that keeping up with Claude Desktop is **cheap and visible**. Release-specific facts live in one JSON file per release (`baselines/desktop-<ver>.json`); the orchestration code rides the stable Agent SDK stream-json protocol.

## The seam

```
STABLE (in code, rarely changes)        VOLATILE (in baselines/, sync-regenerated per release)
  - stream-json control protocol          - agentVersion (+ agentBinary paths & sha256)
  - scenario / session schemas            - network.mode
  - runtime selector, egress proxy        - gates (provenance.gates)
                                          - asarFingerprint (drift tripwire)
                                          - spawn.env
                                          - spawn.effortByModel + spawn.effortRegexDefault

HAND-AUTHORED (in baselines/, drift-guarded — sync does NOT extract these; they carry
forward from the previous baseline untouched)
  - mountLayout (mount modes)
  - network.allowDomains (see "Why the egress allowlist is pinned" below)
  - bg-env-strip list
  - spawn.tools / spawn.allowedTools, the spawn scalars (configDirInGuest, settingSources,
    permissionMode, maxThinkingTokens, effortDefault), the prompt-asset pointers, and every $comment*
```

> **`mountLayout.mounts[].mode` is documentary, and older baselines carry a stale `projects` row.**
> Nothing reads that array at run time: `resolveMounts()` does not return it at all, and
> container/microvm/hostloop take only `cwd`, `sessionRoot` and `mntRoot` from the result — where
> `mntRoot` is DERIVED as `<sessionRoot>/mnt` (the only tree the stagers create) rather than read from
> `mountLayout.mntRoot`; a recorded value that disagrees is reported as a fidelity divergence at spawn.
> The one `mode === "r"` filter reads the launch plan's mounts, not the baseline's. The `projects` row reads `mode: "rw"` in every baseline before
> `desktop-1.25927.0`, which is **not uniformly wrong**: below `MOUNT_BARE_NAME_MIN_VERSION` (1.14271.0)
> `.projects/<name>` really was the connected-folder namespace, and folders are resolver-driven `rw`. From
> that boundary on, folders moved to `mnt/<basename>` and `.projects/<uuid>` became the project-attachment
> namespace, which Cowork mounts **read-only** — so the row is stale in the 18 baselines between the
> boundary and 1.25927.0. They are deliberately left as frozen per-release records: correcting them
> honestly means re-verifying each against its own asar, a blanket edit would put a wrong value into the
> three pre-boundary files, and nothing consumes the field either way. New baselines carry the corrected
> `r`, which `sync` merges forward.

The two generated `spawn` families are **all-or-nothing**: if `deriveSpawnEnv` or
`extractModelEffortConfig` hard-fails, `sync` preserves the previous baseline's values rather than writing
a partial map, and reports the failure as an unknown delta. That is why a green `sync` is meaningful — a
silently half-derived spawn contract is not a state it can produce.

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
cowork-harness run examples/scenarios/   # regression — drift shows as test diffs (this repo's scenarios live under examples/)
```

> **The live-asar tripwires are macOS-local ONLY — CI cannot run them, so a green CI is not evidence the
> baseline still matches the installed Desktop.** Every oracle that reads the real bundle gates on
> `process.platform !== "darwin"` (`test/baseline.test.ts`), and `ci.yml` has **no macOS runner** — all
> its jobs are `ubuntu-latest` / `ubuntu-24.04-arm`. So the golden spawn-env oracle, the
> `checkSpawnContractFacts` real-asar regression and every mutation case built on the live bundle
> **skip in CI, silently**. Measured on this release: Desktop 1.37937.0 added a construction site the
> resolver could not parse, and both `ci.yml` and `release.yml` would have gone green with that drift
> unfixed — only running `sync` on a Mac surfaced it.
>
> Practical consequence: **the per-release runbook above is the only thing that catches parity drift.**
> Do not defer it on the strength of a green pipeline. A committed-asar fixture tier (so the oracles have
> something to run against off-macOS), or at minimum a loud skip in the CI job summary rather than a
> `console.warn` nobody reads, is open work.

If the agent version bumped, there is no image rebuild: the agent ELF is bind-mounted at runtime from the staged Desktop install (`resolveAgentBinary`, `src/baseline.ts`), not baked into the container image. A bumped `agentVersion` only updates `agentBinary.stagedPath` in the baseline (`src/cli.ts`); the container picks up the new binary from that path.

### Agent-binary provenance (`sha256`)

`sync` records the Linux/arm64 ELF's SHA-256 in the baseline's `agentBinary`:

- `sha256` + `shaProvenance: "measured-local"` — hashed from the staged binary on the syncing machine (the trustworthy point-of-truth), plus `manifestChecksumMatch` (whether it equalled Anthropic's official per-version release checksum; `"unknown"` if that manifest was unreachable **or** not served). `sync` stays offline-capable — a missing manifest never fails it, and it now says *which* of the two happened: an HTTP status is a `WARNING` (the channel does not serve this version), a transport failure is a `NOTE` (your rig has no egress, which says nothing about the release).
- `releaseBaseUrl` — the release channel Desktop staged the agent **from**, read out of the asar at sync time. Usually `https://downloads.claude.ai/claude-code-releases`; for a **release candidate** it is `…/claude-code-releases/rc/<40-hex commit>`. Desktop stages RCs routinely (3 of the 24 builds observed so far), the stable path 404s for them, and the commit **cannot be discovered from the network** — `stable` and `latest` point at other versions, and there is no index — so the asar is the only source. This field is what makes the recovery command above work for an RC-staged version, and a stable↔RC flip shows up as a `sync --diff` line. Absent on baselines written before it existed; all of those were stable-staged or later promoted, which is what the command's fallback relies on.
- `sha256` + `shaProvenance: "official-manifest"` — for a version **not** staged on this machine (e.g. a back-filled older baseline), copied from Anthropic's release manifest. Staging-identity is **unverified**: it's the official release hash, not confirmed byte-identical to what Cowork stages for that version (byte-identity is confirmed only for versions actually measured).

There is deliberately **no `nativeSha256`**: the signed+notarized native `.app` inner Mach-O embeds an `LC_CODE_SIGNATURE` and never equals any manifest hash.

The resolved ELF is verified against the recorded `sha256` at run time **by default** (ELF only; opt out with `COWORK_HARNESS_VERIFY_AGENT_SHA=0`). A mismatch **hard-fails** only at the baseline's own staged path against a `measured-local` hash (the binary provably isn't what the baseline was synced against); it **advisory-warns** against an `official-manifest` hash (Desktop may repack what it stages) or when you deliberately supplied the binary via `COWORK_AGENT_BINARY` / the newest-sibling fallback (an intentional substitution is never hard-stopped). The check costs one hash per resolve (once per run) and no-ops when the baseline has no `sha256`.

Another runtime knob in the same family: `COWORK_HARNESS_RESOURCE_INTERVAL_MS` sets the resource-sampler's polling cadence in milliseconds (`resolveIntervalMs()` in `src/runtime/resource-sampler.ts`; default `1000`). A set-but-invalid value (non-integer or non-positive) warns and falls back to the default rather than silently sampling on the wrong cadence.

### Recovering an old agent version

Old staged binaries are re-downloadable from Anthropic's own release channel. For the **container/microvm** tiers the harness needs the **Linux/arm64 ELF**, so download it directly and point the resolver at it:

```bash
V=2.1.258   # your baseline's agentVersion (read it from baselines/desktop-<latest>.json)
# The release channel is NOT always the stable one — Desktop also stages release CANDIDATES, served only
# from .../claude-code-releases/rc/<commit>/, and the commit cannot be discovered from the network (the
# `stable` and `latest` pointers name other versions). Read it from the same baseline; every baseline
# written before `releaseBaseUrl` existed was stable-staged or later promoted, hence the fallback:
B=$(jq -r '.agentBinary.releaseBaseUrl // "https://downloads.claude.ai/claude-code-releases"' baselines/desktop-<latest>.json)
curl -fSL "$B/$V/linux-arm64/claude" -o "claude-$V"
# verify against the committed baseline sha256 (== manifest platforms["linux-arm64"].checksum):
shasum -a 256 "claude-$V"
COWORK_AGENT_BINARY="$PWD/claude-$V" cowork-harness run <scenario>.yaml   # scenario baseline pins $V
```

Note: `install.sh <version>` installs the **host CLI for the running platform** into `~/.local/bin` (clobbering an existing one) — it does **not** produce the Linux ELF the container tier bind-mounts, so recovering the ELF is the direct download above.

For the `hostloop` tier's separate **native macOS** binary (`claude-code/<ver>/claude.app/Contents/MacOS/claude`, distinct from the Linux ELF above), the equivalent override is `COWORK_HOST_AGENT_BINARY=<path>` (checked before `baseline.agentBinary.nativeStagedPath`; `resolveHostAgentBinary` in `src/baseline.ts`). Since the native binary carries no sha256 pin, a **same-major.minor PATCH** drift of the staged native binary is auto-tolerated by default now — no `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1` needed — with a loud stderr note naming the pinned and substituted versions; `doctor`'s native-binary check surfaces the same substitution as an `ok` status with a version-substitution note, sharing one classifier with the resolver. A **major/minor** drift still needs the env-gated fallback (or a hard throw without it).

At `hostloop`, the staged **Linux/arm64 ELF** gets the same patch tolerance: there it is bind-mounted into the bash sidecar only for parity and is not run by any harness-spawned process, so a same-major.minor patch-newer sibling is auto-accepted (loud stderr note, advisory sha) via `resolveAgentBinary(baseline, { parityMount: true })` — matching the native binary's policy above. `cowork` gets this same tolerance **only when the synced baseline gate resolves it to host-loop** (`decideLoopFromBaseline(baseline) === "host"`, mirroring `execute.ts`'s dispatch); `doctor --tier cowork` checks that resolution before deciding whether to ask for the tolerant or strict form, so it never reports the ELF `ok` when the real run would hard-fail. On a `cowork` baseline that resolves to **VM-loop**, the ELF is executed directly — same as `container`/`microvm`, which always keep the strict sha-pinned exact-version requirement described earlier in this section, because the ELF is the executed agent there. By the same resolved-loop logic, `doctor --tier cowork` requires the separate **native macOS** binary only when `cowork` resolves to host-loop (where it's the executed agent); a VM-loop-resolving `cowork` runs the ELF instead, so a missing native binary no longer blocks that rig (the mirror of the ELF case — doctor neither false-greens nor false-not-readies on either resolution).

`sync` refuses to write a baseline in **two** cases: (a) an empty `allowDomains` allowlist — an empty egress allowlist is a safety tripwire (it would silently produce a baseline that permits nothing/everything rather than the real Desktop set). Since `allowDomains` is **pinned** (carried forward from the newest committed baseline, never re-derived), empty here means that baseline was missing, unparseable, or carried no allowlist; and (b) `⚠ unknown deltas` (see below). `--allow-empty` (alias `--force`) overrides **both** refusals and force-writes the baseline anyway — use it only when you understand the impact:

```bash
cowork-harness sync --allow-empty   # force-write past an empty allowlist or unknown deltas
```

**Hard-failure exit codes (for CI scripts):** `sync` exits **1** (not 2) on its hard failures — including (a) a missing required version field in the Desktop install it derives from, (b) a refused empty allowlist, and (c) a `⚠ unknown deltas` refusal. (b) and (c) are overridable with `--allow-empty`.

## Why the egress allowlist is pinned

`network.allowDomains` is **hand-curated and carried forward** by `sync`, not derived from the asar.
It is not an oversight — on the first-party deployment this harness models, the VM egress allowlist
is **not in the app bundle at all**. Binary-verified:

```js
// first-party deployment class
vmEgressPolicy(){ return null }

// the resolver every session goes through
async resolveVmAllowedDomains(e, n) {
  let r = <deploymentMode>().vmEgressPolicy(),
      i = r ? <toDomains>(r) : e;      // 1p: policy is null -> fall through to `e`
  return <appendOtlpHost>(i, n);
}
```

`e` is the session's **server-delivered** `egressAllowedDomains`. The only host the bundle itself
contributes is the OTLP endpoint, appended by the augmenter. So there is nothing authoritative to
extract, and any bundle scan is unsound in both directions: it cannot see a server-delivered host,
and it sweeps in hosts that are not egress.

That second failure mode is not hypothetical. An earlier `sync` derived the allowlist by regexing
every `*.anthropic.com` / `*.claude.ai` literal out of the whole bundle. When Desktop added a webview
first-party-origin classifier (a navigation-trust tier naming `www.claude.ai` and `staging.claude.ai`),
those two hosts were swept into the allowlist. `network.allowDomains` is consumed as the **enforced**
allowlist (`boundaryAllowList`, and the session's egress plan), so the harness would have permitted
egress that Cowork denies — a false-green in exactly the direction the harness exists to prevent.

**What keeps the pin honest:** `checkEgressContractFacts` (`src/sync/cowork-sync.ts`) fails **closed**
on the three constructions that justify pinning — the 1p `null` policy, the resolver's fall-through to
its caller-supplied argument, and the OTLP-only augmentation. If any of them moves, `sync` reports an
unknown delta and refuses to write, which is the signal to re-derive how Cowork computes egress before
trusting the list again. Editing the list is a deliberate, reviewed act: change it in the newest
committed baseline and say why in that baseline's `$comment`.

## Drift detection — two independent signals

1. **Extractor failures → `⚠ unknown deltas`.** When `sync` can't find what it expects in the asar — a
   pinned anchor moves, the asar is missing, or extraction throws — it reports each as an unknown
   delta and the affected field is left empty/stale rather than silently wrong:

   ```
   ⚠ unknown deltas (extend src/sync/cowork-sync.ts):
      - egress: the 1p `vmEgressPolicy(){return null}` branch is gone — first-party egress may no
        longer be server-delivered. network.allowDomains is a PINNED, hand-curated list that is only
        sound while this holds; re-verify how Cowork computes the VM allowlist
        (see checkEgressContractFacts).
   ```

   **Includes the Cowork system-prompt drift guard.** Alongside the asar-structure checks above, `sync`
   also fingerprints the Cowork system-prompt append itself (a content hash over the template body with
   escapes DECODED — minifier-name-independent AND codegen-escape-independent, which the earlier raw-source
   hash was not — plus a
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

   > **Then REPOINT the baseline at the new asset** — `spawn.subagentAppendHostLoop` (and/or
   > `spawn.subagentAppend`) in the freshly written `baselines/desktop-<new>.json`. These pointers are
   > hand-authored, so `sync` carries the PREVIOUS release's value forward untouched; writing the
   > fingerprint entry clears the sentinel whether or not you repoint. Skip this and a host-loop
   > sub-agent silently receives the previous release's paraphrase, with `sync` green. This is the step
   > that was missed on 1.32885.1 and caught by eye.

   **Includes the prompt-patch channel sentinel.** `checkSyspromptMapFacts` pins Desktop's
   `coworkSyspromptMap` — a channel that can *replace* the computed Cowork prompt section for a named
   variant, and which the harness does not model — a disclosed gap, distinct from the paraphrased-append
   one, in
   [docs/fidelity-gaps.md](./fidelity-gaps.md#server-driven-system-prompt-patches-coworksyspromptmap).
   It pins the channel's presence (its **absence** is itself
   a finding: either the channel went away or the extractor stopped seeing it — neither may pass quietly),
   the mode vocabulary as a **closed set** (`replace`/`append` — a third mode would change what a served
   variant can do to the prompt, so this is the highest-value anchor here), the
   `<name>(.replace|.append)?` key grammar, the startup throw requiring `{{promptCacheBoundary}}` in a
   replace-mode variant, and the `hit`/`invalid_entry`/`missing_boundary` resolution statuses. Mind the
   scope split, because it is the reason the sentinel exists at all: the startup throw guards the
   **built-in** variants table only. A **server-supplied** entry is validated later, on the resolution
   path, which **degrades instead of throwing** — a boundary-less `replace` resolves to
   `missing_boundary`, the session gets a different prompt, and nothing errors anywhere. The anchors pin
   the loud half so the quiet half cannot move unobserved.

   **Includes the mount-mode sentinel.** `checkMountModeFacts` pins five facts about
   `mountLayout.mounts[].mode`: the delete-deny resolver (`…?"rwd":"rw"`, which is what makes `outputs`
   and each connected folder `rw`, or `rwd` once approved), plus four mounts whose mode is **hardcoded**
   `"ro"` at the mount-set builder rather than resolved — `uploads`, `.claude/skills`, `.claude/projects`,
   and the per-uuid project attachment `.projects/<uuid>`. Each is pinned individually because a mount
   silently moving from `ro` to a writable mode is a containment change the harness would otherwise model
   wrongly with nothing failing. Two notes worth carrying: the `.projects/<uuid>` anchor is the fact that
   settles why a project mount is **not** in the delete-denied set (it is not writable at all, so there is
   nothing to deny); and the builder runs on two lanes — VM-loop once at spawn, host-loop as
   `computeBashMounts`, recomputed **per bash call** with a live approved-list read. The hardcoded modes
   are identical either way, which is why one set of anchors covers both, but "spawn-time" is the wrong
   mental model for half of it.

2. **`asarFingerprint` → a `--diff` tripwire (separate).** `sync` also records a fingerprint over the
   cowork-relevant code regions (`sliceCowork` tokens). It does **not** itself raise an unknown delta — a
   change just surfaces as a field diff under `sync --diff`, a hint to re-verify the extractor even when
   extraction still *succeeded* (the layout near a token shifted; the regex might be matching the wrong
   thing now).

   **`provenance.fcache` → the same kind of tripwire, for the gate snapshot.** Gate states come from the
   feature cache, not the asar, so they move on their own schedule. A baseline records
   `{ content16, embeddedTimestamp, featureCount }` for the payload it read. **`content16` is the
   identity; `embeddedTimestamp` is metadata and must never be used as one.** The payload refetches
   irregularly (measured intervals of 3.7–20.8 min across five fetches), so a whole-file hash tracks the
   *fetch* — gzip framing and the timestamp field — and reports drift on every refetch even when nothing
   changed. `content16` hashes the canonicalised `features` object instead, so it moves only when the
   content does; verified across four reads, where the content hash held while the file hash moved every
   time. `featureCount` alone is not sufficient either: membership churns **count-neutrally** (one gate
   observed going absent → force while another went present → absent, count pinned at 241 both times).
   **`provenance.asarGateIds` → which gate ids the release's own bundle references.** The fcache fields
   above cannot name a membership change: `featureCount` moves by a net, `content16` says "membership
   and/or values", and neither survives the fact that the payload is server-refreshed *between* two
   baselines (the 1.32885.1 and 1.34493.1 samples are 2.35 days apart, so their count delta is a net over
   hundreds of refetches rather than a fact about the Desktop release). This field is instead a pure
   function of the shipped asar — reproducible by anyone, stable across refetches, attributable to the
   release — so diffing two baselines' lists names the ids outright (measured 1.32885.1 → 1.34493.1:
   **+14 / -1**). It is deliberately NOT intersected with the local fcache: gate membership varies by
   account segment, so filtering through this machine would both leak which gates this operator is served
   and drop DARK gates (51 of the recorded ids are absent from the live fcache, `enableToolSearchAuto`
   among them). To go from an id to a name, grep the id as a quoted literal in the extracted bundle — the
   call site names it (`BS(\`17519066\`)` sits in `isCoworkBrowserEnabled`); that literal-occurrence route
   is how `PINNED_GATES` was built, and it resolves 157 of the 278 live ids. Some numeric noise survives
   the filter by design: a constant is invisible in the delta, which is what the field is read for.

   `sync --diff` renders these as distinct lines — content changed, refetched-only, feature count moved —
   and separately reports a gate that starts or stops **serving** a key, which matters because an unserved
   key silently falls back to a code default that need not match production.

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

## Publishing an agent-image revision

The agent image is published by this repo's `publish-image.yml`, not by Anthropic. It carries two tag
shapes with different promises:

| Tag | Promise | Moved by |
|---|---|---|
| `:2` | floating — a **curated** pointer, moved deliberately so it can agree with the recorded pin | a manual run with `immutable_only` **unchecked**. Explicitly *not* a release tag push |
| `:2-r<N>` | **immutable** — never repointed once published | a manual run, once per `revision` bump |
| `:2-<version>` | legacy co-tag, keyed to the harness version that shipped it | release tag pushes |

`:2-r<N>` is the one a harness pin can depend on, which is why the publish workflow refuses to overwrite
an existing one and fails **closed** if it cannot enumerate the tags to check.

To publish a new revision:

1. Bump `revision` in `docker/agent-image.json` in the **same commit** as the `Dockerfile.agent` change,
   and merge it. The revision lives in that file, never in a workflow input, so the tag that gets
   published and the digest a harness pins can never be keyed to different numbers.
2. Run the workflow from `main` with `immutable_only` **checked** (the default). This publishes
   `:2-r<N>` for both variants and leaves `:2` exactly where it is — so no existing consumer's next pull
   changes.
3. Read the `PINNABLE …= sha256:…` line from each build step's log and write those digests into
   `variants["<local ref>"].digest` in `docker/agent-image.json`.
4. Move `:2` only when you intend consumers to get the new image — and, once a harness pin exists, in
   the same release that ships the updated pin, so the tag, the revision, and the pin agree.

To rehearse without publishing, dispatch with `dry_run` checked: it runs the CI gate and the collision
guard and then stops before building or pushing anything. That is how the guard's **refusal** path gets
exercised — dispatch a revision that already exists and confirm the run fails — without risking the one
thing a digest pin cannot survive, a repointed `:2-r<N>`.

`workflow_dispatch` resolves the workflow file from the **default branch**, so a change to
`publish-image.yml` must be on `main` before it can be dispatched.

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

Versioning follows [SemVer](https://semver.org/); as of 1.0.0 a backwards-incompatible change to a
covered surface (baseline-schema or CLI-contract changes count) is a major bump. A parity-baseline *content* update (a new
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
the CLI with a version FLOOR (`npx "cowork-harness@^X.Y.Z"`), not `@latest`. `@^X.Y.Z` resolves to the newest
published version **within the same major**, and **fails loud** if none satisfies the floor — so a too-old CLI (or a skill
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

## Parity between releases (moved from README)

This is the part built for longevity. The fragile, release-specific facts live in **one JSON baseline**; the orchestration code rides the stable stream-json protocol.

When a new Claude Desktop ships:

```bash
cowork-harness sync --diff
```

`cowork-harness sync` reads your **live install** and the **app.asar** and re-derives the baseline:

| Baseline field | Source (auto-detected) |
|---|---|
| `agentVersion` | `~/Library/Application Support/Claude/claude-code-vm/.sdk-version` |
| env-strip list | `app.asar` main bundle (BG env-strip — env vars the background-agent spawn scrubs before launch) |
| `mountLayout` | `app.asar` (`{uuid,name,mountPath,hostPath}` model) |
| `egress.allowDomains` | `app.asar` `vmAllowedDomains()` + `firewallAlso` + `config.json:coworkEgressAllowedHosts` |
| `networkMode` | `config.json:coworkNetworkMode`, asar `vm_network_mode` |
| `requireFullVmSandbox` | `config.json:lastSeenRequireCoworkFullVmSandbox` |

The diff shows exactly what moved (agent bump, allowlist change, new mount). You review, commit the new `baselines/desktop-<ver>.json`, and the container pin updates automatically from the baseline. Parity drift then surfaces as **test diffs**, not silent rot.

> The sync script is the maintenance contract. If an Anthropic release changes something the sync script doesn't yet read, `sync --diff` flags an `unknown delta` from the asar fingerprint so you know to extend it — rather than parity quietly degrading.

---

