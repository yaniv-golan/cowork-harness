# Cassette guide

A **cassette** is the recorded control-protocol stream from a live run, saved as a single JSON file.
`replay` plays it back deterministically — no token, no model, no Docker — and re-evaluates the content
assertions. Record once in CI (or locally); replay on every PR for free.

**Minimal loop** — record once (live), then replay for free:

```bash
cowork-harness record scenarios/my-test.yaml          # live: writes cassettes/my-test.cassette.json
cowork-harness replay  cassettes/my-test.cassette.json # token-free re-evaluation of content assertions
```

> Without `--out`, this writes to `cassettes/<scenario-name>.cassette.json` — gitignored by default. See
> [Recording prerequisites](#recording-prerequisites) below for how to commit a cassette instead.

**In CI, run both commands — `replay` alone gates only `unverifiable-skill`, not the drift classes.** A recording describes the skill as
it was on the day you paid for it; once the skill moves, a bare `replay` prints
`::warning:: cassette stale` and — since 2.0.0 — **exits non-zero** when staleness could not be VERIFIED (`unverifiable-skill`); the drift classes still only warn. `verify-cassettes` exits **3** on the same tree — could-not-verify, distinct from the exit **1** it uses for a verified failure. The
split is deliberate — `replay` answers *"do the assertions still hold"*, `verify-cassettes` answers *"is
this recording still current"* — but running only the first means a skill edit silently stops being
tested:

```bash
cowork-harness verify-cassettes cassettes/   # privacy + staleness — FAILS on a stale recording
cowork-harness replay            cassettes/  # token-free content/structure
```

That is the order the [CI recipe](../.claude/skills/cowork-harness/references/ci-recipe.md) ships. If you
would rather have one command do both, `replay --fail-on-skill-drift` folds the staleness gate in
(`--strict` also fails on baseline drift). Two caveats worth knowing either way: a cassette recorded
before fingerprints existed has nothing to check and passes silently, and a `COWORK_HARNESS_GITSET` /
`COWORK_HARNESS_AGENT_SCOPE` mismatch between record and CI downgrades real drift to a non-failing
`format` finding.

Recording follows whatever `fidelity:` the scenario declares — a `protocol`-fidelity scenario records with
**no Docker at all** (still needs a token; see [`examples/scenarios/protocol-smoke.yaml`](../examples/scenarios/protocol-smoke.yaml)). The walkthrough below assumes `container` fidelity, the common case.

## Mental model

```
record  (needs token + Docker at container fidelity)
  ↓  saves events.jsonl  +  control-out.jsonl  →  *.cassette.json
replay  (no token, no Docker, no network)
  ↓  re-runs the orchestration from the recording
  ↓  re-evaluates content assertions
  ↓  re-exercises serializeDecision (O7 guard)
```

The cassette is NOT a test in isolation — it replays what the agent did in a past live run.
Use a live `run` for filesystem/egress assertions; use `replay` for the token-free PR gate.

**What a green replay proves — and what it does not.** Replay re-evaluates your assertions against the
recording. **Nothing is executed**: not the model, and not any script your skill bundles. A `Bash` call and
its result are frozen text, and `artifact_json` / `file_exists` read the `outputs/` snapshot `record` took —
so a skill whose real work happens in `scripts/produce.py` can have that script rewritten, or broken, and
replay stays green on the old output. What replay does gate is everything downstream of the model: your
scenario still loads, your scripted answers still match the gates that fired, your assertions still hold,
and the verdict still computes the same way — which is what catches a CLI upgrade or a regression in the
harness itself. For "does my script still produce the right numbers", test the script directly (see the
[pytest lane](../python/README.md)); for "does the agent still behave this way", re-record or run live.
Editing a bundled script *does* change the skill hash and stale every cassette recorded against it — that
tripwire is what keeps the gap above from going unnoticed. Note which command enforces it: `verify-cassettes`
hard-fails on staleness, while `replay` warns on the content-drift classes — so a CI job that runs `replay` alone will not catch a
skill that moved. Run both; the drift note in the "Filesystem assertions" section below has the detail.

**The cassette freezes the WHOLE SCENARIO, not just your assertions.** `name`, `prompt`, `session`,
`baseline`, `fidelity`, `execution`, `lane`, `timeout_ms`, `answers`, `on_unanswered`, `expect_denied`,
`assert`, `skills`, `requires_capabilities` and `allow_host_writes` — every field the schema defines — are
all captured at record time, and a plain `replay` evaluates every one of them from that
frozen copy — nothing in the working tree can change its verdict. Editing `scenarios/<name>.yaml` does not
change a replay; the sibling is read only to print `::notice::` lines when it has drifted, or when it
fails to load. **Only `assert:` (+`expect_denied:`) can be opted back to disk** — a changed `lane:`/`fidelity:`/
`baseline:` reaches a replay only by re-recording. To iterate on assertions token-free, opt in with
`replay --assert-from <scenario.yaml>` (or
`--reassert`): it re-checks against the on-disk `assert:`, but **hard-fails** if any recording-shaping field
(`prompt`/`answers`/`baseline`/`fidelity`/`skills`/`requires_capabilities`) or the skill content drifted from the recording (then you must
re-record). `expect_denied`/filesystem/egress keys are sourced but stay live-only. See
[docs/scenario.md](./scenario.md#what-replay-evaluates--the-whole-scenario-frozen).

**Unknown *top-level* scenario keys are handled differently by the two paths.** The **loader**
(`run`/`skill`/`record`, reading scenario YAML) rejects one outright: exit 2 for a single file, or exit 1
for a directory, which reports each `✗ broken:` file. **`replay` does not.** A cassette's frozen scenario
is read as a passthrough object, so a top-level key the running CLI does not know is carried in the file
but never consulted — replay behaves exactly as if it were absent. Where that key conditions assertions
(as `lane:` does), the result is not merely quiet: **a stale CLI can report green on a cassette the
current CLI fails.** Since `replay` is the token-free CI gate, pin the floor in CI.

*Frozen **assertions** are not loose:* an assertion key this CLI does not recognise, in a cassette recorded
at this version or older, is a hard reject (exit 2) rather than a silent drop.

A cassette recorded by **≥ 1.16.0** whose scenario carries `lane: remote` is stamped v11, which `replay`
and `verify-cassettes` on an older CLI **refuse** — loudly. A cassette recorded by **1.14.0 or 1.15.0**
carrying `lane: remote` is stamped v10 and is still silently misread by a pre-`lane` CLI; run `rehash` to
re-stamp it — see [Cassette versioning](#cassette-versioning) below. **And `replay
--best-effort-future-cassette` overrides the refusal** — on that path an older CLI replays the v11
cassette and the silent misread returns, so do not reach for that flag to work around a version refusal on
a cassette you did not record.

A validated re-check does **not** reach a plain `replay` (which reads the frozen block) until it is written
back. Add **`--write`** to `--reassert` to persist the re-validated block into the cassette — free, no re-record —
when **only** the `assert:`/`expect_denied:` block changed; `events`/`controlOut` stay byte-identical. It refuses
any key that would silently skip on this cassette (needs an artifact manifest, pre-run hashes, or `controlOut`)
and, without `--allow-failing`, a failing verdict — so `--write` can't bake in a green a plain `replay` won't
reproduce. See [docs/scenario.md](./scenario.md#how-an-assertion-edit-reaches-ci) for the full propagation chain.

> Known limitation: if a redaction policy ran at record time, a frozen `assert:` literal (e.g. a
> `transcript_contains` matching a secret pattern) is stored redacted while the on-disk block is plaintext, so
> the default-path "assert differs" notice can fire spuriously. It's a notice only — it never changes a verdict.
> The same overlap bounds `--reassert --write`: if the redaction policy matches content in a **shaping** field
> (`prompt`/`answers`), the frozen copy is stored redacted while the on-disk file is plaintext, so `--reassert`
> hard-fails as recording-shaping drift **before** `--write` runs — re-record is then the only path.

## File shape

```jsonc
{
  "generator": "cowork-harness",          // provenance: the tool that produced this file
  "cassetteVersion": 12,                  // the MINIMUM format a reader needs for this cassette (see Cassette versioning below) — floored at the hash-format epoch, so cassettes stamp 12. ABSENT reads as 0 and, like anything below the v9 read floor, is refused at load time with a re-record error; a FUTURE version hard-fails unless --best-effort-future-cassette
  "scenarioSource": "scenarios/my-test.yaml", // the authored scenario SOURCE file this was recorded from, relative to the cassette dir (absent for an inline/in-memory scenario)
  "scenario": { /* Scenario object — same schema as the .yaml */ },
  "events": [ /* JSON lines from events.jsonl (child→driver stdout) */ ],
  "controlOut": [ /* JSON lines from control-out.jsonl (driver→child control_responses) */ ],
  "effectiveFidelity": "container",       // the tier the live record actually resolved to (e.g. a `fidelity: cowork` scenario resolving to hostloop/container)
  "userVisibleRoots": ["outputs", "myproject"], // visible roots = outputs + each connected folder's mount name (its basename; `.projects` is the pre-1.14271.0 legacy fallback)
  "preRunPaths": ["outputs/existing.json"], // pre-run path baseline for `no_unexpected_files` (workRoot-relative)
  "preRunHashes": { "outputs/existing.json": "…", "myproject/readonly-in.xlsx": null }, // pre-run per-path sha256 baseline for `input_unmodified`; `null` = body secret-scrubbed (evidence-unavailable, never a false "modified")
  "preRunOrigin": "local-walk", // provenance of the pre-run baseline (local-walk / remote-unavailable / local-unreadable); `local-unreadable` makes no_unexpected_files/input_unmodified fail evidence-unavailable on replay instead of diffing an incomplete baseline
  "artifacts": [                         // snapshot of outputs/ + connected folders (optional)
    { "path": "outputs/x.json", "bytes": 24, "sha256": "…", "body": "{…}" }, // body inlined ≤ 64 KiB
    { "path": "outputs/big.bin", "bytes": 9e6, "sha256": "…", "truncated": true, "truncationReason": "size" }, // oversized → hash-only (raise --max-artifact-bytes)
    { "path": "carta-folder/input.xlsx", "bytes": 4096, "sha256": "…", "truncated": true, "truncationReason": "readonly" }, // mode:r connected-folder INPUT → body-less (see below), regardless of size
    { "path": "uploads/report.pdf", "bytes": 51200, "sha256": "…", "truncated": true, "truncationReason": "input" }, // uploaded file under an inputRoots root → body-less, hash-only (see below), regardless of size
    { "path": "outputs/link-to-elsewhere", "bytes": 0, "sha256": "", "linkKind": "symlink" } // v10: symlink/hardlink — path+kind only, never dereferenced, so a link stray is still visible to no_unexpected_files
  ],
  "fingerprint": { "baseline": "1.15962.1", "skillHash": "…", "mode": "git", "contentSig": "…", "fileSigs": [["skills/x/SKILL.md", "…"]], "skillSources": ["…"], "promptAssetsHash": "…" }, // staleness tripwire (v5: fileSigs only; v6: mode + git default; v7: NUL-delimited hash entries; v8: folds fixed-length content shas + type-prefixed/NUL-framed entries; promptAssetsHash: sha16 over the baseline's committed prompt-asset files, keyed independently of `baseline` (appVersion) — see the prompt-assets staleness class below)
  "sessionFingerprint": "…", // v9+: hash of the session's content-relevant SHAPE (folders/plugins/skills/mcp/egress/web_fetch, plus projects and agent_env when set) — verify-cassettes-only, never the default replay verdict
  "folderPrefixMap": [{ "from": "/Users/me/myproject", "mount": "myproject" }], // v9+: record-time connected-folder host-path → mount-name map; computer_links_resolve uses THIS on replay
  "timeline": [ /* … */ ], // harness-observation timeline (see src/agent/timeline.ts): seq/ts/line/type per meaningful in-run event, in total order; `ts` is wall-clock-observation-time, frozen not recomputed on replay — informational only, no verdict impact. ABSENT on a pre-timeline cassette or when timeline.jsonl was empty/unreadable at record time
  "timelineHeader": { "startedAtMono": "…", "startedAtWall": "…" }, // written once as timeline.jsonl's first line; `startedAtMono` is the raw `process.hrtime.bigint()` start value (as a string) that every `timeline[].ts` is milliseconds-elapsed-since; `startedAtWall` is the wall-clock anchor so absolute times are recoverable from the relative `ts` stream
  "authoring": { "nonDeterministic": true, "channel": "decider-dir" } // present ONLY when a live decider answered ≥1 gate (see §Answering gates during recording); re-record may drift, replay is still deterministic. `channel` is optional: it is absent when `--on-unanswered first` answered the gate rather than a decider channel, so the stamp serializes as just `{ nonDeterministic: true }`
}
```

`controlOut` is optional (old cassettes pre-dating full-fidelity replay lack it). When present it
enables full-fidelity replay (see §Full-fidelity replay below). When absent, replay falls back to
events-only mode with a loud warning.

`artifacts` and `fingerprint` are also optional — both engage only when present, so old
cassettes replay unchanged.

### Cassette versioning

`cassetteVersion` is **the minimum format version a reader needs to interpret this cassette** — not which
recorder wrote it, and not a flat build counter. That covers how its digests are computed as well as its
`scenario` keys: a reader older than the cassette's hash format recomputes `skillHash`/`contentSig` under a
different algorithm and reports drift that is not there, so the stamp floors at the **hash-format epoch**
(v12). Above that floor it is *value-aware*: `record` reads a field's actual VALUE rather than its
presence, so `lane: "local"`/omitted lifts nothing (a pre-`lane` reader already gives exactly the
local-delivery semantics it asks for) while `lane: "remote"` would. The epoch floor dominates that
differential today, so cassettes stamp **v12**. A stamped version newer than a given build understands is refused loudly by both `replay` and
`verify-cassettes`. **`replay` alone offers an opt-in override, `--best-effort-future-cassette`;
`verify-cassettes` does not accept that flag** — a verification gate has no "read it anyway" path, and its
refusal says to upgrade instead. See [Unknown
keys](./scenario.md#unknown-keys-the-loader-is-strict-lint-is-lenient) for what that refusal does and does
not cover.

`rehash <dir/>` migrates a cassette to the version it requires, without a re-record — the recovery path
for both a scenario-key bump and a **hash-format** difference.

**How the migration is proved.** A cassette is only rewritten when its content can be shown to be
unchanged: `rehash` recomputes the digest under the **original** algorithm and compares it to what was
recorded. Comparing a new-algorithm digest against an old record would be an algorithm mismatch, not a
content check. `contentSig` is deliberately **not** the proof: it is algorithm-dependent, so comparing it across a format
difference is the same mistake in a different field. `mode` (git/raw) and agent-scope must match too, since both change which files are hashed.

Only the algorithm-derived values are then replaced. Everything else is carried through from the
recording — including `promptAssetsHash` and `labelProvenance`, which the recompute cannot produce — and
`fileSigs` keeps its recorded (redacted) paths, taking only new digests position by position.

**A drifted baseline does NOT stop the migration.** `fingerprint.baseline` is the recorded Cowork app
version — metadata, never an input to `skillHash` — so it says nothing about whether the content is
unchanged. `rehash` migrates the hashes, keeps the recorded baseline, and notes the drift on the row.
(This matters after `sync`, or for any cassette older than the current `baselines/`, which is otherwise
every file you own.)

**Clearing a drifted baseline: re-record, or re-stamp.** `replay` only warns on a `baseline` finding and
still exits 0, but `verify-cassettes` treats any staleness as not-green, so a drifted baseline reds the CI
gate until you do one of two things:

- **Re-record**, which is always correct and always costs a paid run.
- **Re-stamp** `fingerprint.baseline` to the new version by hand — one line per cassette, no run. This is
  a sanctioned path with precedent (`9eaba8d` re-stamped the committed example cassettes across a baseline
  bump), and it is what you want when a baseline moved without changing anything the recording depends on.

  **It is an assertion, not a check.** Re-stamping says "the platform moved, and nothing this recording
  exercises moved with it" — the tool cannot verify that for you. Re-stamp only when the baseline delta
  leaves the spawn contract, the emulated system prompt, the egress policy and the tool surface alone; if
  any of those changed, the recording was made against different behaviour and only a re-record is honest.
  `promptAssetsHash` is the one piece of record-time evidence here, and `rehash` does not recompute it, so
  a re-stamp does not and cannot confirm it.

**It refuses rather than guessing.** `rehash` **errors** on a content mismatch, on unreadable sources, on
a mode or agent-scope change, on `fileSigs` it cannot align entry-for-entry, and on a hand-authored digest
it cannot recompute. Anything it refuses needs a real re-record.

```bash
cowork-harness rehash cassettes/                              # a directory
cowork-harness rehash one.cassette.json --session s.yaml      # a MOVED cassette
```

**`--session` is for a cassette that moved.** A cassette stores `session:` relative to its own directory,
so a `git mv`, a repo reorg or a copy into another project leaves its skill sources unresolvable — and
therefore unprovable. `--session` says where the tree went. One cassette at a time: each may have been
recorded against a different source, so a directory batch cannot share a single override.

### Recording provenance (`environment`)

`environment` records where and by what a cassette was made: `location` (always `local`), `tier` (the
resolved effective fidelity), `agentBinaryFormat`, and **`harnessVersion`** — the cowork-harness CLI that
recorded it. `harnessVersion` exists because a harness-code change can shift recorded behaviour at an
*unchanged* baseline (1.10.0's new declared tool surface did), which no staleness class detects. It is
**absent** on cassettes recorded before 1.11.0, and that absence is meaningful — it is never backfilled.

`verify-cassettes` and `replay` additionally emit a non-gating `[note]` when a cassette's recorded
`system/init` inventory predates the skills/plugins discovery servers *and* its tier declares them today.
That check reads the recorded inventory rather than the version, so it works on cassettes made long before
the field existed. It stays silent at `microvm`/`protocol` (re-recording there would never produce those
tools) and when the init event carries no tool list.

## Recording prerequisites

`record` runs a live scenario first, then saves the two output files as a cassette:

```bash
cowork-harness record examples/scenarios/example-pdf-skill.yaml \
  --out cassettes/example-pdf-skill.cassette.json
```

This requires the same setup as `run` at container fidelity:
- A staged agent binary (Claude Desktop opened once).
- Docker (arm64) + the agent image (`cowork-agent-base:2`).
- A valid auth token (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`).

The generated cassette bundles the scenario, the event stream, and the decision responses. Secrets
(the injected OAuth token / API key) are scrubbed from the recorded `controlOut` by value at record
time — safe to commit for synthetic fixtures (see §Committed fixture below).

Without `--out`, the cassette is named after the scenario's `name:` (or the YAML filename) and written
under `cassettes/`, which is **gitignored** — this repo's own committed examples live at
`examples/replays/` instead. Pass `--out examples/replays/<name>.cassette.json` (or your own tracked
path) if the cassette should be committed.

### Where a cassette lives, and why it can't move afterwards

**Choose the path before you record.** A cassette stores its references — `scenario.session` and
`scenarioSource` — **relative to its own directory**, computed at record time. That keeps a committed
fixture free of absolute host paths, and it means the file is *not* relocatable: move it to another
directory and those paths stop resolving, so `verify-cassettes` cannot recompute the skill hash and
reports

```
[unverifiable] skill dirs not resolvable from the cassette location — cannot verify skill staleness (can't verify ⇒ not green)
```

which is exit `3` (and, since 2.0.0, a non-zero bare `replay`). This applies to any move — a `git mv` during a repo reorganisation, a copy into
another project, or recording to one `--out` and committing to a different path — not just to the
hostloop case below.

> **2.0.0 — `unverifiable-skill` fails a bare `replay`.** "Could not be checked at all" and "checked and
> unchanged" are different claims, and only the second is green. Before 2.0.0 a bare `replay` warned on
> stderr, recorded the class in `staleness[]`, and still exited `0` — so a cassette that had silently
> stopped proving anything kept passing the lane most people run. The change is deliberately narrow: the
> content-drift classes (`skill`, `shared-root`) still require `--fail-on-skill-drift`, so that flag keeps
> its meaning and there is no inverse escape hatch to add. The remedy is `--session <file>` below, or a
> re-record.

**The escape hatch is `--session <file>`**, on both `replay` and `verify-cassettes`:

```
cowork-harness replay        moved/x.cassette.json --session path/to/session.yaml
cowork-harness verify-cassettes moved/x.cassette.json --session path/to/session.yaml
```

It resolves the skill sources from that session instead of the recorded cassette-relative path, so a
moved cassette verifies without being re-recorded.

**If the cassette also predates the hash-format epoch, migrate it first.** Relocation and the epoch are
independent problems, and `--session` only solves the first: a pre-v12 cassette still reports
`unverifiable-skill` because its digests are not comparable, whatever tree you point it at. Run
`cowork-harness rehash <file.cassette.json> --session <session.yaml>` — that migrates *and* resolves in
one step — then verify.

Points worth knowing:

- It takes a **session**, not skill directories, because `staleness.hash_ignore` is a session-level
  field that is *not* stored in the cassette — an override carrying only directories would silently
  change the hash boundary and report drift that isn't there.
- A session's mounts are relative to **its own** directory, so copying or symlinking a session next to
  the moved cassette does *not* work: it will report that the session declares dirs none of which exist.
  Point at the session where it actually lives.
- One cassette at a time. A directory target is refused, because each cassette in it may have been
  recorded against a different source.
- The resolved session **and the dirs it produced** are echoed on stderr. An override that silently
  pinned the wrong tree would manufacture false greens, so it is deliberately never silent.
- An explicit override is trusted: a hash or session-shape mismatch under `--session` is reported as
  real drift, not downgraded.
- Unrelated to `boundary-check --session`, which folds a session's egress additions into the allowlist
  the probes test against — same spelling, different job.

> **Known limitation — multi-root hashing is order-dependent.** `skillHash` folds each mounted root's
> files in **absolute-path sort order**, while deliberately excluding a root's own *name* from the digest.
> A single root is therefore fully location-independent, but with two or more the excluded name re-enters
> through the sort: the same two trees under differently-sorting directory names hash differently. The
> failure direction there is **false drift** — a loud, wrong "skill files changed". A second, sharper axis:
> the roots fold into ONE digest with **no root-boundary marker**, so moving a file **between** roots is
> invisible when the concatenation order survives — that one IS a false green. Multi-root cassettes are
> not refused (none exists in any reachable corpus, and refusing would break input nobody has), but a
> bare `replay` emits a note when a cassette records two or more roots. A related consequence: two mounts can contribute the same
> root-relative path (`skills/x/SKILL.md`), and since the per-file manifest is keyed by path, drift
> ATTRIBUTION for those paths is ambiguous — replay says so explicitly rather than naming a file it cannot
> identify. Fixing either properly means folding a stable per-root identity into the digest, which changes
> every multi-root cassette's hash and so needs a hash-format epoch. Pinned by tests in
> `test/skill-hash.test.ts` so the eventual fix is a deliberate change rather than a surprise.

> **Why the skill hash is what breaks.** The chain is one hop: the cassette resolves its relative
> `scenario.session` against its own directory, and the skill dirs come from **that session file**.
> `fingerprint.skillSources` is stored relative to the *session-file* directory and is diagnostics-only
> — nothing resolves against it, so it is not the thing that breaks. Miss the session file and there are
> no dirs to hash, which is exactly the `unverifiable-skill` finding above.


(The session-shape check degrades more gently: it falls back to a name lookup and downgrades a
mismatch to a non-failing note, precisely because a relocated cassette can't be trusted to match by
path. The skill-hash check has no such fallback.)

On that default path, `record` refuses to overwrite an existing cassette that belongs to a **different**
scenario name (their names slugify to the same default path — a silent-clobber guard, not a general
"don't overwrite" check; a routine same-scenario re-record is unaffected). `--force` narrowly opts out of
just that refusal; pass `--out <file>` instead if you want to disambiguate rather than overwrite.

## Answering gates during recording

By default `record` answers gates from the scenario's scripted `answers:` and falls to `on_unanswered`
(default `fail`) for anything unmatched — so an unanticipated gate aborts the record. Instead of a
separate discovery run to learn the gates, then encoding answers, then recording, you can answer them
**live during the recording**:

- `--decider-dir <dir>` — a driving agent answers in-band (pair with `gates`/`answer`). Single scenario
  only (not a `dir/` batch).
- `--decider-llm [--intent "<one line>"]` — a model answers the gates.
- `--decider-model <model>` — pins which model answers the gates; requires `--decider-llm`.
- `--on-unanswered first` — auto-pick option 1 for any unmatched gate.

> `record` takes a different decider subset than `run` and `skill` do — notably it has no `--decider-cmd`.
> See [decider-dir.md → Decider flags by command](./decider-dir.md#decider-flags-by-command-run-vs-record-vs-skill).

These are rejected together with `--rerecord-stale` (it re-records committed cassettes at the default
policy). When a gate is actually answered by a live decider (or `--on-unanswered first`), the cassette
gains an `authoring: { nonDeterministic: true, channel }` stamp and `record` warns that **re-recording
may drift** — but the cassette itself **replays deterministically**, because the chosen answers are
frozen into it. A `--decider-dir` that goes unused (your scripted `answers:` covered every gate) leaves
the cassette unstamped. (Note: `--allow-failing` only relaxes the post-run *verdict* gate — it does not
salvage an unanswered gate.)

## Artifact scrubbing at record time

Artifact bodies go through a multi-pass scrub before being written into the cassette. The scrub is
applied via `scrubField()` — a function in `src/secrets.ts` that is also exported for custom use (see
§scrubField utility below).

### What scrubField catches

A naive byte-by-byte scan misses secrets that appear **inside a longer base64 blob**. Consider an
Authorization header value `Bearer <TOKEN>` stored as a base64-encoded field. The bytes of `TOKEN`
alone don't form a valid base64 boundary inside `base64("Bearer " + TOKEN)` — so `base64(TOKEN)`
doesn't appear in the encoded value, and a simple "look for base64(TOKEN)" pass silently misses it.

`scrubField` addresses this with three passes:

1. **Direct scrub** — literal token, `base64(TOKEN)`, `encodeURIComponent(TOKEN)`, and other
   surface-level variants. Handled by the underlying `scrub()` call.
2. **Whole-field base64 decode** — if the entire field value is ≥ 20 characters and matches
   `/^[A-Za-z0-9+/=]+$/`, decode the whole blob and run `scrub()` on the decoded form. If a secret
   hit is found in the decoded content: replace the **entire field value** with `"[REDACTED:base64]"`.
3. **Whole-field URI decode** — if the field value contains `%`, URI-decode the whole value and run
   `scrub()` on the decoded form. If a secret hit is found: replace the entire field value with
   `"[REDACTED:uri]"`.

This catches the `base64(prefix + TOKEN + suffix)` class — where surrounding bytes shift the alphabet
so `base64(TOKEN)` alone does not appear in the encoded blob.

### How base64 artifact bodies are handled

When `record` processes a base64-encoded artifact (i.e. `artifact.encoding === "base64"`):

1. `scrubField()` is applied to the body.
2. If a secret hit is found anywhere in the decoded content, the **entire body** is replaced with the
   marker string `"[REDACTED:base64]"`.
3. The `encoding` field is cleared (set to `undefined`), so replay treats the marker as plain UTF-8
   text rather than trying to base64-decode the marker.
4. The `sha256` field is recomputed over the marker bytes.
5. A CI warning fires:

   ```
   ::warning:: artifact <path>: body contained a secret and was replaced with [REDACTED:base64]; artifact_json/artifact_text assertions on this artifact will fail at replay (user_visible_artifact/file_exists still PASS — they check location, not content)
   ```

The warning is intentional, and its scope is exact: the assertions that **read the body** —
`artifact_json` (parses it) and `artifact_text` (matches it) — **will fail at replay**, because the body
no longer matches its record-time content. That is the correct outcome; a compromised artifact should not
green a replay.

**`user_visible_artifact` and `file_exists` still PASS.** They check *location and existence*, never
content, and the marker is written to disk with a recomputed `sha256`. So a green visibility assertion on
a scrubbed artifact proves a file is there — **not** that the scrubbed content survived. Assert
`artifact_json`/`artifact_text` if you need the content checked.

For UTF-8 artifacts, `scrubField()` is applied in the same way (it is safe on plain text; text passes
through unless the entire value is a base64 blob).

### The [REDACTED*] marker guard in redactCassette

`redactCassette()` runs the opt-in PII redaction pass over the whole cassette after scrubbing. To
prevent double-processing, any artifact body that already starts with `"[REDACTED"` is skipped by
`redactCassette()`. This guards the sha256 from being corrupted by a second rewrite of the marker
string: the PII redactor sees the marker and leaves it alone, so the recomputed sha256 remains
consistent with the actual stored body.

### scrubField utility

`scrubField` and `collectSecrets` are published as the package's only programmatic export — the supported
subpath `cowork-harness/secrets` (everything else under `dist/` is private). Use it to apply the same
redaction outside the cassette pipeline:

```ts
import { scrubField, collectSecrets } from "cowork-harness/secrets";

// collectSecrets() reads the known auth-token env vars (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, …)
// plus COWORK_HARNESS_SCRUB_KEYS / _VALUES, and PRE-EXPANDS each secret into its base64 / URI /
// "Bearer …" variants — which is what lets scrubField catch a secret embedded in an encoded field.
const safe = scrubField(rawValue, collectSecrets());
```

`scrubField(value, secrets)` takes the raw field value and an array of secret strings to redact, and
returns: the original string if no hit is found; a `"[REDACTED:base64]"` / `"[REDACTED:uri]"` marker if the
whole-field decode pass triggered; or a scrubbed string from the direct pass.

> **Pass `collectSecrets()`, not a bare `[token]`.** The direct pass only matches occurrences literally
> present in your array — a bare `[ANTHROPIC_API_KEY]` catches the raw token and a whole-field base64 blob,
> but **not** a secret embedded inside a larger encoded field (`base64(prefix + TOKEN)`). That coverage comes
> from the variants `collectSecrets()` adds. If you supply your own list, pre-expand the encodings yourself.

## Assertion table

This table mirrors the union of `ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS`/`MANIFEST_KEYS` in
`src/run/cassette.ts`, which is **the single source of truth**.
Content keys are evaluated on replay; everything else is skipped. This is the per-key reference; for
the rules and CI-placement rationale (why each category behaves this way), see
[docs/scenario.md → Which assertions survive replay](./scenario.md#which-assertions-survive-replay-ci-placement).

### Evaluated on replay (ALWAYS_CONTENT_KEYS ∪ QUESTION_GATE_KEYS ∪ MANIFEST_KEYS)

| Assertion key | What it checks |
|---|---|
| `transcript_contains` | literal substring in assistant transcript |
| `transcript_not_contains` | literal absent from transcript |
| `transcript_matches` | case-insensitive regex matches transcript |
| `transcript_not_matches` | regex does not match |
| `tool_called` | agent invoked the named tool |
| `tool_not_called` | agent never invoked it |
| `tool_result_contains` | literal substring in a tool result |
| `tool_result_not_contains` | literal absent from all tool results |
| `tool_result_matches` | case-insensitive regex matches a tool result — the regex sibling of `tool_result_contains`, for an error-signature family rather than one literal string |
| `tool_result_not_matches` | regex does not match any tool result — the regex sibling of `tool_result_not_contains` |
| `subagent_tool_used` | a sub-agent used the tool |
| `subagent_tool_absent` | no sub-agent used the tool |
| `no_vm_path_file_op` | **`fidelity: hostloop` only** — no gated file tool attempted a `/sessions`(-prefixed) path (`RunResult.fileToolAttempts`) — content-class, re-derived from the frozen `tool_use` stream; any other tier FAILS "cannot verify" (`/sessions/...` is valid there) |
| `subagent_file_write` | a sub-agent-origin write attempt (`path` exact or `path_suffix`) has a paired non-error tool_result (`RunResult.fileToolAttempts` + `RunResult.toolResults`) — content-class, tier-agnostic |
| `subagent_dispatch_healthy` | **`fidelity: hostloop` only** — composite: ties ONE selected dispatch's own delivered write (`delivered`, default true) and path-cleanliness (`no_vm_paths`, default true) to it via `parentToolUseId` — the per-dispatch correlation `subagent_file_write` (which matches ANY sub-agent write) lacks; content-class (`RunResult.fileToolAttempts` + `RunResult.toolResults`) |
| `subagent_dispatched` | a sub-agent matching the regex was dispatched |
| `subagent_declared_but_unused` | sub-agent declared the tool but never used **that** tool (even if it used others) |
| `subagent_output_contains` | a dispatched sub-agent's own output contains the substring — `match` (optional regex over `agentType`/`description`) narrows to specific dispatch(es); omitted, checks whether ANY dispatch's output contains it |
| `dispatch_count_max` | at most N sub-agents dispatched |
| `skill_triggered` | a skill matching the regex was invoked via the `Skill` tool — evidence-unavailable (not a normal fail) when the agent's init tool list has no `Skill` tool |
| `no_skill_triggered` | no invoked skill id matched the regex — evidence-unavailable (never a vacuous pass) when skill-invocation data or the `Skill` tool itself is unobservable |
| `skill_available` | a staged skill's id matched the regex (offered, not necessarily invoked — see `skill_triggered`) — content-class: the id list comes from the agent's init `skills` listing, so it replays from the frozen init event (id-only; the `whenToUse` enrichment is live-disk and thus absent on replay, but the id is what's matched); evidence-unavailable only when `RunResult.context.availableSkills` is absent entirely (an older cassette recorded before the available-skills listing was captured) |
| `connector_available` | an MCP server/connector's name matched the regex (available, not necessarily used) — evidence-unavailable when `RunResult.context.mcpServers` is absent |
| `tool_available` | a tool in the init manifest matched the regex (available, not necessarily called — see `tool_called`) — evidence-unavailable when `RunResult.context.tools` is absent. The `mcp__skills__*`/`mcp__plugins__*` discovery tools are modeled (as `alwaysLoad`) on `container`/`hostloop`/`cowork`; `microvm`/`protocol` still declare no such server, so a miss there is "not modeled at this tier", not "provably unavailable" |
| `skill_tool_used` | a tool matching `tool` ran inside a skill-activation window whose `skillId` matches `skill` — evidence-unavailable when `RunResult.skillActivity` is absent; heuristic for inline skills (a sticky, sequential window, not an exact per-tool boundary) |
| `max_cost_usd` | run's SDK-reported cost ≤ N USD — on replay this asserts the *frozen recording's* cost, not fresh spend |
| `max_tokens` | `usage.input_tokens + usage.output_tokens` ≤ N (cache tokens excluded) — same frozen-recording caveat as `max_cost_usd` |
| `tool_calls_max` | total top-level tool calls (sub-agent tools excluded) ≤ N — meaningfully replay-checkable; the re-drive recomputes `toolCounts` deterministically |
| `tool_no_error` | no tool matching this regex recorded any error — REQUIRES ≥1 matching tool call (fails if the regex matched nothing) |
| `tool_no_error_if_called` | like `tool_no_error` but passes vacuously when no tool matches (presence-free variant) |
| `max_tool_errors` | total tool errors across all tools ≤ N |
| `max_redundant_tool_calls` | total WASTED repeated tool calls (sum of (count-1) across every redundant `{name,args}` group in `RunResult.redundantToolCalls`) ≤ N — not the raw count of redundant groups |
| `max_turns` | SDK-reported (or fallback-counted) turn count ≤ N — replay-checkable, recounted deterministically same as `tool_calls_max` |
| `compaction_occurred` | a `compact_boundary` system event was recorded — lives in the stdout stream, so the re-drive reproduces it; evidence-unavailable when `RunResult.contextEvents` is absent |
| `all_tasks_completed` | every task in `RunResult.tasks[]` reached status `"completed"` — REQUIRES ≥1 task (a zero-task run FAILS; assert `task_count_min` for presence); evidence-unavailable when `tasks` telemetry is absent |
| `task_count_min` | at least N tasks were created (`RunResult.tasks.length >= N`) — presence companion for task assertions; evidence-unavailable when `tasks` telemetry is absent |
| `task_status` | a task whose `subject` OR `id` matches the `match` regex reached the given `status` — evidence-unavailable when `tasks` telemetry is absent |
| `question_asked` | agent asked an AskUserQuestion matching the regex |
| `question_options` | the option set + order that gate offered the user |
| `questions_count_max` | at most N **sub-questions** asked — a bundled `AskUserQuestion` with K sub-questions counts as K, not 1; `trace --view questions`'s footer total uses the same definition |
| `gate_answers_delivered: true` | answered gates' answers reached the model — **zero gates fired passes vacuously** (gate firing is model-dependent); pair with `gate_answer_count_min: >= 1` to also require a gate, or drop it and declare `questions_count_max: 0` in a gate-clean scenario |
| `gate_answers_delivered: false` | the inverse — asserts a *confirmed* delivery failure (at least one gate whose `delivered === false`); an unobserved (`null`) delivery satisfies neither `true` nor `false` |
| `gate_answer_count_min` | at least N AskUserQuestion gates fired AND were delivered non-error — the presence companion to `gate_answers_delivered`'s vacuous-pass. **`: 0` asserts nothing**; `>= 1` is mutually exclusive with `questions_count_max: 0` |
| `hook_blocked` | a PreToolUse hook blocked a tool whose name matches the regex (`RunResult.hookEvents`) — replay: needs `controlOut` (a custom hook's decision lives only there) |
| `no_hook_blocked` | no tool was hook-blocked during the run — replay: needs `controlOut`. **Only `true` is valid** |
| `vm_path_denied` | **`fidelity: hostloop` only** — a path denial (`RunResult.pathDenials`, any source) targeted a `/sessions` VM path — replay: needs `controlOut`; any other tier FAILS "cannot verify" |
| `path_denied` | **`fidelity: hostloop` only** — a path denial matched all given matchers (`tool`/`path_matches`/`source`/`agent_scope`) — replay: needs `controlOut`; any other tier FAILS "cannot verify" |
| `no_path_denied` | **`fidelity: hostloop` only** — no path denial was recorded at all — replay: needs `controlOut`. **Only `true` is valid**; any other tier FAILS "cannot verify" |
| `result` | run ended with `success` or `error` |
| `no_scratchpad_leak` | every file presented via `present_files` that was in the scratchpad was successfully promoted to `mnt/outputs` (none left behind) — vacuous pass if nothing was presented; content-class: both the tool_use and its own tool_result live in the ordinary events stream, so `RunResult.presentedFiles` re-derives identically on replay; evidence-unavailable only when `presentedFiles` is absent (an older run predating the feature); **container tier only** — `present_files` *is* served on hostloop, but that branch passes a validated path through without promoting, so there is no scratch→outputs copy to leak; `microvm`/`protocol` do not serve the tool at all |
| `present_files_called` | at least one file was delivered via `present_files` (`RunResult.presentedFiles` is non-empty) — the presence companion to `no_scratchpad_leak`; content-class (re-derives identically on replay); **container + hostloop tiers** |
| `allow_permissive_auto_allow` | verdict modifier — kept on replay → no-op pass (the live signal it suppresses is zeroed) |
| `allow_missing_capability` | verdict modifier — kept on replay → no-op pass (the live signal it suppresses is zeroed) |
| `allow_l0_plugin_divergence` | verdict modifier — kept on replay → no-op pass (the live signal it suppresses is zeroed) |
| `allow_stall` | verdict modifier — kept on replay → no-op pass (suppresses the `stalled` default-fail; the stall is re-derived on the replay re-drive) |
| `allow_outputs_delete` | verdict modifier — kept on replay → no-op pass (the live outputs-delete scan it waives is zeroed on replay) |
| `allow_delete_in` | verdict modifier — kept on replay → no-op pass (the live per-mount delete scan it waives is zeroed on replay, same as its outputs-scoped sibling) |
| `allow_undelivered_deliverables` | verdict modifier — kept on replay → no-op pass (suppresses the `undelivered_deliverables` WARN; a replay runs no scratchpad walk of its own, so the signal is evidence-unavailable there regardless) |

**`question_asked`, `question_options`, `questions_count_max`, `gate_answers_delivered`, `gate_answer_count_min`, `hook_blocked`,
`no_hook_blocked`, `vm_path_denied`, `path_denied`, `no_path_denied` require `controlOut`** (full-fidelity
replay). On an old cassette without `controlOut` these keys are excluded from evaluation — not vacuously
passed — and a loud warning fires (see §Backward compatibility). The hook and path-denial keys need
`controlOut` for a different reason than the question keys: a custom hook's block/allow decision (and the
`can_use_tool` source of a path denial) is an opaque async reply recorded only in `control-out.jsonl`, not in
the `events` stream — reconstructing from the stream alone would show only the built-in Task hook's view and
could vacuously pass `no_hook_blocked`/`no_path_denied` even if a custom hook or gated ask genuinely blocked.

`file_exists`, `artifact_text`, `user_visible_artifact`, `artifact_json`, `computer_links_resolve`, `computer_links_resolve_if_present`,
`no_unexpected_files`, and `input_unmodified` are **not** in the table above — see the next subsection; they're replay-checkable only
when the cassette carries an artifacts manifest (`no_unexpected_files` also requires `preRunPaths`,
recorded since 0.24 on every live sandbox tier including microvm; `input_unmodified` requires `preRunHashes`,
the per-path sha256 baseline recorded alongside it).

### Filesystem assertions — replay-checkable WITH an artifact manifest

`file_exists`, `user_visible_artifact`, `artifact_json`, `computer_links_resolve`, `no_unexpected_files`, and
`input_unmodified` run on replay **when the cassette carries an `artifacts` manifest** — `record` snapshots
`outputs/` + connected folders and `replay` materializes that snapshot to evaluate them token-free.
`no_unexpected_files` additionally requires `preRunPaths` (the pre-run path baseline, optional cassette
metadata since 0.24 — no version bump); without it the key is **excluded with a loud warning**, not a
vacuous pass (live/verify-run without a pre-run manifest hard-fails evidence-unavailable instead —
deliberate asymmetry). `input_unmodified` — the in-place mutation detector: every pre-existing file whose
workRoot-relative path matches a glob (accepts either a single glob string or an array of globs) keeps an
unchanged content hash after the run — requires `preRunHashes` (the pre-run per-path sha256 baseline);
without it the key is likewise **excluded with a loud warning**. On replay it compares against the
AUTHORITATIVE post-run hash recorded in the `artifacts[]` manifest (`sha256`), never a re-hash of the
materialized tree — a body-less (hash-only) entry materializes as a 0-byte placeholder, so re-hashing it
would falsely report a change. The pre-run baseline also walks `uploads` (alongside `outputs` and any
connected folders), so an uploaded file is a valid `input_unmodified` target even though `uploads` stays
**out** of `no_unexpected_files` (that key's baseline is the user-visible tree only — an upload is an
input, not a place a stray output would land). `artifact_json` needs the JSON `body`
inlined (small files); a hash-only (`truncated`) entry still satisfies `file_exists` but not `artifact_json`.
The inline cap is 64 KiB; raise it with `record --max-artifact-bytes <n>` (or
`COWORK_HARNESS_MAX_ARTIFACT_BYTES`) so a large structured deliverable stays replay-checkable, and `record`
fails fast if an `artifact_json` targets an artifact it had to truncate (that would pass at record but fail
at replay). `computer_links_resolve` resolves every `computer://` link in the transcript against the same
manifest, with host-shaped links normalized via the recorded session folders. Without a manifest (older
cassettes), these are skipped.

**Read-only (`mode: r`) connected-folder contents are captured body-less.** A folder mounted `mode: r` in
`session:` holds pre-existing INPUTS the agent only reads, not deliverables — so `record` snapshots them
the same way it snapshots an over-cap file: path + `bytes` + `sha256`, `truncated: true`, **no `body`**,
regardless of size. The entry still lands in `artifacts[]` (unlike a fully-excluded path) so
`materializeManifest` writes a 0-byte placeholder at replay and `computer_links_resolve`/`file_exists`
resolve identically live and on replay; only `artifact_json` (which needs the inlined body) can't target
one. Two side benefits: no cassette bloat from a large input file, and no `binary` privacy finding (the
scanner only flags a *committed* binary body) — so a `mode: r` input never needs `--allow`. A `mode: rw`/`rwd`
folder's contents are captured with a full body exactly as `outputs/` is.

**Uploaded files are captured body-less the same way**, tagged `truncationReason: "input"` rather than
`"readonly"`. `record` snapshots every path under each root in `inputRoots` (default `["uploads"]`) —
path + `bytes` + `sha256`, `truncated: true`, no `body` — regardless of size, so an uploaded fixture never
bloats the cassette or trips the `binary` privacy finding. `truncationReason` is therefore one of four
values: `"size"` (over the inline cap), `"readonly"` (a `mode: r` connected-folder input), `"unreadable"`
(the file existed but couldn't be read), or `"input"` (an `inputRoots` upload).

A green replay re-confirms *record-time* artifacts, **not** that the current
skill still produces them — `replay --strict` fails the run when the `fingerprint` shows ANY skill/baseline
drift, or `replay --fail-on-skill-drift` fails only on skill-source drift (leaving baseline drift a warning).
Either way, every replay result also reports the drift in `staleness[]` (class-tagged) for a JSON gate to read.

> **On `replay`, drift WARNS by default — the staleness gate is `verify-cassettes`.** Edit a skill without
> re-recording and a bare `replay` prints `::warning:: cassette stale … re-record` and (for the
> content-drift classes) still reports
> success (exit 0); `verify-cassettes` on the same tree exits **3** (could not verify). That split is deliberate: `replay`
> answers "do the assertions still hold", `verify-cassettes` answers "is this recording still current", and
> a stale recording is not by itself a wrong answer. **The consequence is that `replay` alone does not gate
> staleness.** Run both in CI — this repo does ([`ci.yml`](https://github.com/yaniv-golan/cowork-harness/blob/main/.github/workflows/ci.yml) runs the replay
> fixtures and then `verify-cassettes examples/replays/`) — or, if you want one command to do both, pass
> `replay --fail-on-skill-drift` (or `--strict`, which also fails on baseline drift). `--reassert` /
> `--assert-from` imply skill-drift hard-fail already.

### Still skipped on replay (no filesystem/network in a cassette)

`file_absent` (proving a path is ABSENT needs an exhaustive, healthy walk; the manifest records no walk
health, so "not captured" and "not there" are indistinguishable — it would pass while proving nothing),
`no_delete_in_outputs`, `no_delete_in_mounts` (both need the live post-run bash scan; a cassette freezes no
commands to re-scan), `self_heal_ran`, `transcript_no_host_path`, `egress_denied`, `egress_allowed`,
`no_mcp_error` (MCP round-trips are harness-computed at drive time, not in the cassette's frozen stdout
stream, so `RunResult.mcpErrors` is absent on replay), `max_peak_rss_bytes` (replay never spawns a sandbox
to sample, so `RunResult.resources` is absent on replay), `semantic_matches` (an LLM judge call — never
evaluable from a frozen cassette), `no_lost_write_back` (needs the run's authored-file set, which the replay
`AssertContext` has no `authoredFiles` for — a manifest-keyed classification would hard-fail every embedding
cassette's replay; re-deriving authorship from the cassette manifest is a deferred follow-up capped by the
64 KiB body cap)
(and `expect_denied` — a **scenario-level shorthand** that expands to `egress_denied` assertions, not an
assertion key in its own right).

Skipped assertions are **absent** from `assertions[]` in the replay result (filtered before evaluation),
not present-and-passing. A CI script must not assume a fixed assertion count across replay and live lanes.

### Mixed assertions and the partial-skip warning

A single assertion object may mix a content key with a still-skipped egress/filesystem key, e.g.
`{ result: "success", egress_denied: "evil.com" }`. On replay the object is **stripped to its
replay-checkable keys** before evaluation — only `result` is checked; `egress_denied` is dropped. (With an
artifact manifest, `file_exists`/`user_visible_artifact`/`artifact_json`/`computer_links_resolve` are no
longer dropped — they're checkable; only the genuinely live-only keys above are.) To keep "skipped ≠
false-green," replay fires a
second loud warning whenever a key is dropped this way:

```
::warning:: [replay] N mixed assertion(s) had their filesystem/egress half dropped — only the content half was evaluated on replay
```

This is distinct from the full-skip warning (a pure filesystem/egress assertion with no content key,
or a gate-key assertion on a `controlOut`-less cassette — see §Backward compatibility). The partial-skip
warning specifically flags assertions that **passed on their content half** while their filesystem/egress
half went unchecked, so a mixed assertion can't green unnoticed on its content half alone. Use a live
`run` to evaluate the dropped half. (Source: `src/run/cassette.ts`.)

## Full-fidelity replay

When the cassette carries `controlOut`, replay consumes **both** recorded directions:

- **`events`** (child→driver): the assistant turns, tool calls, tool results, and decision *requests*.
- **`controlOut`** (driver→child): the serialized decision *responses* written to the agent's stdin.

On replay, the replay decider (built by `buildReplayDecider()`) indexes `controlOut` by `request_id` and serves the recorded response to
the decision pipeline instead of consulting a live decider or asking the user. This makes the full
`Run.handleDecision` path execute on replay, which populates `rec.questions`, `rec.gateAnswers`, and
`rec.gateDeliveries` — exactly as in a live run. Consequence: `question_asked`, `question_options`, `questions_count_max`,
`gate_answers_delivered`, and `gate_answer_count_min` are now genuinely evaluated, not silently skipped
or vacuously passed.

`gate_answers_delivered` accepts a boolean: `: true` asserts the answered gates' answers reached the
model, **passing vacuously when zero gates fired** (gate firing is model-dependent); `: false` is the
**inverse** — it asserts a *confirmed delivery failure* (at least one gate whose `delivered === false`),
for scenarios that deliberately exercise a non-delivery path. Unobserved delivery (`delivered: null`)
satisfies neither — absence of evidence is a failure, not a pass. Pair `gate_answers_delivered: true`
with `gate_answer_count_min: <N>` when a gate firing at all is part of what you're testing —
`gate_answer_count_min` fails if fewer than N gates fired AND were delivered non-error.

### The O7 guard — `replay_protocol_fidelity`

In addition to populating the decision record, replay **re-serializes** each decision response via
`serializeDecision` and compares the result to the frozen `controlOut` envelope (using a canonical
key-sorted JSON comparator to avoid false mismatches from key-order differences).

- **Match** — fidelity confirmed.
- **Mismatch** — a `{ assertion: { replay_protocol_fidelity: true }, pass: false, message }` entry is
  appended to `result.assertions`; replay exits 1.

This is the **O7 guard on the token-free lane**: if a future change to `serializeDecision` drops
`questions` from the AskUserQuestion `updatedInput` (the O7 bug class), the frozen recording still has
`questions`, the re-serialization won't, and the mismatch fires — without a live model or Docker.

`replay_protocol_fidelity` is a synthesized assertion, not user-authored. It will never appear in a
scenario's `assert:` block; on the live path it would fail as an empty assertion.

### Mutation coverage — `replay --mutate`

`replay --mutate` perturbs recorded, inlined JSON artifact values one at a time, re-runs the scenario's
assertions against the perturbed tree, and reports which perturbations nothing catches — those are the
fields your `assert:` block leaves unguarded. Each perturbation is applied, evaluated, and restored
before the next one runs, so the materialized tree ends the pass unchanged.

> **It samples. Read the ratio accordingly.** The plan is capped at **10 values per file and 50 in
> total** — the per-file cap is applied first, so a corpus of N JSON artifacts yields at most `10 × N`
> perturbations no matter how much total budget is left. A line reading `50/50 … CAUGHT BY NOTHING` means
> 50 of the *sampled* values, not 50 of your fields, and aggregating such lines across many cassettes
> produces a number that describes the sample rather than the corpus. Whenever a cap binds, the report
> appends the eligible total and names the cap that bound — `(sampled 30 of 120 eligible value(s);
> per-file cap 10 reached on 3 file(s))` — and omits that note entirely when nothing was truncated, so
> its absence means the counts are the whole truth. `--output-format json` carries the same facts under
> `mutation` (`sampled` / `eligible` / `truncatedBy` / `caps` / `uncaught`), which is the right surface to
> aggregate over.

**Scope it, and raise the cap that binds.** `--mutate-include <glob>` / `--mutate-exclude <glob>` (both
repeatable, exclude applied last) restrict which artifact paths are perturbed — `*` stays inside a path
segment, `**` crosses them, so `--mutate-exclude 'handoff/**'` drops per-run internals nobody should
assert on and spends the sample on deliverables instead. Filtering happens before planning, so an
out-of-scope artifact is absent from `eligible` too: the report describes the scope you asked for rather
than counting what you deliberately excluded as missed. `--mutate-max-per-file <n>` / `--mutate-max-total
<n>` raise the caps; reach for the per-file one first, since it is applied first and with a handful of
artifacts the total is never the binding constraint. Cost is linear — one full assertion re-run per
perturbation.

This is coverage reporting, not verdict reporting: an uncaught perturbation is a gap in the scenario's
assertions, not a failure of the run, so `--mutate` never changes replay's verdict or exit code — a green
replay stays green regardless of what it finds.

```
cowork-harness replay cassettes/my-scenario.cassette.json --mutate
```

### What replay's `RunResult` carries

A replay `RunResult` is built from the same frozen recording, so several fields are populated from it
rather than left `undefined`: `prompt` (the scenario prompt that drove the re-drive),
`toolResults` (the tool-result records, already reconstructed for assertion evaluation), and `fingerprint`
(the record-time value — carried with a `frozen: true` flag so a consumer can't mistake it for a fresh
run-time recompute). `resources` stays `undefined` on replay: a replay re-drive never spawns a sandbox, so
there is no process to sample (see `max_peak_rss_bytes` above).

## Backward compatibility (old cassettes without controlOut)

Cassettes recorded before full-fidelity replay lack `controlOut`. Replay handles them without silently
regressing to the prior false-green behavior:

1. **A loud warning fires** on stderr:
   ```
   ::warning:: [replay] cassette has no controlOut (pre-full-fidelity) — question/gate assertions
   are NOT checked; re-record to enable them
   ```
2. **`question_asked`, `question_options`, `questions_count_max`, `gate_answers_delivered`, `gate_answer_count_min` are
   excluded** from the evaluated assertion set for that run — not vacuously passed, absent.
3. All other content assertions (transcript, tool, subagent, result) evaluate normally.

This preserves "skipped ≠ false-green." Re-record with a current harness to get the full-fidelity path.

## When to re-record

Re-record a cassette when:
- The scenario's prompt, answers, or assertions change in a way that alters the expected agent behavior.
- The agent binary (from a Desktop update) produces different tool calls or transcript for the same prompt.
- You need `question_asked`/`gate_answers_delivered` assertions and the cassette lacks `controlOut`.
- `replay` exits 1 on a `replay_protocol_fidelity` mismatch — this means `serializeDecision` changed;
  review the change, confirm it's correct, then re-record to update the frozen envelope.

### Upgrading cowork-harness

Re-record AND re-verify all cassettes on every **harness major** (x.0.0) bump — **and on any release,
including a minor, whose changelog reports a change to the emulated tool surface, spawn env, or system
prompt.** A minor can change what the agent sees: **1.10.0** is the first such release (it added the
`skills`/`plugins` discovery servers, so `container`/`hostloop`/`cowork` cassettes recorded before it froze
a tool inventory five tools short). Cassettes recorded earlier keep replaying correctly — but a scenario
asserting `tool_available: "mcp__skills__.*"` will fail against them, correctly, because that recording
genuinely had no such tool. Re-record those.

```bash
cowork-harness record scenarios/ --dry-run          # preview + REAL loader check (schema errors surface here), write nothing
                                                    # ALSO refuses what the real record would: on_unanswered: prompt,
                                                    # and a statically unsatisfiable assert pairing
                                                    # (assert-contradiction). Reports EVERY offender, not the first.
                                                    # Prints the batch cost estimate summed from prior-run history.
cowork-harness record scenarios/ --dry-run --quiet  # the same check shaped for CI: silent on success, loud on failure
                                                    # (--quiet mutes the preview, never a refusal)
cowork-harness record scenarios/ --max-budget-usd 2.50   # refuse up front if the batch's cost history exceeds the cap
cowork-harness record scenarios/                    # or: record cassettes/ --rerecord-stale
cowork-harness verify-cassettes cassettes/
```

Why: a major may change the emulated system-prompt, the egress policy, or the hash algorithm — any of
which can shift recorded behavior. Most of those inputs have an automatic tripwire (a baseline, prompt-asset
or skill-hash drift is reported by `verify-cassettes`/`replay` as a staleness finding); a change to the
*declared tool surface* is the one that historically had none, which is why the changelog is the authority
for that class. Structural assertions (`artifact_json`, `file_exists`, `result`) are
stable across these shifts; prose-level `transcript_matches` is not. Prefer structural asserts where
possible.

`verify-cassettes` reports these staleness causes:
- **`recorded under hash format vN (now vM)`** — classed **`unverifiable-skill`**, and it means what it
  says: the recorded digest and the one this build computes came from **different algorithms**, so they
  cannot be compared at all. That is not the same claim as "your skill changed", and it is why the class is
  not `format`: `format` is waivable and warns while exiting 0, which on the day of an epoch would be a
  green run for every cassette in existence. This **fails a bare `replay`**, and an explicit `--session`
  *escalates* it rather than quietening it — an override cannot make incomparable digests comparable.

  It fires when the recorded version is below the **hash-format epoch** (v12 — the version at which
  `skillHash`/`contentSig` are computed the way this build computes them), never merely because it is below
  the current `cassetteVersion`. Note it is checked **before** the git/raw mode and agent-scope comparisons, which
  would otherwise swallow a pre-epoch cassette that also had a mode flip into a waivable warning.

  **The remedy is `rehash`, not necessarily a re-record.** Where the content can be proved unchanged the
  migration is free; see the `rehash` section above, including `--session` for a cassette that moved.

  A cassette at the epoch never gets this message for genuine skill drift; it gets the per-bucket
  `skill files changed …` finding below instead, with the changed-file detail intact. (Any
  cassette recorded below the **v9** read floor is refused at load time with a re-record error before this
  staleness check is reached. A cassette that carries no `skillHash` is unaffected and keeps replaying.)
- **`skill files changed since record — N changed (path, …)`** — the **exact** changed/added/removed file(s),
  from the per-file manifest (`fileSigs`). **A `fileSigs` sha is not always `sha256(file)`** — it is the sha of
  the bytes that fold into `skillHash`, and a `.claude-plugin/plugin.json` folds with its `version` deleted
  (see the exclusion list under the `skillHash` description). Hand-checking one with `shasum` mismatches and
  reads as corruption. **The hand-check depends on `fingerprint.hashFormat`, so read that first:**

  | `hashFormat` | reproduce the sha with |
  |---|---|
  | absent (legacy) | `JSON.parse` → delete `version` → `JSON.stringify` → sha256 |
  | `"jcs1"` | `JSON.parse` → delete `version` → canonical (JCS-style) serialization → sha256 |

  Using the legacy recipe on a `jcs1` cassette will not match for any manifest whose keys are not already
  in canonical order — which reads as corruption and is the exact confusion this field's caveat exists to
  prevent. `COWORK_HARNESS_DEBUG_SKILLHASH=1` dumps the folded set with these shas, but fires **only on a
  hash mismatch** — a cassette that verifies clean has no on-demand dump. For a scoped cassette the drift is
  attributed **per bucket** by the
  actual changed paths: a `shared root changed (scope: skills/x) [N changed (…)]` message for shared-dependency
  changes and a `skills/x changed since record [N changed (…)]` message for the scoped skill's own files. When
  **both** buckets change you get **both** messages — a co-occurring shared change does not mask the skill's
  own drift. (With `COWORK_HARNESS_AGENT_SCOPE=skill`, a changed `agents/<x>.md` is attributed to skill `x`,
  matching the hash boundary.)
- **`session-shape fingerprint differs from the current session file (connected folders/plugins/skills/mcp/egress/web_fetch
  config changed since record; projects and agent_env are hashed only when set) — re-record`** (v9+) — the recorded `sessionFingerprint` no longer matches the
  live session's SHAPE. Distinct from `fingerprint.skillHash` (skill/plugin file content): a folder swapped or
  egress widened can drift the session with the skill tree untouched. Computed and hard-failed by
  `verify-cassettes` **only**, gated by the same `--skip-staleness` flag as the rest of this list — it never
  affects the default `replay` verdict, not even under `--strict`. `sessionFingerprint` is optional even on a
  v9+ cassette (below v9 the cassette is refused at load, not silently tolerated) — absent → silently not
  checked (no false stale on an old, still-valid recording). A genuine mismatch is normally a hard fail —
  **except** when the session file was only resolved via a name-lookup fallback (its persisted source path
  was missing, so the cassette may have been relocated onto a tree that doesn't mirror the original layout
  and the match could be an unrelated same-named sibling). In that one case `verify-cassettes` downgrades the
  mismatch to a non-failing note instead of a hard fail.

  There is a second downgrade, for a cassette recorded before `projects[]` was part of the shape: its hash
  covers everything *except* `projects[]`, so if the rest matches exactly, the mismatch is reported as
  **unverifiable** rather than as drift — *"recorded before `projects` was part of the session shape …
  re-record to gain that coverage"*. Read that as "this cassette cannot tell you whether a project mount
  moved", **not** as "nothing moved": a hash that never contained `projects` cannot distinguish the two,
  and calling it clean would put back the false green the coverage exists to close.
- **`recorded in '<mode>' file-set mode, verifying in '<mode>'`** — the staleness boundary differs between
  record and verify (e.g. recorded in a git work tree but verified from a non-repo copy); the hashes are not
  comparable, so re-record under the same mode. **This finding REPLACES the skill/shared-root comparison
  rather than accompanying it** — with nothing comparable to diff, emitting a content diff would be
  misleading. It is classed `format`, which is outside the skill-drift classes, so a bare `replay` warns and
  exits 0 and **`--fail-on-skill-drift` cannot fire**: while the boundary differs, skill-source drift is not
  detected at all. `--strict` fails, but on the boundary, not on the drift. This is the state you are in
  when you replay a git-recorded cassette from an **extracted npm tarball**, which is not a work tree — so
  run `replay` from a git work tree (or re-record with the same `COWORK_HARNESS_GITSET` setting) whenever
  detecting skill drift is the point.
- **`fidelity: cowork now resolves to '<tier>' … but the cassette was recorded at '<tier>'`** (class
  `resolved-tier`) — a `fidelity: cowork` cassette's recorded `effectiveFidelity` (the concrete tier —
  `hostloop` or `container` — the baseline's host-loop gate resolved to at record time) no longer matches
  what the scenario's baseline resolves to today; the recording exercises the wrong tier. Re-record.
- **`fidelity: cowork cassette predates effectiveFidelity — cannot verify tier stability`** (class
  `unverifiable-tier`) — either the cassette has no recorded `effectiveFidelity` field, or the scenario's
  pinned `baseline:` failed to load; the tier check couldn't run at all. Re-record to add the field (or
  fix the baseline pin). An **explicit**-tier scenario (not `fidelity: cowork`) is statically knowable and
  never produces this finding — at most a non-failing informational note.

Both classes exist only for `fidelity: cowork` scenarios, whose tier is baseline-resolved rather than
authored — see [fidelity-and-answers.md](../.claude/skills/cowork-harness/references/fidelity-and-answers.md)
for the `cowork` → `hostloop`/`container` resolution.

- **`the baseline's committed prompt assets changed since this cassette was recorded (same appVersion) …`**
  (class `prompt-assets`) — prompt identity keyed on `fingerprint.baseline` (appVersion)
  alone cannot see an edited committed prompt asset (`spawn.promptTemplate` / `subagentAppend` /
  `subagentAppendHostLoop`) under the SAME appVersion silently replayed old-prompt behavior. Non-failing
  by default (warns), `--strict` fails, `verify-cassettes` treats it like any other finding — re-record.
- **`cassette recorded a prompt-asset fingerprint but the live baseline's prompt assets can't be hashed …`**
  (class `unverifiable-prompt-assets`) — a recorded `fingerprint.promptAssetsHash` exists but the live
  baseline's prompt-asset pointer moved or the asset file is missing, so the drift check can't run at all
  (can't verify ⇒ not green on `verify-cassettes`, warns on the default replay gate). A cassette recorded
  **before** `promptAssetsHash` existed carries no field at all — that's a non-failing informational note
  ("`prompt-assets:` cassette predates prompt-asset fingerprinting"), not a finding. Notes are emitted at
  `::notice::` and, on a directory replay, collapsed to one summary line per note kind.

**The skill-hash boundary (v6+):** by default the hash covers the **git-tracked** files of each skill/plugin
source dir (a dir not in a git repo falls back to a raw filesystem walk). **OS-junk** (`.DS_Store` /
`Thumbs.db` / `desktop.ini`) is always excluded, so a Finder touch never re-stales a cassette. Opt out of git
mode with `COWORK_HARNESS_GITSET=0`. Set `COWORK_HARNESS_DEBUG_SKILLHASH=1` to dump the exact file set on a
mismatch. Declare per-plugin non-runtime paths in `.cowork-hashignore` / the session `staleness.hash_ignore`.
Any cassette recorded before this boundary is below the v9 read floor and is refused at load time with a
re-record error — `rehash` never gets the chance to attempt a digest-only migration for it.

## Batch recording

`record` takes a single scenario OR a directory:

```bash
cowork-harness record scenarios/                 # record every scenario in the dir (one cassette each)
cowork-harness record cassettes/ --rerecord-stale # re-record ONLY the cassettes whose fingerprint drifted
```

**`--dry-run` and `--rerecord-stale` cannot be combined** — dry-running a stale-only re-record would need
real filesystem selection work `--dry-run` doesn't do, so the combination is rejected. To pre-flight what a
`--rerecord-stale` sweep would touch, dry-run the plain **scenarios directory** instead
(`cowork-harness record scenarios/ --dry-run`): a superset of what actually gets re-recorded (every
committed cassette's source scenario, not just the ones whose fingerprint drifted), so it's conservative in
the right direction.

Each cassette is written **atomically** — to a same-directory temp file, then `rename`d over the target
(atomic on POSIX). An interrupted, failed, or OOM-killed batch therefore never leaves a partial or corrupt
cassette behind: you get the previous cassette or the new one, never a half-written file. **You do not need
to wrap `record` in your own temp-file + `mv` dance** — a batch that dies part-way leaves the
already-completed cassettes valid and the rest untouched.

Directory discovery keys on a **positive `prompt:` signal**: a `*.yaml` with no top-level `prompt:` is an
announced skip (it's a session/other doc), but a doc that *looks* like a scenario (has `prompt:`) yet fails
to parse is a **failure**, never a silent skip. Zero scenarios discovered → loud non-zero exit. `record`
also **refuses to freeze a failing live run** into a cassette (`--allow-failing` overrides) — a committed
red cassette is a latent false-signal.

### Parallel re-records (`--concurrency`)

A fleet re-record is sequential by default (one ~7–8 min live run at a time). `--concurrency <N>` records a
dir batch (or `--rerecord-stale`) **N at a time**:

```bash
cowork-harness record cassettes/ --rerecord-stale --concurrency 3
```

This is **safe**: every run is fully isolated — its own per-run Docker networks + egress proxy and its own
session run dir, reaped by name on exit — so parallel records never collide on resources or output (each
`--rerecord-stale` item also targets its own committed cassette). The flag is purely a **bound**, not a
correctness switch; the limits it guards against are:

- **Docker's address pool** — each run creates two networks; too many at once exhausts the default pool. The
  error is reframed actionably; widen the daemon address pool or `docker network prune` SIGKILL'd orphans.
- **Model API rate limits** + host CPU/RAM — N concurrent live agents.
- **microVM only:** a parallel batch that includes `fidelity: microvm` scenarios can occasionally race on
  host-port reuse (a brief allocate/bind window); it's rare and retriable. The default `container`/`hostloop`
  tiers are unaffected.

Default is `1` (ordered output); `2–3` is a good fleet-refresh setting; max is `8`. A dir batch where two
scenarios' `name:` slugify to the same cassette path is rejected up front (they'd clobber each other).

> **Note on separate processes.** Running multiple *separate* `cowork-harness record <file>` invocations in
> parallel (e.g. `xargs -P`) is also safe at steady state, but on a **cold** machine they can race to build the
> egress-proxy image (each would run `npm run build` + `docker build`). `--concurrency` avoids this — the
> in-process pool builds the image once (the build is synchronous, so the first worker completes it before any
> other starts). Build the proxy image once first if you must use `xargs -P` cold (`cowork-harness doctor`
> reports the build line).

## Privacy: cassettes are committed fixtures

A cassette snapshots the transcript **and the body of every under-cap regular file** under `outputs/` and
`.projects/` — not just JSON. UTF-8-safe content is inlined as text, anything else as base64, so a
spreadsheet, an image or a PDF is embedded just as literally as a `.json` (names, dollar figures, share
counts). Uploads and `mode:r` connected folders are hash-only, and a file over the body cap carries
`truncationReason: "size"` instead of its contents. That is the committed PII surface. Two layers, distinct from secret-scrub (which only strips auth tokens):

- **Opt-in redaction** (the mutation). Drop a `.cowork-redact.json` next to your scenarios, or set
  `COWORK_HARNESS_REDACT_PATTERNS` / `COWORK_HARNESS_REDACT_KEYS`. The policy file is searched in
  **cwd → the scenario file's dir → the cassette's dir** (each dir's file merges once; the env vars
  merge on top), and `cowork-harness init-redact` copies the packaged reference template into the cwd
  as a reviewed-and-tailored starting point. `record` also runs a **pre-spawn preflight**: when the
  resolved tier is host-path-bearing (`hostloop`, `protocol`) and the assembled policy is EMPTY, it
  emits a `::warning::` *before* the paid run starts (once per batch for `record <dir>` /
  `--rerecord-stale`) — that combination commits real host paths, which `verify-cassettes`' `path`
  scanner then hard-fails; the always-on scanner remains the universal net (container can trip it
  too). At record time it rewrites matching PII
  across the whole cassette surface (transcript, artifact bodies + filenames, prompt/answers/assert,
  skillSources) **structurally** — JSON stays valid and the AskUserQuestion question/answer strings stay in
  sync, so the O7 guard still passes. Redaction is **verdict-preserving**: `record` replays before/after and
  **refuses to write** if redaction would flip an assertion (a manufactured green is the cardinal sin) — or
  if it changes the number of `computer://` links extractable from the model-visible text (a pattern that
  eats a link's closing delimiter destroys the link, and `computer_links_resolve` would then pass
  **vacuously** on replay). Write path patterns to redact only the machine-specific prefix (stop before
  `/mnt/`) and exclude `)`/`]`/backtick from their character classes — see this repo's `.cowork-redact.json`.
  **Pattern ORDER matters, and it is not cosmetic.** Patterns apply in sequence over the accumulating
  output, so a bare catch-all placed ahead of a lookahead-anchored rule for the same prefix matches first
  and eats the `/mnt/` tail the lookahead exists to preserve — after which every `computer://` link stops
  resolving on replay, with no error and no finding. Keep the `(?=/mnt/)`-anchored rules **before** the bare
  ones, as the shipped policy does. Loading a policy in the hazardous order prints a warning naming both
  pattern indices. `--no-redact` skips redaction for known-synthetic inputs.
- **Always-on scan gate** — `verify-cassettes <file|dir>` scans the committed cassettes and **exits
  non-zero** on a finding, so "no leak" is a gate, not discipline. The full net (`email` + `currency` +
  bare-`domain` + `path` + `machine-inventory`) runs over the **whole cassette** — the deliverable (`outputs/`
  bodies + filenames), the author-written `prompt`/`answers`/`assert`, AND the agent's reasoning + tool I/O —
  with **one structural exception**: the agent's **capability-manifest** messages — the `system/init` event,
  the `initialize` registry `control_response` (`request_id:"init-1"`), the MCP `initialize`
  `control_request` (Claude Code's own client handshake, `clientInfo.websiteUrl` etc.), and the MCP
  `initialize` `control_response` (the configured MCP server's own handshake reply, `serverInfo`) — get
  `email` + `path` + `machine-inventory` only, not the full net. The first two carry the tool/skill catalog
  (slash-command descriptions naming `docsend.com`, `Pitch.com`, …) and the MCP-server names
  (`claude.ai Gmail`, …); the MCP handshake pair carries the agent's own product identity
  (`claude.com`) and the server's own name/version — environment boilerplate a regex can't tell apart from
  customer data, and the sole concentrated source of false positives — so `currency`/`domain` are excluded
  **as a unit**, not by domain. `email`, `path`, and
  `machine-inventory` still scan them: the registry's `account` field can carry the developer's own email,
  those same messages' own structural fields (`cwd`, `plugins[].path`, `memory_paths`) are exactly where a real
  local filesystem path — leaking a username, plugin-cache layout, or private marketplace name — lives, and a
  live-enumerated app/process inventory sentinel (e.g. a computer-use tool schema's "Available applications on
  this machine: …") is never legitimate catalog boilerplate either; none of the three share the ambiguity that
  gets `currency`/`domain` excluded there. `--allow <regex>` suppresses synthetic / public reference names
  (e.g. `NVCA`, `Cooley GO`, `Acme`) — each `--allow` value is a **pattern**, matched against a finding, not a
  path to allow; each allow must match the **whole** finding token (so a bare-domain allow no longer silently
  clears an email whose domain it matches), and `--allow-domain` / `--allow-email` / `--allow-path` /
  `--allow-machine-inventory` / `--allow-host-inventory` scope an allow to a single finding class, while `--allow-patterns-file <path>` is a
  different thing — it loads allows from a version-controlled **file of patterns** (one regex per line, `#`
  comments), not a path to allow directly. Multi-word proper
  names are **not** a default class (too noisy).

- **`host-inventory` — a structural class, not a regex.** A cassette recorded at a **host-inheriting** tier
  (`protocol`, `hostloop`, or `cowork` when it resolves to hostloop) freezes the recording *machine's* own
  inventory into its `system/init` and command-registry events. Committed to a public repo, that publishes
  your tool stack — this has actually happened here. The text net above cannot see it: an MCP server that
  never connected (`status: pending`/`needs-auth`/`failed`) **declares no tools**, so no `mcp__<server>__<tool>`
  token is ever written and `grep mcp__` over the cassette reads clean. The inventory lives in **name
  fields**. So this check reads specific name fields of the decoded events and flags: an `mcp_servers[].name`
  outside the harness's own servers, a `mcp__<server>__…` tool naming a foreign server, `account.email` /
  `.organization` / `.subscriptionType`, an `agents[]` entry outside the built-in roster, and a `skills[]`
  entry outside the agent's own built-ins. The skills axis is not theoretical: at `protocol` with local
  OAuth the harness keeps the operator's **real `CLAUDE_CONFIG_DIR`** (a fresh one breaks OAuth), so the
  personal skills installed there are discoverable, and a skill name says what you have installed exactly
  as an MCP server name does. Suppress with
  `--allow-host-inventory <regex>`; if the flagged name is a genuine Cowork server, add it to
  `KNOWN_COWORK_SERVERS` instead of allowing it.
  **A plugin the scenario mounted is not host inventory.** Its agents join the roster — at `hostloop`,
  that roster *is* the fixture — so an agent namespaced `<plugin>:<agent>` whose plugin the same recording
  declares in `plugins[]` is exempt, exactly as an `mcp.config`-attached server is. The provenance comes
  from the cassette itself, so this applies to recordings you already have; no re-record, and no allow
  regex to invent. A foreign agent, or one namespaced to a plugin the run never mounted, still flags. The
  same exemption covers `skills[]`.
  **`plugins[].name` is deliberately NOT an axis.** That array is the harness's own declaration channel —
  every entry arrives from a `--plugin-dir` the harness passed, and the settings it writes carry an
  explicit `enabledPlugins` allowlist. Across every committed fixture, including `protocol` and `hostloop`
  recordings made on a machine with many host plugins installed, it holds only the scenario's own. A field
  that carries nothing but declarations would produce false positives and catch nothing — the failure this
  class has already had once.
  **`record` carries its own preflight for the same risk.** Recording at a host-inheriting tier
  (`protocol`, `hostloop`, or `cowork` resolving to hostloop) into a repo-visible cassette path is
  refused by default — that recording would freeze this machine's MCP servers, agents, and account
  metadata into a committed fixture. `--allow-host-inventory-fixture` is the boolean consent to record
  anyway; it is distinct from `verify-cassettes`' `--allow-host-inventory <regex>` above (a per-finding
  suppressor, not a record-time consent) and is appropriate only when the session has no personal MCP
  servers or plugins.
  **The preflight is a PREDICTION; `record` now also checks the EVIDENCE.** The preflight reads the tier
  and the destination path before the paid spawn, which is the right place for it — but it never looks at
  the resulting bytes, so it can be wrong in both directions. After redaction and before the write, the
  finished recording is scanned, and a `host-inventory` or `machine-inventory` finding on a repo-visible
  path is **quarantined**: the cassette is written under `<runs-root>/quarantine/` (honouring `--run-dir`)
  with a `.findings.txt` sibling naming what leaked, and the command fails without writing the path you
  asked for. It is not discarded — you paid for that run — and it is not left where it could be committed.
  Only the machine-identity classes trigger this; `email`/`currency`/`domain`/`path` findings are often
  legitimate scenario content (a cap-table fixture is *supposed* to contain currency figures), and a gate
  that fires on those teaches you to pass the escape flag by reflex. Outside a git repo nothing publishes
  the file by accident, so there you get a loud warning instead of a quarantine. If the runs root is itself
  inside a working tree, quarantine falls back to the OS temp dir and says so — moving a leak into another
  committable location would be theatre.

  **The right way out is usually `fidelity: container`**, which is sealed (`HOME=/tmp`) and has nothing
  to leak. Redirecting the *output* elsewhere is not equivalent: a cassette recorded outside the repo
  and moved in afterwards is [unverifiable for staleness from its own location](#where-a-cassette-lives-and-why-it-cant-move-afterwards) — recoverable only by passing `--session <file>` on every invocation —
  so you would trade a loud refusal for a silent one. Record where the file will live, at a tier whose
  recording you're willing to publish.
  **Tier-gated on purpose:** at `container` the agent is sealed (`HOME=/tmp`), so a foreign server name there
  can only be one your scenario attached deliberately via `mcp.config` — a supported feature — and flagging
  it would fail a legitimate fixture.
  **What it does NOT cover.** Only the name fields above are checked. The catalogs — `slash_commands[]`,
  `skills[]`, `plugins[]`, and command *descriptions* — are **not** gated: `slash_commands` legitimately
  varies between clean fixtures and descriptions are unbounded free text, so there is no clean predicate,
  only an arbitrary threshold. In the leak that actually shipped, the gated fields were about **11% of the
  removed bytes** and the ungated catalogs about **89%** (the registry command catalog alone ~80%);
  both measured the same way, as whole JSON values. The check would have caught that fixture (18
  foreign server names, plus the account org) — but a host recording with *no* configured MCP servers, a
  plain `account`, and only built-in agents will still pass while carrying the host's full command and skill
  catalogs. Treat it as a backstop against the demonstrated failure, not as proof a cassette is clean.

`verify-cassettes` also runs the **staleness**
  check (both checks run by default; scope to one with `--skip-privacy` or `--skip-staleness`): a drifted
  `skillHash` (you edited the skill but didn't re-record) fails the gate.
  A third, always-on check compares a committed scenario's `prompt` against the cassette's frozen
  prompt: a resolvable, drifted prompt is a hard fail in its own `scenarioDrift` bucket (so
  `--skip-staleness` can't mask it) — the frozen events no longer correspond to the scenario; opt out
  with `--skip-scenario-drift`. `replay` surfaces the same drift as a non-failing notice rather than a
  hard fail (it can't tell whether the drift changed the outcome without re-recording).
  The `skillHash` hard-excludes only what is UNIVERSALLY non-runtime — recorded cassettes (`*.cassette.json`,
  by extension, so writing a cassette under the hashed tree doesn't self-invalidate the fingerprint it just
  recorded), VCS/cache dirs (`.git`, `node_modules`, `__pycache__`, …), and the `version` field of a
  `.claude-plugin/plugin.json` manifest (a pure version bump is metadata; mcpServers/hooks/deps still count).
  The manifest folds through **canonical (JCS-style) serialization**, so reordering its keys — semantically
  identical, no behavioural change — does not re-stale the cassettes that hash it. `contentSig` folds the
  same `D:` directory markers `skillHash` does, so an added or removed EMPTY directory is visible to both.

  **Scoping the hash to what changed.** Two consumer-declared knobs narrow the hash so an unrelated
  edit doesn't re-stale every cassette in a multi-skill plugin:
  - **`skills: [<name>, …]`** on a *scenario* — hash only those skills' `skills/<name>/` dirs plus the
    plugin's shared roots (everything not under `skills/<x>/`). Fail-closed: an unknown skill name falls back
    to hashing the whole tree. Omit it → whole-tree (default).
  - **`COWORK_HARNESS_AGENT_SCOPE=skill`** (opt-in env, default off) — refines `skills:` scoping so a
    **skill-named** sub-agent contract `agents/<name>.md` counts as skill `<name>`'s **private** input rather
    than a fleet-wide shared root. With it set, editing `agents/cap-table.md` re-stales only the `cap-table`
    cassettes, not the whole fleet. A `agents/<n>.md` whose `<n>` is **not** a skill name (a generic/shared
    agent) stays shared. **Convention + caveat:** this assumes "an agent named after a skill belongs to that
    skill" — if you genuinely share a *skill-named* agent across skills, leave this off (or rename it to a
    non-skill name so it stays fleet-wide). The setting is stamped into the cassette fingerprint (`agentScope`),
    so flipping it is an honest one-time "re-record under the same setting" (like `COWORK_HARNESS_GITSET`);
    existing cassettes recorded without it are unaffected until you opt in.
  - **`hash_ignore`** — gitignore-style globs for paths that don't affect recorded behavior (`tests/`,
    `docs/`, `**/*.md`). Declare them in the *session* under `staleness.hash_ignore: [...]`, and/or in a
    plugin-local **`.cowork-hashignore`** file at the mount root (the two compose). The harness does NOT
    hard-code layout opinions like `tests/`; the plugin/test author declares its own runtime boundary. A
    slash-free glob matches that name at any depth; a slashed glob is anchored to the mount root.

- **`--margins`** (diagnostic only, never affects the gate verdict) — reports a recorded-vs-budget count
  plus margin for each count-bound assert (e.g. `tool_calls_max`, `max_redundant_tool_calls`), replaying
  each affected cassette once to fold the count. A single-sample estimate — one cassette isn't a
  distribution; use `run --repeat` for real variance. See `verify-cassettes --help`.

```bash
cowork-harness verify-cassettes cassettes/ --allow 'NVCA|Cooley GO|Acme'
```

### Reading the result

`verify-cassettes` exits one of three codes — don't treat every non-zero exit as "the gate caught a
leak/drift":

| exit | meaning | JSON buckets populated |
|---|---|---|
| `0` | clean | none |
| `1` | **verification RAN and found a real problem** | `findings[]` (a PII/privacy match), `staleness[]` (a genuine, non-`unverifiable-*` drift finding), and/or `scenarioDrift[]` |

> **Triage first, then read the rows.** Text output opens with a per-class count —
> `findings by class: host-inventory 240` — before the per-file listing. A sweep that surfaces hundreds
> of findings of one class reads as hundreds of separate problems until you know that; the header says
> what kind and how many in one line. It is additive: every per-file row still prints, because which
> file carries which finding is the answer a per-file audit exists to give. JSON consumers already have
> `findings[].cls` and need no rollup.
| `2` | usage error (e.g. `--skip-privacy`+`--skip-staleness` together, zero cassettes under a dir) | n/a |
| `3` | **verification could NOT complete** | `unverifiable[]` (an `unverifiable-*`-class staleness finding), `version[]` (the cassette is from a newer harness than this one understands), and/or `error` (a malformed/unreadable cassette, or a per-file crash) |

If a run has both a real finding and a could-not-verify signal, `1` wins — a confirmed problem is the
stronger signal. This split matters for CI: a naive `[ $? -ne 0 ]` (or a `must-fail` canary built the
other way around) can't tell "the scan found a leak" apart from "a cassette couldn't be read" — branch
on the exit code, or read the `unverifiable`/`version`/`error` buckets directly, when that distinction
matters. Text-output rows carry the same split: `[stale]` = a genuine drift finding, `[unverifiable]` =
could-not-verify, `[version]`/`[error]` unchanged. A per-file `[error]` row is a bug to report (a
malformed cassette or a crash), not a signal to re-record.

The cardinal rule still holds: record against **synthetic** inputs (e.g. "Cadence / Acme", made-up
numbers) — redaction and the scan are belt-and-suspenders, not a license to record real customer data.

**If a scan finding surfaces on a cassette headed for `examples/replays/`** (the "safe to publish"
tier), the correct response is to **re-record against a clean/synthetic environment or hand-review the
whole cassette** — not to `--allow` the finding and commit. An allow only suppresses the one class the
scanner happened to check; it says nothing about classes the scanner doesn't cover (a plugin catalog, an
MCP-server list, a marketplace name) that may be sitting right next to it in the same real recording. A
finding is a prompt to ask "why is real data in a fixture that's supposed to be synthetic at all?", not a
checkbox to clear. This repo's own `.cowork-redact.json` (repo root) redacts local absolute paths and
email addresses at record time by default — extend its `patterns`/`keys` rather than reaching for
`--allow` first when a new class of real data shows up in a recording.

## Committed fixture

`examples/replays/example-pdf-skill.cassette.json` is a **synthetic** cassette committed to the repo
(not generated from a live run). It covers: assistant text, tool calls (Read/Write), and a
`result: success` — no gate exchange. Its `assert:` block exercises `result`, `user_visible_artifact`,
`transcript_contains`, `tool_called`, and `tool_not_called`. For a fixture that exercises an actual
AskUserQuestion gate, see `example-multiselect-gate.cassette.json`.

It is safe to commit because:
- It was hand-authored from the existing test patterns, not a live run with a real token.
- `controlOut` in a live-recorded cassette is secret-scrubbed at record time (tokens stripped by value),
  so a real recording is also safe to commit after inspection.

See `examples/replays/README.md` for how to re-record it from a live run if the fixture needs updating.

## Minimal CI snippet

Add this to the **token-free** job in your CI pipeline (no API key needed):

```yaml
- name: Replay cassette (token-free PR gate)
  run: |
    node dist/cli.js replay \
      examples/replays/example-pdf-skill.cassette.json \
      --output-format json
  # exit 1 if any assertion fails; the json envelope has ok:true on pass
- name: Verify cassettes (the staleness + privacy gate replay does NOT apply)
  run: node dist/cli.js verify-cassettes examples/replays/ --output-format json
  # exit 1 = a real finding; exit 3 = could not verify. Both are gate failures.
```

Both steps, because they answer different questions — which is what this page's opening line means by "run
both commands". `replay` asks "do the frozen assertions still pass"; `verify-cassettes` asks "is this fixture
still a valid, non-stale, privacy-clean thing to commit". A gate with only the first leaves staleness and the
privacy scan unchecked.

**`replay` exit-code key** (so a CI script can tell a real failure from a misconfiguration):

| Exit | Meaning |
|---|---|
| `0` | pass — every evaluated assertion passed |
| `1` | an assertion (or a `replay_protocol_fidelity` mismatch) failed |
| `2` | usage error — bad flags or an unreadable/malformed cassette |

This dogfoods the documented pattern and pins the fixture against future `parseMessage` / assertion /
`Run` regressions on every PR without spending a token.

For the complete CI pipeline (unit, boundary, scenarios, replay), see `.github/workflows/ci.yml` and
the [README Testing section](../README.md#testing--cicd).

## Cross-references

- [docs/scenario.md](./scenario.md) — `scenarios/*.yaml` schema, the full assertion reference, and
  which assertions survive replay.
- [SPEC.md](../SPEC.md) — the replay-fidelity contract clause (§11 / RunResult shape).
- `src/run/cassette.ts` — the implementation: `ALWAYS_CONTENT_KEYS`/`QUESTION_GATE_KEYS`/`MANIFEST_KEYS`/`LIVE_ONLY_KEYS` (the content-key buckets), `replayCassette`, `CassetteAgentSession`.
- `src/agent/session.ts` — `serializeDecision` (and its declared inverse `deserializeDecision`).
- `src/secrets.ts` — `scrubField` + `collectSecrets`, published as the `cowork-harness/secrets` subpath
  export for custom scrubbing pipelines.
