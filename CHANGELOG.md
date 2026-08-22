# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses
[Semantic Versioning](https://semver.org/); as of 1.0.0, a backwards-incompatible change to a covered surface ([SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)) requires a major bump.

## [Unreleased]

### Added

- **`lint` warns when `prompt:` names a slash command anywhere but the start** (⚠
  `WARN [prompt-slash-not-leading]`). Writing `/<skill-name>` into a scenario prompt is what an author
  reaches for when a skill will not auto-trigger, and it works — the harness sends `prompt:` verbatim and the
  agent expands a **leading** slash before the model is called. Named mid-sentence ("review the deck with
  `/deck-review`") it is never expanded: the text reaches the model as prose, which may then pick the `Skill`
  tool on its own — the same auto-trigger path the slash was meant to bypass. The scenario still runs and can
  still pass, so it silently stops testing what it reads as testing. Paths, URLs, filenames and dates
  (`/mnt/uploads/x`, `https://…`, `/deck.pdf`, `8/22`) do not trigger it.

### Documentation

- **[`docs/scenario.md`](./docs/scenario.md) — new "Slash commands in `prompt:`" section.** Documents that a
  slash command must START the prompt; that skills resolve by their bare frontmatter `name:` from either
  staging route (`skills.local` or a `--plugin-dir` plugin source); that an unregistered name is answered by
  the **agent**, not the model, ending the run with `Unknown command: /<name>`, `num_turns: 0` and no tokens
  spent; and that expansion is not enforcement.
- **[`docs/fidelity-gaps.md`](./docs/fidelity-gaps.md) — corrected the `UserPromptSubmit` rationale.** It
  previously justified not serving the hook with "a scenario `prompt:` is not a slash command, so the hook
  returns `{}`" — an assumption about consumer input, not a property of the harness, and one consumers do
  violate. The gap itself is unchanged and narrower than that framing implied: the agent binary performs the
  expansion on stream-json input on its own, so the body injection here is identical to production; only
  Desktop's additional `additionalContext` is missing.

## [2.0.0] — 2026-08-21

### Changed — BREAKING (requires a major bump; see [SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract))

- **HASH-FORMAT EPOCH — `cassetteVersion` 12. Every cassette carrying a `skillHash` fails a bare `replay`
  until it is migrated.** Read that sentence literally: this is not a warning you can defer.

  **Migrate with one command.** `cowork-harness rehash <dir/>` proves each cassette's content unchanged and
  relabels it in place — no re-record, no model calls, no cost. For a cassette that has MOVED (a `git mv`, a
  repo reorg, a copy into another project) its skill sources cannot be resolved from its own directory, so
  use `cowork-harness rehash <file.cassette.json> --session <session.yaml>`. Anything `rehash` cannot prove
  is refused rather than migrated, and does need a real re-record.

  **After a successful `rehash`, the epoch is cleared and you are done with it.** Migration does not touch
  the other staleness classes, and it does not need to: `baseline`, `format` and `prompt-assets` behave
  exactly as before — they surface in `staleness[]`, print a `::warning::`, and **exit 0**. Only
  `unverifiable-skill` fails a bare `replay`, which is what the epoch produces and what `rehash` clears. So
  a cassette that also carries, say, baseline drift migrates cleanly and then goes green with that drift
  still reported as a warning, exactly as before this release. (Measured, not inferred: a cassette with a
  deliberately wrong `fingerprint.baseline` replays `pass: true`, exit 0, with a non-failing `[baseline]`
  finding.)

  **`verify-cassettes` is stricter than `replay`, and that is not new.** It treats ANY staleness finding as
  not-green, so a migrated cassette that still carries baseline drift replays green and reds the
  verification gate — as it did before this release, for the same reason. Clear it by re-recording, or by
  re-stamping `fingerprint.baseline` where the baseline moved without changing anything the recording
  exercises; [docs/cassette.md](./docs/cassette.md#cassette-versioning) covers when that re-stamp is honest
  and when it is not. This release also ships a new platform baseline, so expect that drift on cassettes
  recorded against the previous one.

  **What changed.** A plugin manifest now folds into `skillHash`/`contentSig` through canonical (JCS-style)
  serialization instead of insertion-order `JSON.stringify`, so **reordering keys in `plugin.json` no longer
  re-stales every cassette that hashes it** — semantically identical input now produces an identical digest.
  `contentSig` additionally folds the directory markers `skillHash` has always folded, so an added or removed
  **empty directory** is finally visible to it; `CONTENTSIG_ALGO` moves 4 → 5 to say so. A new
  `fingerprint.hashFormat` records which transform produced the digests — **absent means the legacy
  pre-v12 transform, never raw bytes**, since every cassette already on disk carries version-stripped
  manifest digests.

  **Why it fails rather than warns.** A pre-epoch digest and a post-epoch digest came from different
  algorithms; they cannot be compared at all. That is `unverifiable-skill` — "this was not verified" — and
  not `format`, which is waivable and exits 0. A warning everyone ignores for a release is exactly the
  green-against-unverified state the strict-replay change below exists to end, and on the day of an epoch it
  would apply to every cassette in existence.

  **Some cassettes will migrate with an unchanged digest.** A manifest whose keys were already in canonical
  order, or a tree with no manifest at all, hashes identically under both algorithms. Those are still
  flagged and migrated, **by recorded version rather than by whether the number moved** — otherwise they
  would pass unlabelled, and at the next epoch nobody could tell which algorithm produced them.

  `cassetteVersion` now means the minimum reader for the **whole cassette**, not just for its `scenario`
  keys: a v11 reader handed a v12 cassette would recompute legacy digests and report drift that is not
  there. The scenario-aware differential still applies above that floor.

- **A bare `replay` now FAILS when skill staleness cannot be verified** (`unverifiable-skill`), where it
  previously warned on stderr, recorded the class in `staleness[]`, and exited `0`. "Could not be checked
  at all" and "checked and unchanged" are different claims and only the second is green — a cassette that
  had silently stopped proving anything kept passing the lane most people run, and green-against-unverified
  is worse than a loud red because silence prompts a re-record while green does not. The major is required because a previously-green
  input now exits non-zero — `verdict.pass` / `ok` and the per-command exit behaviour are covered surfaces
  ([SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)). Note the *meaning* of exit 1 is
  unchanged (still assertion-or-agent failure), so §11's exit-code table needs no edit; what changed is
  which inputs reach it.

  **Deliberately narrow.** The content-drift classes (`skill`, `shared-root`) still require
  `--fail-on-skill-drift`, so that flag keeps its meaning and no inverse escape hatch is needed.

  **One exception, and it exists to stop a false green:** under an explicit `--session`, the drift classes
  are escalated too. Without that, pointing `--session` at a WRONG but resolvable tree would turn
  `unverifiable-skill` (a hard fail) into ordinary `skill` drift (warn-only) — so the flag could be used,
  accidentally, to silence the very gate it exists to help you escape. `--session` is an escape from
  "cannot verify", never from "verified, and it changed".

  **Migration.** The commonest cause is a cassette that MOVED — use the new `--session <file>` below
  rather than re-recording. If you genuinely want the old behaviour for a lane, it was never expressible
  as a flag and still isn't; fix the resolution instead.

- **`verify-cassettes --output-format json` gained a REQUIRED `privacyScanned` field on every result.**
  `schema/verify-cassettes.json` is a covered 1.0 surface ([SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract)),
  and `privacyScanned` is now in its `required` list — so a consumer validating this build's output against
  an older copy of the schema is unaffected, but one validating an OLDER CLI's output against the NEW schema
  will fail. It is emitted on every return path, so anything keying on it can rely on it.

  The field exists because `error` became ambiguous. A cassette that fails SHAPE validation is now still
  privacy-scanned (see Fixed, below), so `error` covers both "never scanned" and "scanned fine, just not
  replayable" — and a gate cannot tell those apart from it. **If you have CI keyed on `error` meaning "this
  file was not checked", that reading is now wrong; switch to `privacyScanned === false`,** where
  `findings: []` is an absence of evidence rather than evidence of absence. `--skip-privacy` also reports
  `false`, for the same reason.

### Added

- **`provenance.asarGateIds` — a gate-membership change is now nameable.** A baseline recorded
  `provenance.fcache` as two aggregates and a timestamp, so when a sync moved `featureCount` **271 → 278**
  nothing could say *which* seven arrived, a count-neutral membership swap was invisible entirely, and
  `content16`'s diff line had to hedge "membership **and/or** values moved". The fcache is also
  server-refreshed on its own schedule (3.7–20.8 min observed), so a count delta between two baselines is
  a net over days of rollout rather than a fact about the Desktop release — and the previous payload is
  overwritten in place, so the question goes unanswerable the moment you think to ask it.

  Baselines now additionally record the gate ids **this release's own bundle references**, sorted. That is
  a pure function of the shipped asar: reproducible by anyone, stable across the fcache's refetches, and
  attributable to the release. Diffing two baselines names the delta outright (1.32885.1 → 1.34493.1:
  **+14 / −1**), and `sync --diff` prints the ids rather than a count.

  It is deliberately **not** intersected with the syncing machine's fcache. Gate membership varies by
  account segment, so filtering through one machine would both leak which gates that operator is served
  and drop DARK gates — 51 of the recorded ids are absent from the live fcache, `enableToolSearchAuto`
  among them. To turn an id into a name, grep it as a quoted literal in the extracted bundle; the call
  site names it, which is how `PINNED_GATES` was built in the first place.

- **`record` now scans what it wrote, and quarantines a leaking recording instead of publishing it.**
  `scanCassette` had exactly one production call site — `verify-cassettes` — which runs at commit time at
  the earliest. `hostInventoryPreflight` does fire before the paid spawn, but it reads the tier and the
  destination path, never the resulting bytes: it is a prediction, and it can be wrong in both directions.

  After redaction and before the write, the finished cassette is scanned. A `host-inventory` or
  `machine-inventory` finding on a repo-visible path writes the recording to `<runs-root>/quarantine/`
  (honouring `--run-dir` / `COWORK_HARNESS_RUNS_DIR`) alongside a `.findings.txt` naming exactly what
  leaked, then fails without writing the requested path.

  Three things about that policy are deliberate. **Quarantine, not discard** — the tokens are already
  spent, and throwing the recording away is both the most expensive answer and the one most likely to end
  in "just commit it anyway". **Only the machine-identity classes trigger it** — `email` / `currency` /
  `domain` / `path` findings are frequently legitimate scenario content, and a gate that fires on those
  teaches the operator to pass the escape flag by reflex, which is how a safety gate becomes decoration.
  **Outside a git repo it warns instead of quarantining** — nothing there publishes the file by accident,
  so quarantining would be obstruction rather than protection. If the runs root is itself inside a working
  tree, quarantine falls back to the OS temp dir and says so; moving a leak into another committable
  location would be theatre.

  `--allow-host-inventory-fixture` (the flag the preflight already honours) still writes the file, and now
  reports what it is publishing rather than going quiet.

  Coverage is labelled honestly: the policy (`classifyRecordLeak`) and the effect (`quarantineCassette`)
  are pure, exported and mutation-tested; the *wiring* inside `recordScenarioObject` needs a live spawn to
  reach, so it is guarded structurally — the same split this repo already uses for `buildCassette`.

- **Corrected a standing inaccuracy in the record-consent docs.** `SKILL.md` and `ci-recipe.md` both said
  the host-inventory preflight "refuses outright rather than warn". It refuses for a **new** cassette path
  but **warns** for one that already exists — deliberately, since refusing there would fire on every
  `--rerecord-stale` pass and make the escape flag reflexive. That warn path was the gap the record-time
  quarantine above now covers, so both documents now say which is which.


- **Platform baseline `desktop-1.34493.1` (agent `2.1.237`).** The Cowork system prompt, both sub-agent
  append branches, all 28 pinned gate states, the VM egress policy and the 22-key spawn env are all
  unchanged — re-derived from the new bundle rather than inferred from an absent diff row (only the
  minified prompt constant id rotated). `sync` reports no unknown deltas.

  The substantive change is in the **agent**, and an asar-only pass cannot see it: `2.1.237` adds six
  Cowork-specific risk categories to the auto-mode permission rubric's vocabulary —
  `cowork_delete_grant`, `cowork_folder_access`, `cowork_run_routine_now`,
  `cowork_scheduled_task_delete`, `cowork_scheduled_task_write`, `cowork_skill_persistence` — in both the
  native binary and the VM ELF. They are **inert for this harness**: the rubric is entered only on
  `permissionMode === "auto"`, which no scenario can request and no baseline pins (now pinned by
  `test/auto-mode-unreachable.test.ts`). They matter because the rubric's reach now names operations the
  harness does model, so the existing "auto-mode permission rubric is not modeled" gap has moved from
  generic infrastructure risk into Cowork territory. The agent's env-flag export table also moves
  524 → 533; none of the additions are set by the Cowork spawn.

  All three committed example cassettes are re-recorded against this baseline and stamp v12 /
  `hashFormat: "jcs1"`.

- **`--session <file>` on `replay` and `verify-cassettes`** — the escape hatch for a relocated cassette. A
  cassette stores `session:` relative to its own directory, so any move (`git mv`, a repo reorganisation, a
  copy into another project) made skill staleness permanently unverifiable with no way to say where the
  tree went; the only remedies were moving the file back or re-recording. It takes a **session**, not skill
  directories, because `staleness.hash_ignore` is a session-level field that is not stored in the cassette —
  an override carrying only directories would silently change the hash boundary. Refused for a directory
  target, for a path that is not a file, and for inline scenarios; the resolved session **and the dirs it
  produced** are echoed on stderr, since an override that silently pinned the wrong tree would manufacture
  false greens. An explicit override is trusted: a mismatch under it is reported as real drift rather than
  downgraded.

- **Duplicate manifest paths are now reported as ambiguous** instead of silently under-reported. Two mounts
  can each contribute `skills/x/SKILL.md`, and every consumer keys `fileSigs` by path, so duplicates
  collapsed to the last occurrence and the changed-file list could name the wrong file or none. Drift was
  always still DETECTED — the hash folds every entry — so this is an attribution fix, not a false-green fix.
  Exact attribution needs per-root identity in the digest, which is a hash-format epoch change.

### Fixed

- **A cassette that fails shape validation is now privacy-scanned.** `verify-cassettes` does two
  independent jobs — a privacy scan and a staleness check — and both sat behind one strict `readCassette`.
  Any document that failed shape validation returned early, so `scanCassette`, on the very next line, never
  ran: the file was reported with zero findings, which reads in every summary as `0 PII finding(s)`. That is
  a clean-looking number from an instrument that never ran, and a file too broken to replay is exactly the
  kind of file a leak arrives in. Measured on a malformed fixture carrying MCP server names, an account org
  and an agent roster: **0 findings and exit 3 before, 6 findings and exit 1 after.**

  The fix is a read-boundary **split**, not a loosening: `readCassette` stays exactly as strict (replay,
  staleness and the hash-format epoch's version/`hashFormat` invariant all depend on it). A separate
  `readCassetteForScan` reads the transcript only, requiring nothing but `events: string[]`, and
  `scanCassette`'s parameter type is narrowed to the fields it genuinely reads — so a future scan axis that
  reaches for some other field is a compile error until the projection carries it, rather than silently
  reading `undefined` off a partial document. Narrowing that type immediately turned up five fields the
  scan reads that a hand audit had missed (`userVisibleRoots`, `scenario.name`, `scenario.session`,
  `scenarioSource`, `environment.agentImage.ref`).

  The projection also **fails closed on an unrecognized tier**. `scanCassette` exempts a positively-sealed
  tier and scans everything else including `undefined`, but it tests set membership — so an arbitrary
  string (`"garbage"`, a typo'd `"containerr"`) is neither, and would have skipped the structural
  host-inventory scan entirely. The strict reader cannot produce that; this one can, because malformed
  input is its whole job.

- **The pre-commit cassette gate now fails CLOSED.** `.githooks/pre-commit` tested `hook_status` for `1`
  (block) and `3` (warn) and let every other outcome through to a successful commit, so the guard switched
  itself off — silently — on outcomes that ordinary refactors produce: exit `2` (`examples/replays/` renamed
  or emptied, or any CLI flag renamed), exit `127` (`node` off `PATH`), and a missing `dist/cli.js`, which is
  the state of a fresh clone, a `git clean -xdf`, a branch switch, and any tree with a failing typecheck
  (`npm run build` does `rm -rf dist` first). None of those fail a test elsewhere. Anything that is not a
  proven clean `0` now blocks.

  This matters more than a local convenience: `ci.yml` triggers on `push: [main]` and `pull_request`, but the
  documented workflow lands with `merge --ff-only` into `main` and pushes afterwards — so on that path the
  hook is not one layer of two, it is the only gate, and what it waves through is already public when CI
  reds.

- **An unscannable cassette no longer commits unscanned.** Exit 3 folds together unverifiable *staleness*,
  an unsupported `cassetteVersion`, and a per-file read error. Only the first means "we looked and could not
  conclude"; the other two mean the privacy scan never ran, so there is no evidence either way about host
  inventory — and a cassette recorded by a newer CLI than the committer's `dist/` committed with nothing
  having checked it. The hook now splits exit 3 by cause (`--output-format json`) and blocks on the two that
  are not staleness, in line with the `can't verify ⇒ not green` rule the CLI states everywhere else. A
  payload it cannot interpret is treated as undetermined, not as staleness.

- **The gate no longer misses cassettes by filename.** `record --out` accepts an arbitrary path and does not
  validate the suffix, so a recording written to e.g. `notes/run.json` was invisible to the hook's trigger,
  to CI's pathspec, and to `git ls-files '*.cassette.json'`. The hook trigger is now content-derived (any
  staged `.json` whose staged blob carries the `"generator": "cowork-harness"` marker), and CI cross-checks
  the suffix-derived set against the content-derived one. Separately, `resolveInputs` does not recurse, so
  `examples/replays/sub/x.cassette.json` was reachable by neither the directory scan nor the per-file loop
  (which excluded all of `examples/replays/`); the exclusion is now scoped to files *directly* in that
  directory.

- **CI scans every tracked cassette, not just one directory.** The sweep is derived from `git ls-files`
  rather than a hard-coded path, fails loudly if the pathspec ever matches zero files (an `xargs -r` sweep
  exits 0 on no matches and reads as success), and carries exactly one exclusion with its reason recorded:
  `test/evals/files/report-check.cassette.json` is an eval *attachment*, not a recording — it has no
  `scenario.session`, so `readCassette` rejects its shape before the scan can run. Measured rather than
  assumed: adding a `session` field does not make it verifiable, it converts the exit 3 into an exit 1 on
  baseline drift for a fixture that is never re-recorded.

- **The local gate is no longer laxer than the CI gate on the same directory.** The hook passed
  `--allow-email`/`--allow-domain` suppressions that `ci.yml` does not; the committed fixtures verify clean
  without them, so they are gone. Its scratch file also moved from a predictable `/tmp` path to `mktemp`, and
  a clean run now says so instead of passing in silence.

- **`sync` derived the enforced egress allowlist from a bundle-wide regex, and Desktop 1.34493.1 made that
  wrong.** `network.allowDomains` is the allowlist the harness ENFORCES (`boundaryAllowList` plus the
  session egress plan), but it was built by matching every `*.anthropic.com` / `*.claude.ai` literal in the
  whole app bundle. 1.34493.1 added a webview first-party-origin classifier — a navigation-trust tier naming
  `www.claude.ai` and `staging.claude.ai` — and the sweep pulled both into the enforced list, which would
  have permitted egress Cowork denies.

  Narrowing the sweep was investigated and rejected: on the first-party deployment there is nothing to
  narrow to. The 1p class returns `vmEgressPolicy(){return null}`, so `resolveVmAllowedDomains` falls
  through to the session's **server-delivered** `egressAllowedDomains`, and the only host the bundle
  contributes is the OTLP endpoint. `vmAllowedDomains`/`firewallAlso` are the 3p path and Desktop's own
  renderer endpoints — neither is the VM allowlist. Any bundle scan is unsound both ways: blind to
  server-delivered hosts, open to hosts that are not egress.

  `network.allowDomains` is therefore a **pinned, hand-curated list carried forward** from the newest
  committed baseline, and a new fail-closed `checkEgressContractFacts` guards the three constructions that
  justify pinning (the 1p null policy, the resolver's fall-through to its caller-supplied argument, and the
  OTLP-only augmentation) — so a real change in how Cowork computes egress hard-fails `sync` instead of
  silently rewriting the list. The baseline's `network.$comment` now records that provenance and names the
  entries that are unverified as VM egress; `network` became a `looseObject` so that note survives loading.

- **Consumers of 1.25.0 were NOT affected by this** — it is recorded because the shape is worth knowing,
  not because it shipped. While building `--session`, skill staleness, session-shape staleness, label
  provenance and the skill-hash debug dump could each have resolved a different session. The cassette-relative join was duplicated byte-identically
  in three functions and `sessionFingerprintDrift` accepted an override its only caller never passed, so
  `--session` would have verified skill content against the override while session shape still resolved the
  recorded path — reporting "clean" on an axis that hard-fails when used normally. All consumers now share
  one resolver.

- **An unresolvable session now says WHY** — missing file, unreadable/unparseable YAML, or declared mounts
  that do not exist — instead of one undifferentiated message. Those point at different fixes, and only the
  first looks like a relocation, so it also names the remedy.

### Known limitations (documented, not fixed)

- **Multi-root skill hashing is order-dependent.** `hashSkillDirs` folds roots sorted by absolute path
  while deliberately excluding a root's own name from the digest, so identical content at differently
  sorting directory names hashes differently. One axis (root ORDER) fails loudly as false drift. A second is
  worse: roots fold into one digest with no root-boundary marker, so moving a file BETWEEN roots is
  invisible — a genuine false green. Multi-root cassettes are still not refused, because none exists in
  any reachable corpus and refusing would break input nobody has; instead replay now emits a note when a
  cassette records two or more roots. Fixing it needs a hash-format epoch.
  Not scheduled: no multi-root cassette exists in any reachable corpus (32 cassettes on the widest
  denominator across three repos), and no session declares 2+ plugin/skill roots. Pinned by tests in
  `test/skill-hash.test.ts` so the eventual fix is a deliberate change.


## [1.25.0] — 2026-08-20

### Added

- **Platform baseline `desktop-1.32885.1` (agent `2.1.234`).** The Cowork system prompt is
  byte-identical to the previous baseline, the egress allowlist is unchanged at 15 domains, and the
  spawn contract still derives the same 22 env keys — but the **host-loop sub-agent append gained a
  sentence**, so `baselines/prompts/desktop-1.32885.1/subagent-append-hl.md` is a newly re-derived
  paraphrase and `spawn.subagentAppendHostLoop` now points at it. The added text tells a host-loop
  sub-agent that its shell commands start at the VM session root and that anything written outside
  `<root>/mnt/` — `/tmp` included — stays inside the sandbox, invisible to both the user and the
  sub-agent's own file tools. That is the host-loop split-filesystem fact the harness already models;
  it is now stated to the model. The `vm` branch is unchanged and keeps its existing asset.

  Worth knowing for anyone re-deriving this: the branch fingerprints decode `\uXXXX` escapes before
  hashing, so this is a real content change and not the codegen-escape artifact that moved both
  fingerprints a release earlier — the `vm` branch, which an escape change would also have moved,
  did not budge.

  **Live-verified against this baseline on 2026-08-19** across `protocol`, `container` and `hostloop`:
  the example-scenario suite 6/6, the `boundary-check` sandbox proof with all six constraints enforced,
  and `npm run test:live` at 4 suites / 24 assertions (20 green, 4 skipped). Three of those four skips
  passed on a re-run — the model-variance the suite skips loudly for rather than failing. The fourth,
  `live-outputs-delete`'s "a whole-line `#` comment is prose, not an executable delete", skipped in all
  three runs made against this baseline and so has **not** been green here; by that suite's own rule a
  skip persisting across runs means the agent has stopped being willing to run the pinned command, which
  makes it scenario-maintenance debt rather than a guard defect. Recorded rather than rounded away.

- **A `--repeat` rollup now names the ARM it ran, so a one-armed batch can't be banked as an A/B.**
  `--ablate-skill --repeat 5` produces 5 control runs and zero treatment runs — correct for a
  single-arm flag — and summarized them as `repeat "<skill>": PASS — 5/5 passed (100%)`, which reads
  as a completed comparison. A consumer made exactly that read twice, producing 10 baseline runs and 0
  treatment runs across two prompts before catching it at analysis. The verdict line now carries the
  arm: `repeat "<skill>": PASS [ABLATED — control arm] — 5/5 passed (100%)`. A partially-ablated batch
  (no flag produces one today; a resumed or hand-assembled run set could) reads
  `[MIXED ARMS: 2/3 ablated]` rather than being rounded to either arm, and a normal batch carries no
  tag at all — a label on every batch is noise, which is how the ablated one would come to be ignored.
  `--matrix`'s per-cell rollup lines get the same label, since that is where the largest batches run.

  **The flag combination stays legal.** Refusing it would ban a real measurement — "how variable is my
  no-skill baseline?" is a question these flags compose correctly to answer — and the output was never
  dishonest, only unlabeled at the one line a human reads. (Contrast `--ablate-skill --resume`, which
  *is* refused: there ablation does not take effect at all, so `ablated: true` would be a lie.)

- **A `[provenance]` banner on every run verdict — "which experiment actually ran?"** Three separate
  multi-run measurements by one consumer were silently scoped to the wrong thing, and in every case the
  run record already held the answer: a whole finding measured on `claude-sonnet-5` because the session
  file omitted `model:`; a 10-run "A/B" that was 10 `--ablate-skill` control runs and zero treatment
  runs; an answer that read exactly like skill output, from a run where the skill was offered and never
  invoked (the model read the mounted `SKILL.md` as a file instead). `models`, `ablated`,
  `context.availableSkills` and `skillsInvoked` were all in `result.json` and none of them were
  anywhere a human looks, so checking meant hand-written scripts against the record — which nobody runs
  until a result looks wrong, i.e. after the money is spent.

  The footer now prints one line beside the verdict, on passing AND failing runs and on the replay lane:

  ```
  [provenance] model=claude-opus-5  skill=offered,NOT-invoked  ablated=false
  ```

  `model` drops `<…>`-wrapped agent markers first — `<synthetic>` marks a locally fabricated turn, not a
  model, and an unfiltered join reads as a two-model run. `skill` has four states, and
  `offered,unknown` / `unknown` mean **evidence unavailable**, never "no": a banner that exists to
  prevent false confidence must not manufacture any. `ablated=false` prints too — the value is that the
  line is on every run.

  The same derived object rides in the `--output-format json` envelope as `results[].provenance`
  (beside `verdict`), so a consumer never re-derives the marker filter or the evidence-unavailable
  states. A `--repeat` batch gains an aggregate `provenance:` row on its rollup, reporting models and
  skill states as **sets** — a batch silently spanning two models is the multi-run form of the same
  defect, and collapsing to the first run would hide it. `--compact` (and `--demo`) suppress the line,
  matching the `[status]` contract.

### Changed

- **`verify-run --output-format json` now emits `results[]` with a per-result `verdict`, matching
  `run`.** The two commands answered the same question — "did my assertions pass?" — in structurally
  different envelopes: `run` nested everything under `results[].verdict`, `verify-run` was flat
  (`pass`/`assertions[]`/`signals[]`, no `verdict`, no `failures[]`). The cost was not a missing field
  but a **silent false green**: the defensive jq idiom from `run`'s own docs —
  `.results[]? | .verdict.failures[]? | select(.kind=="assertion")` — returns `[]` when `.results` is
  null, and `[]` reads as "no failures" in the query whose entire purpose is detecting failure. Run
  against a **failed** `verify-run`, it reported success. This matters most where `verify-run` is
  promoted hardest: as the cheap, token-free iteration path in CI.

  `results[]` always holds exactly one entry — `verify-run` judges one run dir, which is the same shape
  `run` emits for a single scenario. **Additive**: the flat `pass`, `assertions[]`, `signals[]` and
  `answerCoverage` keys are unchanged, so an existing consumer reading them is unaffected; `ok` still
  mirrors the verdict. A cross-command regression test runs the real documented query against a real
  failing envelope, so restoring the flat-only shape as a "simplification" fails the suite rather than
  silently reopening the false green.

### Fixed

- **The outputs-delete live suite was refusing to run, and a refused case verifies nothing.** It handed
  the agent a byte-pinned destructive command wrapped in prohibitions ("run this EXACTLY as written… do
  not modify it… do not run any other command") plus an unexplained sentinel, and asserted the command
  came back verbatim. The agent increasingly declined — over the framing, not the file operation — and a
  declined case SKIPS. Measured across 27 case-runs the refusal rate was **41%**; every case was refused
  at least once and the worst sat at 67%, so the suite could report success having verified almost
  nothing.

  It now asks for **ordinary tasks** whose completion requires the file operation — write two poems and
  delete one; write a poem and rename it. The agent has no delete tool, so a deletion must go through
  Bash, which is exactly the path the scanner watches, while a benign creative task gives it no reason to
  refuse. Measured 9 of 9 runs complied, zero refusals. The two form a polarity pair: one must trip the
  guard, one must not.

  Because the task is real, the run is now also asserted on its **effect** — exactly one poem file
  survives in `mnt/outputs` — where the pinned suite only ever proved the scanner had recorded an
  *intent* to delete. What is given up is byte-exactness: the agent picks its own filenames and command
  form, so assertions are on shape plus effect. Command-form distinctions that cannot be asked for
  naturally ("emptying a file is not a delete", "a commented-out `rm` is not a delete", the `mv`
  spellings) moved to `test/execute.test.ts`, deterministically and for free — including the
  `mnt/`-prefixed `mv` bytes the live case depended on, which no unit test had covered.

  Two intermediate attempts are recorded in the file's header so they are not retried blind: explaining
  the request (stated purpose, what the marker is for) made refusals **worse**, and retargeting one
  case's destination away from `/tmp` helped that case only.

- **A fixture shrinking could red an unrelated test.** `replay-json-pipe-truncation` multiplied a seed
  cassette to exceed the 64KB pipe buffer, with the copy count hard-coded at 10 and justified as
  "~15KB/result". The real figure was ~5.5KB, so the total sat just under the buffer and a routine
  re-record of the seed tipped it under — reddening the suite for a reason unrelated to the truncation
  bug it exists to pin. The count is now derived from a measured result at ~2x the buffer; the
  `> 65536` assertion stays as the tripwire.

- **`replay --help` now says that `--allow-failing` waives the skill-drift gate too.** `--assert-from`
  forces that gate on precisely so a re-asserted block cannot be frozen against a recording whose skill
  sources have moved — but the gate is the verdict, and `--allow-failing` waives the verdict wholesale.
  Nothing downstream re-checks drift. So `--assert-from --write --allow-failing`, which is the natural
  incantation when your asserts are legitimately failing (that being why you are re-asserting), persists
  the block against a drifted recording with no warning. Behaviour is unchanged — the flag is an explicit
  override and stays one — but it is now stated where it is reached for.

  The same block documents that text mode writes to stderr and nothing to stdout (a passing replay is 0
  bytes), and names `verdict.failures[].kind` as the way to separate your own failing asserts from
  injected drift/corruption findings, which the exit code collapses.

- **`verdict.failures[].kind` said "your assertion failed" when the cassette was corrupt.** That field is
  the documented way to tell an author's own failing `assert:` from something the harness injected — and
  seven cassette-corruption paths (duplicate `request_id`s with differing bodies, malformed control-out
  lines, a truncated recording) pushed their pseudo-assertions without the `source` stamp that drives it.
  `computeVerdict` falls back to `a.source ?? "assertion"`, so every one of them was reported as an
  authored assertion, in direct contradiction of the contract written above the field. A consumer asking
  "did MY assertions pass?" with the documented `select(.kind=="assertion")` query got a yes-it-failed on
  a cassette that was simply unreadable.

  They now stamp `cassette-format`, whose definition widens from "a cassette too new to interpret" to
  cover corruption as well — the shared property is that the cassette itself cannot be interpreted. No
  enum changed; `cassette-format` was already a member.

  **The guard that was supposed to catch this could not see it.** It scanned for the `{} as Assertion`
  cast shape, and all seven pass a real assertion key (`{ replay_protocol_fidelity: true }`), so they
  never matched — the suite stayed green while the sites shipped unstamped. It now keys on
  `assertions.push(` itself, which in these files is by construction an injection (an author's own
  asserts are evaluated elsewhere and never reach that call), and carries a mutation check proving the
  matcher rejects a bare push. Its site count is now counted rather than inherited: the old comment said
  2 in `cli.ts`; there are 3.

- **A stale sub-agent prompt pointer can no longer ship with a green `sync`.** The prompt assets a
  baseline points at (`spawn.subagentAppendHostLoop` / `spawn.subagentAppend`) are hand-authored, so
  `sync` carries the previous release's values forward untouched — while the drift sentinel compares the
  shipping app's text against a recorded fingerprint and never looks at those pointers. Recording a new
  fingerprint therefore cleared the sentinel whether or not the pointer moved, and a host-loop sub-agent
  would silently receive the previous release's paraphrase with every check green.

  A new coupling check closes it: when the newest recorded fingerprint differs from the one before it on
  an axis, the newest baseline's pointer for that axis must differ from the previous baseline's. Both
  inputs are already-committed data, so there is no new field to fill in — and nothing to copy-paste into
  compliance, which is what sank an earlier attempt at this. Verified by simulating the real failure: the
  check fires and names the exact edit required.

  Its limits are documented where it lives, not glossed: the committed asset is a deliberate paraphrase,
  so this enforces coupling and cannot verify faithfulness; it is dormant between fingerprint moves; and
  back-filling an older fingerprint entry equal to the newest silently disarms it.

  Alongside it, the per-tier branch-selection assertions were unfrozen from a pinned `desktop-1.20186.1`
  to `latest`. Pinned, they asserted real hl-vs-vm content semantics that could never observe a repoint
  of the CURRENT baseline — coverage in appearance only for the pointer production actually renders.

- **`verify-cassettes` stopped flagging the agent's own built-in skills as operator inventory.** The
  host-inventory scan keys off a closed roster of skills the product itself ships; that roster still held
  a single entry (`deep-research`) while the agent grew fourteen more. The first fresh `protocol`
  recording after a sync therefore reported 14 `host-inventory` findings on a cassette carrying no
  operator inventory at all — the exact false positive that pushes people toward a blanket
  `--allow-host-inventory`, which would disable the check that matters.

  The roster is now current, established three ways rather than assumed: the recording was made against
  a **managed (fresh) config dir** whose session stages no plugins or skills, so nothing from the
  operator's own config could have been enumerated; every name appears as a literal in both the staged
  agent ELF and the host CLI; and ten personal/plugin skill names from the same machine are **absent**
  from that binary, so the check discriminates rather than matching everything. The known cost is
  unchanged and inherent to a name-keyed set: an operator whose own skill shares one of these bare names
  is no longer flagged — the same trade the built-in *agent* roster already makes.

- **A minified `$` in the shipping app could make `sync` refuse a perfectly healthy Desktop release.**
  Several spawn-contract sentinels pinned a minifier-assigned binding, callee or member name with
  `\w+`. `\w` is `[A-Za-z0-9_]` — it cannot match `$`, which is a legal JavaScript identifier
  character that minifiers use freely. Claude Desktop 1.32885.1 named the empty-`ANTHROPIC_*`
  blank-sentinel helper `$s`, and the sentinel asserting that helper runs on the spawn env stopped
  matching. Nothing about the spawn contract had changed: re-deriving it against the new app produced
  the same 22 keys with the same values.

  An audit of every regex in the sync module found **11 such atoms across 7 patterns**, all in the
  spawn family, of which only one was firing — the other six were latent purely because their bindings
  happened not to draw a `$` this build. All of them are now `[\w$]`, including the captured env-object
  binding, which previously admitted a *trailing* `$` only and so would still have missed a
  `$`-initial name even with its callees widened.

  **The whole class fails closed** — an unresolvable value flags and refuses to write, rather than
  writing a wrong one — so the cost was a false refusal on a good release, never a silently incorrect
  baseline. That is also why six of the seven went unnoticed for so long, and why the fix ships with a
  guard rather than just a widening: a new test asserts the module contains **zero** regex atoms that
  cannot match a `$`-initial identifier, and backs that structural invariant with behavioural fixtures
  that drive the real sentinels using `$`-named bindings. The fixtures also assert the sentinels still
  *fire* when the contract genuinely breaks, so the widening cannot be mistaken for weakening them.

  Ships with one relaxation on the release checker: `check-versions`' DESIGN.md gap-form regex now
  accepts the singular *"1 baseline has shipped since"* — this release is the first N=1 gap on record,
  and the count is still verified against the enumerated list, so the singular form is not a loophole.

### Documentation

- **Three claims about the committed example fixtures were wrong, and are corrected.** `docs/protocol.md`
  said all three golden protocol vectors were "extracted verbatim" from
  `example-multiselect-gate.cassette.json`. `initialize.json` cannot have been: it carries an
  `appendSubagentSystemPrompt` holding the VM sub-agent text and a session id present in no committed
  cassette, while a `protocol`-tier run renders no sub-agent append at all and that scenario has been
  `fidelity: protocol` for its entire history. It is a real captured frame, from a container-tier run
  that was never committed. The other two do come from that scenario, but "verbatim" has a shelf life —
  one still matches field-for-field, the other carries a `request_id` regenerated on every re-record.

  `examples/replays/README.md` described a fixture as "`protocol`-tier (no Docker/agent needed to
  replay)", implying the tier is the reason. Replaying any cassette needs neither Docker nor a staged
  agent whatever tier it was recorded at — replay reads recorded frames and spawns nothing, which is why
  the token-free CI lane replays the container, protocol and hostloop fixtures side by side. The same
  file called that fixture "synthetic"; that was true of its hand-written capability catalog and stopped
  being true when it was re-recorded hermetically for this release's baseline sync.

- **`docs/maintenance.md` now names the repoint step.** The per-release procedure walked a maintainer
  through updating the paraphrase asset, appending a `subagentAppendVersions` entry and re-running
  `sync` — and never said to repoint `spawn.subagentAppendHostLoop` at the new asset. Those pointers are
  hand-authored, so `sync` carries the previous release's value forward untouched, and writing the
  fingerprint entry clears the sentinel whether or not you repoint. Skipping it ships a host-loop
  sub-agent the previous release's paraphrase with `sync` green. That is the step that was missed on
  1.32885.1 and caught by eye.

## [1.24.0] — 2026-08-18

### Added


- **`verdict.failures[]` entries carry a `kind`, so "did MY assertions fail?" is answerable from the
  envelope.** A consumer was scraping stderr for this, because the only available discriminator was
  whether an entry carried an `assertion` key — and that was wrong in **both** directions. `verify-run`
  injects `{ answer_coverage: <question> }`, which is not an `Assertion` key at all, so a coverage miss
  rendered exactly like one of the author's own asserts; meanwhile guard failures, `--strict` staleness,
  `--fail-on-skill-drift` drift and a too-new cassette all arrived key-less and indistinguishable from
  one another. (The sentence in the shipped CI recipe describing key-presence as the discriminator was
  therefore already false — corrected here.)

  Every entry now carries one of `assertion` | `guard` | `staleness` | `cassette-format` | `coverage`,
  stamped at each of the **five** pseudo-assertion injection sites via a new optional
  `RunResult.assertions[].source`. `jq '[.verdict.failures[] | select(.kind=="assertion")]'` is now the
  supported way to ask whether your own asserts held, and `select(.kind=="staleness")` whether the
  cassette is stale — neither is inferable from the exit code, since all of them land on exit 1.

  Additive: `assertion` and `message` are unchanged, so an existing consumer reading them is unaffected.
  A source-scanning guard fails if any future pseudo-assertion is pushed without a `source`, because the
  unit tests could only ever cover the sites they happen to construct — a mutation run proved that gap
  by deleting one stamp with every other test still green.

- **`file_absent` and `artifact_text` — the two file-family gaps a consumer report named.**

  `file_absent: <path>` is the direct negative-existence check. The workaround until now was inverting
  `no_unexpected_files`, which is a different claim with two traps: it is **new-files-only**, so a file
  that existed before the run is invisible to it however tight the allowlist, and it needs a pre-run
  manifest — the consumer paid for a re-record just to allowlist an incidental `.lock` file.
  **LIVE/verify-run only**, deliberately: proving absence needs an exhaustive, healthy walk, and
  `buildManifest` collects through the health-*discarding* `collectArtifactPaths`, so on replay a
  containment-skipped or unreadable subtree is indistinguishable from an empty one and the key would
  pass while proving nothing. It also fails evidence-unavailable on `lane: remote` and on
  `preRunOrigin: remote-unavailable` — where the filesystem is not locally observable, a missing
  snapshot is not evidence of absence. It does **not** inherit `local-unreadable`: that flag describes
  an incomplete pre-run *baseline*, which says nothing about whether one named path is on the post-run
  tree.

  `artifact_text: {artifact, contains?, not_contains?, matches?, not_matches?}` asserts over a
  delivered artifact's text body — `artifact_json`'s companion for non-JSON deliverables, and the way
  to prove an internal filename did not leak into a file a user receives. A consumer shipped exactly
  that to a founder: an internal reference name appeared 13 times in the delivered `report.json` and 0
  times in `report.md`, so the fix looked complete. `artifact` is a literal path, not a glob — one
  entry per delivered surface; a glob would be an exhaustive claim over the manifest's file set, which
  is `file_absent`'s class and unprovable there for the same reason. On `lane: remote` it names the lane
  rather than reporting a bare "file not found" — not a false green either way, but on a lane with no
  locally observable filesystem that message reads as "the skill didn't write it" (`artifact_json` still
  has that wart; the new key does not inherit it).

  Both are fail-closed on missing evidence, and one of those paths was a latent bug in the key they
  share a code path with: **`artifact_json` never checked `ctx.linkPaths`.** A manifest entry recorded
  as a symlink travels a different channel from `truncated` and materializes as a real 0-byte file;
  `artifact_json` survives it only because `JSON.parse("")` throws. A text matcher would have read the
  placeholder and reported "does not contain" as a pass, so the guard now lives in the shared block for
  every body-reading key. For the negative matchers, a body that is not lossless UTF-8 also fails
  evidence-unavailable rather than "passing" against replacement characters. And the record-time
  over-cap refusal that keeps `artifact_json` honest across lanes now covers `artifact_text` too — a
  deliverable big enough to be worth scanning for a leak is exactly the one that clears the 64 KiB body
  cap.

  Supporting change: `isLosslessUtf8` moved to the leaf module `src/run/artifacts.ts` (re-exported from
  `cassette.ts`) so `assert.ts` can use it without closing an import cycle, and
  `ALL_CLASSIFICATION_KEYS` now spreads `MANIFEST_KEYS` instead of hand-listing it — that literal was
  the one place a new manifest key threw at first replay for want of a second edit.

  Documented in `docs/scenario.md`, `docs/cassette.md` and the bundled skill — catalog rows, the goal→key
  index, and the replay-class lists: `artifact_text` joins the manifest class (its "all five" count
  becomes six) and `file_absent` the live-only class, with the reason it can never be replay-checked. The
  docs-sync guard cannot see that placement — `test/skill-docs-sync.test.ts` requires only that each key
  appear backtick-quoted somewhere in the skill's schema reference, which a single catalog row satisfies.

- **`question_options` — assert the option SET and ORDER a gate offered the user.** The gate family could
  assert *that* a question was asked (`question_asked`, text only), how many, and whether the answer was
  delivered — nothing could assert what the person was actually SHOWN. A consumer hit the consequence:
  their skill enforced an option tuple on the file, the agent presented that list **reversed** — demoting
  the safe choice from first to last and putting a different option in the default slot — and every
  artifact assertion passed, because the artifact was correct. The only wrong thing was what a founder
  saw.

  ```yaml
  - question_options:
      when_question: "rubric doesn't fit"
      equals: ["Stop review", "Proceed anyway", "Pick another rubric"]   # order compared by default
  ```

  `when_question` is a regex over the same label `question_asked` matches (`question`, falling back to
  `header`); omit it only when the run fired exactly one sub-question — more than one without a selector
  FAILS as ambiguous rather than silently taking the first, since guessing would make the assertion
  depend on the gate order it exists to pin. Set exactly one of `equals` (the complete set) or `contains`
  (a subset) — both, or neither, is rejected at **load**, so a contradictory assert is refused before the
  run is spent rather than after. `order: exact` is the default; `order: any` compares membership only,
  as a multiset so a duplicated label is not equal to a distinct one.

  **The evidence is captured when the gate is ASKED, not when it is answered.** The answer-time channel
  (`decisions[].questions`) is written only on the answered branch, so a gate that was shown and then
  denied, stalled or left undelivered carries no option set there — which is precisely the case worth
  asserting. Live and replay read the new ask-time `RunRecord.gateOptions`; `verify-run` reads
  `events.jsonl`, the only sidecar that retains option labels (the distilled `trace.json` drops them),
  and does so whenever the key is asserted rather than only when the scenario has scripted `answers` —
  a scenario using `on_unanswered: first` or an LLM-decided gate would otherwise have reached the
  evaluator with no evidence at all. Every unreadable-evidence path fails **evidence-unavailable**: a
  truncated-cassette replay, an absent `events.jsonl`, or one with any unparseable frame (a partial gate
  set must never be graded as complete). Replay evaluates it only with `controlOut`, like the other gate
  keys.

  A cassette recorded with this key still stamps format v10 and is rejected by installs that predate the
  key — the standing consequence of any assertion-key addition. Documented in `docs/scenario.md` and in
  the bundled skill: the assertion catalog, the goal→key index, the four gate-key replay lists, and the
  `positional-choose-order` advisory, which stops telling you to compare option order by hand.

### Changed


- **A `scripts/`-grounded `not-adjudicable` now says WHY it could not be decided.** `scripts/` is
  outside the evaluator's corpus by design — it grades authored guidance (`SKILL.md`, `references/**`,
  `agents/<name>.md`), not implementation — and `docs/critique.md` has always said so. What the verdict
  never said is which kind of "can't decide" it meant. A consumer read `not-adjudicable` on a claim
  about their own `gate_state.py` and treated it as unproven; it was a **verified product bug**, and the
  evaluator had simply never been shown the file. The report now appends one note to that section
  naming the boundary, the reading ("could not SEE the code, not that the claim is false"), and the
  documented remedy — state a script's contract in `SKILL.md` or a `references/` file if it matters to
  how the skill is used. The corpus boundary itself is unchanged: packaging script bodies would widen
  the evaluator from grading guidance to grading implementation, which is a scope decision, not a bug
  fix.

- **`lint` gains an ERROR-class `file-absent-contradiction` rule.** `file_exists: X` and
  `file_absent: X` on the same path cannot both hold, so a scenario carrying both would spend a run to
  fail. Like every ERROR-class finding it gates **without** `--strict`. It lives in the linter rather
  than in the TypeScript contradiction groups because those match on key PRESENCE across the assert
  array and cannot compare values — the linter already has the parsed YAML, so the comparison is free
  there. The `positional-choose-order` advisory also stops telling you to read
  `decisions[].questions[].options[]` by hand and points at `question_options` instead.

- **`--strict` means two different things in one CLI, and both help strings now say so.**
  `lint --strict` fails on ERROR+WARN+**INFO**; `lint-skill --strict` fails on ERROR+WARN and **never**
  INFO, deliberately. Each help text was individually accurate and the pair was silently contradictory —
  a consumer met the stricter of the two and read its INFO findings as a gate. Each now names the
  other's rule, and the CI recipe states the `--strict --min-severity WARN` pairing at the line where
  someone copies it. The semantics are unchanged: narrowing `lint --strict` would silently weaken a gate
  people may be relying on, which needs a deliberate major-version decision rather than a quiet fix.

- **Three documented gaps gain the framing a field report supplied.** The elicitation gap is not only
  "the form branch goes untested" — because the host's guidance is absent, so is every **conflict**
  between it and a skill's own instructions, and a real session produced exactly that (a skill mandating
  `AskUserQuestion` "(NOT plain chat)" against the host's injected form guidance). That class is
  structurally unobservable here, so a skill can ship a directive production silently overrides with
  every harness run green — which reframes what the planned opt-in stub server is worth.
  `docs/critique.md` now also states that a **fleet-consistency** defect is out of scope for any single
  critique by construction (the graded agent mounts the whole plugin; the evaluator's corpus is one
  skill), and the N-run recipe carries a measured case for why one critique is a sample: two runs of the
  same skill over the same document produced 78 vs 50 extracted figures and 12 vs 0 first-pass errors
  from the same real bug.

- **`critique`'s cost guidance stated one ratio unconditionally, and it inverts for the skills people
  most want to critique.** `--help` and `docs/critique.md` said the two evaluator passes dominate spend
  at ~3/4 of an end-to-end total. That holds for a trivial probe. Measured on a real document-analysis
  run: **task turn ~61%, evaluator ~30%** — because evaluator cost is roughly fixed (bounded by the
  evidence package) while the graded task turn is unbounded. The harm was the advice that followed:
  swap `--evaluator-model` on a fleet sweep, trading the injection-resistance property that is verified
  **for the default evaluator only** for a saving a third the advertised size. Both surfaces now name
  both regimes and point at the per-run split, and the report's `cost:` line prints the evaluator's
  **share of the total** alongside the four-way breakdown — so a run corrects the guidance itself rather
  than waiting for the next reader of the docs. When the task turn dominates, the levers named are
  `--model`, `--timeout` and probe scope.

- **`critique --out report.json` warns when the extension and `--output-format` disagree.**
  `--output-format` defaults to `text` and `--out` writes whatever it says, so the flag most likely to
  be scripted against had its format decided by a different flag with a non-obvious default: a
  downstream `json.load()` failed with `Expecting value: line 1 column 1`, which reads as a corrupt or
  missing report rather than a format mismatch. The warning fires at **argument-parse time**, before the
  four workloads spawn — the reported cost of this was a paid run discovered to be unparseable after the
  fact. Deliberately a warning and not extension inference: a filename is not proof of intent, and
  silently changing what an existing `--out foo.json` writes would break a script that already parses
  the text.

- **`record` warns BEFORE the run when a cassette would not be portable.** A cassette stores its
  `scenario.session` and `scenarioSource` relative to its own directory, so if reaching them means
  climbing out of the project tree, the stored relatives resolve only from that one filesystem layout —
  the file is uncommittable, and `verify-cassettes` reports it permanently `unverifiable` for staleness.
  Two consumers discovered that *after* paying for the run. The new preflight fires at the same
  pre-spend point as the host-inventory guard, and in `record --dry-run`, so the rehearsal is free. The
  bundled skill states it where it already warned that a cassette cannot be moved after the fact, and on
  `--dry-run` itself.

  It tests **climb-out**, in both directions: the cassette written outside the tree (the reported
  `--out /tmp/…` case) and a `session:` that lives outside it (an absolute or `~` path) — the mirror
  image, equally unresolvable, and invisible to a check that only looks at where the cassette lands.
  `~` is expanded first: `parseScenarioFile` deliberately leaves a `~/…` session untouched, and a raw
  `~/x` reads as *relative*, so an unexpanded check resolves it under the cwd and calls it in-tree.
  The reference root is the scenario source's git top-level, falling back to the **cwd** — not the
  session file's directory, since `sessions/` and `cassettes/` are conventionally siblings and that
  anchor would warn on every default record. Paths are canonicalized as far as they exist, because
  `git rev-parse --show-toplevel` always returns a real path and `/var` vs `/private/var` would
  otherwise warn on every macOS record. A warning, not a refusal: an out-of-tree throwaway cassette is
  legitimate — the defect was that nothing said so while the author could still act.

- **The host-inventory record refusal no longer recommends an out-of-repo `--out`, and its remedy is
  branch-aware.** Two consumers hit the same trap: the refusal told them to `--out` a path outside the
  repo, and taking that advice bakes a cassette whose `scenario.session` / `scenarioSource` — stored
  relative to its own directory — can never resolve again, so `verify-cassettes` reports it
  `unverifiable` for staleness (can't verify ⇒ not green, exit 3) and only a re-record recovers. It cost
  paid runs to discover, and the skill's own guidance had already started contradicting the message.
  That branch is gone; the message now names it as explicitly NOT a fix, with the consequence spelled
  out. The remedy it *does* offer is now scenario-dependent: `fidelity: container` normally, but a
  scenario asserting a hostloop-only key (`no_vm_path_file_op`, `vm_path_denied`, `path_denied`,
  `no_path_denied`, `subagent_dispatch_healthy`) cannot run at container at all, so it is pointed at
  `--allow-host-inventory-fixture` after auditing the session instead. The key set is read from the
  evaluator's own gate sites (`HOSTLOOP_ONLY_KEYS`, newly exported from `src/assert.ts`) rather than
  restated — `test/hostloop-only-keys.test.ts` scans the `hostloopOnly("…")` call sites and fails if the
  two drift, in either direction.

- **Parity baseline synced to Claude Desktop 1.32352.0** (agent ELF unchanged at 2.1.229). Two spawn env
  keys are new: `CLAUDE_PREVIEW_CLASSIFIER_FLOOR` is **pinned** — it is unconditional in the Cowork spawn
  env, so every first-party session receives it (the variable is older; what is new is Cowork setting it
  outright rather than the desktop code-session runner setting it behind a gate) — and
  `CLAUDE_CODE_DIAGNOSTICS_FILE` is **allowlisted, not pinned**, because it is constructed only inside the
  third-party/MDM deployment branch and never on a first-party session. The `automode-permission-rubric`
  gate flipped `off (defaultValue)` → `on (force)` server-side; the rubric it enables is Desktop-side and
  applies to VM-loop non-chat sessions, which the harness does not construct — see `docs/fidelity-gaps.md`.
  `DESIGN.md`'s scope note moves from "no baselines have shipped since" to naming what the last live
  end-to-end pass does **not** cover, which is what shipping a baseline is supposed to force.

### Fixed


- **`assertions --list` was advertised as emitting each key's replay class. It does not.** The
  bundled skill's CI recipe offered the JSON form as the authoritative substitute for hand-typed key
  enumerations — "every key, with its replay class" — and the output is `{key, description}`, with no
  structured class field to filter on. A consumer taking that at face value writes a `jq` selector
  against a field that has never existed, on the one surface recommended for not going stale. The line
  now says what the command emits, and points at the catalog's replay-class tables for the classes
  themselves.

- **Five published sentences described `fingerprint.skillSources` as cassette-relative. It is not.** The
  "a cassette is not relocatable" guidance added earlier in this release listed `scenario.session`,
  `fingerprint.skillSources` and `scenarioSource` as all being rewritten relative to the cassette's own
  directory. Only the first and third are. `skillSources` is stored relative to the **session-file**
  directory and is diagnostics-only — nothing resolves against it. The real break chain is one hop
  (cassette dir → relative `session:` → that file's declared skill dirs), which is why a moved cassette
  loses the skill hash. Corrected in `SKILL.md`, `references/scenario-schema.md`, `docs/session.md`,
  `docs/cassette.md` and this file's own earlier entry; `docs/cassette.md` gains a note stating the chain
  positively, since knowing which reference actually breaks is what tells you whether a move is
  recoverable.

- **`result.json`'s `models` array is documented as agent-verbatim, and `<synthetic>` is named.** A
  consumer hit `<synthetic>` in `models` and could find it nowhere — because it is not a harness string:
  the agent stamps that literal on assistant messages it fabricates locally (no API call, zero-filled
  `usage`), and the harness records model ids verbatim. Every surface that describes `models` said or
  implied each entry is a real model id — `schema/run-result.json` carried no `description` at all, while
  `docs/session.md` and `docs/debugging.md` told you to read the array back as run provenance, which two
  runs of the *same* pinned model can differ on purely by whether a synthesized turn occurred. All four
  now state the rule (drop `<…>`-wrapped entries — the angle-bracket prefix is the marker, not the one
  spelling), and `docs/gotchas.md` gains a symptom-keyed entry for the literal token someone greps for.
  The maintainer-only eval gate has filtered this since it was bitten live, but its comment mis-attributed
  the value to "a cassette/replay rep that used NO live model" — an ordinary live rep can carry it —
  and referenced a `single()` sort that F20 replaced; both corrected. The bundled skill carried the same
  "read `models` back" instruction in three places (measurement hygiene, the scenario schema's `model:`
  comment, the repeat-batch recipe); all three now carry the caveat with it.

- **Documented what the harness is *for*, not only that it is faithful.** The README leads with the
  record as well as the contract, and a new **"Why not just `claude -p` or the Agent SDK?"** section
  states the five things that are structurally hard to get otherwise — the staged Cowork agent in cowork
  mode, a test of the **real** router (the agent binary does discovery, so `skill_triggered` checks a
  `description` edit rather than your own dispatcher), real plugin loading (a failed load surfaces as a
  missing skill in `context.availableSkills`), **derived** run evidence a raw `stream-json` stream does
  not carry (`skillActivity`, `skillsInvoked`, `subagents[].referencesRead`, `ablated`, …), and the
  reproduced *limitations* — plus token-free replay and scripted gate answers. Mirrored in `llms.txt`.
  `docs/README.md`'s "I want to…" table grows from 5 rows to 11, covering the questions the harness
  uniquely answers (did the skill actually run · did a description edit break triggering · did it pass or
  pass once · does the skill beat no skill · testing a skill that asks questions · proving no egress).

- **`--ablate-skill` is documented as ONE arm.** The flag runs a single invocation with the skill
  removed — the control arm of a with/without comparison, not both arms; composed with `--repeat N` it
  produces N *ablated* runs and zero treatment runs. Now stated on `skill` and `run` in the README, in
  `docs/scenario.md`, in the companion skill (a new **Measure** section in Part II), and in the skill's
  Recipe 5, which described the experiment in prose without naming the flag. The scope is stated with
  it: the harness supplies the runs and the control arm; designing the comparison (scrubbing, shuffling,
  blind judging, unblinding) is the caller's.

- **A `skill`-lane `PASS` is explained.** With no `assert:` block it reports that no *guard* fired — not
  that the skill was invoked, nor which model or arm produced the run. New gotcha in the companion skill
  and a note in the README, both pointing at `skillsInvoked` / `skillActivity` / `models` / `ablated`.

- **"Confirm the skill was invoked" is now the first entry in the false-green hunt** (`docs/debugging.md`),
  alongside the failure family it belongs to: an answer that describes work the run never did. The skill's
  own source is mounted where the model can read it — in production too — so an answer that reads like
  skill output is not evidence of invocation.

- **Model pinning is documented as a measurement requirement.** Omitting `model:` emits no `--model` flag
  at all, so the run uses whatever the *staged agent binary* defaults to — fine for tracking the agent
  default, never fine for a `--repeat` batch or a before/after. `docs/session.md` and the skill's schema
  reference say so, and note that the ad-hoc `skill` lane has no session file, so `--model` is the only
  control there.

- **A recorded cassette is documented as NOT relocatable.** It rewrites `scenario.session` and
  `scenarioSource` relative to its **own** directory at record time, so a
  later move (a different `--out`, a `git mv`, a copy) leaves them unresolvable and `verify-cassettes`
  reports `unverifiable-skill` (exit 3). New section in `docs/cassette.md`, with caveats added next to the
  "relocatable bundle" promise in `docs/session.md` and the skill's schema reference, and next to the
  host-inventory record refusal — where `fidelity: container`, not an out-of-repo `--out`, is the answer.

- **Assertion families now state their ceiling, not just their members.** The gate keys match question
  **text**, counts and delivery — no key asserts a gate's **option set or order** (the options are
  recorded at `decisions[].questions[].options[]`); `no_unexpected_files` is an allowlist over *newly
  created* files and is not a stand-in for "file X must not exist"; `skill_tool_used` counts
  **sub-agent** calls inside the window and matches tool **names** only, so it can say neither which
  agent called nor with what path. `allow_stall` is marked scenario-only — an open-ended `skill` run has
  no `assert:` block and therefore no way to suppress a `stalled` verdict.

- **`lint` messages corrected and de-noised.** The unknown-assertion-key warning said the harness "would
  ignore it, so it silently does nothing"; `run`/`skill`/`record` in fact **reject** the scenario at load,
  and the message now says so and names the negative-form keys people reach for. The two unconditional
  INFO advisories (`manifest-needs-snapshot`, `gate-needs-controlout`) are reworded from imperative
  "re-record…" to "no action needed if your cassette is current", and `positional-choose-order` now notes
  that unstable option order is also what the *user* sees, not only a re-record flake.

- **`verdict.failures[]` documented as the machine-readable failure breakdown** (`references/ci-recipe.md`):
  entries carrying an `assertion` key are your failed assertions; entries without one are guard signals,
  infra errors, or — under `replay --assert-from`/`--reassert` — skill-source drift. Both land on exit 1,
  so the exit code cannot separate them and the envelope can.

- **`sync` mis-scanned the Desktop bundle, and it had been doing so silently since Desktop 1.25927.0.**
  `normalizeBundleQuotes` — the tokenizer that rewrites the bundle's backtick literals so every anchor in
  `sync` can be written against one quoting style — carried three defects that each desynchronised it, so
  that from the first bad character onward it paired the CLOSING backtick of one string with the OPENING
  backtick of the next. Downstream, whole regions were left unnormalised (every anchor over them reads as
  "gone") and stretches of code were rewritten into string literals. On Desktop 1.32352.0 this produced
  **32** unknown deltas of which **21** were phantom — and, less obviously, it *masked* four real ones, so
  the flag list was wrong in both directions rather than merely noisy.

  The three: an interpolation is code and may contain a **regex literal**, so a quote inside one (the
  POSIX shell-quote escaper `` `'${t.replace(/'/g, …)}'` ``) opened a phantom string; the regex-vs-division
  test admitted only punctuation, so a regex in a **keyword** context (`return/…/`) was read as division;
  and a substitution-free **tagged** template was rewritten into a string, which stops the tag being called
  and leaves text no parser accepts.

  Guarded by a parser oracle rather than by more anchors: `normalizeBundleQuotes` is now required to emit
  output that still parses, and that contains exactly the same multiset of string values as its input — a
  desync mints strings that were never in the source. It runs over every chunk of the installed Desktop
  bundle and skips cleanly where there is no install. The previous check — confirming that one known key
  had normalised — stayed green through two of the three defects.

  `sync` now also carries the tripwire itself, because that oracle needs a Desktop install and so never
  runs in CI — while `sync --diff` is the first thing run when a release lands. Any chunk whose
  normalized text stops parsing is reported **above** the deltas, saying in as many words that absent
  anchors may be phantom *and* real deltas may be masked. It is fail-soft by construction: a chunk is
  reported only when the RAW text parses and the normalized text does not, so a future Desktop shipping
  syntax the parser does not know reads as "not our damage" rather than blocking every sync.

- **The path-gate and Artifact sentinels survive a release that mangles exported CONSTANT names.**
  Desktop 1.32352.0 renamed `HOST_LOOP_PATH_GATED_BUILTIN_TOOLS` to `Cg` (and
  `HOST_LOOP_EXCLUDED_BUILTIN_TOOLS`, `REQUEST_COWORK_DIRECTORY`, `SESSION_TYPE_CHAT` with it) while the
  values behind them stayed byte-identical, so every path-hook anchor reported the machinery "gone". The
  guidance to never anchor on a minified *member* name did not cover exported *constants*. Each now binds
  by content — the defining chunk is resolved through the install site's spread, the tool-set arrays are
  matched literally and then required to still be exported, and the two constants are anchored on their
  values. A second codegen change in the same release (arrow bodies are now parenthesised) is admitted the
  same way. `checkPathHookFacts` gains the real-asar regression test its two sibling checkers already had —
  its absence is why this reached `sync` with nothing red.

- **The host-loop `canUseTool` chain is checked as a whole, including its new wrapper.** Production moved
  the `??` chain inside a block body wrapped by a pre-pass that can deny before any link runs and a
  post-pass that can turn the chain's ALLOW into a DENY. Teaching the extractor the block shape alone
  would have silenced three flags while leaving both new decision points invisible, so the wrapper is
  pinned too: the pre-pass must be awaited (an un-awaited async link yields a Promise, which is never
  nullish, so the early deny and the veto both go inert), must still carry the `/sessions` VM-path deny,
  and the chain's result must still flow through its `finish()`. Separately, the frame-artifacts predicate
  legitimately **dropped** its `!isHostLoop` term — `Artifact` now reaches the host-loop tier — so both
  term lists are admitted while the remaining tier restrictions are pinned.

- **Prompt fingerprints compare rendered content, not codegen.** The Cowork system-prompt and
  sub-agent-append fingerprints hashed the RAW minified template source, justified as being independent
  of minifier-assigned names. It is not independent of **escape form**: Desktop 1.32352.0 began emitting
  non-ASCII as `\uXXXX`, which moved the prompt hash by +630 code points and moved **both** sub-agent
  branch fingerprints — while the rendered text was byte-identical, as a diff of the decoded bodies
  confirms. Every fingerprint now also records a `decodedSha256`/`decodedCodePoints` over the body with
  escapes resolved, and drift is judged on those; a raw-only move is reported as a re-stamp note instead
  of an unknown delta. The raw hashes stay — they are the committed history — and an entry predating the
  decoded pair still compares raw, saying so in the message. The golden-oracle test that pinned the
  1.20186.0 raw hash was a version pin in an invariant's clothing (it went red the day Desktop updated,
  for no product reason); it now asserts the rendered-prompt hash, which genuinely has not moved since
  1.20186.0.

## [1.23.0] — 2026-08-14

### Added

- **Platform baseline for Claude Desktop 1.30096.1 (bundled agent ELF `2.1.229`).** The agent ELF's
  `sha256` was verified against the official release manifest for 2.1.229. The modeled spawn contract is
  unchanged across the bump — `spawn.tools` stays 20 entries, `allowedTools` 19, the egress allowlist 15
  domains, the spawn-env key set 61 with 31 conditional spreads, and the Cowork system prompt is
  byte-identical (its fingerprint is recorded for 1.30096.1 in
  `baselines/prompts/cowork-system-prompt-fingerprints.json`). `sync` refused to write this baseline until
  the two sentinel defects below were corrected.

- **Two drift sentinels pinned in the synced baseline's `provenance.gates`**: the artifact-mount gate
  (`coworkArtifacts`) and the CIC `can_use_tool` handler (`cicCanUseToolEnabled`). Both are force-ON in
  production, and the artifact-mount gap documented in `docs/fidelity-gaps.md` rests on that fact — which
  was previously read from a live feature cache the baseline never recorded, so nothing would have
  noticed it changing.

- **`check:versions` guards DESIGN.md's live-verification scope note (invariant 11).** That note is the
  repo's disclosure of how much of the *current* baseline has actually been verified live, and every
  figure in it is derivable from `baselines/desktop-*.json` — yet it sat in unguarded prose and had
  drifted twice, the baseline list having been extended without recounting. Understating how much is
  unverified is the doc error least worth shipping, so it is now checked. Two forms, selected by whether
  the note's live-pass baseline is the newest one: with a gap, the listed baselines must run contiguously
  from wherever the list starts through the newest baseline, and both counts must match the list and the
  real `agentVersion` transitions; with no gap, the note must say so explicitly and carry no stale
  enumeration. Either way the named agent must be the newest baseline's. Because shipping a baseline flips
  the no-gap form into the gap form, a new release now forces the note to be rewritten rather than
  silently overstating coverage. The list's *start* is deliberately not derived — the note omits baselines
  covered by the live pass itself, and encoding that rule would only relocate the drift. A missing or
  unrecognisable note is an error, never a skip.

- **Cassettes now record the rootfs image they were recorded against**, closing the last gap in the
  agent-image provenance work. The image decides `missingCapabilityUse`, which `computeVerdict` fails
  on, so the rootfs is verdict-affecting — yet no cassette field named it, and a recording silently
  inherited whatever image happened to be on the machine. `environment.agentImage` now carries the
  resolved `ref` plus whichever identities exist: `configId` (the local config id, present for built
  **and** pulled images but not comparable across machines) and `registryDigest` (the registry manifest
  digest, pulled images only, and the only identity comparable across machines).

  The field is stamped only for the tiers whose capabilities actually come from that image —
  `container` and `hostloop`. `microvm` probes the Lima guest instead, so it records nothing rather
  than naming an image that had no bearing on the run. Additive: no `cassetteVersion` bump, absent on
  cassettes recorded before the field existed, and never backfilled — the absence is meaningful.

  `ref` is a verbatim `COWORK_AGENT_IMAGE` value, so a private registry ref (`registry.acme.corp/…`)
  would otherwise be committed into a public fixture with `grep`-clean transcript text. It is scanned
  by `verify-cassettes` and rewritten by redaction like every other user-controlled string; the digests
  are content hashes and are deliberately left intact.

- **`replay` warns when the rootfs image differs from the recording.** It compares `registryDigest`
  first — the only identity stable across machines, which is the case the field exists to serve — and
  falls back to the local config id only when neither side has a registry digest. A recording made
  against a pulled image and replayed against a local rebuild is reported as drift rather than passing
  silently. Advisory only: a legitimately re-pulled image is the common case, so this names the
  difference instead of failing the replay.

  The current image is inspected at most once per `replay` invocation, and only when a cassette
  actually recorded one — so replay stays usable with no container runtime present, and the
  `verify-cassettes` privacy scan never shells out.

### Fixed

- **The host-loop `canUseTool` chain sentinel could be widened silently.** Desktop 1.30096.1 inserts a
  fourth link into the chain — an allow carve-out that rewrites the tool's input and runs ahead of the
  existing deny. The sentinel was a prefix match with no terminator, so it accepted any chain that merely
  *started* with the expected calls: an inserted **synchronous** link would have passed unnoticed, and
  the block that surfaced this release only happened because the new link is `await`ed.

  The check now decomposes the chain with a real scanner (the assignment must be brace/paren-balanced,
  and `??` legitimately occurs inside a template interpolation in the chain's own log line) and asserts
  it end to end: the terminal operand must be a bare call to the saved original, every operand whose
  callee is an `async function` must be awaited, no link that can return an allow may precede the
  VM-path deny, and each link must resolve to a definition. The await rule is the load-bearing one — an
  un-awaited async link returns a Promise, which is never nullish, so `??` short-circuits and every later
  link *including the original callback* is skipped. Three and four link chains are both accepted so an
  older Desktop still syncs; a fifth is reported for classification.

- **The early-allow ordering check had never fired.** It searched for a containment helper by two
  readable names, neither of which occurs in any shipped asar — production mangles the call — so the
  guard was permanently inert and its test passed only because the fixture hard-coded a token that does
  not exist in the product. The helper is now identified by shape and resolved through the export map.

- **S6c no longer hard-blocks on a minifier rename.** It pinned the HIPAA-restriction call by its
  minified *member name*, so the rename `A.r()` → `t.hu()` failed a predicate that is otherwise
  byte-for-byte identical. The callee is now resolved through the chunk's export map and verified two
  hops to the reader that consults the restriction, with resolution failure treated as a miss.

- **The `protocol`-tier live suite had been silently skipping itself for many releases.** `live-matrix`
  required a staged agent binary for a baseline pinned years back, but protocol fidelity spawns the host
  `claude` from `PATH` and never resolves a staged binary — the requirement was never real for that tier.
  Because Claude Desktop prunes old staged agents on update, the gate went false as soon as a machine
  moved past that agent version, and the suite dropped out on every developer machine and in CI without
  naming itself. It now gates on what the tier actually uses and emits a skip notice identifying the
  failing precondition, since this is the only protocol-tier live coverage there is.

- **The `hostloop` uploads-are-`Read`-able live case no longer fails on the model's choice of exploration
  tool.** It asserted that neither native nor workspace bash ran at all, as a proxy for "the agent needed a
  workaround" — so a run where the agent listed the uploads directory with `ls` went red, while the next
  run, which used `Glob` instead, went green. In both the upload was `Read` directly at the advertised
  path and no outputs-delete fired, so the regression the case guards was absent either way. It now reads
  the recorded bash commands and fails only when one **names the uploaded file**, which is what reading or
  copying it as a workaround requires and what listing its directory cannot do. Verified against both
  recorded runs plus `cat`/`cp` mutations: the false red is gone and the workaround chain still trips it.

### Documentation

- **A full live end-to-end pass now covers baseline `desktop-1.30096.1` / agent 2.1.229**, across all
  three tiers (`protocol`, `container`, `hostloop`), superseding the `desktop-1.20186.0` pin. DESIGN.md's
  claim and its scope note are re-stamped accordingly, including the caveats: two `live-outputs-delete`
  cases skipped as model-behaviour misses, the tiers were covered across two invocations because the
  `protocol` suite was repaired mid-pass, and the suites are model-dependent enough that a single red is
  evidence of variance until a re-run says otherwise.

- **`docs/fidelity-gaps.md`'s artifacts section records the agent-side consent floor.** The server-delivered
  session flag no longer only decides Desktop's spawned tool list — the agent reads the corresponding
  spawn-env key itself and uses it to select its own artifact publish surface and a read-only mode. The
  agent also refuses artifact publishes, comment replies, comment-thread resolves and artifact database
  writes outright in a session with no answerable approval surface, and fails closed if it cannot confirm
  one. The section now also states why this is recorded rather than modeled: artifact operations are
  server-backed, on hosts outside the sandbox egress allowlist, so supplying the flag would offer a tool
  resolving against a service the sandbox cannot reach.

- **The same section's mount-kind list is corrected.** It named a synthetic root that is not a mount kind
  and omitted one that is, which mattered because the artifact-mount gap is stated in terms of what the
  harness does and does not mount.

- **`docs/maintenance.md` corrects what moves the floating agent-image `:2` tag.** It is a curated pointer
  moved deliberately by a manual publish with `immutable_only` unchecked — explicitly *not* something a
  release tag push moves.

## [1.22.0] — 2026-08-12

### Added

- **Platform baseline for Claude Desktop 1.28929.0 (bundled agent ELF `2.1.227`).** The modeled
  first-party spawn contract is unchanged: `spawn.tools` stays 20 entries, `allowedTools` 19, and the
  egress allowlist 15 domains. The Cowork system prompt, the sub-agent append, `coworkSyspromptMap` and
  the mount-mode anchors all passed unchanged, and the VM rootfs image is byte-identical, so no
  provisioning re-capture. The ELF's SHA-256 matches Anthropic's official `linux-arm64` release
  manifest checksum. All three committed cassettes replay clean (re-stamped, not re-recorded — replay
  runs no live agent, so their recorded behaviour could not move).

  Two spawn-contract deltas, both classified rather than bypassed:

  - Desktop can now splice an **`Artifact` tool** into the session tool list, between `AskUserQuestion`
    and `ToolSearch`. It is selected by a **server-delivered session flag**, not a feature gate — the
    flag arrives with the session config alongside `memoryEnabled`/`skillsEnabled`, so it is invisible
    to gate diffing and can change without a Desktop release. It is off for a default first-party
    session, so the rendered tool list is unchanged and `Artifact` is **not** added to the pin.
  - Desktop constructs one new spawn-env key, `CLAUDE_CODE_COWORK_FRAME_ARTIFACTS`, gated on that same
    flag. It is **allowlisted rather than pinned**: a default session never receives it, so pinning
    would bake a value into the baseline that production does not send. `provenance.spawnEnvKeys` grows
    60 → 61 to record that Desktop constructs it.

  Also recorded: the `coworkRuntimeConfig` gate now serves a **1 h** (was 15 min) TTL for the host-loop
  `web_fetch` dedup cache. The harness reads that value from the baseline, so the change is carried
  automatically; the code-level fallback is unchanged and still mirrors Desktop's own absent-key default.

- **Guards for the conditional `Artifact` tool and its spawn-env key.** `sync` admits the new spread
  only while it still resolves to the frame-artifacts predicate. The check walks the real chain —
  condition → attended-turn wrapper → predicate — capturing each callee rather than hard-coding
  minified names, and matches the condition as a **whole expression anchored at both ends**. Fragment
  matching is not sufficient and was the defect in an earlier draft: appending `||!0`, flipping the
  cached arm, or replacing the trailing restriction all make `Artifact` unconditional while still
  containing the right call. A companion check asserts the env key stays gated on the **same**
  predicate as the tool, in both directions, because allowlisting a key is unconditional by
  construction — without it, making either unconditional or re-keying one of them would be absorbed
  silently. Fifteen mutations covering these paths are executed as tests.

- **Two drift sentinels** in the synced baseline's `provenance.gates`: the skill-argument collection
  guidance flag (on for a standard account) and the auto-mode permission rubric flag (dark). Neither
  flag name appears in the asar, so both carry kebab-case descriptors under the existing name caveat
  rather than names shaped like verified flags.

### Changed

- **The tools-list tail guard now pins the whole tail.** It previously anchored only on the first
  spread after `ToolSearch`, leaving everything past it unguarded — which defeated its own stated
  purpose, since a tool appended there was invisible to both it and the head check. That region already
  held a second conditional tool. The tail is now pinned through its closing bracket, with the trailing
  tool's name and its condition both **resolved** rather than shape-matched: swapping either would
  otherwise pass silently.

- **The CI boundary-parity job pulls the pinned agent-image digest instead of the floating `:2` tag.**
  CI previously certified whatever was published last while `doctor` certified the pin, so a green CI
  said nothing about the pinned image and vice versa. Both now validate the same bytes, and a pin naming
  a digest that was never pushed fails the gate rather than silently falling back to a rebuild.

### Fixed

- **The egress proxy answered nothing when a CONNECT upstream failed before the tunnel was
  established.** A transient failure on an **allowlisted** host — DNS, a TCP reset, an unreachable
  route — destroyed the client socket with no HTTP response and no log record anywhere. The client saw
  the proxy accept CONNECT and then vanish (`curl: (56) Proxy CONNECT aborted`), and container logs were
  empty, so an intermittent left nothing to diagnose. The asymmetry was accidental: the plain-HTTP
  forward path already answered 502 on the same class of failure. CONNECT now matches it and emits a
  structured `upstream_error` line.

  The 502 is written only *before* the tunnel is established — afterwards the socket is a raw tunnel and
  an HTTP status would corrupt the stream. No egress-log row is written either way: `allow` is recorded
  only after a successful connect precisely so a failed request cannot false-pass `egress_allowed`, and
  `deny` would be untrue since the host is allowlisted and nothing was blocked.

  **The egress proxy image tag moves to `cowork-egress-proxy:5`.** The tag is the cache key, so existing
  installs would otherwise keep serving the old proxy while `doctor` reported it healthy. No action is
  required — the image is rebuilt automatically when the tag is absent.

- **The two allowlisted boundary probes retry** (`--retry 2 --retry-all-errors`). A single-shot request
  through the proxy is exposed to the same ordinary transients, which failed a probe once in eight runs
  while the sandbox was behaving correctly. The off-list probes deliberately do **not** retry: they
  assert a 403 deny, and retrying a policy decision could turn a real enforcement failure into a later
  pass.

- **Release tags no longer move the floating `:2` agent-image tag.** Every release rebuilt both image
  variants and repointed `:2`, while nothing re-recorded `docker/agent-image.json` — whose digests are
  transcribed by hand from a log line that tag-push builds never emit. Pin and tag therefore diverged
  permanently after the first release. `docs/maintenance.md` already stated the intended contract (move
  `:2` in the same release that ships the updated pin); the workflow now implements it. `:2` remains
  movable by an explicit dispatch, which is how a deliberate image refresh has always been described.

### Documentation

- **`docs/fidelity-gaps.md` gains four sections.** *Artifacts — two mechanisms, neither modeled*
  (Cowork's per-artifact bind-mounts and the newer `Artifact` tool are mutually exclusive, the selecting
  flag is not observable locally, and the harness models neither); *HIPAA restriction is a process-global
  latch*; *Auto-mode permission rubric is not modeled* (dark, and scoped to sessions the harness does not
  model); and *Skill argument collection — the elicitation form branch is not reachable here*, which
  records that production splits between `AskUserQuestion` and an elicitation form while a harness run
  deterministically takes the former. That last one is an **open gap with a stated plan**, not a closed
  question. The `save_skill` section notes the tool is now additionally governed by the permission rubric.

- **`RELEASING.md` gains an agent-image checklist item.** The release process never mentioned the image
  pin, which is what let the tag drift go unnoticed. It also notes that an unchanged `Dockerfile.agent`
  still yields different bytes on a rebuild, since its `apt`/`pip`/`npm` installs are unpinned.

## [1.21.1] — 2026-08-08

### Fixed

- **The agent-image pin silently skipped the full-parity variant.** `doctor` picked the local registry
  digest by matching only the ghcr-qualified repository (`ghcr.io/owner/name@sha256:…`). Docker records a
  RepoDigest per repository the image is known by, and that set is not predictable: `cowork-agent-full:2`
  carries only the bare `cowork-agent-full@sha256:…`. The ghcr-only filter missed it, the image was
  reported as a local build, and the pin check quietly did nothing for every full-parity user — a skipped
  check reads exactly like a passing one. Both forms are now matched, with the ghcr-qualified digest
  preferred when they disagree.
- **A `main` CI run could be cancelled, making a good commit unpublishable.** `ci.yml` cancelled
  in-progress runs for any ref; `require-ci-success` requires `conclusion == success` for the SHA it
  checks, and `cancelled` is not it. Merging two PRs minutes apart left the earlier merge commit
  unpublishable. Cancellation now applies to pull-request refs only.

### Changed

- **The freshness check's "works offline" property is now a guard, not a claim.** It was argued from the
  absence of a registry call, and an absence cannot fail when someone reintroduces one. A test now asserts
  the path contains exactly one spawn — the local `image inspect` — and no registry command. Comments are
  stripped before the check, so the guard cannot be satisfied by deleting its own rationale.
- **`publish-image.yml` gains a `dry_run` input** (maintainer-facing): it runs the CI gate and the
  immutable-tag collision guard, then stops before building or pushing. The guard's *refusal* path was
  otherwise untestable without risking a repointed `:2-r<N>`, which is the one thing a digest pin cannot
  survive.

## [1.21.0] — 2026-08-08

### Upgrade notes

- **`decide --decider-dir <dir>` BLOCKS until you answer the gate — every other `decide` path returns in
  ~2 s.** That wait is the feature (it is a live rehearsal of the in-band rendezvous, using the same
  channel a real run uses), but it means a script or test that invokes this path without answering will
  sit on the 10-minute `COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS` backstop. Answer it with
  `cowork-harness answer <dir> --gate 1 --choose "<label>"`, or point the flag at a **dirty** directory
  when you only want to exercise the fresh-dir refusal (that returns immediately, exit 2).

- **`Skill.run(decider_cmd=...)` starts working in this release.** It previously exited 2 every time (see
  *Fixed*), so any Python caller that "handled" that failure — a try/except, a skip, a fallback path —
  will now take the success branch for the first time. Nothing to change; just don't be surprised when a
  previously dead code path starts executing.

### Added

- **`decide --decider-dir <dir>` — the in-band answer channel is now rehearsable in ~2 s, with no run.**
  `decide` exists to fire one sample question through your configured decider before you pay for a run,
  and it was the one channel it refused. It now drives the same `fileChannel` + `ExternalDecider` a real
  run uses, so the fresh-empty-dir refusal, the wire shape and the atomic temp+rename are the production
  ones rather than a mock: it writes a real `req-1.json`, prints the two commands that answer it, and
  blocks (10-minute backstop) until you reply with `gates`/`answer`. It is the only `decide` path that
  waits — that is the rehearsal. Rejected alongside `--decider-cmd`, `--decider-llm` and
  `--answer`/`--answer-policy`, matching the run lanes.

- **`Skill.run(decider_dir=...)` in the Python API.** The in-band channel previously had no Python
  surface at all, which made "this API only supports scripted answers and a spawned helper" simply true
  from inside it. Mutually exclusive with `decider_cmd`, raised as a `ValueError` locally rather than as
  an opaque exit 2 from the subprocess.

### Fixed

- **`Skill.run(decider_cmd=...)` was a guaranteed usage error and always had been.** The Python lane
  emitted `--on-unanswered <policy>` unconditionally, and the CLI rejects a terminal *channel* alongside
  the *policy* (the channel IS the terminal, so the policy could only ever be inert) — so every
  `run(decider_cmd=...)` exited 2 before doing any work. The policy is now emitted only when no channel
  is configured. Found while adding `decider_dir` beside it; nothing caught it because nothing asserted
  on the constructed argv.

### Changed

- **The unanswered-gate error now names every answer channel, not two of them.** With
  `on_unanswered: fail`, the hint offered a scripted answer and `on_unanswered: llm` — so the one surface
  read at the moment of being stuck taught a two-channel model. Measured against the shipped skill, agents
  asked how to answer a gate whose option set cannot be known in advance either hand-rolled the
  `req-N.json`/`resp-N.json` files that `gates`/`answer` exist to replace, or reached for `chat`, which
  produces no pass/fail verdict. The hint now lists all channels once (after the per-question block, never
  per question), names the `gates`/`answer` subcommands explicitly, and carries per-command qualifiers —
  which are derived by executing each (command × flag) pair against the real parser in CI, not
  hand-maintained, because that matrix is asymmetric in ways that are easy to get wrong (`record` takes no
  `--decider-cmd`; `run` takes no `--decider-llm`).

- **The skill's *Choose an answer path* section is now a decision tree keyed on "will this run be
  re-executed unattended?"** — a question an agent can answer about its own situation — replacing a flat
  table whose determinism column read "depends". It carries each channel's cost, the
  discover → transcribe → script loop that makes `--decider-dir` a feeder for the scripted default rather
  than a rival, and an explicit split of the two problems that were being conflated: drifting label *text*
  (a scripted problem, solved by a uniqueness-guarded substring anchor) versus an unknowable option *set*
  (the only thing that requires a live channel).

## [1.20.0] — 2026-08-07

### Upgrade notes

- **`record --dry-run` now refuses what the real `record` refuses, so a batch preflight can no longer
  green a scenario the paid run rejects.** It already ran the real loader; it now also applies the
  scenario-level refusals — `on_unanswered: prompt` (previously enforced in the single-file arm only,
  never in a directory batch) and the new unsatisfiable-assert pairing. A directory dry run reports
  **every** offender rather than stopping at the first, since the point of previewing N scenarios is to
  learn about all N in one pass, and exits 1 when any is refused. `--quiet` still mutes the readiness
  preview and never a refusal. Caught by a founder-skills consumer who noted that the refusal shipped on
  the execution path only — while `record --dry-run` is what we document, in four places, as the
  token-free way to validate a scenario, and is what their CI and re-record script call.

- **Two `COWORK_*` env vars are removed from the covered surface, and this is deliberately NOT a major
  bump.** `COWORK_EGRESS_PROXY` and `COWORK_DOCKER_NETWORK` leave the documented env-var set that
  [SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract) covers, and
  [RELEASING.md](./RELEASING.md#versioning-semver)'s rule reads "a removal … means a **major** bump".
  The exception is taken knowingly: both knobs were **provably inert** — every container-like tier built
  its egress sidecar before the env branch could execute, and `microvm` never read them at all (see
  *Fixed*, below) — so no run's behaviour changes in either direction, and no configuration that worked
  before stops working. Setting either variable was a no-op before this release and is a no-op after it.
  Recorded here rather than left silent, so the contract is departed from on purpose and once, not by
  accident. `COWORK_PROXY_IMAGE` is genuinely live and unchanged.

  Note for anyone auditing this later: `npm run check:surface` does **not** catch a removal like this.
  It compares the current code against the committed snapshot, which was regenerated in the same
  commits — so it reports `+0 -0 ~0`. The removal is visible only by diffing
  `test/fixtures/surface-baseline.json` across the release boundary
  (`git diff v1.19.0..v1.20.0 -- test/fixtures/surface-baseline.json`).

- **Four scenario shapes that lint clean today may newly fail `cowork-harness lint --strict
  --min-severity WARN`** (the invocation the CI recipe teaches). None is a false alarm — each is a
  scenario that was already not testing what it looked like it tested:
  1. A presence assertion paired with its absence sibling → new `assert-contradiction` ERROR (and the
     run itself is now refused): `questions_count_max: 0` with a gate-presence key, `no_hook_blocked`
     with `hook_blocked`, or `no_path_denied` with `path_denied`/`vm_path_denied`.
  2. `gate_answers_delivered: true` paired with `gate_answer_count_min: 0` → the zero floor no longer
     counts as a companion. **Most likely to already be in an existing corpus.** Fix: raise the floor to
     `1`, or drop `gate_answers_delivered`.
  3. `tool_called: "askuserquestion"` (or any wrong-case spelling) alongside `gate_answers_delivered`
     → the glob is case-sensitive and never matched the gate; it no longer silences the rule.
  4. `tool_called: "Ask.*Question"` → a regex-shaped value, already rejected at scenario load by the
     tool-glob schema, no longer silences the rule either. Use `Ask*Question`.

  Conversely, `gate_answers_delivered: false` **stops** warning — if you carry a suppression for it, it
  can go.

### Added

- **`record --dry-run` reports the batch cost estimate, with or without `--max-budget-usd`.** The
  summed worst-case cost from prior-run history was already computed on every batch preflight and then
  discarded unless it happened to exceed a cap — so the only way to learn what a re-record would cost
  was to bisect `--max-budget-usd` until it refused. It is now printed on the passing path (text) and
  carried as `estimatedCostUsd` + `unpricedScenarios` in the `--output-format json` payload, and the
  refusal path is unchanged. A total summed over partially-unpriced history is labelled a **LOWER
  BOUND** and names the scenarios contributing $0, so a fresh corpus's `$0.0000` can never read as
  authoritative.

- **`doctor` checks the agent image against a digest this release pins, offline.** The check previously
  asked GHCR what the floating `:2` tag pointed at *at that moment*: it needed network and
  `docker buildx` (degrading to `unknown` when either was missing), and it could only ever establish that
  two digests differ — never which one the harness expected, since a floating tag can be repointed in
  either direction. It now compares against `docker/agent-image.json`, **per variant**, so a
  `cowork-agent-full:2` user is checked against the full-parity image rather than the base one. The
  remedy is digest-addressed (`docker pull …@sha256:…`), because pulling `:2` cannot satisfy a pin to an
  older revision. A locally built image and an unpinned image both stay quiet skips, and a stopped Docker
  daemon reports `unknown` rather than a confident "built locally".

- **The agent image can be published at an immutable `:2-r<N>` revision tag without moving `:2`.**
  `docker/agent-image.json` carries the image's own revision counter (deliberately not the harness
  version — a version-keyed co-tag encodes something that was never the image's identity, and
  republishing at an existing version would repoint a tag a pin depends on). A manual
  `publish-image.yml` run now defaults to `immutable_only`, publishing `:2-r<N>` for both variants and
  leaving the floating `:2` untouched, so no existing consumer's next pull changes. Release tag pushes
  are unaffected. The workflow refuses to repoint an existing `:2-r<N>` and fails **closed** when it
  cannot enumerate tags — an inconclusive check must never read as "tag absent". See
  [docs/maintenance.md](./docs/maintenance.md#publishing-an-agent-image-revision).

- **`run` / `skill` / `record` now refuse an unsatisfiable assertion pairing before spawning, and
  `lint` reports it as `assert-contradiction` (ERROR).** Three pairs, each one assertion requiring a
  record to exist next to its sibling requiring none to, on a single evidence channel:
  - `questions_count_max: 0` with `gate_answer_count_min: >= 1`, `question_asked`, or
    `gate_answers_delivered: false` — a delivered gate records at least one question.
  - `no_hook_blocked` with `hook_blocked` — one hook-event list.
  - `no_path_denied` with `path_denied` or `vm_path_denied` — one path-denial list.

  Previously each cost a live run to discover. Where the evidence is absent both halves fail
  evidence-unavailable rather than passing, and the denial keys are hostloop-only so a wrong tier fails
  both too — no combination produced a silent both-pass, only a guaranteed one. Each negative key
  **on its own** is unaffected; `questions_count_max: 0` in particular remains the supported way to
  declare a gate-clean scenario.

  This is a **command-level** refusal, not a schema change: `schema/scenario.schema.json` still accepts
  the document, so the covered input contract ([SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract))
  is untouched and no cassette is affected.

### Changed

- **Platform baseline `desktop-1.26832.0` (agent ELF `2.1.222`), with no behavioural change to the
  modeled spawn contract.** The ELF's SHA-256 matches Anthropic's official `linux-arm64` release
  checksum. The Cowork system prompt, the sub-agent append, `coworkSyspromptMap`, the mount-mode
  anchors and the egress allowlist are all unchanged — the whole sentinel set passed. All three
  committed cassettes replay clean (re-stamped, not re-recorded — no live agent runs at replay tier, so
  their recorded behaviour could not move).

  Desktop constructs one new spawn-env key, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. It is
  **allowlisted rather than pinned**: both of its construction sites sit inside the
  `accountType === "3p"` object literal and are further conditional on `telemetry.disableNonessential`,
  alongside `DISABLE_GROWTHBOOK`/`DISABLE_TELEMETRY`, which are allowlisted for the same reason. Pinning
  it would bake a third-party-provider key into a baseline that describes the first-party spawn.

  Two gate movements worth naming, neither of which changes emulated behaviour.
  `scheduledTaskToolsApprovableByAutoMode` flipped to force-on, but Cowork spawns with
  `CLAUDE_CODE_DISABLE_CRON=1` regardless and the scheduled-task tool set is unchanged. And
  `coworkRuntimeConfig` began *serving* `skillsSyncIntervalMs`/`pluginsSyncIntervalMs` (20 min) plus
  `pluginsFullSyncStalenessMs` (1 h) instead of letting them fall back to code defaults — the code
  reading them already shipped. Cowork therefore re-syncs host skills and plugins into a live session
  roughly every 20 minutes; the harness stages once per run and never re-stages, which is a deliberate
  divergence — it stages from a git-tracked, immutable-per-run source, so there is no mid-run mutation
  for it to observe.


- **The agent image's base layer is pinned by digest.** `docker/Dockerfile.agent` builds
  `FROM ubuntu:22.04@sha256:3b06811b…` instead of the floating `22.04` tag. This Dockerfile has no
  `COPY`/`ADD` — every byte comes from the base plus apt and pip — so with a floating base, rebuilding
  an unchanged recipe produced a different image and "the recipe didn't change" said nothing about the
  contents. Rebuild locally to pick this up; the toolchain versions are unchanged (verified: Ubuntu
  22.04, Node 22.22.3, numpy 2.2.6 / pandas 2.3.3 / openpyxl 3.1.5, `LANG=C.UTF-8`, uid-1000 `ubuntu`).

### Fixed

- **`lint`'s `vacuous-gate-assert` rule was wrong in four ways, two of them silent.** The rule exists to
  catch a `gate_answers_delivered` that guards nothing, and it read only assertion **key names**, never
  their values:
  - It fired on `gate_answers_delivered: **false**`, whose premise is the opposite — that assertion
    demands a confirmed delivery *failure*, so zero gates fails it. A correct negative-path scenario was
    told, in a build-failing warning, that it passed vacuously.
  - It accepted `gate_answer_count_min: **0**` as the presence companion. `delivered >= 0` always holds,
    so the pairing everyone reads as "and a gate must actually fire" asserted nothing — a silent
    false-green wearing the correct idiom's clothes.
  - It matched `tool_called` with a case-insensitive `re.search`, but that field is a **glob**
    (anchored, case-sensitive, only `*`/`?` special). Valid globs that do pin the gate
    (`Ask*Question`, `*Question`, `**/AskUserQuestion`, `**/*`) were flagged anyway, while
    `askuserquestion` — which can never match — silenced the rule. The matcher is now a port of the
    harness's own glob engine, with a differential test against it.
  - Its remedy only ever said "add a presence companion". For a scenario that is gate-clean **by
    design** every branch of that was wrong, and the correct fix — drop the key, it asserts nothing
    there — was never named. The fix line now carries both branches, and when a scenario already
    declares `questions_count_max: 0` the finding says the key is *inert here, drop it* rather than
    telling you to add a gate.

  Thanks to the founder-skills consumer whose report surfaced the one-sided remedy; the other three came
  out of investigating it.

- **`expect_denied` could not tell an empty egress channel from an allowed host.** The expansion into
  `egress_denied` assertions was duplicated in the live run and the verify path, and both reported a bare
  `expected <host> to be denied` even when the proxy had recorded nothing at all — so a tier whose shell
  could reach no host read identically to one that correctly denied the host you asked about. The two
  copies now share one helper with three distinct outcomes, and the verify path passes its
  `egressMissing` signal through, so a `result.json` with no `egress` field reports evidence-unavailable
  rather than a failed assertion. Assertion *outcomes* are unchanged — only the message, and only in the
  cases that were previously indistinguishable.


- **Two documented networking overrides never worked.** `COWORK_EGRESS_PROXY` and
  `COWORK_DOCKER_NETWORK` sat behind values the caller always supplies — every container-like tier builds
  its egress sidecar before spawning, so the env branch could not execute in any tier, and `microvm`
  never read them at all. README advertised both as working knobs, which is worse than an undocumented
  dead branch: the docs vouched for a promise the code could not keep. They are removed rather than
  wired up — redirecting a run at a proxy or network the harness did not create would silently move the
  boundary `boundary-check` exists to prove. `COWORK_PROXY_IMAGE`, in the same README bullet, is
  genuinely live and unchanged.
- **The golden host-loop snapshot asserted a container that does not exist at that tier.** It was built
  from the container-shaped helper, so it pinned a full agent env and a `claude -p …` argv for a sidecar
  that has neither — the same "test a shape nothing runs" defect that let host-loop bash egress die
  unnoticed. It now models the real sidecar: proxy env only, `sleep infinity`, and the ELF bound
  read-only for parity. `SPEC.md` §3.4 and `dockerRunArgv`'s own doc comment both claimed no agent binary
  is bind-mounted there, which was false since the host/VM split; both now say what actually happens —
  no agent *argv* runs in the sidecar, but the ELF *is* bound.


- **`hostloop` `bash` had no egress at all — a regression dating to v0.21.0.** The VM sidecar that `bash`
  runs in via `docker exec` was spawned with an empty env on a Docker network with no route off-box, so
  shell commands could reach **neither allowlisted nor denied hosts**: both failed identically with a DNS
  error. The allowlist was not enforced there so much as bypassed by being unreachable — while
  [docs/boundary.md](./docs/boundary.md), [docs/scenario.md](./docs/scenario.md),
  [docs/session.md](./docs/session.md) and [docs/fidelity-gaps.md](./docs/fidelity-gaps.md) all described
  the allowlist as enforced at this tier, one of them recommending it for testing egress policy. The
  native host/VM process split introduced the gap by replacing the sidecar's computed env with a literal
  and orphaning the `egressProxy` parameter that fed it — the parameter kept being passed in and was
  simply never read. `bash` at `hostloop` now reaches the same allowlist as `container`, through the same
  proxy.

  A sixth `boundary-check` probe (`hostloop-bash-egress`) pins it, and it consumes the runtime's own env
  builder rather than a hand-assembled copy — the distinction that matters, since every hand-built check
  stayed green throughout the regression. It asserts an allowlisted host is reachable **and** an off-list
  host refused; the reachable half is load-bearing, because a sidecar with no egress also refuses
  everything and is otherwise indistinguishable from working enforcement.


- **The egress proxy intercepted the sandbox's own loopback traffic.** The spawn env set
  `HTTP_PROXY`/`http_proxy` (and the HTTPS pair) with no `NO_PROXY`, so a proxy-honouring client asking
  for `http://localhost:PORT` had the request diverted to the allowlist proxy — which lives in a
  *different* container, where `localhost` means the proxy itself — and answered `403`. A skill that
  started a local server and curled it failed against an unrelated process. Cowork's allowlist is a
  public-egress filter that does not stand between a process and its own loopback, and the harness
  already encoded that intent at the microvm tier (the guest firewall explicitly accepts `lo` and
  `127.0.0.0/8`) while the proxy vars defeated it. The spawn env now sets
  `NO_PROXY`/`no_proxy=localhost,127.0.0.1,::1`, scoped to loopback only. A fifth `boundary-check` probe
  (`loopback-not-proxied`) pins the behaviour and carries a positive control, so it cannot pass merely
  because nothing was proxied.
- **`boundary-check` tested a proxy configuration nothing actually ran.** Its probe passed only the two
  UPPERCASE proxy vars, and curl honours `http_proxy` in lower case only for `http://` URLs (the
  CVE-2016-5385 mitigation) — so plain-HTTP probes went unproxied. The probe and the agent spawn now
  derive their proxy env from one shared definition and cannot diverge.


- **A blank `COWORK_AGENT_IMAGE` or `COWORK_CONTAINER_RUNTIME` produced an empty ref instead of the
  default.** Both were resolved with `process.env.X ?? "default"`, which passes `""` straight through, so
  a bare `COWORK_AGENT_IMAGE=` in a `.env` or a shell export made every container invocation fail with an
  opaque runtime error. A blank or whitespace-only value now falls back to the default. Both are resolved
  in one place (`src/runtime/agent-image.ts`) rather than at the 7 and 10 call sites that previously
  duplicated the expression, so the default and the override semantics can no longer drift apart.

- **`doctor`'s stale-image warning claimed a direction it never measured.** The check compares the local
  pulled digest against whatever `ghcr.io/…/cowork-agent-base:2` points at now, which establishes that
  the two differ — not that the published one is newer. `:2` floats and can be repointed either way. The
  detail now reads `local <image> no longer matches the current published <ref>`; the `warn` status and
  the re-pull remedy are unchanged, as is JSON output (`state` already carried this).

## [1.19.0] — 2026-08-06

Follow-up to the consumer report against published 1.18.0: two false-positive/misreporting fixes in the
tooling 1.18.0 introduced, plus the scoping and summary controls those reports asked for.

### Upgrade notes

- **The new `skills[]` axis can fail a cassette that passed under 1.18.0.** It applies only at
  host-inheriting tiers (`protocol`, `hostloop`, or `cowork` resolving to hostloop). A flagged entry is a
  skill name from the recording machine; re-record against a clean environment, or scope an allow with
  `--allow-host-inventory <regex>` after reviewing the finding.
- **Conversely, `host-inventory` failures on a plugin's own agents go away.** If 1.18.0 forced you to add
  an allow regex for `<plugin>:<agent>` entries, that exemption is now automatic and the regex can be
  removed. No re-record is needed.

### Added

- **`verify-cassettes` reads `skills[]` as a `host-inventory` axis.** A skill name discloses what is
  installed on the recording machine, the same class of disclosure as an MCP server name, and the field
  was previously read by no axis. Two exemptions: the agent's built-in skills, and a `<plugin>:<skill>`
  whose plugin the same recording declares in `plugins[]`. Host-inheriting tiers only — at `protocol`
  with local OAuth the harness keeps the operator's real `CLAUDE_CONFIG_DIR`, so personally installed
  skills are discoverable there. `plugins[].name` is deliberately not scanned: that array holds only
  entries the harness supplied via `--plugin-dir`, so it carries no host inventory to find.
- **`replay --mutate` accepts scoping and cap overrides.** `--mutate-include <glob>` and
  `--mutate-exclude <glob>` (both repeatable; exclude applied last) restrict which artifact paths are
  perturbed — `*` matches within a path segment, `**` across them. Filtering is applied before planning,
  so an out-of-scope artifact is excluded from the eligible count as well. `--mutate-max-per-file <n>`
  and `--mutate-max-total <n>` raise the sampling caps (defaults 10 and 50); prefer the per-file one,
  which binds first. Any of these without `--mutate` is a usage error. Cost is linear — one full
  assertion re-run per perturbation.

### Changed

- **`verify-cassettes` prints a per-class findings count before the per-file listing**, e.g.
  `findings by class: host-inventory 240`. Informational classes such as `unscanned` are counted too, so
  the header agrees with the rows beneath it. The per-file rows are unchanged — the rollup is additive.
  JSON output is unchanged; `findings[].cls` already carried this.

### Fixed

- **`replay --mutate` reported its sample as though it were the full set.** The plan is capped at 10
  values per file and 50 in total, with the per-file cap applied first, but the report showed only
  `<uncaught>/<planned>`. It now appends the eligible total and names the binding cap — `(sampled 30 of
  120 eligible value(s); per-file cap 10 reached on 3 file(s))` — and omits the note entirely when
  nothing was truncated. A bare ratio from 1.18.0 or earlier describes the sample, not the corpus.
- **`replay --mutate` produced no machine-readable output.** Coverage now rides the JSON envelope as
  `mutation`, carrying `sampled`, `eligible`, `truncatedBy`, `caps`, and `uncaught`.
- **The `host-inventory` check flagged the scenario's own plugin agents.** At `hostloop` the agent roster
  necessarily includes the agents of the mounted plugin, so any plugin declaring agents failed the gate
  on upgrade to 1.18.0. An agent named `<plugin>:<agent>` whose plugin the same recording declares in
  `plugins[]` is now exempt, matching the existing carve-out for `mcp.config`-attached servers. The
  exemption is derived from the cassette, so it applies to recordings made before this release without
  re-recording. A foreign agent, or one namespaced to a plugin the run never declared, still flags.

## [1.18.0] — 2026-08-06

### Upgrade notes

- **`verify-cassettes` can red a previously-green gate.** The new `host-inventory` finding class flags a
  cassette recorded at a host-inheriting tier (`protocol`, `hostloop`, or `cowork` resolving to hostloop)
  that froze the recording machine's own MCP servers / agents / account into its events. Cassettes that
  passed under 1.17.0 can fail here — that is the point of the check. Re-record against a clean
  environment, or scope an allow with `--allow-host-inventory <regex>` after reviewing the finding.
- **Some previously-accepted command lines are now usage errors.** `--on-unanswered` alongside
  `--decider-dir`/`--decider-cmd` is rejected on `run`, `record`, `skill` and `probe-dispatch` (the
  channel is the terminal, so the policy was silently inert), and `record` refuses a scenario whose YAML
  sets `on_unanswered: prompt`. Drop whichever of the pair you did not mean.

### Fixed

- **`critique --help` and `docs/critique.md` misstated the tier prerequisites.** Both said the `container`
  and `hostloop` tiers need an authenticated `claude` CLI on PATH. They need a token in the environment
  or `.env` (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` as a CI fallback) — the graded turns run
  the staged agent binary, not the host CLI. The evaluator passes are what require `claude` on PATH,
  overridable with `COWORK_HARNESS_CLAUDE_BIN`.
- **A scenario's `on_unanswered:` overrode an explicit `--on-unanswered` in silence.** The precedence is
  intentional and documented (`run --help`: "per-scenario answers/on_unanswered in the YAML take
  precedence where set") — a committed scenario is the reproducible definition of its own test — but a
  user who passed the flag got no signal it had been discarded, and the run answered gates by the very
  policy they were replacing. The harness now warns when the two disagree, naming both values and which
  one applies. Silent when they agree, so a `run dir/` over a tree that already declares the same policy
  stays quiet. Precedence is unchanged.

- **`--dry-run` on `skill` validated nothing it previewed.** The dry-run early return sat above four
  guards, so `skill … --on-unanswered banana --dry-run` exited 0 — as did a `--decider-dir` +
  `--decider-cmd` pair and both `--repeat` conflicts. `--dry-run` is the advertised pre-flight check, so
  a guard it skips green-lights an invalid command line. Root cause: `resolvePolicy` both *validated*
  the flag value and *resolved* the effective policy, and every path that legitimately skipped
  resolution — the dry-run return, the `externalChannel ? "fail" : …` short-circuit — skipped validation
  with it. Validation now runs at flag-parse time, so no downstream return can bypass it, and the
  channel/`--repeat` conflicts moved above the return. The preview also reports the resolved
  `on_unanswered` and decider channel, which it previously omitted.
- **`--on-unanswered` alongside `--decider-dir`/`--decider-cmd` is now a usage error** on `run`,
  `record`, `skill` and `probe-dispatch`. The channel is the terminal, so the policy terminal is never
  constructed and the flag was silently inert — the same conflict `--decider-llm` already rejected.
- **`record` rejects a scenario whose YAML sets `on_unanswered: prompt`**, matching `run`. `record`'s
  `--on-unanswered` enum already excluded `prompt` for determinism, but the scenario field outranks the
  flag, so a TTY wait stayed reachable on the command that writes a committed fixture.
- **`probe-dispatch` usage errors named `skill` as the command.** `resolvePolicy`'s signature could only
  express `run | skill`, so `probe-dispatch` passed `"skill"` and every error envelope it raised carried
  another command's name.

### Added

- **`verify-cassettes` now fails on a leaked host inventory (`host-inventory` finding class).** A cassette
  recorded at a host-inheriting tier (`protocol`, `hostloop`, or `cowork` resolving to hostloop) freezes the
  recording *machine's* own inventory into its `system/init` and command-registry events; committed to a
  public repo that publishes your tool stack. The existing text scanner could not see it, and neither can
  `grep`: an MCP server that never connected declares no tools, so no `mcp__<server>__<tool>` token is ever
  written — the inventory lives in **name fields**. This check reads those fields structurally and flags a
  foreign `mcp_servers[].name`, a `mcp__<server>__…` tool naming a foreign server, `account.email` /
  `.organization` / `.subscriptionType`, and an `agents[]` entry outside the built-in roster. Suppress with
  `--allow-host-inventory <regex>`; if the name is a genuine Cowork server, add it to `KNOWN_COWORK_SERVERS`
  instead. **Tier-gated deliberately** — at `container` the agent is sealed, so a foreign server name there
  can only be one your scenario attached via `mcp.config`, and flagging it would fail a legitimate fixture.
  What it does *not* cover is documented in [docs/cassette.md](./docs/cassette.md): the command/skill/plugin
  catalogs and command descriptions are ungated (no clean predicate, only an arbitrary threshold), so treat
  this as a backstop against a known failure, not proof a cassette is clean.

- **`record` refuses, before spending, to write a host-inheriting recording into a repo-visible path.**
  Refusing afterwards would be worse than useless — the tokens are gone and the tempting fix is to commit it
  anyway. The message names the tier, the fix (record at `container`, or `--out` outside the repo — the
  default `cassettes/` dir is gitignored), and the override `--allow-host-inventory-fixture`. Re-recording an
  *existing* committed fixture in place **warns** rather than refuses, so `--rerecord-stale` keeps working
  and the override does not become reflexive; the finding class above still hard-gates the result.

- **Platform baseline `desktop-1.24012.11`, and the proactive skill-suggest mode is now modeled ON.**
  The Desktop bump itself is near-empty: the staged agent ELF is unchanged (`2.1.219`, same sha), the
  Cowork system-prompt constant is byte-identical, the sub-agent append is unchanged, and spawn env /
  mount layout / egress allowlist / `bgEnvStrip` do not move. The one substantive delta is
  `proactiveSkillSuggestEnabled` flipping ON — by a **server-side** rollout, not a Desktop change (it
  reads ON on earlier Desktop versions too), so an omitted `skills.proactive_suggest_enabled` now
  resolves ON and `suggest_skills` declares its proactive description plus an optional `trigger` param
  by default. `skills.proactive_suggest_enabled: false` restores the old surface per session. The gate's
  third production effect — a swapped guidance line inside Desktop's generated `<skills_instructions>`
  block — is **not** modeled, because the harness renders no such section; that is recorded in
  `docs/fidelity-gaps.md` rather than left implicit.

- **A dark drift sentinel for the `1p-direct-mcp` gate**, new in `1.24012.11`. It arms a Desktop-side
  direct-MCP pool for MDM-managed 1P servers, is inert for a standard unmanaged account, and is pinned
  (not modeled) so a production rollout surfaces as a `sync` diff instead of silent widening.

- **`record` reports what changed vs the cassette it replaced.** Re-recording is the only moment where
  "did my edit change what the agent does?" is observable — replay re-checks a frozen transcript and is
  structurally blind to it — and until now that answer was discarded: you paid for a re-record and got an
  opaque new file. An overwrite now prints e.g. `gates 2 → 0, tool calls 5 → 4`, or says explicitly that
  behaviour is unchanged. Gate count leads because a skill that silently stops asking is the regression
  this exists to surface. First records print nothing (no prior to compare), and an unreadable prior is
  simply no delta — never a failed record.

- **`replay --mutate` measures whether your assertions actually test anything.** It perturbs each recorded
  JSON artifact value (`total: 42 → 43`, `"USD" → "__MUTATED__"`), re-runs the same assertions against the
  same evidence, and reports every perturbation that **nothing caught** — each one a field your skill
  produces that no assertion verifies. Cheap: replay has already materialized the artifacts and
  `evaluate()` is pure, so there is no model call and no sandbox. **Reporting only** — it never changes the
  verdict or exit code, because an unguarded field is a gap in the scenario rather than a failure of the
  run. A corpus of 21 cassettes was found to contain seven scenarios asserting nothing meaningful, and only
  because someone wrote a throwaway script to look.

- **Gate option labels are now fingerprinted against the skill's own prose.** At record time the harness
  stamps which emitted `AskUserQuestion` labels appear **verbatim** in the skill source, per file, **in the
  order they appear in that file**; staleness re-checks them. This catches two things `skillHash` cannot:
  a catalog **reorder** (every label still exists, so an existence check passes by construction — eight
  cassettes once replayed green through exactly that), and drift in prose that is **delivered to the agent
  but excluded from the hash** via `.cowork-hashignore` / session `staleness.hash_ignore`, which is outside
  `skillHash` permanently. Only verbatim-sourced labels are stamped — a model-paraphrased label was never
  in the prose, so it cannot regress and is never checked. Reported in the existing `skill` drift class, so
  it rides `--fail-on-skill-drift` / `--strict` rather than adding a severity nobody configured; cassettes
  recorded before the stamp existed skip the check.

- **`lint` now flags a `gate_answers_delivered` with no presence companion** (`vacuous-gate-assert`, WARN).
  That key checks every gate that *fired* was delivered non-error — and **zero gates fired passes
  vacuously**, so the assertion that looks like it guards "the skill still asks its questions" stays green
  when the skill stops asking altogether. A real corpus had a 0-gate recording sit green for weeks against
  exactly this assertion. Pair it with `gate_answer_count_min: 1` (shipped since 0.25.0), a
  `question_asked` regex, or `tool_called: "AskUserQuestion"` — anything that *fails* rather than
  vacuously passes on an empty gate set. `questions_count_max` deliberately does not count: a maximum is
  satisfied by zero.

- **`docs/scenario.md` gains a "goal → key" chooser** between the strategy section and the 71-row catalog:
  *"a gate still fires at all"* → `gate_answer_count_min: 1`, *"a deliverable reached the user"* →
  `user_visible_artifact`, and so on. The table previously existed only in the agent-facing skill, so a
  human reading the docs got a reference with no way in.

- **`allow_outputs_delete: true` accepts an outputs delete you meant to happen.** Until now there was no
  way to say so: asserting `no_delete_in_outputs` fails, writing `false` is schema-rejected, and *omitting*
  the key permits nothing either — a detected delete still fails the run via the `outputs_delete` signal,
  which fires precisely **because** the key was not authored. Three doors, all locked, and the docs pointed
  at the one that does not open (that sentence is now corrected everywhere it appeared). The new key is a
  **waiver of the harness's post-hoc detection**, not a model of Cowork's `allow_cowork_file_delete`
  approval handshake — the agent never sees an `EPERM` here, so a skill that would catch one and escalate
  still behaves differently. Mutually exclusive with `no_delete_in_outputs`, rejected at load and in the
  published JSON Schema (a zod refinement has no schema representation, so the rule is mirrored by hand and
  validated by a test — otherwise an editor would green a scenario the loader rejects).

- **Delete detection now covers every delete-denied mount, not just `outputs` — with `no_delete_in_mounts`
  and `allow_delete_in` to assert on it.** Production denies `unlink`/`rmdir` on `outputs` *and* on every
  `rw` connected folder until per-mount approval; the harness only ever looked at `outputs`, so a skill
  deleting inside a connected folder passed here and would have hit `EPERM` in Cowork. The post-run scan
  now covers all of them and records each hit in `result.json`'s `scan.mountDeletes` (`{mount, command}`;
  `outputsDeletes` is unchanged, and the new array is a superset). Assert `no_delete_in_mounts: true` to
  fail on any unwaived delete in a delete-denied mount; waive per mount by name with
  `allow_delete_in: ["reports"]`, the mount-scoped analogue of `allow_outputs_delete` and a mirror of
  production's `fileDeleteApprovedMounts`. Listing `"outputs"` there conflicts with `no_delete_in_outputs`
  and is rejected at load and in the JSON Schema. An unwaived delete outside `outputs` raises the new
  `mount_delete` signal at **warn**, not fail — deliberately, because production *enforces* with `EPERM`
  while the harness only *detects after the fact*, and a warn says "this diverges" without failing a run
  the harness cannot actually adjudicate. `no_delete_in_mounts` is live-only (the scan needs real bash
  commands), so `lint` flags it on a replay-only scenario.

- **A session can model Cowork's connected *Projects*, not just connected folders.** `projects: [{uuid,
  from}]` maps to production's `userSelectedProjectUuids` and mounts each one **read-only** at
  `mnt/.projects/<uuid>` — distinct from `folders:` (`userSelectedFolders`), which can be writable. There
  is no `mode:` knob by design: production hardcodes `ro` for these, and offering a writable option would
  model something Cowork does not do. A project never becomes the session cwd — `{{workspaceFolder}}`
  stays at `outputs`. Pre-run input hashing covers projects too, so `input_unmodified` sees them.

- **`sync` gained three new hard-fail anchors, so a Desktop change cannot pass unnoticed.** The
  `coworkSyspromptMap` channel is sentinelled: its mode vocabulary is pinned as a closed set
  (`replace`/`append` — a third mode matters because `replace` *discards* the computed prompt section),
  along with the key grammar, the `{{promptCacheBoundary}}` startup invariant, and the resolution-status
  machine that governs server-supplied variants, which degrade **silently** rather than throwing. The
  mount-mode check widened from 2 pinned anchors to 5, adding `.claude/skills`, `.claude/projects` and the
  per-uuid project mount — a Desktop build quietly making one writable now fails `sync` instead of
  slipping through. And a baseline records `provenance.fcache` (content hash, embedded timestamp, feature
  count), so `sync --diff` can say whether a gate snapshot genuinely moved or was merely refetched, and
  can name a gate that starts or stops *serving* a key — an unserved key silently falls back to a code
  default that may not match production.

- **`replay --mutate` now says WHY it found nothing to perturb.** It is diagnostic and exits 0 either
  way, so `no perturbable values` was the one output most easily misread as "the feature is broken" — it
  looked identical whether the cassette held no JSON at all, held JSON whose bodies were deliberately not
  inlined, or held a document with nothing perturbable in it. Three situations, three different fixes, one
  of which is "nothing, that's by design". The manifest already knew: `truncationReason` records why each
  body is absent, so the message now names the cause and the remedy — `size` says raise
  `--max-artifact-bytes`, while an upload says uploads are never inlined, i.e. don't chase it.

- **Platform baseline `desktop-1.25927.0` (agent ELF `2.1.221`), with one behavioural change: the MCP
  tool timeout default tripled, `60000` → `180000` ms.** If you have a long-running MCP tool that used to
  be cut off at 60s under emulation, it now gets 180s — matching production. `spawn.env.MCP_TOOL_TIMEOUT`
  carries the new value; pin `baseline:` explicitly in a scenario to stay on the old one. Everything else
  holds: the Cowork system prompt is byte-identical, the sub-agent append, egress allowlist and the
  remaining spawn env are unchanged, and all three committed cassettes replay clean (re-stamped, not
  re-recorded — their recorded behaviour did not move). The recorded mount layout carries one correction
  rather than a Desktop change: the decorative `projects` row reads `mode: "r"`, read from the asar, where
  it was previously `"rw"` from a probe. Cowork mounts a connected project read-only in both versions, so
  no emulated behaviour moved — the older baseline simply recorded the fact wrongly.

### Changed

- **`status --help`, the `--output-format` help, and the docs state which stream carries what.** Human
  output goes to stderr and stdout carries the machine envelope — a deliberate convention, stated in the
  README and `docs/scenario.md` but absent from every `--help`, which is where someone writing a poll loop
  looks. The gap has a sharp edge: `cowork-harness status <dir>` writes its summary to stderr and leaves
  stdout **empty**, so `until ! status "$D" | grep -q '● running'; do sleep 30; done` matches nothing, exits
  1, and returns instantly against a live run — a silent false "done" (measured in the field returning at
  21s against a run with ~1260s left). `status --help` now names the streams and points at `--follow`;
  `docs/run-status.md`, the skill's liveness section, and the CI recipe carry the anti-pattern beside the
  working form. No behaviour change — `--follow` (JSON lines on stdout until a terminal state) and
  `--output-format json` already answered this; they were just unfindable from the help.

- **`run`'s unexpected-argument error says how to check a scenario without spending.** `run` takes no
  `--dry-run` (`skill`, `record`, `rehash`, and `prune` do, and `critique` rejects it *with* its reason), so
  reaching for it there follows the tool's own surface — and the rejection left the reader nowhere to go on a
  command that costs real money. It now names both token-free checks, which answer different questions:
  `record <file.yaml> --dry-run` (does the loader accept it) and `lint <file.yaml>` (assertion invariants —
  lenient, so a WARN there may still not run). `run --help` states the same. The pointer lives in the message
  rather than the error's `hint` field on purpose: a caller-supplied hint wins over the auto-derived
  "that global flag goes before the subcommand" guidance, which a token like `--dotenv,foo` still needs.

- **`docs/cassette.md` and the CI recipe now state that `replay` alone does not gate staleness.** A bare
  `replay` on an edited skill prints `::warning:: cassette stale` and **exits 0**; `verify-cassettes` exits
  **1** on the same tree. Both belong in CI — that is the order the recipe has always shipped, but the
  guide led with the single ungated command, so a reader following the headline had a gate that stopped
  gating the moment their skill moved. Also documents the two ways the drift signal can be silently absent:
  a pre-fingerprint cassette has nothing to check, and a `COWORK_HARNESS_GITSET` / `COWORK_HARNESS_AGENT_SCOPE`
  mismatch between record and CI downgrades real drift to a non-failing `format` finding.

- **`no_delete_in_outputs` no longer flags operations Cowork permits.** The guard treated `truncate`,
  a statement-leading `> file`, and bare `shred` as deletes. Probing a real outputs mount directly with raw
  syscalls — in a folder-connected session and a folder-less one, which agree on every operation — shows
  outputs is a **FUSE** mount whose policy is narrower than that: `unlink` and `rmdir` fail `EPERM`, and
  **nothing else does**. `truncate(f,0)`, `O_TRUNC`, `> f`, renaming within outputs, and renaming onto an
  existing destination all succeed. The harness was therefore **stricter than the product it emulates** —
  a fidelity defect pointing the opposite way from the usual concern, and a large false-positive source
  since `truncate` is ordinary English in a comment. The token set now covers only operations that unlink:
  `rm`/`unlink`/`rmdir`, `find -delete`, the python equivalents, and `shred` **with** `-u`/`--remove`
  (bare `shred` overwrites in place and never unlinks). `mv` is unchanged and was already correct — a move
  out of outputs fails (`EXDEV`, then `EPERM` on the copy-then-unlink fallback) and stays flagged, while a
  move within outputs is permitted and is not. **Runs that previously failed on an in-place truncation now
  pass**; a skill emptying a deliverable is a content bug, catchable with content assertions, not a
  containment violation.

- **A rename inside `outputs/` is no longer reported as a deletion by the filesystem diff.** The
  outputs-delete guard has two independent detectors — the command scanner and a pre/post path diff — and
  only the scanner was corrected above. The path diff still treated a vanished name as a removal, so
  `mv outputs/a.md outputs/b.md` (which production permits) could be flagged. It now clears a vanished path
  whose content reappears at a **new** path under `outputs/`; "new" is load-bearing, since matching content
  anywhere would let an unrelated pre-existing file mask a real delete. Overwrite and truncate never reach
  the check at all — the path is still present. Hashing is lazy, so a run with nothing vanished pays
  nothing, and every unprovable case still reports.

- **The CI recipe and README now lint with `--strict --min-severity WARN`.** Without `--strict` the lint
  step **cannot fail** on a WARN-class rule: it prints the finding and exits 0. So the recommended
  invocation could not enforce `vacuous-gate-assert` — a guard against silent false-greens that was itself
  a silent false-green. `--min-severity WARN` is the other half: bare `--strict` also fails on the advisory
  INFO class. If you copied the previous recipe, add both flags.

- **`assertions --list` groups its 71 keys by family** (outcome, transcript, gates, hooks, path denial,
  sub-agents, tools, skills, tasks, egress, files, budgets, verdict modifiers). The JSON envelope stays
  flat — grouping is a reading aid, not a contract. A new assertion key that matches no family fails
  `test/assertions-families.test.ts`, so adding one forces a conscious choice instead of appending to a
  dump nobody reads.

### Fixed

- **A sub-agent's own sub-agent could research, and `subagents[].webSearches` reported none.** Only
  dispatches the parent event stream surfaced become `subagents[]` entries, and the capture joined child
  transcripts to those entries by exact `toolUseId`. A dispatch made *by a sub-agent* has no entry — so
  its transcript matched nothing and was dropped with a bare `continue`. Measured on a live run: a
  three-deep chain where the only `WebSearch` ran at depth 3, `modelUsage.webSearchRequests` proved a
  search had happened, and every `webSearches[]` read empty. For a field whose whole job is grounding a
  "researched" claim, that is the worst possible shape — indistinguishable from "the sub-agent did not
  search". A descendant's searches are now attributed to the nearest ancestor that *does* have an entry,
  each tagged `viaAgentId` / `viaSpawnDepth` so a dispatch's own research stays distinguishable from one
  made beneath it; `trace --view subagent-research` marks them `[via nested agent …]`. When no ancestor
  can be found the capture **warns** naming the orphaned agent, because an empty array that silently
  means "inconclusive" is the defect being removed. Attributed, never appended: `subagents.length` backs
  the published `dispatch_count_max` assertion, and inflating it would silently re-grade existing
  scenarios.

- **A gate key the payload does not serve is no longer read as "off".** Cowork reads value-gate keys
  through an accessor carrying a per-call default, so an unserved key resolves to *that* default — and
  two keys on the runtime-config gate default to **true**. The harness returned `false` for any absent
  key, wrong in the silent direction. Reads now state the production default explicitly. Nothing moves
  today: all three keys the harness reads default to `false` at their call sites, read from the asar
  rather than assumed — which also settles whether scenarios pinning an older baseline, where one of
  those keys was unserved, might silently gain a cache. They do not.

- **A plain `npm test` could spend real money.** The fast lane excluded live suites by *filename*, so
  `live-matrix` and `live-resume-continuity` sat in it, held back only by their own `describe.skipIf`. On a
  normal dev machine — Docker up, image pulled, agent staged — the single false leg of that check is the
  token, which put `npm test` one `export CLAUDE_CODE_OAUTH_TOKEN=…` away from a paid run with no warning.
  The same hand-maintained list had already drifted the other way: `live-resume-continuity` was missing
  from the live config's `include`, so its assertions ran in **neither** lane. Both configs now use a
  `test/live-*.test.ts` glob, so adding a live suite never requires remembering two edits. (Note that the
  live suites read the token from `process.env` or `~/.cowork-harness-token`, **not** the repo `.env` —
  vitest loads no dotenv — so an empty `.env` was never the reassurance it looked like.)

- **`sync` could not read Desktop 1.25927.0 at all — it reported 25 unknown deltas and refused to write.**
  Desktop changed its *bundler*, not its behaviour: plain string literals are now emitted with backticks
  (``settingSources:[`user`]``), export names are mangled to one or two characters (`...o.TASK_TOOL_NAMES`
  became `...E.vt`), and the bundle split from 101 chunks into 341. Every literal anchor broke at once.
  `sync` now normalizes substitution-free template literals back to the quoted form before matching, and
  resolves an exported name by following the referencing chunk's own `require()` binding into the chunk
  that defines it. Both matter for correctness, not just for getting a green: the old single-bundle regex
  hop on a two-character name landed on unrelated text and produced two **false** reports — that
  `CLAUDE_DESIGN_TOOLS` was no longer empty, and that `maxThinkingTokens` no longer resolved to 31999.
  Both facts were verified unchanged in the asar by hand. This is why the run refused rather than writing:
  the refusal was right even though most of its reasons were wrong.

- **One path-hook ordering check had been failing open.** The qt-before-containment order guard — which
  catches a blanket early-allow shape in the PreToolUse hook — located its scan offset with the readable
  export name. Once that name was mangled the offset became `-1`, and the guard was written to *skip* on a
  negative offset rather than flag, so it silently stopped running instead of reporting anything. It now
  reuses the same shape-based anchor used to find the install site, and flags if the two ever disagree.
  The install-site check itself is now stronger than before: rather than matching a name, it resolves the
  spread and requires it to still be the gated `Read/Write/Edit/Glob/Grep` set.

- **`cls: "binary"` was missing from the published `verify-cassettes` schema.** The artifact path has been
  emitting it, so a consumer validating that output against `schema/verify-cassettes.json` would reject a
  valid envelope. Added, along with a test asserting every emitted `cls` literal is present in both the
  schema and SPEC.md — the enum is hand-maintained in three places and had already drifted once.

- **The pre-commit cassette check only ran when a *baseline* was staged.** A baseline moves `latest` and
  stales the fixtures, which is why the check started there — but the commit that adds or re-records a
  cassette is the one that can introduce a leak, and it stages no baseline, so it skipped the check entirely
  (including the host-inventory warning printed inside that branch). It now also triggers on a staged
  `*.cassette.json`.

- **The proactive `suggest_skills` branch now matches production.** Its empty-catalog `note` used to
  branch proactive-vs-not and return a bare "continue silently", suppressing the `search_plugins` chain
  production emits for *every* trigger state — silence is only the `proactive` tail. And because
  `trigger` is optional, a trigger-omitted call is a distinct third path that must not be told to
  forward a trigger it never supplied; it was previously grouped with `user_asked`. The proactive
  description also carried the permission to suggest without the constraints that fence it, so the
  modeled agent over-suggested relative to production.

- **`provenance.eipcChannelUuid` is no longer carried into new baselines.** It advertised itself as
  "per-build" but no extractor ever existed, so it was copied forward unchanged into all 20 baselines —
  one value, matching no shipped asar — and was structurally incapable of ever reporting drift. Nothing
  read, typed, or asserted it. The hazard was the comment: a promise of per-build freshness invites a
  provenance tripwire on ground that cannot move. Historical baselines keep their recorded value.

- **A comment could be read as an executable outputs delete.** `splitStatements` is quote-blind, so the
  body of a `python3 -c "…"` or `perl -e '…'` program string is shredded into pseudo-statements and scanned
  as shell — an English comment mentioning a delete then became evidence of one, and a read-only pipeline
  could fail a run for touching nothing. Whole-line `#` comments are now dropped before any statement-level
  decision. The ordering is load-bearing in **both** directions: bash does not treat a backslash inside a
  comment as a continuation, so `# note \` followed by `rm outputs/x` really does run the `rm` (stripping
  after joining would have hidden a real delete); while in `rm \` followed by `# outputs/x` the backslash
  *does* continue and the `#` line is an argument. Both are false negatives if mishandled and both are
  pinned by tests. The comment-bearing text still feeds the co-occurrence fast path, so
  `# stage to outputs` + `rm -rf "$UNRESOLVED"` still flags on the rm's own unprovable target.

- **The outputs-delete guard reported `ok` while a delete had been detected.** The roster derived its
  status from whether the *signal* fired, and the signal is suppressed whenever the scenario authored
  `no_delete_in_outputs` — so a scenario that authored the key and **failed** it showed a green guard. It
  now derives from the evidence: `fired` whenever a delete was detected, `ok` only on a clean scan,
  `unverified` when the scan did not run.

- **A redaction-induced verdict flip now names what flipped.** The self-check reported
  `pre-redaction pass=true → redacted pass=false` and stopped, so diagnosing it meant replaying both copies
  by hand. It now appends the failing-assertion diff (already computed, but surfaced only in a branch that
  is unreachable on a flip) **and** the verdict signal codes — both are needed, because `computeVerdict`
  folds in non-assertion signals, so a verdict can flip with an unchanged assertion set and a key-only diff
  would read `[] → []`.

- **`docs/cassette.md` never stated that replay executes nothing.** Every individual fact was documented,
  but two consequences a reader has to assemble were not. First: a skill's bundled scripts are **not run**
  on replay — a `Bash` call and its result are frozen text, and `artifact_json` reads the recorded
  `outputs/` snapshot, so a rewritten or broken `scripts/produce.py` replays green on the old output.
  Second: staleness is enforced by **`verify-cassettes` (exit 1)**, not by `replay`, which warns and exits
  0 — so a CI job running `replay` alone does not gate a skill that moved. Both are now stated in the
  mental model and next to the drift flags, with the division of labor between the two commands named.

## [1.17.0] — 2026-08-01

Reported by two consumer skills against published 1.16.0, plus a 54-item documentation review against the
source (32 findings valid). If you relied on the `semantic_matches` or `undelivered_deliverables`
documentation, re-check against the corrected text below.

### Added

- **`cowork-harness lint-skill` and `run` now report on a mounted plugin's hook declarations.** Three
  findings: `hooks-json-misplaced` (WARN — see the footgun below), `hook-event-unknown` (ERROR — a typo,
  including a wrong-capitalization one, which never runs anywhere), and `hook-event-not-served` (INFO —
  the event *does* fire, but the harness offers no assertion key for it, so a scenario cannot gate on it;
  assert the hook's observable effect instead). Before this, a plugin declaring `UserPromptSubmit`
  mounted, ran, and produced no comment of any kind — the surface was discoverable only by grepping the
  harness's own compiled output, which is exactly what one consumer had to do. The served set is
  generated from `SERVED_HOOK_EVENTS` into the existing `assertion-keys.json` channel, with the same
  drift tests as the assertion-key lists, so a hand-copied set cannot go stale.
- **New footgun flagged: a plugin's `hooks.json` must live at `<plugin>/hooks/hooks.json`.** At the plugin
  root it is **silently ignored** — no error, no warning, no log line, nothing fires, which reads exactly
  like "plugin hooks aren't supported". `lint-skill` and `run` now flag it (`hooks-json-misplaced`).
- **`verify-cassettes --allow-empty`** — an existing but cassette-free directory exits 0 instead of the
  default loud 2, for a repo that deliberately commits none (previously every caller wrapped the command
  in an `ls` guard). Scoped to *empty directory* only: `resolveInputs` now returns a typed `kind`
  discriminant, so a **missing** path still exits 2 and the flag can never green a typo — the vacuous
  pass the loud default exists to prevent.
- **`semantic_matches: {include_subagent_text: true}`** — opt in to sending each sub-agent's `kind:"text"`
  turns to the judge, for a fan-out skill whose real work is otherwise invisible to it. Opt-in because
  enlarging the judged document can re-grade an existing rubric. Sub-agent *thinking* is excluded: it
  arrives empty with `redacted:true`, so including it would pad the document with blanks a judge could
  read as "the sub-agent did nothing".
- **`analyze-skill` gains an `unscannedArtifactSources` field** (JSON) plus a text-mode warning line, so an
  explicitly-named target the artifact parser cannot read is reported instead of passing silently. See
  Fixed. Directory walks are unaffected; exit codes are unchanged.
- **New guard `test/scenario-key-vocabulary.test.ts`** — flags a backticked token within edit distance 2 of
  a real assertion key that is not one, across 8 consumption surfaces. The existing `scenario-docs-sync`
  guard checks only the forward direction (every key has a doc row) and anchors on table rows, so it could
  not see a key named in prose.

### Changed

- **The hook mechanism accepts any event; the default install is unchanged.** Binary-verified against
  `app.asar` 1.24012.9, real Cowork installs three hook event types and six hooks where the harness
  installs one — `PreToolUse` ×4 (`Task`, `Skill`, the force-ask set, `mcp__.*`), `PostToolUse:WebSearch`,
  and `UserPromptSubmit`. All six are now recorded in each baseline's `spawn.hooks` as a drift tripwire
  (with a `served` flag), and `docs/fidelity-gaps.md` gains a Hooks section. The install is unchanged
  because **none of the five unserved hooks would change observable behaviour here today**: two never match
  (the force-ask set gates four tools this harness doesn't register; the `mcp__.*` deny hook has no remote
  MCP to deny), one never triggers (`UserPromptSubmit` expands a leading `/slash`, which a scenario prompt
  is not), one cannot be sourced faithfully (`PreToolUse:Skill` injects `additionalContext` from Desktop's
  plugin/skill registry — inventing that text would put words in the model's context production never
  sends), and one is **already covered by a different path**: `PostToolUse:WebSearch` seeds
  `webFetchAllowedUrls` in production, and the harness reaches the same end by seeding provenance from
  *every* tool result (`run.ts` → `ProvenanceTracker.seedFromToolResult`), a faithful-but-less-precise
  regex-over-text subset of production's structured extractor, documented as such in
  `src/hostloop/provenance.ts`. The force-ask hook becomes worth serving if `save_skill` is ever modeled.
- **A plugin's own hooks DO fire — live-verified at `container` and `hostloop`.** There are two hook
  channels, not one: the table above is what *Desktop* installs, while a plugin's own `hooks/hooks.json`
  reaches the agent by the separate `--plugin-dir` route and is executed by the agent binary itself. A
  fixture plugin declaring `SessionStart` / `UserPromptSubmit` / `PostToolUse` had all three fire at both
  tiers. What is missing is narrower than "hooks don't work here": there is no assertion key for those
  events (you cannot *gate* on one) and no reproduction of the extra hooks production installs. A skill
  relying on `UserPromptSubmit` to inject a rule does work here; it has to be asserted via its effect.
- **Serving a bare, un-prefixed tool name is confirmed not feasible.** A live probe registered
  `SendUserFile` in `--tools`/`--allowedTools` *and* aliased it via `toolAliases` →
  `mcp__cowork__present_files`. The alias reached the wire, but the agent advertised 23 tools with
  `SendUserFile` absent, and the model reported it had no such tool. `toolAliases` only redirects a call
  the model already makes; it cannot make a name visible, and `--tools` silently drops an unrecognized one.
  This closes the open question blocking a remote-delivery emulation — that path is dead, and the
  remaining option is an MCP-prefixed name with a documented divergence.

### Fixed

- **`undelivered_deliverables` no longer fires on every remote run.** On `lane: remote` the location arm
  of the delivery check is correctly off, but the `presentedFiles` arm can never match either — no remote
  delivery tool is served, so the array is structurally always empty. Every live first-turn remote run
  that wrote a file therefore warned "never reached the user", which is a claim the evidence cannot
  support, and it forced `allow_undelivered_deliverables: true` into every remote scenario. A new
  `deliveryObservable()` predicate gates the signal, and the new **`delivery_unobservable`** warn states
  the gap instead of guessing. The two are mutually exclusive, and the new one stays quiet on a run that
  produced nothing to deliver — so net warn volume per run is unchanged, not increased.
- **`analyze-skill` reported a clean scan on files it never parsed.** The help string listed
  `.ts/.jsx/.tsx` among the sources scanned for lost artifact write-backs; the scanner reads
  `.html/.htm/.js/.mjs/.py` only (the in-process parser cannot read TypeScript or JSX). A `.ts` target
  returned no findings, empty `artifactScanned`, and `ok: true`.
- **The unanswered-gate hint named a `skill`-only flag.** Under `on_unanswered: fail` the error said
  `add: --answer "…"`, but `run --answer` exits "unexpected argument(s)". The same text appeared in the
  `run --on-unanswered first` success footer and in `docs/scenario.md`. All three now give the scenario
  `answers:` form first and label `--answer` as the `skill` path.
- **`semantic_matches`' judged document is narrower than every doc said.** Both the public schema row and
  the companion skill's copy described it as "the union of the final message, **the transcript**, and any
  authored files". The transcript is **top-level `assistant_text` only** — it excludes every
  `tool_use`/`tool_result`, and excludes **all sub-agent text**, including fork-scoped `Skill`/`Agent(fork)`
  dispatches (whose *tool* calls the harness does attribute to the main agent — the text path does not).
  A rubric claim such as *"the agent either used a tool to surface the file, or said none was available"*
  can never grade true on its first branch, regardless of behaviour: the evidence is not in the document.
  The rows now state the exclusions and warn that tool-invocation claims are unassertable — use
  `tool_called` / `present_files_called` / `subagent_dispatched` instead.
- **`undelivered_deliverables`' remedy was lane-blind in the docs.** The runtime message has branched on
  lane since 1.16.0 ("moving it under `outputs/` does not help on this lane"); `docs/scenario.md` and the
  skill still gave the unconditional "write deliverables under `outputs/`".
- **The `lane: remote` rejection advised something impossible.** Asserting `user_visible_artifact` there
  failed with *"Assert the delivery itself"* — but no remote delivery tool is modeled, so that phrase
  pointed at nothing. It now says so and offers the weaker proxy (`file_exists` + `transcript_matches`).
  Both call sites and their rationale comments are corrected together.
- **Four surfaces named an assertion key that does not exist** — `subagent_dispatched` written without its
  trailing "ed", in `docs/scenario.md`, both skill references, and the generated schema. The truncated
  spelling is also an internal `AgentEvent` type, so it appears in the repo. `lint` reports
  `unknown-assert-key` and `run` rejects the scenario at load, so no run false-greened.
- Also corrected: a nonexistent scenario path in `python/README.md` and `python/cowork_harness.py`; the
  composite Action's three outputs (`ok`, `envelope-path`, `summary-md`), previously documented only in
  `action.yml`; `docs/protocol.md`'s v1 changelog, silent for six baselines, now stating that they were
  verified by `sync`/asar analysis rather than a live re-run; ~20 rotting line-number citations in
  `docs/subagents.md`, replaced with symbol names; `--plugin-dir` described as a user-facing flag in
  `README.md`; a missing `--enable` in `docs/session.md`'s marketplace row; `scripts/` scope in
  `docs/critique.md`; `record --decider-dir`, `status --follow` and `--run-dir` in `docs/decider-dir.md`;
  three missing `Result` accessors in `python/README.md`; the duplicated shipped-examples inventory; and
  two example YAML comments with unresolvable paths.

## [1.16.0] — 2026-08-01

A founder-skills adoption pass over published 1.15.0 reported no bugs, but re-confirmed the pattern the
prior release was supposed to close: **1.15.0's own docs fix restated a true statement about one code path
(the loader) as though it covered the whole system — the second time in two releases the same failure mode
shipped, against a different sentence.** The over-generalized claim was "a key from a newer harness fails
LOUD on an older CLI — it is never silently reinterpreted." True of the loader. False of `replay`, which is
the token-free CI gate consumers actually run, and which reads a cassette's frozen scenario as a
passthrough object — an unknown top-level key there is silently ignored, and where that key conditions an
assertion (as `lane:` does), a stale CLI can report green on a cassette the current CLI fails. This release
corrects the wording everywhere it shipped, closes the structural gap that made the silent case possible
in the first place (a conditional cassette-version stamp), and folds in three smaller drift issues the same
audit surfaced.

**Upgrade notes.**

- **`replay --assert-from`/`--reassert` now hard-fails on a `lane`-flipped sibling scenario.** `lane`
  conditions three assertion keys' outcomes (`user_visible_artifact`, `present_files_called`,
  `no_scratchpad_leak`) but was missing from the recording-shaping drift guard since the key shipped in
  1.14.0 — so a command that flips `lane:` on disk and re-checks was silently re-validating under the
  **wrong delivery contract** and could report green regardless. If a currently-green `--assert-from`/
  `--reassert` invocation starts failing after this upgrade, that is the guard catching a real drift it
  should have caught since 1.14.0 — re-record, don't work around it.
- **A cassette recorded by ≥ 1.16.0 whose scenario carries `lane: remote` is stamped cassette format
  v11**, which an older harness's `replay` and `verify-cassettes` both refuse to read — loudly. Only
  `replay` offers an override (`--best-effort-future-cassette`); `verify-cassettes` has none by design, a
  verification gate being the wrong place for a "read it anyway" switch, and its refusal says to upgrade
  rather than naming a flag it does not accept. Every other scenario — including `lane: local` or
  `lane:` omitted, nearly all of them — still stamps v10 and replays unchanged on an old install; this is
  a conditional stamp, not a blanket format bump.
- **If you copied 1.15.0's "fails LOUD … never silently reinterpreted" sentence into your own
  documentation, replace it.** The corrected wording is under Fixed, below.

### Added

- **Conditional cassette-version stamping — the structural fix (`CASSETTE_VERSION` → `11`,
  `schema/cassette.v11.json`).** An unconditional version bump would refuse every new cassette on an older
  CLI, including the vast majority that use no new key — a permanent cost for a narrow problem. `record`
  now stamps each cassette with `requiredVersionFor(scenario)`: the minimum format a reader needs to
  interpret THIS scenario's values, not a flat build counter. The predicate is value-aware, not
  key-presence-aware — `lane` is `.default("local")`, so every parsed scenario carries the key, and a
  presence check would have stamped v11 on every cassette, reproducing the exact unconditional bump this
  design avoids. Only `lane: "remote"` needs v11 (a pre-`lane` reader already treats every run as
  local-delivery semantics, which is what `lane: "local"`/omitted asks for). A test pins that every one of
  `ScenarioObject`'s keys has an entry in the version-predicate map, so adding a scenario key without
  deciding its cassette-version impact reds CI, rather than silently defaulting to "harmless." `rehash`
  uses the same shared predicate (previously it re-stamped unconditionally, which would have bumped an
  entire clean, lane-free v10 corpus to v11 the moment this shipped — the exact blast radius the
  conditional design exists to avoid) and is the **recovery path** for a `lane: remote` cassette already
  recorded by 1.14.0/1.15.0 (stamped v10 there, since the conditional stamp did not exist yet). That
  recovery is conditional, not guaranteed: `rehash` **skips** a cassette whose recorded baseline has
  drifted from the live one, and **errors** on a `contentSig` mismatch rather than silently re-stamping
  over a genuine skill-content change. **This does not repair a cassette already recorded by 1.14.0/1.15.0
  until `rehash` is actually run against it, and it cannot make an already-published CLI (1.13.2 and
  earlier) speak up about a v10 cassette it already accepts** — those installs are immutable; this fix
  helps only ≥ 1.16.0 readers of ≥ 1.16.0-recorded cassettes. `replay --best-effort-future-cassette`
  remains a deliberate, documented override of the v11 refusal — using it on a cassette you did not record
  reopens the exact silent-misread hole this release closes.

- **`replay` names an unrecognized frozen top-level scenario key with a `::notice::`**, but only when the
  cassette's own `cassetteVersion` is newer than the running build understands — not on every replay.
  Diffing keys unconditionally would trip on a future release's new **defaulted** key on every replay of
  every newer cassette (Zod defaults materialize into the frozen scenario at record time, so this build
  cannot tell a meaningful value from an unknown key's default); gating on the version signal instead makes
  this notice complementary to the version stamp above rather than overlapping it, and keeps it silent on
  an ordinary same-version cassette, by design. Non-gating: it cannot move a verdict or an exit code, and it
  helps only CLIs ≥ 1.16.0 — it cannot make an already-published CLI speak up about a case it already
  accepted.

### Changed

- **`record --dry-run`'s readiness preview no longer reads like a CI failure.** Advertised in 1.15.0 as the
  token-free loader check, a usage mode where the token/agent probe is irrelevant by construction — but the
  probe still printed `✗ MISSING` for both, which a CI log reader (and at least one consumer) reasonably
  mistook for a broken pipeline. The lines are now worded as informational ("fine for `--dry-run`; only a
  real record needs it") instead of `✗`-prefixed. **`--quiet` now suppresses the preview block** (it was
  accepted but a no-op on `record` before this release) — and, deliberately, nothing else: it does not
  suppress `✗ broken:`/`skipped:` lines or change an exit code, because muting the loader check's only
  named output would gut the feature 1.15.0 documented while leaving the exit code red — the worst of both.
  That combination is the point: **`record scenarios/ --dry-run --quiet` is the load gate a CI step wants**
  — no output and exit 0 when every scenario loads, and on failure the `✗ broken:` line naming the file and
  the rejected key, exit 1. It belongs next to `lint` rather than instead of it: `lint` only *warns* on an
  unknown key, so a scenario that lints with warnings can still be unloadable, and a green `lint` is not
  evidence the suite runs. Documented as a pipeline stage in `references/ci-recipe.md`.

### Fixed

- **The unknown-key strictness rule is corrected at every site it shipped wrong** —
  `docs/scenario.md`, `docs/cassette.md`, `SKILL.md`, and `references/scenario-schema.md`. 1.15.0's own
  docs fix stated: "a key from a newer harness fails LOUD on an older CLI — it is never silently
  reinterpreted," with no path qualifier. That is true of the **loader** (`run`/`skill`/`record`) and false
  of **`replay`**: a cassette's frozen scenario is a passthrough object, so a top-level key the running CLI
  doesn't know is carried but never consulted, and where that key conditions an assertion (as `lane:`
  does), a stale CLI can report green on a cassette the current CLI fails. The corrected statement also
  keeps the guarantee this class of fix keeps dropping: frozen **assertions** are not loose — an
  unrecognized assertion key in a same-or-older-version cassette is still a hard reject (exit 2), so
  `replay` does not validate nothing. Every site states the same three regimes: a ≥ 1.16.0-recorded
  `lane: remote` cassette (v11, refused loudly by an older `replay` and `verify-cassettes` alike); a
  1.14.0/1.15.0-recorded one (v10, still silently misread — `rehash` to fix); and **`replay
  --best-effort-future-cassette`**, which overrides the v11 refusal and reopens the silent-misread path on
  purpose. That override is `replay`-only — `verify-cassettes` does not accept it.

- **`record --help` documents every flag `record` accepts.** Two hand-maintained usage strings had drifted
  in both directions: `--help` was missing `--max-budget-usd` and `--decider-model` (both present in the
  usage-error string), and the usage-error string was missing `--dry-run` (present in `--help`). Both
  strings are now built from one exported flag set (`RECORD_BOOLEAN_FLAGS`/`RECORD_VALUE_FLAGS` in
  `src/run/cassette.ts`), and a test asserts every flag in that set appears in `record --help` (with an
  explicit allowlist for the two deliberate no-ops, `--verbose`/`--quiet`'s pre-1.16.0 behavior) — so this
  class of drift reds CI instead of waiting for a consumer to grep for a flag that exists.

- **`lane` is added to the `--assert-from`/`--reassert` recording-shaping drift guard.** `lane` conditions
  assertion outcomes exactly like the six fields the guard already compared, but was never added when the
  key shipped in 1.14.0 — see the Upgrade note above for what this changes for a currently-green command.
  The three places that enumerate the drift set for a human (the reassert notice, and two usage strings)
  now derive from one shared field list instead of hand-repeating it, closing the same drift class as the
  `record --help` fix above — two of those three strings were already stale before this release (missing
  `fidelity`/`requires_capabilities`, not just `lane`).

- **`--dry-run` and `--rerecord-stale`'s mutual exclusion is now documented**, in `record --help`,
  `docs/cassette.md`, and `references/task-recipes.md`. The guard existed before this release and was
  deliberate — dry-running a stale-only re-record would need real filesystem selection work `--dry-run`
  doesn't do — but 1.15.0 advertised the cumulative budget cap specifically for `--rerecord-stale` sweeps
  without mentioning that the exact form it was advertising cannot be pre-flighted. The documented
  workaround: dry-run the plain `scenarios/` directory instead — a superset of what a `--rerecord-stale`
  sweep would actually touch, so it's conservative in the right direction.

## [1.15.0] — 2026-07-31

Documentation-led release. A consumer adoption pass over 1.14.0 found no bugs — but reported a
confidently wrong conclusion about how `replay` sources a scenario, and tracing *why* found that our own
docs taught it. Most of what follows is that root cause; one new flag and one new message came out of it.

### Added

- **`record --max-budget-usd <x>` — a cost cap on the paid path.** `run` and `skill` have had one since
  1.13.0; `record` never did, despite being the widest-blast-radius spend in the CLI (it takes a `dir/`,
  has `--rerecord-stale`, and parallelizes up to `--concurrency 8`, so a re-record sweep is 16+ live runs
  with nothing bounding it). On a batch the cap is **cumulative**, not per-scenario: it sums each
  scenario's worst observed cost from run history and refuses **before the first spawn** if the total
  exceeds `x`. That is the reading `--max-budget-usd` already carries under `run --repeat`, applied to the
  other batch lane — a per-scenario cap on a 16-scenario batch would permit 16× the number you typed.
  At **`--concurrency 1`** a running total additionally stops the batch once the cap is reached, and the
  scenarios that did not run say so explicitly (they have no cassette and stay stale). **Above
  `--concurrency 1` the running-total stop is disabled and the tool says so out loud** — with N runs in
  flight the total is only known once an overshoot is already paid for, and a cap that fires after the
  money is gone is a false guarantee, not a cap. Unpriced scenarios contribute $0 and are named, with the
  estimate labelled a LOWER BOUND, rather than being silently treated as free. Missing cost telemetry
  mid-batch disables the running total loudly (once) instead of counting an unknown as zero. The gate also
  runs under **`--dry-run`**, refusing identically — a preview that reports clean and is then refused for
  real is a false preview.

- **A scenario that fails to LOAD is now announced on the default `replay` lane.** Plain `replay` reads the
  sibling YAML to emit its `assert:`/`prompt:` drift notices, inside a `catch` that swallowed *everything*.
  That catch is right for a half-written file — a mid-edit sibling must never break a deterministic
  replay — but it also swallowed **schema** errors, so a scenario carrying a typo'd or too-new key replayed
  with no signal at all. It now emits a `::notice::` naming the offending key and pointing at
  `record --dry-run`, while read/YAML-parse failures stay silent as before. Notice only: it cannot move a
  verdict or an exit code. This was the mechanism behind the adoption report's wrong conclusion — the
  loader's loud rejection was invisible through `replay`.

### Changed

- **The freeze rule is documented at the right scope.** A cassette freezes the **whole scenario** —
  `name`, `prompt`, `session`, `baseline`, `fidelity`, `lane`, `skills`, `answers`, `execution`,
  `requires_capabilities`, `expect_denied`, `assert` — and a plain `replay` evaluates every one of them
  from the frozen copy. Every place we documented this scoped it to `assert:` ("Where `replay` reads
  `assert:` from…", "To iterate on **assertions** token-free…"), across eight sites. That scoping did not
  merely omit the general rule, it implied the opposite: if only `assert:` were frozen, the other keys
  would come from disk — which is exactly the inference the adoption report made about `lane:`.
  `docs/scenario.md`, `docs/cassette.md`, `README.md`, `SKILL.md` and the `scenario-schema` / `ci-recipe`
  references now state the scenario-wide rule first and keep the `assert:` detail beneath it, and spell
  out that **only `assert:`/`expect_denied:` can be opted back to disk** — an edited `lane:`/`fidelity:`/
  `baseline:` reaches a replay only by re-recording. The `docs/scenario.md` section was retitled to match;
  its previous slug is preserved as an anchor alias so existing links keep resolving.

- **The unknown-key strictness contract is written down.** The loader (`run`/`skill`/`record`) rejects
  every key it does not know — a hard `Unrecognized key: "<k>"`, exit 2 — while `lint` only warns and
  exits 0. Nothing said so, and the asymmetry runs opposite to the natural guess: **`lint` is the lenient
  surface, the runtime is the strict one.** Two consequences now documented: a scenario that lints with
  only warnings may still be unloadable, and **a key from a newer harness fails loud on an older CLI
  rather than being silently reinterpreted**.

- **`record --dry-run` is documented as the token-free loader check**, not just a recording preview. It
  runs the real loader and needs no token or staged agent to report a schema error (exit 2 for a single
  file; a directory reports each `✗ broken:` file and exits 1). It is the only path that reaches the
  loader *and* is side-effect-free on a valid scenario.

- **`lane:` now states its version floor (≥ 1.14.0).** On an older CLI a scenario carrying it does not load
  at all — it is **not** reinterpreted as `lane: local`. The floor was documented nowhere when the key
  shipped; it is now in `docs/scenario.md` and `references/scenario-schema.md`.

- **`RELEASING.md` gains "top-level scenario key" as a documentation-trigger category**, with a required
  clause: state the version floor and what older CLIs do with the key. `lane:` cleared every
  machine-enumerable guard — schema, `lint`'s valid-key list, the surface snapshot — and still shipped with
  its behavioural contract undocumented, in a category the checklist did not name.

### Fixed

- **The egress-proxy reclaim command in 1.14.0's notes omitted `cowork-egress-proxy:1`.** That tag really
  shipped (it was the original, bumped to `:2` early), so anyone who installed before that bump keeps a
  stale image by following the published command. The 1.14.0 entry is left as shipped; the corrected
  command is:

  ```bash
  docker image rm cowork-egress-proxy:1 cowork-egress-proxy:2 cowork-egress-proxy:3
  ```

  Keep `:4` — that is the current tag.

### Internal

- `preflightBudget` moved from `src/cli.ts` into a new `src/run/budget.ts` so `record` (in
  `cassette.ts`) can reach it without an import cycle. Pure extraction — `run`/`skill` behaviour is
  unchanged and the move required no test edits.

## [1.14.0] — 2026-07-31

### Added

- **`critique` accepts `--fidelity cowork`.** It was refused on the grounds that `cowork` resolves
  dynamically and "would make the graded tier baseline-dependent" — conservative rather than necessary.
  The determinism that actually matters is *within* a critique: both turns must run at the same tier,
  because a cross-tier `--resume` is blocked fail-loud by the session-manifest fidelity stamp. So
  `cowork` is now resolved **once, before either turn is spawned**, and both turns receive the resolved
  literal — the invariant is preserved exactly, and the literal `cowork` never reaches a child. This is
  the same argument that lifted the container-only pin to `container|hostloop` in 1.12.0. The resolution
  reads the pinned baseline's loop gate exactly as a plain run does, echoes `[loop] cowork → <tier>` to
  stderr, and is reported as **`requestedFidelity`** next to the tier that ran, so a report never reads
  as though you named the tier yourself. It also accounts for `--dotenv`: the child CLI loads that file
  before deciding, so its `CLAUDE_FORCE_HOST_LOOP` is read here too (read, **not** applied — loading the
  file into critique's own env would hand every variable in it to the evaluator's spawned CLI). An
  unreadable baseline is rewrapped into a sentence naming both the cause and the escape hatch, rather
  than surfacing a bare `ENOENT` — a worse diagnostic than the refusal it replaces would have made this
  a net regression for the person hitting it. `microvm` and `protocol` stay refused, each with its own
  reason. **`chat` still refuses `cowork`** — its fidelity is fixed at parse time with no gate
  resolution at all, which is a differently-shaped change; deliberately out of scope here.
  The related gap on the **tier** axis — `stats` averaging runs from different tiers together without
  saying so — is closed in this same release; see *"`stats` warns when an aggregate spans more than one
  fidelity tier"* below. It was reachable by passing different `--fidelity` values explicitly and was not
  introduced by this change.

- **Scenarios can declare which Cowork lane's delivery contract to test against — `lane: local|remote`.**
  Cowork runs a session in one of two lanes, chosen per session by the user ("Run this task: In the cloud /
  On your computer"), with cloud the default for new sessions — and they disagree about what *delivered*
  means. On `remote`: location delivers nothing (a remote container has no auto-delivering outputs
  directory and is reclaimed at session end), so `user_visible_artifact` fails as unverifiable rather than
  passing on a file the user never receives; `present_files` is not served at all, because a local MCP
  server cannot reach a remote session; and the two `present_files`-shaped assertions fail as can't-verify.
  Default `local` leaves every existing scenario unchanged. Orthogonal to `fidelity` (isolation tier) and
  `execution` (where the run happens) — a `lane: remote` scenario still runs locally. Scoped to delivery
  semantics: the remote device bridge (`device_bash`/`device_commit_files`) stays deliberately unmodeled,
  since emulating it faithfully would mean real command execution and real writes on the operator's
  machine on behalf of a simulated session. **A `lane: remote` scenario that also asserts
  `present_files_called`, `no_scratchpad_leak` or `user_visible_artifact` is rejected at LOAD time** —
  those keys cannot pass on that lane, and an authored assertion that can never pass should cost a config
  error rather than a paid run that fails at assertion time.

- **`ended_with_question` now consults the lane too.** This pre-existing `warn` signal treated the presence
  of an `output`-class file as evidence the run produced something, and stayed quiet on that basis. That
  reasoning holds only where location delivers: on `lane: remote` an `output`-class file has reached nobody,
  so it no longer suppresses the warning — which is the lane where "the agent ended by asking a question
  instead of finishing" matters most. Behaviour on `lane: local` (the default) is unchanged.

- **A run now warns when the skill produced deliverables it never delivered.** New `warn`-severity verdict
  signal `undelivered_deliverables`: files the run produced but never got to the user. **What counts
  depends on the lane**, because what "delivered" means does: on `local`, where the outputs directory
  delivers by location, a candidate is a file written outside every user-visible root; on `remote`, where
  location delivers nothing, every produced file is a candidate — a file sitting in `outputs/` included. It
  fires without any assertion being written — which is the point, since `present_files_called` covers the
  positive case only when an author thought to ask for it, and the runs that most need this are the ones
  where nobody did. Observed motivating case: a real run created 23 files, delivered 3, and reported
  success. On a remote Cowork session an undelivered file is destroyed with the workspace; on a local one
  it persists but stays invisible — either way the user does not get it. **Silent when the evidence cannot
  answer the question** — no workspace walk, a tier that runs no scratchpad walk, absent delivery
  telemetry, or a resumed turn (where the scratchpad still holds files delivered on an earlier turn,
  because `present_files` copies rather than moves) — since "cannot tell" must never read as "clean".
  Opt out per scenario with **`allow_undelivered_deliverables: true`** when a skill legitimately leaves
  intermediates, caches or downloaded inputs behind; the signal is warn-only and never fails a run alone.
- **`result.json` gains `scratchpadEvidenceComplete`** — whether a complete scratchpad walk observed this
  run. It is what lets the warning above distinguish "nothing was left undelivered" from "we could not
  tell", so a consumer reading the absence of that signal knows which of the two it means.
- **`present_files` is served at the `hostloop` tier.** Real Cowork registers the tool unconditionally and
  `alwaysLoad`, and its handler has both a VM branch and a host-loop branch — and production runs host-loop
  mode. The harness served it only at `container`, so its parity-claiming tier was one `alwaysLoad` tool
  short of production's toolset, which can change how a model interprets "deliver this". The hostloop
  handler mirrors production's own host-loop branch: it validates and **passes the path through without
  promoting** (there is no scratch→outputs copy at that tier). Every path is checked with `lstatSync`
  (symlinks and non-regular files rejected outright) then `realpathSync` + containment under the session's
  outputs dir or a connected folder; one rejected path aborts the whole call, as production does, rather
  than partially succeeding. `present_files_called` now works at `container|hostloop`.
  `no_scratchpad_leak` stays container-only on the merits — hostloop never promotes, so there is no copy
  to leak — and its message now says that instead of implying the tool is missing.
- **`workspaceFiles[].class` gains `scratchpad`** — files the agent wrote outside every user-visible root,
  the class the field previously left unimplemented. This is what makes the warning above computable: the
  verdict sees only `RunResult`, and the undelivered side of the ledger reached it from nowhere. Existing
  consumers filter by class and are unaffected; the visible-root walk is deliberately not widened, so
  `no_unexpected_files` (which walks the same prefixes itself) cannot change verdict as a side effect.

- **`stats` can query and group by skill generation.** `--skill-hash <prefix>` and `--label <tag>` narrow
  to one generation of the iterate-across-fixes loop, and `--group-by scenario|skill-hash|label` splits a
  scenario per generation instead of aggregating across them — the A/B comparison in one command instead
  of a hand-written `jq` pipeline. The index has carried `skillHash`/`runLabel` since they were added *for*
  a group-by step; until now nothing could query them. `--skill-hash` matches the 12-char prefix the index
  stores or the full hash from `result.json` (6-character floor). `--last <n>` now windows per **group**,
  which is unchanged at the default grouping.
- **`stats --runs` lists the individual runs behind each summary** — timestamp, verdict, `runId`,
  `skillHash`, `runLabel`, cost, duration, and `(pruned)` when the run dir is gone — so which generation a
  run belonged to is visible without opening its `result.json`. No command listed individual runs before
  (`list` lists platform baselines; `stats` only aggregated). It selects exactly the rows the summary above
  it aggregated, through the same filter path, and adds a `runs` array to the JSON envelope only when asked.

- **`stats` warns when one aggregate spans more than one skill generation.** Runs from before and after a
  skill change accumulate in the same scenario directory, so a plain `stats <scenario>` could silently
  average pre-fix and post-fix runs into one line. Each summary now carries `distinctSkillHashes`, and a
  window > 1 emits a `::warning::` on stderr naming both remedies. Rows lacking the grouped-on field (the
  `chat` lane, a run that mounted no skill) are excluded from grouping and reported as `hashlessRuns`,
  never bucketed under a blank key.
- **The single-run verdict footer reports the run's cost.** Previously only a `--repeat` batch printed a
  total, leaving the open-ended lane — where spend is least predictable — silent. Absent cost telemetry
  prints nothing rather than `$0.0000`, and the replay lane is suppressed (a replay carries the *recorded*
  cost of the original paid run; printing it would misreport fresh spend).
- **`--max-budget-usd` works without `--repeat`.** On a single run it is a **pre-flight** refusal: if the
  scenario's own cost history exceeds the cap, the run is refused before spending — on the plain, the
  directory-sweep, and the `--matrix` paths alike, and for a sweep every scenario is checked before any of
  them runs. There is no live cost signal to abort a run mid-flight on — `cost.usd` arrives only with the
  SDK result message — so with no priced history it warns loudly and proceeds uncapped rather than
  pretending the cap is enforced. `--allow-budget-stop` still requires `--repeat`: it modifies a batch
  verdict. `critique` still rejects the flag, now for an accurate reason: it spends across four workloads,
  so a cap pre-flighted from single-run history would gate on the wrong number.

- **`lint` flags `lane: remote` against the assertion keys the runtime rejects.** *(Author-time
  enforcement of the load-time rule described under the `lane` axis above — same three keys, checked
  before you spend rather than at load.)*
  `present_files_called`, `no_scratchpad_leak`, and `user_visible_artifact` are refused at scenario
  **load** time on that lane — it serves no `present_files` and delivers nothing by location, so these
  keys can only ever report cannot-verify. The linter previously said nothing, so the first signal was a
  run that refused to start. New finding tag `lane-remote-incompatible-key` (ERROR). The tier rules
  (`container-only-key-off-container`, `present-files-key-off-tier`) are suppressed on `lane: remote`,
  since the lane check fires first regardless of tier and their "use a different tier" advice cannot help
  there. `manifest-needs-snapshot` is suppressed too, but only for `user_visible_artifact` — the one key
  that is both manifest-backed and lane-rejected — since the ERROR above already covers it and a
  redundant INFO about a key the scenario can never load with would just be noise.

- **`stats` warns when an aggregate spans more than one fidelity tier, and `--group-by fidelity` splits
  it.** `container` and `hostloop` runs of one scenario were averaged together silently — the same
  unlike-things gap the skill-generation warning covers on the other axis, and the one the 1.14.0
  `--fidelity cowork` entry named as still open. Each summary now carries `distinctTiers` and `tiers`,
  computed over `effectiveFidelity ?? fidelity` — the tier that actually **ran** — a total key, so nothing
  is ever excluded from this grouping. The warning names the tiers and the remedy, and fires independently
  of the skill-generation warning. `--group-by fidelity` splits per effective tier, and `totalUsd` splits
  with it — per-tier cost in one command. A `--fidelity` filter on `stats` was considered and deferred: a
  flag is covered surface (removing it later would be a MAJOR bump), and its only unique capability —
  comparing generations within a single tier — has no demonstrated workflow yet. `stats --runs` gains the
  same field per row: `RunListEntry.fidelity`, computed by the same `tierOf` helper the summary grouping
  keys on, so a listed run's tier can never disagree with the summary aggregating it. Total by
  construction — every row has one — unlike `skillHash`/`runLabel`, which are conditionally omitted.
  JSON-only: the text-mode run line (`formatRunLine`) is unchanged.

### Changed

- **The supported Node floor moves from 20 to 22.** Node 20 reached end-of-life on 2026-04-30 and
  receives no security patches; `engines` and `doctor` both claimed it was fine. `doctor`'s Node check
  **fails** on 20 and its title reads `Node ≥ 22`, so `doctor` exits 1 and any script gating on it stops.
  Other commands are not gated on the Node version and behave as before. For anyone installing the
  harness **as a dependency**, `engines` is advisory: npm warns (`EBADENGINE`), pnpm honours
  `engineStrict` (default off) for dependencies, Yarn 1 enforces (`--ignore-engines` bypasses), Yarn
  2+/Berry does not check it. Installing on Node 20 therefore keeps working and `doctor` is the gate that
  reports the problem. (Measured against pnpm 10.33: it warns and proceeds by default, including for a
  project's own `engines`; set `engine-strict=true` to make it fail. pnpm's own documentation still
  describes the project case as unconditional — the observed behaviour is what is stated here.)
  **Upgrade to Node 22 or 24 before taking this release.** The agent sandbox's own pinned Node is
  unchanged: it tracks what Cowork ships, not what is current.

- **CI runs on Node 24 (Active LTS), with a dedicated job pinned to 22** so the declared floor is
  exercised rather than assumed; that job gates the merge context. The packaged Action installs Node 24 —
  note it uses a composite action, so steps after it in your job also see Node 24.

- **If you copied the CI recipe from the shipped skill, update the runner in YOUR repo.** The recipe in
  `references/ci-recipe.md` pinned `node-version: '20'` and now pins `'24'` — but that only fixes the
  copy we ship. A workflow pasted from an earlier release still runs Node 20 in your repository, where
  this release's CLI will fail `doctor` and warn `EBADENGINE` on install. Bump `node-version` to `'22'`
  or `'24'` wherever you pasted it.

### Fixed

- **`stats` under-reported a `critique`'s cost by 65–84%; it now reports a group `total=`.** A critique's
  three index rows partition its spend disjointly — the two graded turns carry their own, and the roll-up
  row's `costUsd` is the two evaluator passes *only*, set that way so the sum is exact and double-counts
  nothing. But `stats` dropped every roll-up row before any filter ran, so the one consumer that sums
  `costUsd` never saw the partition. A live critique costing **$1.0588** was reported at **$0.368**
  unfiltered and **$0.1708** under `--label`. `critiqueTotalUsd`, added in 1.13.0 for exactly this, had
  writers, a type guard and tests — and no reader. Root cause: one predicate answered two different
  questions. *"Is this a run?"* is correctly **no** for a roll-up (it has no verdict or duration, and
  counting it drags `passRate` toward 1); *"does this carry spend?"* is **yes**, and the same gate said no.
  Those are now separate predicates. **Every count, rate and percentile is unchanged** — cost `p50`/`p95`
  stay per-run, since the median of a graded turn, a reflection turn and an evaluator pair is not a typical
  run cost. The new **`totalUsd`** is the figure that prices a critique whole. It is `undefined`, never
  `$0.0000`, when nothing was priced, and new **`unpricedRuns`** counts rows with no cost telemetry so a
  total that is a floor says so. **`--max-budget-usd` is deliberately untouched**: its pre-flight asks
  "will my next RUN breach this cap", so it still reads run-only history — feeding it evaluator spend would
  have refused runs costing a fifth of the cap. Text output appends `total=$X` after the cost percentiles
  (and `(N unpriced)` when relevant), so a consumer scraping the existing line keeps matching.
- **A `--label`-filtered total is now complete.** `--label` reaches a critique's task turn but deliberately
  not its reflection turn (labelling it would inject a near-always-green row into the labelled group and
  inflate `passRate`), so a label-filtered set held turn 1 + the roll-up and silently dropped turn 2 — 19%
  light. Rows are now re-admitted by shared `runId`, since a critique is one session. Those re-admitted
  rows count toward **cost only** — never `runs`, `passRate` or any percentile — so the pass-rate property
  the labelling rule protects is preserved exactly. Expansion applies only to the identity filters
  (`--label`, `--skill-hash`) and never re-admits a row excluded by `--scenario`/`--since`/`--baseline`/
  `--branch`. `--skill-hash` needed nothing: all three rows already carry the hash.

- **The egress proxy binds loopback by default, instead of the wildcard.** An unqualified `listen(0)`
  bound `*:<port>`, and on macOS `SO_REUSEADDR` lets that coexist with an existing `127.0.0.1:<port>`
  listener — so the ephemeral allocator could hand the proxy a port an unrelated long-lived process
  already held on loopback, and the kernel would route every `127.0.0.1` connection to the **more
  specific** listener. The proxy silently received nothing; the caller waited for a
  `200 Connection Established` that never came. Root-caused from an intermittent test failure (~0.13% per
  proxy start on a machine with 21 parked loopback listeners), reproduced 12 times, and verified at 0
  failures in 5600 iterations after the change. A collision is now a loud `EADDRINUSE` rather than a
  silent steal. The two places a guest dials the proxy over a real interface — the microVM host proxy and
  the Docker sidecar — pass `host: "0.0.0.0"` explicitly, so production behaviour is unchanged. **The
  sidecar image tag moves to `cowork-egress-proxy:4`** so existing installs pick up the new CMD.

- **The egress-proxy image builds on a supported Node base, and existing installs actually receive it.**
  It was built `FROM node:20-slim`. Both `ensureProxyImage` and `doctor` reuse that image on **tag
  existence alone**, so changing the Dockerfile would have reached nobody who had already built it —
  their machine would keep serving egress from an end-of-life base while `doctor` reported it healthy.
  The tag therefore moves to **`cowork-egress-proxy:4`** (via `:3`, which never shipped — see the egress
  bind fix below), which makes the next run rebuild it automatically. **Reclaim any old images with
  `docker image rm cowork-egress-proxy:2 cowork-egress-proxy:3`** — nothing removes them for you. If you pin `COWORK_PROXY_IMAGE`, rebuild that image yourself. **If you bring the proxy up
  via `docker/compose.yml`** rather than letting the CLI manage it, that service is built under compose's
  own project namespace and is not covered by the tag bump — rebuild it explicitly with
  `docker compose -f docker/compose.yml build egress-proxy`.

- **`--compact`/`--demo` suppress the `[status] <outDir>` line, and now say so.** The line is a raw host
  path, which those shareable-output modes exist to withhold — but `SKILL.md` stated the line was printed
  unconditionally and neither flag was documented in the skill at all, so backgrounding a run with
  `--compact` and capturing stderr looked like the harness had no liveness signal. `status.json` is still
  written either way; `cowork-harness status` also accepts the run-dir root.
- **A corrupt `skillHash`/`runLabel` in `index.jsonl` is quarantined.** Both became load-bearing once
  `stats` could filter and group on them; a wrong-typed value is valid JSON and would previously have
  reached `buildStats` and thrown.
- **`SKILL.md` documents where a run's cost lives** — `result.json` → `cost.usd` (the SDK's
  `total_cost_usd`), noted as a different source from summing `modelUsage[].costUSD`, which is what
  `trace --view usage` reports and which can legitimately differ.

- **The verdict footer prints `warn`-severity signals. It never did.** Only `fail` signals were rendered,
  and only in the branch a failing run takes — so on a green run every warn (`undelivered_deliverables`,
  `ended_with_question`, `scan_unavailable`, `exec_infra_error`, `prompt_asset_missing`) reached
  `result.json` and no surface a human reads. That is backwards for a severity whose entire purpose is to
  fire when *nobody authored an assertion*: the runs that most need the warning are the ones where nobody
  will go looking for it. Warns now render on pass and fail alike, prefixed `·` (never `✗` — a warn does
  not change the verdict, and marking it like a failure would teach readers to skip it) and never
  truncated, since the message *is* the finding. `non_deterministic` is excluded because the meta line
  already carries it. Found by running this release's own new signal live and watching it not appear.

- **`undelivered_deliverables` described the wrong lane's failure on `lane: remote`.** The candidate set
  is lane-dependent — on remote nothing is delivered by location, so a file under `outputs/` counts — but
  the message text was written for the local case only. A remote run therefore named `outputs/report.md`,
  asserted it was "written outside every user-visible root", and prescribed "write deliverables under
  `outputs/`" as the fix for a file already sitting there: self-contradictory, and the remedy is not even
  true on that lane. The explanation now branches on the same predicate that selects the candidates, and
  both variants name `allow_undelivered_deliverables` so the reader is told how to silence it. The
  pre-existing tests asserted only the signal *code*, which is why the prose could be wrong and green.

- **`lint` no longer errors `present_files_called` on `fidelity: hostloop`.** *(The author-time linter
  catching up with the runtime change above — a separate code path in the bundled `scenario.py`, not a
  second fix to the same one.)* The harness has served
  `present_files` at `container` **and** `hostloop` since the host-loop handler landed, but the linter
  still treated the key as container-only and hard-failed a scenario the runtime accepts. The key set is
  now split: `present_files_called` is flagged only on `protocol`/`microvm` (new finding tag
  `present-files-key-off-tier`) and is clean on `container`, `hostloop`, and `cowork` (which resolves to
  one of the two). `no_scratchpad_leak` keeps its container-only ERROR on the merits — hostloop serves the
  tool but passes a validated path through without promoting, so there is no scratch→outputs copy to leak
  — and its message now says that instead of implying the tool is missing.

- **Every `trace --view` help list now derives from one catalog.** `src/cli.ts` carried the view list in
  three places — the top-level command catalog, `trace --help`'s `SUBCOMMAND_USAGE.trace`, and the
  no-target usage error — and two of the three had drifted, omitting the `subagent-research` view even
  though the `--view` validator accepted it. All three now interpolate one `TRACE_VIEWS` constant, moved
  above the module-load `HELP` template literal so the interpolation can't throw a temporal-dead-zone
  `ReferenceError` at import time. `SUBCOMMAND_USAGE.trace` is now a real multi-line template literal
  rather than one line with embedded `\n`s. A guard test fails on any hardcoded `--view` pipe-list left in
  the source, and pins the usage string's per-view explanation lines against the same constant.

### Documentation

- **`docs/fidelity-gaps.md` records the file-delivery lane split.** Cowork has two file-delivery tools —
  `mcp__cowork__present_files` on the desktop-local sandbox this harness emulates, and the agent-native
  `SendUserFile` (`files: string[]`, required `status`, optional `caption`/`display`) on remote
  cloud-container sessions. Probing a remote session and diffing against this harness reads as "wrong tool
  name AND wrong schema"; it is neither, and adopting `SendUserFile` would green skills that then fail on
  real desktop-local Cowork. Verified against the pinned baseline's spawn allowlist and `present_files`
  handler, the agent binary's `SendUserFileTool` schema and enablement gate, and a live-recorded init
  toolset. The entry names the discriminator (`CLAUDE_CODE_ENTRYPOINT`) and the guidance that holds on
  both lanes: never hardcode a delivery tool name in a `SKILL.md`. The rule is stated where an author
  actually forms the belief, not only in that one page: **SKILL.md Gotcha 24** (the installed payload —
  `docs/` is repo-only), both assertion catalogs, `references/fidelity-and-answers.md`'s tier discussion,
  and the `no_scratchpad_leak`/`present_files_called` descriptions themselves, so `assertions --list` and
  `schema/scenario.schema.json` carry it too.

- **The assertion tables — in the docs, the shipped skill's own references, and `llms.txt` — are rescoped
  to match the lint fix above**, describing `present_files_called` as working at `container|hostloop`
  rather than `container` alone. This also reverses stale `user_visible_artifact` guidance for a skill that
  delivers via write-to-cwd→`present_files`: docs previously said that pattern "false-reds" at `hostloop`;
  it actually **passes** there, because the agent's cwd at that tier already *is* the outputs dir (no
  promotion needed to make the file user-visible) — the false-red note now names only `microvm`/`protocol`.

- **Five factual corrections:** the documented Node floor (was 20, is 22, matching `engines`/`doctor`);
  README's default egress-proxy image tag (was `:3`, is `:4`); CONTRIBUTING's CI stage count (was
  seven-stage, is eight with the floor job); the agent's documented working directory in both the
  DESIGN.md mermaid diagram and README's ASCII twin (said `/sessions/<id>/mnt`; the spawn contract sets it
  to `/sessions/<id>`); and `docs/debugging.md`'s `stats` index-key recipe (the index key is the skill
  folder's basename, not the raw `$SKILL` path). Also fixes a stale `src/assert.ts` comment claiming
  `WRITE_BACK_SOURCE_EXTS` mirrors `analyze-artifact.ts`'s `SOURCE_EXTS` — it's a deliberate superset, not
  a mirror — replaces a stale baseline-version pin in DESIGN.md with a pointer that can't rot, and rewords
  a DESIGN.md paragraph lead-in that read like a command into a description of the sync extractor.

- **Two dead anchors fixed** — README's `lane:` link and `examples/README.md`'s flakiness link, both stale
  after `docs/scenario.md`'s headings moved — found via a repo-wide sweep of all 96 in-repo anchor links
  across README.md, CONTRIBUTING.md, DESIGN.md, SPEC.md, `examples/README.md`, and `docs/*.md`, which
  turned up no others broken. `examples/README.md`'s npm-package caveat now also names `matrices/`,
  `answer-policies/`, and `probes/` as trees that need a source checkout (confirmed via
  `npm pack --dry-run` that the published tarball ships only `examples/README.md` and
  `examples/replays/`). The `doctor` blurb in `examples/README.md` and `docs/README.md` now states that a
  bare `doctor` defaults to the `container` tier and that a Keychain-only login downgrades its auth check
  to a warn specifically at `protocol`; the trigger-accuracy-sweep row now notes that `run` skips a
  subdirectory non-recursively.

- **Contributor-workflow corrections:** CONTRIBUTING's pre-push checklist gains a `Typecheck` bullet
  (`npm test` strips types; `npm run typecheck` is the only path that checks test files); CONTRIBUTING.md
  and RELEASING.md now point at the `format:write` script instead of the raw `prettier` invocation;
  README's local command list drops the "Stage 1"/"Stage 2" numbering now that `boundary-check` is no
  longer part of `npm run ci`; and `python/README.md` clarifies that its `.env` precedence chain describes
  the CLI only — the Python API has no `dotenv` parameter.

## [1.13.2] — 2026-07-28

### Fixed

- **`lint-skill`'s corpus check sized a smaller set than the ceiling it warns about, and could pass
  `--strict` on a corpus a critique would cut.** The evidence ceiling governs `SKILL.md` + `references/**`
  + `agents/<skill>.md` **combined**; the check summed only the first two. A multi-skill plugin whose
  SKILL.md and references sat in the INFO band while its `agents/<name>.md` carried the total past the
  ceiling reported INFO and **exited 0 under `--strict`** — a green gate on content that was already
  destined to be cut. The check now counts all three classes, resolving `<root>/agents/<name>.md` the same
  way `critique --skill <name>` does; a standalone skill (no `skills/` parent) is unaffected.

  Two clarifications that follow, because both were understated: every file under `references/` counts
  regardless of extension — the packager applies **no** extension filter, so JSON schemas and rule packs
  are part of your corpus — and the remaining approximation now errs in one direction only. The check
  skips staging's git-tracked filter, so an untracked reference inflates the figure and warns early
  rather than late. `corpusCuts` in the report remains the authority.

  Reported by a consumer, who caught it by measuring their own plugin against the new check on upgrade.

## [1.13.1] — 2026-07-28

### Fixed

- **A misplaced global flag written as `--dotenv=<path>` / `--run-dir=<path>` keeps its exact-fix hint.**
  The pre-dispatch guard matches the spaced form by exact token — deliberately, so a per-command value
  like `--answer "--dotenv=x=foo"` is never hijacked — which left the equals form to surface as a bare
  `unknown flag`, dropping the one thing the caller needed: where to put it instead. The hint is derived
  where usage errors are rendered, and `run` additionally rejects a stray global ahead of its scenario
  path — that ordering previously absorbed the flag as the target and reported the user's *correct* path
  as the unexpected argument. The trigger is anchored on the two message shapes that mean "parsed as an
  unrecognized flag": a broader match fires on errors about a *correctly-placed* leading flag
  (`--dotenv file not found`, `--dotenv requires a path`) and on a flag name inside a quoted value,
  telling the user to move a flag that is already in the right place.

  Coverage is most of the CLI, not all of it. A command that never reaches that rendering point
  (`critique`, `chat`, `prune`, `migrate-run-dir`) or whose usage message is shaped differently (`vm`, a
  bare `assertions`, and `lint`/`lint-skill`, which forward the token to Python argparse) keeps its own
  bare `unknown flag` message.

- **The shipped-skill pointer guard covers `schema/` and `examples/`, not `docs/` alone.** A plugin
  install materializes only `.claude/skills/<name>/**`, so a bare pointer to any other repo directory
  dangles the same way — including the one naming the machine-readable schema a consumer needs to read
  field semantics. Four live pointers rewritten to permalinks or made runnable. `scripts/`, `cassettes/`
  and `src/` stay out of scope: the first resolves inside the payload, the second names the reader's own
  directory in a recipe, the third is provenance. A line whose sentence already qualifies a pointer as
  npm-only opts out with an explicit `<!-- npm-only-ok -->` marker.

- **Pointer-guard and hint boundary cases.** The guard matched a path segment that was only the tail of
  a longer word (`mydocs/x.md`), reported a wrong target for an extension outside its set (`docs/x.mdx`
  as `docs/x.md`), missed an upper-case extension, and rejected any absolute URL that was not a GitHub
  *blob* permalink — so an equally-resolvable `raw.githubusercontent` / GitLab / GitHub-`tree` link was
  reported as a dead relative pointer, the checker refusing its own prescribed fix written another way.
  The opt-out marker's whole-line scope is a deliberate trade-off and is now pinned by a test. Separately,
  `.` is no longer a token terminator in the misplaced-flag match: a typo'd filename (`--dotenv.yaml`) was
  read as the flag and answered with "move it before the subcommand".

### Added

- **`lint-skill` flags a skill corpus at or over the 512 KiB critique evidence ceiling** —
  `skill-corpus-near-evidence-ceiling` (INFO, ≥ 80%) and `skill-corpus-over-evidence-ceiling` (WARN), so
  the fact is free and static instead of costing a paid critique. The figure approximates the packager's
  corpus — it excludes `agents/<skill>.md` and does not apply the tracked-set filter — which the finding
  text states; `corpusCuts` in the report remains the authority. **CI note:** the over-ceiling finding is a
  WARN, so a `lint-skill --strict` job that was green can now fail — which is the point, since that corpus
  is one a critique would cut before grading.

### Documentation

- **`critique` is in the skill's orientation router, with the routing rule.** "What does this skill do"
  is a `skill` question; "what is wrong with this skill" is a `critique` question, and the second costs
  four model workloads. The router listed five entry points and `critique` was not among them.
  Reported by a consumer.

- **`referencesRead` is main-agent-only, stated inside the plugin payload.** Sub-agent Reads live under
  `subagents[].referencesRead`, so an empty top-level list on a dispatcher-style skill is not evidence
  the material went unread; the critique report's `noSkillFilesRead` unions both. Reported by a consumer.

- **The run's own evidence and the critique evidence package are distinguished at the router and on the
  debugging page**, not only mid-document — the first place a reader meets the word, rather than the
  third. Reported by a consumer.

## [1.13.0] — 2026-07-28

**Upgrade notes.**

- **`critique` verdicts are not comparable across this release — but the counts still are, and that
  distinction decides what to do with your history.** The evaluator now sees materially more of your skill,
  so a *per-item* verdict may flip for reasons that have nothing to do with your edits: do not diff
  individual findings across the boundary, and re-baseline anything that tracks a skill's progress
  report-to-report. **Do NOT discard your pre-upgrade reports.** Aggregate counts — above all the
  `not-adjudicable` count on identical prompts — remain the right way to measure what this release did,
  and your archived reports are the only "before" that exists. Pair that with the
  `citationResolved:false` (DROPPED) rate, which is the guard in the other direction: a much larger corpus
  could make the evaluator's citations sloppier, and nothing else would show it.
- **`skillMdTruncated` is gone from `critique-report.json`**, replaced by `evidenceBudget`
  (`corpusBytes` / `corpusCeiling` / `corpusCuts` / `corpusExcluded` / `trimRecord`). A harvester reading
  the old boolean should read `evidenceBudget.corpusCuts` instead — it is empty on every real skill.
- **An untracked skill file is no longer graded**, and the two cases behave differently — do not read one
  as the other:
  - **Untracked `references/**` or `agents/<skill>.md`** are simply excluded, named in
    `evidenceBudget.corpusExcluded`, and announced with a `::warning::`. **This does NOT force
    `not-adjudicable`** — and it should not: the agent never received those files either, so the
    evaluator's view now MATCHES the agent's. A finding like "the skill never explains X" against an
    excluded reference is correctly `grounded`; before this release the evaluator could see the file the
    agent never got and mark that true finding `already-covered`.
  - **An untracked `SKILL.md`** previously had its content **graded** (the packager read the host directory
    raw). It now reports `skillMdStatus: "untracked"`, withholds the content, and **does** force the same
    `not-adjudicable` downgrade as an unreadable one — coverage claims cannot be judged with no skill source
    at all.
  Either way, `git add` before critiquing to grade as-published.

### Fixed

- **Every `docs/*.md` pointer in the shipped skill was dead for a plugin install.** A plugin install
  materializes only `.claude/skills/<name>/**`; `docs/` ships in the npm tarball and not in that payload.
  The skill referenced `docs/` pages **25 times across 13 targets** anyway, so a consumer following one
  found nothing. This cost real time: `critique-evidence-package.txt` — the corpus the evaluator actually
  graded — was documented only in `docs/critique.md` and named nowhere a plugin user could see, so its
  behaviour got reverse-engineered from compiled `dist/` instead. All 25 are now repo permalinks that
  resolve for tarball and plugin users alike, a trimmed `references/critique.md` ships inside the payload
  covering what a plugin install cannot otherwise reach, and **`npm run check:skill-doc-links` fails CI on
  any new dangling reference** — the durable half, without which the next release re-creates them.
  Reported by a consumer.
- **`lint-skill --min-severity` exited 2 with no explanation.** The flag belongs to `lint`; the error now
  names the sibling command instead of leaving you to diff two help texts.
- **`index.jsonl` under-reported a critique's cost by ~39%.** A critique is four model workloads, but only
  the two graded turns produce a run and therefore a row — the two evaluator passes are direct API calls
  that produce neither. Anything summing the index missed them entirely (measured: $10.17 indexed against
  $16.67 actual across three runs), and the index is the only cost record that survives run-dir pruning, so
  spend trends built from it were systematically light. Each critique now writes one roll-up row carrying
  `critiqueTotalUsd`, and `--reindex` reconstructs it from the run dir's `critique-report.json` so a lost
  index recovers critique costs too. The roll-up's own `costUsd` is the **evaluator passes only**, so
  `sum(costUsd)` across all rows is exactly true spend — neither double-counted nor short. Roll-ups are
  excluded from `stats` aggregation, where they would otherwise add a phantom run and inflate `passRate`.
  Reported by a consumer.

  **Sharing a runs root across CLI versions:** an *older* CLI's `--reindex` deletes these roll-up rows —
  its supersede clause drops any prior row without a `turn`, which a roll-up is. Re-run `--reindex` with a
  current CLI to restore them from the run dirs.
- **A critique was indistinguishable from a plain `skill` run in the index**, which recorded the *inner*
  command for both turns and carried no `skill` field despite `--skill`. With three concurrent critiques of
  three skills against one plugin, every row read `scenario: skill-<plugin>` and the only way to tell them
  apart was opening each run dir. Rows now carry `critiqueRole` (`task` / `reflection` / `rollup`) and the roll-up carries
  `skill`. These are **additive-optional fields, not a new `command` value**: the row validator hard-codes
  the command allowlist, so widening it would make an older CLI quarantine every critique row and drop it
  from `stats`. The role derives from critique's own session-id shape, so `--reindex` marks rebuilt rows too.
- **`critique`'s task-turn timeout was 10 minutes**, which a sub-agent-dispatching skill routinely exceeds.
  The turn is killed *after* its model spend, so the consumer paid for a graded run and received an
  instrument failure instead of a critique — a reported case burned $11.05 that way. Raised to 30 minutes,
  matching the evaluator transport; `--timeout` still raises it further, and the byte cap and process-group
  kill remain the real runaway guards.


- **`critique` graded skills against a fraction of their own references.** The evidence package shared one
  8 KiB budget across ALL `references/**` files, filled in filename-sort order — so the alphabetically
  first file took what it needed and every later file was dropped whole. Measured across nine real runs on
  a six-skill plugin: the same first file was the sole survivor in 9 of 9, and **11 of 13 distinct
  reference files had never reached an evaluator in any run**, including a scoring rubric a sub-agent had
  opened in order to do the scoring. Skill-authored content (SKILL.md, every `references/**` file,
  `agents/<skill>.md`) now ships **whole** — bounded only by a **512 KiB sanity ceiling across all three
  combined**, which no real skill approaches (the largest measured is ~164 KB, about a third of it). A skill
  that does breach it is cut **loudly and by name** in `evidenceBudget.corpusCuts` — never silently, and
  never by refusing the run. The transcript is bounded separately at 128 KiB. Reported by a consumer.
- **The evidence corpus could contain files the agent never received.** Staging delivers git-tracked files
  only, but the packager read the host directory directly — so an uncommitted reference was absent from
  the mount and present in the evaluator's evidence. An agent saying "the skill never explains X" could be
  marked `already-covered` against a file it was never given. The packager now applies staging's own
  tracked-set filter and reports what it excluded.
- **`references/**` traversal was neither recursive nor symlink-aware**, so nested and symlinked reference
  files were dropped silently, with no omission marker.
- **The overall package trim did not converge.** It shaved a section by exactly the overflow and then
  appended a truncation marker, leaving the package marker-length over; it then shaved the next section by
  that amount and re-added the same marker, cascading through every section and exiting still over cap
  with the whole document mangled. It remains a belt-and-suspenders path that should never fire — the
  per-section budgets still sum under the cap, now pinned by a test — which is exactly why it had to be
  correct: nothing exercises it until something else has already gone wrong.
- **The overall trim destroyed the run record first.** It shaved from the last section backwards, which is
  the transcript — so a breach caused by oversized *skill* content was paid for by deleting *run*
  evidence. Trim priority is now explicit and independent of render order.
- **`writeSync` short writes and `EAGAIN` were unhandled at every stdout/stderr sink.** `verify-cassettes … | tail`
  died with `EAGAIN` instead of printing its verdict, and a short write on a pipe silently dropped the
  remainder of a JSON envelope. Every `writeSync` output site in `src/` now goes through `writeAllSync`, including critique's own JSON report — the largest single payload the tool emits, and the one its own code comment already flagged as at risk when piped to `jq`. (Sites already using async `process.stderr.write`, and two dev-only sinks under `scripts/`, are unchanged — the failure was specific to the synchronous idiom.)

### Documentation

- **`turn` vs `turns` in `index.jsonl` is now explained.** The names invite reading `turn: 2, turns: 1` as
  "turn 2 of 1". They are unrelated: `turn` is the position within a resumed session, `turns` is the count
  of agent turns *inside* that one run, and neither bounds the other. A critique roll-up carries neither,
  since it accounts for workloads that are not runs. Documented rather than renamed — a rename breaks
  `stats` and would need a schema version bump for no behavioural gain. Reported by a consumer.

**Cost note.** Sending the whole corpus costs more per critique, not less: roughly **+5% to +18%** on a
~$5.60 run, scaling with how much of your skill was previously being cut (a skill whose SKILL.md sat under
the old 64 KiB cap and had few references sees almost nothing; one that was heavily truncated sees the top
of the range). Evidence input was only ~14% of an evaluator pass's cost to begin with, which is why the old
caps were rationing the cheap term — but it is an increase, and a batch budget should carry it.

### Added

- **`session.json` now identifies its own run.** The resume manifest (written for `--session-id`/`--resume`
  runs) held only opaque ids, so the file whose name makes it the first thing you open in a run dir
  answered nothing — with several concurrent runs against one plugin there was no way to tell which was
  which without opening each turn's `result.json`. It now also carries `scenario` and `prompt`. These are
  **additive-optional**: nothing validates them, and a manifest written before this still resumes.
  `result.json` remains authoritative for identity; this is a signpost, not a second source of truth.
  Reported by a consumer.
- **`critique` reports progress.** Four `::notice::` lines on stderr at the phase boundaries (task turn →
  reflection turn → evaluator pass 1 → evaluator pass 2). Previously four model calls over 10–20 minutes
  produced no output at all until the finished report appeared, so a working run and a hung one were
  indistinguishable. stdout remains the machine channel.
- **`costUsd` now reports the evaluator passes' token split** (`evaluatorPass1Tokens` /
  `evaluatorPass2Tokens`, each `{input, output, cacheRead}`). The transport always handed the harness the
  full usage object and it was summed to a dollar figure and discarded — so the report said what a pass
  COST and never why, and "is this money evidence or thinking?" was unanswerable from any artifact the tool
  produced. That is the question that decides whether sending more evidence is cheap, which makes it the
  number to check first when budgeting a batch under the whole-corpus change above.
- **`evidenceBudget` in `critique-report.json`** — what the evaluator was actually shown, so the budgets
  are discoverable without reading compiled source. Includes `packageTruncated`, which is what carries the
  transcript's head+tail elision: that elision is what adds the evaluator's truncation caveat, and without
  the flag an elided package was indistinguishable from a clean one (`corpusCuts` is empty in that case and
  would otherwise imply nothing had been cut).
- **A no-reads signal** (`noSkillFilesRead`). When the graded turn Read no `references/` or `scripts/`
  file at all — neither the main agent nor any sub-agent — the report says so. Worded observationally on
  purpose: the underlying predicate counts the `Read` tool only, so `Grep` or `assets/` use produces an
  empty set having demonstrably reached the material, and calling that "progressive disclosure never
  fired" would be a false accusation about someone's skill.

### Changed

- **The overall evidence-package cap is 144 KiB → 768 KiB** (`critique --help` reports it). It stays a
  belt-and-suspenders bound: the per-section budgets deliberately sum under it, pinned by a test.
- **The transcript bound is 32 KiB → 128 KiB and now keeps head *and* tail** with an elided middle.
  A tail-only cut is the worst shape for a procedural skill, which puts its workflow steps last.
- **`critique`'s evaluator passes get a 30-minute transport timeout** (was the decider's 600 s default).
  That timeout is enforced with SIGKILL and no retry, so a kill during pass 1 discarded the whole critique
  *after* the graded turns had already been paid for.

## [1.12.0] — 2026-07-25

**Upgrade notes.**

- **Your cassettes will report baseline staleness.** `baseline: latest` now resolves to
  `desktop-1.24012.9` (agent `2.1.219`). A cassette recorded against an earlier baseline replays with
  `[stale] baseline moved <old> → 1.24012.9 since record`. Re-record, or pin the scenario to the baseline
  it was recorded against (`baseline: desktop-<ver>`). This repo's own example cassettes are re-stamped.
- **Cassette staleness notes moved from `::warning::` to `::notice::` and now aggregate.** If a CI step
  greps stdout for `::warning::` to detect staleness, it will stop matching. Parse the JSON envelope
  instead — per [SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract), annotation text is
  explicitly not a covered surface.

### Changed

- **Platform baseline synced to Desktop 1.24012.9** (`baselines/desktop-1.24012.9.json`, now what
  `baseline: latest` resolves to). The staged **agent binary is `2.1.219`** (native app + VM ELF, new
  sha256 for each, `measured-local` with a matching official manifest checksum). **No prompt, spawn-env,
  or egress-allowlist drift:** `spawn.env` is byte-identical to 1.24012.1 — the agent's five new
  `CLAUDE_CODE_*` flags are not set by Desktop — no top-level or `spawn` key was added or removed, and
  every hand-authored field carried forward. One spawn field moved: **`claude-opus-5` joins the per-model
  effort map** (`low|medium|high|xhigh|max`, recommended `high`, modes `auto`), and it is the first
  literal-map entry to carry `disallowThinkingDisabled` — see Fixed. The three example cassettes are
  re-stamped to the new baseline.

- **`canProposeSkills` (gate `1824824999`) is pinned as a drift sentinel.** Its sibling `canSaveSkill`
  (`3246569822`) is served **on/force** by the live feature cache — a server-side rollout, independent of
  Desktop version — which widens a real cowork session's tool surface with a `save_skill` tool this
  harness does not model. `canProposeSkills` gates the `propose_skills` sibling and is present-but-off,
  so pinning it makes the same class of widening a visible `sync` diff rather than silent drift. Both
  gate states are recorded in the baseline's `provenance.gates`; neither is enacted. See
  [docs/fidelity-gaps.md](./docs/fidelity-gaps.md).

- **Cassette staleness notes are now `::notice::`, and a directory replay collapses them to one line per
  kind.** They were emitted at `::warning::` — against an adjacent code comment that claimed the opposite —
  so a non-gating advisory outranked the *actionable* assert-drift `::notice::` beside it on a CI
  annotation surface. They also repeated a constant string once per cassette (measured: 5 lines over this
  repo's own 3 example cassettes, one kind firing 3/3); `replay <dir>` now prints
  `N/M cassette(s) — <reason> [kind]`. Per-file notes are unchanged in `verify-cassettes`' JSON envelope.
- **`lint` names a command you can actually run.** Its usage and error lines came from the bundled
  `scenario.py` (`usage: scenario.py lint …`), and an unknown flag additionally printed argparse's
  internal subcommand list. Both now read `cowork-harness lint`. Invoked directly
  (`python3 scenario.py lint`), it still says `scenario.py` — that path is documented and stays honest.

### Fixed

- **An uploaded file made a scenario impossible to re-record, and burned the paid run doing it.**
  `buildManifest` captures uploads (`INPUT_ROOTS`, hash-only) deliberately *outside* `userVisibleRoots`,
  but `redactCassette`'s artifact↔root check measured every artifact against that set — so any
  upload-bearing scenario threw `redaction broke artifact↔root consistency: artifact path
  "uploads/…"` and wrote no cassette. The two features shipped with no overlapping tests (the uploads
  capture had no redaction coverage; the redaction guard had no uploads coverage), which is how a
  collector and its validator contradicted each other unnoticed. The throw lands *after* the agent run,
  so a live recording was spent each time. The check now accepts the input roots — redacted with the same
  policy, so a rule rewriting `uploads` stays consistent on both sides. Matching is by **path prefix**,
  not by `truncationReason: "input"`: a *symlinked* upload short-circuits in `readEntry` before the
  reason is applied, so a reason-keyed exemption would miss exactly the case it must cover. A genuine
  redaction-induced break still throws.
- **`schema/cassette.v10.json` declared neither `truncationReason: "input"` nor `preRunOrigin`**, both of
  which the recorder has been emitting. The gap was invisible because the cassette that would have
  exposed it could not be re-recorded. Both are now declared (additive and corrective — the producer,
  the TS types and `docs/cassette.md` already promised them; no `cassetteVersion` bump).


- **`sync`'s per-model effort extractor silently dropped `disallowThinkingDisabled`.**
  `parseModelEntryBody` read only `effortLevels`/`recommended`/`modes`, because the field had appeared
  solely on the regex-default entry (which sets it from its own anchor capture). Desktop 1.24012.9's
  `claude-opus-5` is the first entry in the literal per-model map to carry it, so the synced baseline
  would have recorded that model's config **incomplete, with no flag raised** — the exact silent staleness
  the S20 sentinel exists to prevent. The field is now parsed for per-model entries too, additively and
  optionally, and absent stays absent rather than defaulting to `false` (so a baseline distinguishes
  "production omits it" from "production sets it false"). Nothing enacts the field yet —
  `validateEffort` reads only `effortLevels` — so this is baseline data fidelity, not a behaviour change.
  Caught because the golden oracle is transcribed from raw asar text; copying the extractor's own output
  into it would have rubber-stamped the bug.

- **The path-gate excluded-set sentinel refused the 1.24012.9 sync.** Desktop's
  `HOST_LOOP_EXCLUDED_BUILTIN_TOOLS` gained `"PowerShell"` (a 6-element literal), which the anchor
  correctly rejected as an unknown delta. `PowerShell` **is** a real tool in the agent registry, but it is
  win32-gated and never registers on the macOS/Linux runtimes this harness targets, so hostloop's
  `disallowed` set is unchanged; only the anchor and its stale explanatory comment moved. A mutation test
  now fails a regex loosened back to the 5-element form, which the pre-existing append-style mutation
  would not have caught.

### Documentation

- **SPEC.md's `mounts[]` row documented a mount path that was fixed away.** It still described
  `remote_plugins` mounting at `.remote-plugins/<name>` — the basename form that was replaced by
  `.remote-plugins/plugin_<id>` precisely *because* two entries sharing a basename collided. The
  implementation (`session.ts`), `docs/discovery.md`, `docs/plugin-root.md` and `docs/session.md` had all
  said `plugin_<id>` for releases; SPEC was the one stale page, and it is the §12 frozen-contract page,
  where a wrong path is a misstated contract rather than a typo. Now names the real shape and why the id
  is a hash of the declared source rather than a basename. Reported by a consumer.

- **`save_skill`/`propose_skills` are recorded as an unmodelled surface** in
  [docs/fidelity-gaps.md](./docs/fidelity-gaps.md). Cowork declares `mcp__cowork__save_skill` on a
  standard account; the harness declares neither tool at any tier. The entry states the three properties
  easiest to get wrong — it **uploads** a zipped skill to the account-level library rather than writing
  files (the local-storage path belongs to the `custom-3p` deployment, which a first-party account never
  reaches); it is **force-asked**, so Cowork prompts for it even under `bypassPermissions`; and it is
  **ToolSearch-deferred**, not `alwaysLoad`, which is why its absence is inert for skills that never seek
  it. It also states why a byte-faithful emulation would be unsafe: the side effect is an authenticated
  upload with the operator's own credentials, and `overwrite: true` resolves and replaces an existing
  skill by name, so a scenario exercising the update path could destroy the very skill under test. Where
  it bites is narrow but silent — a skill-authoring workflow greens in the harness by writing `SKILL.md`
  to disk, while production tells the model those edits do not persist.

- **Every doc pin that names the baseline or the agent version tracks 1.24012.9 / 2.1.219.** A baseline
  sync leaves nine such pins stale across seven files: SKILL.md's `tracks-harness` stamp and its "Version
  note", README.md's latest-shipped-baseline sentence, the `V=<agentVersion>` recovery snippets in
  README.md / `docs/maintenance.md` / `references/ci-recipe.md`, and the `(baseline desktop-X.Y.Z)` stamps
  in all four `references/*.md`. `npm run check:versions` enforces all of them — but it is **not** part of
  `npm run ci`, only of `preflight`, so a stale pin leaves the suite green and blocks the release instead.
  DESIGN.md's one present-tense "currently **X**, per `baselines/desktop-Y.json`" sentence is the one pin
  with no guard at all. Two of the nine are latent: SKILL.md's "Version note" and the `references/*.md`
  stamps are checked against SKILL.md's `tracks-harness` rather than against the max baseline, so they only
  start failing once `tracks-harness` is corrected — fix them in the same pass, and re-run
  `check:versions` until it exits 0 rather than trusting a hand-enumerated list.

- **A guard holds the shipped skill's `docs/` pointers resolvable** (`test/skill-docs-pointers.test.ts`).
  The payload under `.claude/skills/cowork-harness/**` points at ~a dozen `docs/*.md` files that do not sit
  beside it; that works only because SKILL.md **defines** "repo-only" as "not bundled with the installed
  SKILL" and names `node_modules/cowork-harness/docs/<name>.md`. That definition was load-bearing for every
  such pointer and nothing protected it — delete it and a reader meeting `(repo-only)` concludes the doc is
  unavailable when it is one path away. The guard now pins three things: the definition survives and still
  precedes its first parenthetical use; every referenced doc exists; and every referenced doc is actually
  shipped by `package.json`'s `files` (a doc can exist in the repo and still be excluded by a `files`
  negation, so a pointer into one would dangle for npm consumers too). Mutation-verified against all three.

- **Two prose enumerations that no guard covers are corrected.** `docs/maintenance.md`'s seam table named
  neither `spawn.env` nor `spawn.effortByModel`/`effortRegexDefault` in its VOLATILE column, though both are
  re-derived from the asar every sync — so the doc defining the maintenance contract understated what a sync
  regenerates, in the release where the effort map moved. Its HAND-AUTHORED column was short by
  `spawn.tools`/`allowedTools`, the spawn scalars, the prompt-asset pointers and the `$comment*` keys. It now
  also records the all-or-nothing contract the code implements: on a `deriveSpawnEnv` /
  `extractModelEffortConfig` hard failure, `sync` preserves the previous values and reports an unknown delta
  rather than writing a partial map. Separately, the baseline's `provenance.gates.$comment` described its
  "also pinned" sentinels as ones "the harness deliberately models as OFF" while omitting the four
  skill-family gates it carries — including `canSaveSkill`, which is **on**. Both were structurally green
  under every checker; only reading them caught it.

- **The packaged skill documents 1.11.0's surface.** `--min-severity`, `environment.harnessVersion`, and
  the discovery-surface note shipped documented nowhere a consumer reads; a consumer found them by diffing
  tarballs. Added to SKILL.md's Gotchas (as workflow guidance — the skill delegates flag detail to
  `--help`) and the cassette-anatomy table.
- **`extra-args` and its version coupling are documented** (`references/ci-recipe.md`), and `action.yml`
  now states that `version` accepts an **npm range**, not only an exact pin. A flag passed through
  `extra-args` that needs release X fails hard on an older CLI (`unrecognized arguments`, exit 2) — floor
  the step with `version: ">=X"`. An exact pin rots the moment a recipe adopts a newer flag.
- **A doc-coupling ratchet for nested cassette fields** (`test/skill-docs-sync.test.ts`). The existing
  guard checked top-level keys only, which is why `environment.harnessVersion` shipped undocumented
  despite passing the surface-contract gate: nothing coupled a field's *existence* to its *explanation*.
- **`AGENTS.md`** gains an advisory-design section (actionable-or-aggregated; severity tracks
  actionability; "harmless otherwise" is a design smell) and a Traps section for the silent failure modes
  that mislead contributors. **`RELEASING.md`** gains a checklist line naming CHANGELOG + README +
  SKILL.md + references explicitly — a version bump is not documentation.
- **`AGENTS.md` documents the one-worktree-per-session convention**, because two sessions sharing a single
  checkout is a failure mode nothing errors on — the integration branch simply advances under an in-flight
  rebase and the conflict surfaces later. The entry prescribes `git merge --ff-only <branch>` run in the
  primary, and explicitly warns off the `git fetch . <branch>:main` ref-update as the standard path: it
  works only while `main` is unchecked-out and fails with `refusing to fetch into branch 'refs/heads/main'
  checked out at …` the moment a worktree holds it. A ref-update also protects the other session's HEAD
  while doing nothing for `main` itself, so it never solved the larger half.

## [1.11.0] — 2026-07-25

### Added

- **Cassettes record the harness version that wrote them** — `environment.harnessVersion`. A harness-code
  change can shift recorded behaviour at an unchanged baseline (1.10.0's new tool surface did exactly
  that), and no staleness class keys off it, so this was the one fidelity input with no provenance at all.
  Additive: no `cassetteVersion` bump, absent on older cassettes (and that absence is meaningful — it is
  never backfilled), readers that don't know the field ignore it.
- **`verify-cassettes`/`replay` now flag a cassette that predates the skills/plugins discovery surface** —
  a non-gating `[note]` (never a finding, so it cannot red an existing fleet). It reads the tool inventory
  the agent actually reported in `system/init`, so it works **retroactively on cassettes recorded long
  before this release**, and it stays silent where re-recording would not help: `microvm`/`protocol` (which
  declare no such server), a cassette whose init carries no tool list at all, and any cassette whose tier
  cannot be determined.
- **`lint --min-severity ERROR|WARN|INFO`** — drop findings below a floor. Filtering happens before both
  the render and the exit computation, so `--strict --min-severity ERROR` behaves like a plain lint rather
  than reporting zero findings and still exiting 1; `--output-format json` is filtered identically.
  Default `INFO` = unchanged. Note this **mutes** the unconditional `manifest-needs-snapshot` /
  `gate-needs-controlout` advisories rather than resolving them — the linter is static and cannot read a
  cassette to know whether they apply, so they still fire by default.

### Fixed

- **`doctor`'s Keychain remedy named the wrong actor at every tier.** It said "the in-Docker agent can't
  read the Keychain" — emitted verbatim at `hostloop` (a native host process) and at `protocol` (no Docker
  at all), because the branch never consulted the tier. It now states what is true everywhere and does not
  contradict the detail line above it (`doctor` *does* read the Keychain — that is how it detects this
  case): cowork-harness does not pass a Keychain credential to the agent, it injects only env / `.env`.
- **`doctor --tier protocol` reported "not ready" for a macOS user who could actually run it.** Protocol
  deliberately keeps your **real** `CLAUDE_CONFIG_DIR` when no API key is present (a fresh one breaks
  OAuth), so the agent authenticates from local login state and no env / `.env` token is needed. The token
  check was tier-blind and failed them anyway — a false negative on the one tier that needs neither Docker
  nor a staged agent, i.e. the cheapest way in. It is now a non-blocking **warning** at `protocol` when a
  Keychain credential is present (a warning, not a pass: the probe proves a credential exists, not that
  the login state is still valid). `container`/`microvm`/`hostloop` are unchanged and still require the
  token — they pass a managed `CLAUDE_CONFIG_DIR`, which severs self-sourcing.
- **The skill-hash discoverability hint printed once per drifting cassette** — a 16-cassette fleet replay
  emitted the same constant string 16 times on stderr. Now once per process. The
  `COWORK_HARNESS_DEBUG_SKILLHASH=1` dump is unchanged and remains per-cassette, since per-cassette drift
  attribution is the point of that flag.

## [1.10.0] — 2026-07-25

### Changed

- **The packaged `cowork-harness` skill no longer carries a per-release version history.** SKILL.md's
  "what the floor gates, by release" list had grown to 19 releases / ~15 KB (about a fifth of the file)
  and was self-defeating: every entry described a feature at or below the floor, so anyone meeting the
  floor already had all of it. Because SKILL.md is loaded into an agent's context on every invocation,
  that was pure token cost for content that cannot change behaviour. The version floor (and *why* to pin
  it rather than use `@latest`) stays; the history now lives where it belongs — this changelog — with a
  pointer for anyone diagnosing an older CLI. SKILL.md: 77 KB → 62 KB.

### Added

- **Skill/plugin discovery SDK-MCP servers** (`mcp__skills__list_skills`/`suggest_skills`,
  `mcp__plugins__list_plugins`/`search_plugins`/`suggest_plugin_install`) — modeled on `container` and
  `hostloop` (and `cowork`, which resolves to one of those) alongside the existing `cowork`/`workspace`
  servers, via a new `combineSdkMcp` composition helper (`src/agent/session.ts`). Every tool is
  `alwaysLoad` so it surfaces in `system/init.tools` from turn one, matching real Cowork; `list_skills`/
  `list_plugins` are populated deterministically from the session's actually-mounted skills/plugins,
  and `suggest_skills`/`search_plugins`/`suggest_plugin_install` return a deterministic empty-catalog
  advisory result (the real add/install catalog is out of band). Two gates control the `skills` server's
  `suggest_skills` tool — `suggestSkillsEnabled` (default on) and `proactiveSkillSuggestEnabled` (default
  off, adds a `trigger` param) — read from the synced baseline via a new bare-boolean `readGateBool`
  reader, with new session-level overrides `skills.suggest_enabled` / `skills.proactive_suggest_enabled`
  (see [docs/session.md](./docs/session.md)). `tool_available: "mcp__skills__.*"` /
  `"mcp__plugins__.*"` is no longer a false negative on `container`/`hostloop`/`cowork` (still absent on
  `microvm`/`protocol` — see [docs/fidelity-gaps.md](./docs/fidelity-gaps.md)). Fidelity scope: the tool
  inventory, inputSchemas, gating, and the `list_skills`/`list_plugins` envelopes are asar/session-log
  derived; the tool **description strings** and the `search_plugins`/`suggest_plugin_install` envelopes are
  a faithful reconstruction rather than byte-captured — see [docs/fidelity-gaps.md](./docs/fidelity-gaps.md).
  **Upgrade note — existing cassettes:** a cassette recorded before 1.10.0 froze the previous tool inventory,
  so a scenario asserting `tool_available: "mcp__skills__.*"` / `"mcp__plugins__.*"` will fail against it —
  correctly, since that recording genuinely had no such tool. No staleness class flags this (the classes key
  off the baseline and the skill/scenario inputs, and the baseline did not change), so **re-record
  `container`/`hostloop`/`cowork` cassettes whose scenarios assert on the discovery tools**. See
  [docs/cassette.md](./docs/cassette.md) → "Upgrading cowork-harness".
  Both catalogs report what the sandbox will actually **receive**: a plugin skill directory that staging
  drops (untracked, under the default git-tracked staging boundary) is omitted from `list_skills` *and*
  `list_plugins`, including on `--resume`, so the two never contradict each other within a run.

### Fixed

- **`chat --fidelity container` declared SDK-MCP tools it never served.** The container branch built its
  SDK-MCP bundle and then discarded it, so `mcp__cowork__present_files` was advertised on `--tools`/
  `--allowedTools` while its server was never announced in `initialize` — calling it failed, and
  `context.mcpServers` omitted `cowork`. (`run --fidelity container` was unaffected; this was the
  interactive `chat` lane only.) The bundle is now forwarded, which also serves the new
  `skills`/`plugins` discovery servers on that lane.

## [1.9.0] — 2026-07-24

### Added

- **`schema/critique-report.json`** — a descriptive, test-pinned schema for `critique`'s JSON report /
  `critique-report.json` artifact, so automation consumers (budget pacers gating on `costUsd.complete`,
  harvesters) parse field names/shapes from a schema instead of prose. Deliberately **not** a SPEC
  §12-frozen surface (unlike `doctor.json`) — critique is EXPERIMENTAL and additive field changes are
  expected; the schema says so in its own description, and a two-way sync test pins it against the
  actual report builder on every branch (findings / infraFailure / evaluatorError).
- **`gradedSkill` in the critique report** (text header + JSON): the resolved `skills/<name>` the
  packager graded under `--skill`/auto-selection. Load-bearing for multi-skill plugins:
  `gradedSkillHash` keys the whole mounted plugin, so pairing by hash alone cross-pairs critiques of
  *different* skills — pair by `(gradedSkillHash, gradedSkill)`. Docs updated accordingly.

### Docs

- Truncation→DROPPED mechanics: a finding whose `evidence` quotes SKILL.md text past the packaging cap
  fails citation-resolution and lands in DROPPED (the check runs against the *cut* copy) — documented
  next to `skillMdTruncated` so a back-half DROPPED skew on an oversized skill has its cause named.
- `findingFingerprint` direction-of-inference: high-precision, LOW-RECALL — a match proves
  reproduction; a mismatch does NOT prove non-reproduction (the same finding reworded fingerprints
  differently). The Reproduction section says so before anyone concludes "didn't reproduce".
- Evaluator cost share: the two evaluator passes were ~3/4 of a measured e2e total — the
  calibrate-then-`--evaluator-model` strategy is now in the cost section and `critique --help`, with
  the armor-verification-is-default-evaluator-only caveat.
- SPEC §12 now names the critique report explicitly under **NOT covered**: `schema/critique-report.json`
  is descriptive (parse against it, not prose) but not the compatibility contract while critique is
  EXPERIMENTAL — its surface-baseline presence is for change visibility, and it is the promotion
  candidate on the `doctor.json` template once critique stabilizes. README, llms.txt, and the shipped
  skill point at the schema and the `(gradedSkillHash, gradedSkill)` pairing rule.

### Fixed

- **critique's "Attached inputs" evidence no longer reports `(none)` when `mounts.json` is corrupt.**
  `listAttachedInputs` derived connected-folder names from `loadVmPathContext`, which returns `null` for
  BOTH an absent `mounts.json` (legitimately no mounts) and a present-but-unparseable one (the folder map
  is UNKNOWN). Uploads already distinguished these (the ENOENT-vs-read-fault split), but folders — which
  have no fixed-layout fallback — silently collapsed to `[]`, so a corrupt `mounts.json` rendered `(none)`,
  telling the evaluator "the agent correctly saw no connected folder" when the truth was unknown. It now
  surfaces a corrupt `mounts.json` as an explicit UNKNOWN note, completing the same
  confabulation-vs-correct guard the uploads path already applies.
- **`diff` no longer treats two tool inputs that differ only past the ~2000-char cap as the same call.**
  `canonicalizeInput` truncated a tool input's canonical JSON to a 2000-char cap and used that truncated
  string as the tool-sequence equality key, so two `Write`/`Bash` calls sharing a long identical prefix
  but differing only in the dropped tail compared as `op: "same"` in `diffToolSequence` — a false "no
  change" that could flip the advisory `diff` exit code to 0. A truncated key now folds in a
  `#<len>·<sha16>` hash of the full canonical string, so the key depends on the entire content while the
  visible prefix stays readable in the hunk; both diff sides canonicalize identically, so the comparison
  stays consistent.
- **`COWORK_VM_GATEWAY` is now validated as a canonical IPv4 literal.** The L2-microVM gateway override was
  interpolated verbatim into a root-run guest `iptables -A OUTPUT -d <gateway>` command (via `sh -c`), so a
  malformed or hostile value could inject shell syntax into privileged provisioning — or, more mundanely,
  leave the firewall in an unknown state. `vmGatewayIp()` now rejects anything that isn't a canonical IPv4
  literal (digits-and-dots only, octets 0–255, no leading zeros), failing loud instead of reaching the
  shell. Operator-set env var, so this is defense-in-depth; no valid gateway value is affected.
- **The `agent.stderr.log` sink is now flushed before the teardown secret-scrub reads it.** The stderr sink
  was piped fire-and-forget and never awaited, so bytes still buffered when `scrubRawRunLogs` read the file
  could land raw *afterwards* — a persisted-secret leak in a narrow teardown window. `LiveAgentSession` now
  pipes it with `{ end: false }` and ends+awaits it in the same session-teardown drain that already flushes
  `events.jsonl` / `control-out.jsonl`, so the session generator resolves only after the sink is fully
  flushed — the scrub always sees the complete log.
- **`critique` no longer prints raw host paths in its report or diagnostics.** The text report's `run dir:`
  line, the `inspect <dir>` hints, the write-failure diagnostics, and the echoed skill-folder path all
  printed absolute `$HOME`-rooted paths, so a shared report or screenshot leaked the username + filesystem
  layout (it landed in a video frame). critique was the one rendering path in the CLI that never called
  `tildeify`, while `skill`/`run` scrub unconditionally. Every human-facing path is now collapsed to `~`;
  the JSON report and persisted-artifact paths stay raw (machine data a consumer feeds back to a tool). The
  `--demo` rejection is unchanged — it was never the fix — but its reason now notes the report already
  collapses paths.
- **`critique` fails fast on a missing or non-directory skill folder.** A typo'd/absent positional folder
  previously minted a session and spawned the task turn before infra-failing (exit 2), leaving a stray run
  dir behind. `resolveCritiquedSkillDir` now `existsSync`/`isDirectory`-checks the folder up front — before
  any session is minted or spawned — so a bad path exits 2 immediately with nothing left on disk. A
  present-but-`SKILL.md`-less folder still defers to the packager's degraded flow, unchanged.
- **`critique`'s report header and stderr diagnostics now say `critique:` (were `skill-critique:`).** A
  leftover label from the `scripts/skill-critique.ts` instrument; the invoked command is `critique`.
  Cosmetic, no schema change.

## [1.8.0] — 2026-07-23

### Added

- **`check:versions` closes the stale-pin gap a docs audit found.** Three new enforcement surfaces:
  every companion-skill `references/*.md` `(baseline desktop-X.Y.Z)` pin must match SKILL.md's
  `tracks-harness` baseline; `task-recipes.md` now carries the same guarded
  `` Tracks `cowork-harness X.Y.Z` `` stamp as the other references (and is a `bump-version` target);
  DESIGN.md's one present-tense "currently **X**, per `baselines/desktop-Y.json`" sentence must name the
  max committed baseline + its `agentVersion` (its dated verification-pass notes stay exempt). A new
  docs-index sync test keeps README's Documentation table and docs/README.md's Guides table from
  drifting apart (that drift is how `critique.md` went missing from the README table).

- **`doctor` warns when a *pulled* agent image is behind the published one.** For the
  `container`/`hostloop`/`cowork` tiers, a new advisory `image-freshness` check compares the local agent
  image's registry digest against the current published `ghcr.io/yaniv-golan/cowork-agent-base:2` (or
  `-full`) and warns — with a re-pull + retag remedy — when they diverge. Best-effort and never blocking:
  a locally-built image (no registry digest), an offline host, `docker buildx` being unavailable, or a
  custom `COWORK_AGENT_IMAGE` is a quiet skip, never a false "stale"; only a pulled image incurs a network
  probe. The `doctor --output-format json` envelope gains an `image-freshness` entry (the open
  `checks[].id` set — SPEC §12 — already permits this).
- `critique` now stamps `verdictProvenance` on every report (JSON key + text "verdict scope" line): the
  verdict is an advisory self-run, not an independent attestation.
- **`critique --skill <name>` — plugin-aware grading.** A multi-skill plugin root (`skills/<name>/SKILL.md`,
  no root SKILL.md) previously graded a missing file, downgrading every coverage finding to "not
  adjudicable". `--skill` selects the invoked skill's folder for the packager (selection only — the
  positional folder is still what both turns mount, and `fingerprint.skillHash` is unchanged: per-plugin,
  not per-skill); a multi-skill root with no `--skill` is refused **before any model spend**, naming the
  available skills; a single-skill plugin auto-selects with a notice. The evidence package now also
  carries the invoked skill's `agents/<name>.md` body and bounded `references/*.md` **content** (not just
  filenames), and the report carries an advisory `skillInvocationObserved` (false = the graded run's own
  `skillActivity` never mentions the selected skill).
- **`critique` persists run-dir artifacts.** Every critique writes `critique-report.json` (the
  machine-readable report); when the evaluator ran, `critique-evidence-package.txt` (the exact armored
  corpus it graded against — re-grade a disputed finding offline); on an instrument failure (exit 2),
  `critique-salvage.json` (the self-report + each evaluator pass's RAW reply captured **pre-parse**).
  New `--out <path>` also writes the selected-format report to a file. The two `not-built` limitations
  these close (`evidence-not-persisted`, `report-stdout-only`) are removed from the registry.
- **Per-critique cost across all four workloads.** The report's `costUsd` sums the task turn, reflection
  turn, and BOTH evaluator passes (whose usage the transport previously discarded), marked `INCOMPLETE`
  whenever any workload is unpriced. The header also carries the pinned `fidelity` plus the graded turn's
  recorded `gradedEffectiveFidelity`/`gradedBaseline`, and the graded run's resolved gate answers are
  echoed as copy-pasteable `--answer` lines (JSON: `gateAnswers`).
- **`critique` evaluator parse is per-item tolerant.** One malformed item in an `{"items":[...]}` reply
  previously discarded the whole document ("no valid JSON found", a broken discovery run). Valid items now
  survive; malformed ones are dropped AND counted (`droppedEvaluatorItems`, surfaced in both report
  formats). The integrity canary is recognized by its `idea` alone (a mutated echo still proves
  instruction-following) and stripped before dedup, so a full-document + canary-only-restatement reply no
  longer trips the ambiguity throw. Fail-loud preserved: garbage, or all-malformed-with-no-canary, still
  throws — now naming which field check failed.
- **Sub-agent research is observable end-to-end.** A sub-agent's WebSearch never enters the main
  `toolCounts`/`webSearches[]`; its query + result are now captured from the child session transcript as
  `subagents[].webSearches` (bounded, live/record lane only — absent on replay, and absence is never
  evidence of no research), surfaced by the new **`trace --view subagent-research`**, and packaged into
  critique's evidence as a "Sub-agent research" section so "researched" claims are groundable.
- Each critique item now carries a **`findingFingerprint`** (sha16 over the normalized
  idea + classification + recommendedAction, deliberately excluding the input-specific evidence excerpt) —
  clusters the SAME finding across DIFFERENT inputs, complementing `skillHash` (same skill across fixes).
  docs/critique.md gains a "Reproduction" section documenting the ≥2-run discipline.
- SKILL.md truncation is now reported distinctly: a readable-but-oversized SKILL.md marks the report
  `skillMdTruncated` ("the evaluator graded a cut copy") instead of being indistinguishable from a fully
  packaged one; only missing/unreadable still forces the mechanical "already-covered" downgrade — the
  `--help`/docs limitation wording now says so.

### Changed

- **Published agent images (`cowork-agent-base` / `cowork-agent-full`) now carry OCI metadata labels**
  (`org.opencontainers.image.{title,description,source,documentation,licenses}`), so their GHCR package
  pages render a description, repo link, license, and the "contains no Anthropic binary" provenance note
  instead of appearing bare. The `publish-image` workflow sets the `full` variant's title/description via
  `--label` so its page isn't mislabeled by the base image's baked-in defaults.
- `critique` evidence caps raised: SKILL.md 16KB→64KB, transcript 16KB→32KB, overall package 48KB→144KB
  (the overall cap sits above the worst-case per-section sum, agents/references/research sections included), so
  a flagship-sized (~51KB) SKILL.md no longer grades permanently truncated. Increases per-critique evaluator
  token cost on large skills (~2–2.5×).
- `sync`'s two code-tripwire warnings (the `getMcpSkillSources` caller-count and MCP-skills-capability
  checks) now carry a self-contained instruction — re-verify whether MCP servers can contribute skills and
  whether the harness must model MCP-contributed skill sources — instead of pointing at a reference the
  published repo does not carry.
- **Pinned sessions stamp their fidelity tier on `session.json`, and a cross-tier `--resume` fails loud**
  (pre-spawn, with a "re-run at `--fidelity <stamped>`" remedy). The agent's native conversation store is
  tier-LOCAL — container persists it under the work tree, hostloop under the host config dir — so resuming
  a session at a different tier would hand the binary a `--resume` for a conversation its store has never
  seen. Legacy stampless manifests (pre-dating the stamp) are let through with a warning; every manifest
  written from now on carries the stamp. `readSessionManifest` gains a required `expectedFidelity`
  argument.

### Docs

- README documents that the agent images are **published to GHCR** and can be pulled + retagged instead of
  built from scratch (`:2` floats to the latest release; `:2-<version>` pins an immutable per-release
  build), and that the harness resolves the *local* tag — so a stale local image shadows the published one;
  re-pull after upgrading. The `doctor` command row notes the new freshness warning.

### Fixed

- **hostloop uploads bullet advertised a non-readable path.** The dynamic "## Shell access" section
  rendered the uploads mapping's file-tool side as `dirname(upload.hostPath)` — the user's original
  source dir, which the path-containment gate does not allow — while the base prompt pointed at the
  correct staged dir. An agent following the bullet got "outside this session's connected folders" and
  worked around it via copy-into-outputs + `rm`, tripping a spurious `outputs-delete` fail. The bullet
  now advertises the staged uploads dir — the SAME hoisted value the path gate allows, so the prompt and
  the gate cannot disagree. (Live-verified: hostloop `--upload` + Read-tool read succeeds at the
  advertised path.)
- The task-turn timeout kill message now names `--timeout` and the 10-minute default; a "missing"
  SKILL.md report note now points at `--skill` / the invoked skill's folder (the multi-skill-plugin-root
  cause) instead of only stating the symptom.
- Shipped-doc corrections that induced field misdiagnoses: the cowork-harness skill's gotcha #8 now states
  that **production enforces** outputs delete-deny (EPERM + approval) and the harness gap is
  detection-only; docs/critique.md documents that a WebSearch produces **no search-host entries in the
  container egress.log** (an `api.anthropic.com`-only log is consistent with research working —
  live-verified with a first-party capture) and that sub-agent searches don't increment the main
  `toolCounts.WebSearch`; the shipped fidelity reference explains the hostloop Read-vs-bash path split
  including uploads readability.
- **`critique` now runs at `--fidelity hostloop` as well as `container` — the container-tier pin is
  lifted.** The pin existed because the reflection turn *resumes* the task turn and resume-continuity was
  only proven for the container Linux ELF; a live two-turn proof at hostloop's **native** agent binary
  (`test/live-contract.test.ts`, "resume-continuity proof at hostloop") cleared it, and a live
  `critique --fidelity hostloop` e2e validates the full protocol there. `microvm`/`protocol`/`cowork` stay
  refused, each with its own stated reason: the single `container-tier-only` limitation is replaced by
  three tagged ones — `microvm-tier-refused` `[unverified]` (a resume-continuity proof at the microVM guest
  would lift it), `protocol-tier-refused` `[not-built]` (protocol never plumbs a session id/`--resume`),
  and `cowork-tier-refused` `[deliberate]` (the synced loop gate would make the graded tier
  baseline-dependent, adding noise to skillHash-paired generation comparisons).
- **`skill` accepts `--allow-host-writes`** (and `critique` forwards it to BOTH turns) — the
  hostloop writable-connected-folder consent that previously only `chat` (its own flag) and `run` (the
  `allow_host_writes: true` scenario field) could grant; a plain `skill --fidelity hostloop --folder X`
  was refused with no way to consent at all. Folder-less runs (skill dir + uploads) still need no consent —
  uploads and skill/plugin mounts are read-only.
- **`critique`'s spaced flag parser no longer silently grabs the next flag as a value.** `critique
  <folder> --prompt --output-format json` (a forgotten `--prompt` value) swallowed `--output-format` as the
  prompt AND dropped the real flag, then ran a four-workload critique on the wrong input. The spaced form
  now fails loud and points at the equals escape hatch (`--prompt=<value>`) for a value that intentionally
  starts with `-`.
- **`critique`'s subprocess byte cap is now one combined stdout+stderr budget.** `boundedSpawn` kept two
  independent per-stream counters, so a looping or hostile child splitting output across both streams could
  buffer ~2× the documented cap before either tripped. It now charges both streams against a single budget
  and slices the terminal chunk to the remaining room, so captured output never exceeds the cap.
- **`critique`'s verbatim citation-grounding is now case-sensitive.** The mechanical check that drops any
  finding whose cited evidence is not a verbatim excerpt normalized whitespace AND folded case — so a
  case-altered (paraphrased) citation resolved as "grounded," weakening the principal defense against
  evaluator hallucination. It now matches case-exact; whitespace reflow stays tolerated (models reflow
  spacing when quoting — they don't change case).
- **critique's "Attached inputs" evidence no longer reports `(none)` when the uploads dir is unreadable.**
  `listAttachedInputs` caught every `readdirSync` failure identically, so an unreadable uploads dir
  (`EACCES`/`ENOTDIR`/…) collapsed to the same `(none)` as a legitimately-absent one — telling the
  evaluator "the agent correctly saw no file" when attachment presence was actually UNKNOWN. It now
  distinguishes `ENOENT` (absent) from a genuine read fault and surfaces the uncertainty loudly.
- **critique flags a partly-corrupt archived turn-1 transcript instead of grading it as clean.**
  `readTurn1Transcript` skipped malformed JSONL rows (resilient) but returned `degraded: false` on the
  first valid transcript record regardless — so archive corruption vanished from evidence health and the
  evaluator graded a silently-incomplete transcript as solid ground truth. It now scans the whole
  (turn-1-only) archive and sets `turn1SliceDegraded` when a malformed row was skipped or the archive
  doesn't hold exactly one transcript record; the transcript is still delivered, just flagged.
- **critique flags a crashed task turn instead of grading evidence from it.** `taskTurnInfraFailure` only
  treated a *killed* (timed-out / byte-capped) task turn as an instrument failure — a task that exited
  nonzero without ever printing a parseable result envelope (a crash after the early `[status]` line)
  slipped through, and its `[status]`-recovered run dir was reflected on and graded as a legitimate task.
  It now also flags a nonzero exit with no parseable envelope. Deliberately narrow: a completed run that
  reported a failing verdict (`ok:false` / `result:"error"` with a valid envelope) stays gradeable.
- **A nested unreadable output subtree no longer persists a partial file list as complete.** The
  `workspaceFiles` / `artifacts` list was recorded as UNAVAILABLE (`undefined`, the evidence-unavailable
  convention) only when the workspace ROOT was unobservable; a nested `EACCES`/`EIO` subtree left the walk
  partial (`walkComplete: false`) but still persisted the incompletely-enumerated list as if complete. An
  authored file inside the unreadable subtree then vanished with no signal, so an absence-sensitive
  consumer (`delivered_clean` / `ended_with_question`, the replay `diff`, `scaffold`, `file_exists`) could
  read it as absent — a silent false-clean. All three RunResult producers (run, partial-salvage, chat) now
  route through one shared `trustedWorkspaceFiles` gate that collapses a missing root OR any incomplete
  walk to `undefined`, and the run lanes emit a `::warning::` naming the unreadable subtree.

## [1.7.0] — 2026-07-22

### Added

- **`migrate-run-dir` — convert pre-layout run dirs to the per-turn `turns/<N>/` layout, in place.**
  A run dir written before the per-turn layout keeps `result.json` / `run.jsonl` / `trace.json` /
  `resources.jsonl` at its root. Once the legacy read layer is removed, those dirs become unreadable to
  `verify-run` / `diff` / `inspect` / `stats`; this command converts them so the history survives the
  change instead of having to be re-run.

  **Dry-run by default** — `--write` applies, and `--scenario <name>` scopes the run to a single
  scenario so a rollout can be staged: migrate one, verify it, then do the rest. It renames rather than copies, so file mtimes (the recency
  signal `stats` and `status --latest-for` rank by) survive untouched, and it restores directory mtimes
  afterwards. An interrupted run records a journal outside the run dir and is finished by re-running the
  command. Anything it cannot resolve unambiguously — a root artifact that is neither a duplicate nor
  placeable, telemetry whose turn boundary cannot be dated or that spans more than two turns or whose
  samples would land in a turn no transcript or result evidences, a dir with
  no transcript at all — is **refused and named**. The one inference it makes is positional: an EMPTY file
  has no content to attribute, so it follows its position to an EVIDENCED turn (its own, by name or by
  rootArtifactTurn when a root transcript or result exists to move there) — never one it would mint. The
  same never-mint rule holds on the content path: a stray `resources.turn-N.jsonl` cannot manufacture
  `turns/N/` whether it is empty or carries samples, and a fully-archived dir's trailing telemetry cannot
  manufacture the next turn out of arithmetic alone. Exit `1` when anything was refused, so a CI caller sees unfinished work.
  After a `--write` that migrated or recovered anything, it prints a reminder to rebuild the index
  (`cowork-harness stats --reindex`), since the index keys a row's timestamp off `result.json`'s mtime and
  the files have moved.

- **`prune` skips scenarios with a migration in flight.** Between an interrupted migration and its
  recovery a run dir's mtime reflects the migration, not the run — and `prune` ranks keep-slots by that
  mtime, so it could evict a newer run in favour of a half-migrated older one. It now defers those
  scenarios and says so.

- **`critique` surfaces the GRADED turn's `outcome` and `skillHash` in its own report**
  (`gradedOutcome` / `gradedSkillHash` in JSON, and in the text header), and writes the graded result
  under the stable name **`result.graded.json`**. `critique` runs two turns into one run directory, so
  after the resume `result.json` is the *reflection* turn's and the graded turn is archived as
  `result.turn-1.json` — the correct file to read was the *lower* number, the opposite of every other
  multi-run convention. A harvester reading `result.json` silently ingested the reflection turn's numbers:
  valid-looking, wrong, and unsignalled. Reported by a consumer building exactly that harvester; a
  documentation-only fix would have helped only readers who already knew to look.

- **`exec_infra_error` verdict signal (`WARN`)** — a container `exec` that failed for infrastructure
  reasons, as distinct from the fail-severity `infra_error` (a supervising process died). One failed
  command no longer contaminates a whole run's evidence.
- **`RunResult.infraErrors[].source` is now an enum** — `hostloop-sidecar` / `hostloop-exec` /
  `egress-sidecar`. The origin is what drives severity, and it is carried through the frozen cassette so
  replay reaches the same verdict as the live run.
- **Capability use-scan health** — an unreadable or partially unparseable `events.jsonl` is now reported
  as a degraded scan instead of being indistinguishable from a complete scan that found nothing.

- **Every `critique` limitation is now tagged with WHY it exists**, not just what it is — `structural`
  (permanent, architect around it), `unverified` (unproven, **not** known-impossible), `deliberate` (a
  design choice), `not-built` (simply absent). The distinction a reader needs is rarely "what can't it
  do" but "should I design around this forever, or wait for it?" **Container-tier-only is `unverified`**:
  the resume-continuity proof was run against the container tier's Linux ELF, and hostloop runs a
  different (native) agent binary, so the proof does not transfer — nothing suggests hostloop would fail,
  nobody has run it. **Lifting the pin needs BOTH** a live resume-continuity proof at hostloop against its
  native binary AND the follow-on work that proof unblocks (unpinning three hard-coded container sites,
  stamping the tier on the session manifest so a cross-tier resume fails loud, and plumbing host-write
  consent) — evidence alone is not sufficient. A consumer read that pin as permanent and built a second
  test lane around it. The tags appear in `critique --help` and [docs/critique.md](./docs/critique.md),
  generated from one source.
- **`critique --help`'s KNOWN LIMITATIONS block is generated** from that source, and CI asserts the
  shipped binary's output, the docs bullets, and their tags all agree.

### Changed

- ⚠️ **BREAKING: per-turn run-directory layout, single shape — the root-level `result.json` compatibility
  copy is REMOVED.** A run directory that holds several turns (any `--resume`, and every `critique`) writes
  each turn's `result.json`, `run.jsonl`, `trace.json` and `resources.jsonl` into **`turns/<N>/`**, once,
  under its final name — nothing is renamed or overwritten as later turns arrive. `chat` now goes through
  the same layout too (always `turns/1/` — a `chat` session mints a fresh dir per invocation and never
  resumes). **`<outDir>/result.json` no longer exists — there is no root compat copy of any per-turn
  artifact, on ANY run dir.** Read `turns/<N>/result.json` directly (`turns/1/` for a single-turn run), or
  — for `critique` — the unchanged `result.graded.json` / `trace.graded.json` role aliases. Cumulative
  streams (`events.jsonl`, `timeline.jsonl`) and session state are unchanged, so `critique`'s byte-offset
  turn-isolation proof and cassette capture are unaffected.

  **Two prior shapes are now REFUSED, loudly, by name, instead of being silently misread:**
  - a **pre-layout** run dir (written before `turns/<N>/` existed: root `result.json`/`run.jsonl`, or a
    name-mangled `result.turn-<N>.json` archive, no `turns/`);
  - a **mixed** run dir (a pre-layout dir resumed under CURRENT code before this release — `turns/` present
    *and* a stray root/archived file).

  `verify-run`, `inspect`, `scaffold`, `diff`, `status --latest-for`, and a resumed `--session-id` all
  refuse these with a message naming the shape found and pointing at `trace <dir>` — which still works
  fully, since every one of its views derives from `events.jsonl`, which never moves. `stats --reindex`
  counts them as skipped and names the remedy rather than dropping them from the index quietly.

  **Migration: `cowork-harness migrate-run-dir`** converts a pre-layout dir in place (dry-run by default),
  preserving the file timestamps `stats` and `status --latest-for` rank by. `diff` and
  `status --latest-for` are called out because their pre-refusal behaviour was the dangerous kind: `diff`
  reported two genuinely different runs as `identical` and exited 0, and `status --latest-for` could
  select a *different* run than the newest and report its verdict — a CI script reading `.verdict.pass`
  got a green light for a red run.

  Previously the latest turn lived at the root while earlier ones were name-mangled archives, so a file's
  name depended on whether a later turn ever happened; that shape produced a wrong-turn read, a destroyed
  trace, and a dropped index row — this release's read-side (`turnArtifactPath` / `listTurns` in
  `turn-layout.ts`, with the old `readTurnResult` deleted for having zero production callers) no longer has
  a legacy-resolving branch at all, so that class of bug is now unrepresentable rather than merely fixed. The Python SDK's `_latest_run_jsonl` likewise now raises loudly
  on a pre-layout dir instead of silently falling back to a root `run.jsonl` that (for any current-layout
  dir) is a path to nowhere.

- **Platform baseline synced to Desktop 1.24012.1** (`baselines/desktop-1.24012.1.json`, now what
  `baseline: latest` resolves to). The staged **agent binary is `2.1.217`** (native app + VM ELF, new
  sha256 for each). The baseline moved in two steps this release — an earlier sync to **1.24012.0** (agent
  `2.1.215`), then to 1.24012.1 — with **no prompt, spawn-env, or egress-allowlist drift across either**:
  `spawn.env` is byte-identical to 1.22209.3, the same 15-domain allowlist and `gvisor` mode carry over
  (the effort map is the one spawn field that changed — see the sonnet-5 delta below), and the
  `deriveSpawnEnv` / `checkSpawnContractFacts` oracles stay green against the live asar. The
  substantive deltas all came from the 1.24012.0 step and carry forward unchanged: `claude-sonnet-5` joins
  the per-model effort map (`low|medium|high|xhigh|max`, recommended `medium`, modes `auto`); the
  `coworkRuntimeConfig` gate drops its `pluginsFullSyncStalenessMs` key (never modeled here, inert); and
  the dormant `autoModeOverridesAlwaysAllow` sentinel fired — see below. 1.24012.1 itself adds only the
  agent bump: the `2.1.217` binary can emit the VCS SDK events `code_change_published` /
  `vcs_state_changed` (SDK floor `2.1.216`), which the harness surfaces as a `system_event` (its existing
  graceful degradation of an unmodeled system event, unchanged), and the binary's native skill-discovery
  enable predicate widened to three branches — still inert here, since real Cowork's model-visible surface
  is the Desktop SDK-MCP discovery servers, not the native tools. The example cassettes'
  `fingerprint.baseline` tracks the new baseline.
- **The `autoModeOverridesAlwaysAllow` gate (`4200321681`) flipped absent → on** (`source: force`) and was
  revisited as its pin intended. It stays **unmodeled, deliberately**: binary-verified in 1.24012.0, both
  call sites only override an *already-existing* always-allow decision — the session rule cache
  (`approvedToolNames`) and scheduled-task auto-approval — each further gated on `permissionMode` and
  `isDestructiveConnectorTool`. The harness persists neither, so it already prompts wherever the gate makes
  Cowork prompt; enabling it moves real Cowork *toward* harness behavior rather than away. Revisit only if
  the harness gains a persistent per-tool approval cache.
- **The staged agent (`2.1.217`) enforces sub-agent fan-out caps, so `dispatch_count_max` is now framed as
  a budget UNDER Cowork's cap, not a reproduction of it.** Because the harness spawns the real binary, a
  run that fans out past the agent's caps now errors from the binary itself: a **concurrent** cap
  (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default 20; error `subagent_concurrency_cap`, new in 2.1.217)
  and a **per-session** cap (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`, default 200; error
  `subagent_count_cap`, present since ≤2.1.215). The scenario schema's `dispatch_count_max` description,
  the `assert` over-budget message, and SPEC §10 no longer claim "Cowork imposes no in-conversation
  Task-dispatch cap" — that claim was stale. The harness does not reproduce the caps; it inherits them by
  running the binary.
- **A host-loop `exec` infrastructure failure now WARNS instead of failing the run.** ⚠️ **Upgrade note:**
  a run that previously exited `1` because one `docker exec` failed will now exit `0`. A dead sidecar
  still hard-fails. Known residual, documented in `docs/scenario.md`: if *every* exec failed the agent ran
  nothing and the run still only warns — inspect `result.infraErrors` when a run looks suspiciously empty.
- **A model-requested bash `timeout_ms` expiry is no longer classified as an infrastructure failure.**
  The model now receives its command's own partial output with `Command timed out after <duration>`
  merged into stderr — matching real Cowork, verified against the staged agent binary — instead of an
  opaque `[infrastructure error: see run log for details]`.
- **The agent's spawn env now always carries a normalized IANA `TZ`** — matching Desktop, which injects
  `Intl.DateTimeFormat().resolvedOptions().timeZone` unconditionally. Previously `TZ` was forwarded only
  when the host shell exported it, and forwarded raw, so a host with no `TZ` set — or a legacy/non-IANA
  export (`US/Eastern`, `EST5EDT`) — diverged from real Cowork's date/"today" rendering inside the agent.
- **The `tool_available` assertion now names its evidence limit.** It evaluates against the run's
  *eagerly-loaded* tool set (the SDK init manifest in `result.json`); a factory-deferred tool — e.g. the
  skill-discovery MCP tools, loaded on demand via a `ToolSearch` round-trip — can be genuinely available in
  the run yet miss here, a false negative. The assertion still fails on a miss; the failure message now
  states that eagerly-loaded scope rather than implying provable unavailability.
- **An explicitly requested `--dotenv` file now fails loud.** ⚠️ **Upgrade note:** an unreadable file, or
  a path that is a directory, previously fell through to lower-precedence `.env` sources *while still
  printing a success line* — so a typo'd path silently ran against the wrong credentials. It is now a
  usage error. Automatic `.env` discovery is unchanged (still best-effort).
- **`diff` no longer reports `identical` when only one side has an artifact manifest.** ⚠️ **Upgrade
  note:** such a comparison previously exited `0`; it now exits `1`, because unavailable evidence is not
  evidence of equality. Both-sides-missing still does not veto identity. The `--output-format json`
  envelope gained an `artifactsAvailability` key.
- **`stats --reindex` merges rows by per-completion identity** (`outDir` + a new `turn` field) rather than
  by `outDir` alone, and reports rejected symlinked run directories.

### Fixed

- **`verify-run` now REFUSES a multi-turn run directory** instead of certifying the wrong turn. Root
  `result.json` is the latest turn; on a `critique` directory that is the *reflection* turn while the
  scenario describes the *graded* one. Previously the cumulative gate scan false-FAILED on the other
  turn's gates — wrong, but loud. The refusal names `result.graded.json` / `turns/1/result.json` so the
  caller can still reach the graded turn.
- **`trace` no longer mixes turn scopes.** After timeline reads became turn-scoped, `--view
  tool-durations` showed the latest turn while the tools/questions/dispatches views still showed every
  turn — two views of one run directory describing different scopes. All views are now the latest turn,
  and a `::notice::` reports when earlier turns exist rather than hiding them. Its cache-read footer and
  gate-provenance (`answeredBy`) views also now say when a result is not turn-addressable (a pre-layout
  dir) instead of silently omitting the cache-read ratio / labels.
- **`prune` no longer demotes an unmigrated pre-layout run dir to the junk tier.** Its real-run predicate
  keyed on `hasTurnDirs || events.jsonl`, reasoning only about what current writers produce — but `prune`
  ranks *history*, including the legacy dirs `migrate-run-dir` exists to preserve, so a legacy dir with no
  `events.jsonl` could be evicted ahead of an empty scaffold. It now also counts a `legacy` / `mixed` shape
  as a real run. (Distinct from the in-flight-migration deferral above — this is about which dirs count as
  real at all.)

- **A resumed turn was judged on the PRIOR turn's evidence — three wrong-verdict paths.** `events.jsonl`
  is append-only across turns with no per-turn marker, and three whole-file scanners decide a run's
  outcome: `scanEvents` (outputs-delete / host-path-leak → fail signals, and an authored
  `no_delete_in_outputs`), `findUngatedPathToolCalls` (→ a run-level `error` at hostloop), and
  `detectCapabilityUse` (→ `missing_capability`, a fail signal, which fires on the default lean image).
  So on any `--resume` — and every `critique` reflection turn — turn 1's delete, gated tool call, or
  capability use FAILED turn 2. A turn-start marker now scopes all three to the current turn.
  `resources.jsonl` had the same shape (turn 1's peak RSS judged against turn 2's `max_peak_rss_bytes`)
  and is archived per turn. Single-turn runs write no marker, so their `events.jsonl` is byte-identical
  and no cassette is affected. Missing marker ⇒ whole-file scan, i.e. fail-closed.

- **A resumed turn's telemetry included the PRIOR turn's events, and could produce a false PASS.**
  `timeline.jsonl` is append-mode with a fresh header per turn, but `readTimeline` returned every line
  after the first as an event — so on any `--resume` (and every `critique` reflection turn) the current
  turn's `toolDurations`/`skillActivity`/`subagents` folded in the previous turn's tool calls. Because
  the **`skill_tool_used` assertion** evaluates against that same `skillActivity`, a turn-1 skill window
  could satisfy a turn-2 assertion. The reader now returns only the current turn's segment. The file
  stays one append-only stream, so `critique`'s byte-offset turn-isolation proof is unaffected.

- **A resumed turn destroyed the prior turn's `trace.json`.** Because it is rebuilt and overwritten on
  every completion, the earlier turn's trace was deleted rather than preserved, so a `critique` lost the
  graded turn's trace entirely. Each turn now owns its own `turns/<N>/trace.json`, written once and never
  overwritten, and `critique` additionally writes **`trace.graded.json`** beside `result.graded.json`.
- **`stats --reindex` dropped every non-latest turn when rebuilding from the runs tree.** It read only the
  root `result.json` per run directory, so a resumed session's earlier turns vanished — and on a
  `critique` directory the root file is the *reflection* turn, so it was the **graded** rows that were
  lost. Every turn under `turns/<N>/` is now indexed as its own completion; `result.graded.json` — a
  root-level copy of the graded turn — is deliberately not matched, so it cannot double-count. A dir that
  has not been migrated is counted as `skippedLegacy` and reported with the remedy, never dropped
  silently.

- **An ambient `GIT_DIR` silently computed the wrong skill file set.** Git hooks export `GIT_DIR` (and
  `GIT_INDEX_FILE`) into every child process, and with `GIT_DIR` set but no `GIT_WORK_TREE` git stops
  inferring the work tree from `cwd` and treats `cwd` as the repo root. `gitTrackedSet`'s
  `rev-parse --show-toplevel` probe therefore still succeeded — so the not-a-repo raw-walk fallback never
  fired — while `git ls-files -- .` returned the **entire repo index as root-relative paths** instead of
  the directory-relative ones. Measured on this repo: 2 tracked files became 625 wrong ones. That set
  feeds both `skillHash` and the mount-copy filter, so any run invoked from a git hook (or from CI that
  exports `GIT_DIR`) got a wrong hash and a mount filter pointed at paths that do not exist under the
  skill dir. The visible symptom was the repo's own pre-commit hook reporting committed example cassettes
  as `[stale] skill files changed since record` on every parity sync. `skillCommit` had the same defect:
  `git -C <dir>` is overridden by an ambient `GIT_DIR`, so every skill dir resolved to that foreign repo's
  HEAD — recording a foreign commit as the skill's provenance and masking dirs that are genuinely in
  different repos. Both call sites now spawn git with `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`
  stripped, via one shared helper so they cannot drift. `run-index`'s `gitInfo` and `doctor`'s worktree
  probe deliberately keep inheriting — they are asking about the *ambient* repo.
- **`stats --reindex` destroyed multi-turn history.** Every `--resume` turn — and `critique`'s task +
  reflection pair — writes to one `outDir`, so keying by directory collapsed N completions into one,
  silently changing run counts, pass rates and costs.
- **Host-loop sidecar failures never reached the verdict.** They were appended straight to `events.jsonl`,
  which no live drive re-reads, so a dying sidecar left the run green; a signal-only termination (OOM,
  `SIGKILL`) was recorded nowhere at all.
- **`result.json` was written non-atomically** at all three producers, so an interrupted write could leave
  the canonical record truncated.
- **Corrupt index rows were blind-cast**, letting one malformed row crash `stats` or fabricate a
  pass/cost value; `reindex` also followed symlinks out of the runs root.
- **`scaffold` turned unavailable artifact evidence into "no artifacts"**, permanently encoding a false
  "this run produced nothing" claim into a generated scenario.
- **`critique` treated a vanished turn-1 evidence file as genuinely empty evidence** rather than an
  integrity failure. A stream that was legitimately zero bytes at capture is still reported clean.
- **`critique`'s exit-code table omitted `1`.** Exit `1` is reachable on operator interrupt
  (SIGINT/SIGTERM); a sweep wrapper treating it as impossible misreads a cancelled run as a crash.
- Documented that after critique's resume, `result.json` is the **reflection** turn's result — the graded
  turn is archived as `result.turn-1.json`. Reading the wrong one yields a valid-looking wrong number.

## [1.6.0] — 2026-07-20

### Added

- **`critique` now accepts the `skill` flags a graded run needs — starting with uploads.** A skill whose
  whole job is "here is a document, analyze it" (cap table, pitch deck, financial model, transcript) could
  not be critiqued at all: there was no way to attach the file, so the agent was asked to analyze a
  document that was never there and then asked what confused it — you harvested a finding about the test
  rig. `--upload`, `--folder`, `--plugin`, `--marketplace`/`--enable` (all repeatable), `--model` and
  `--allow-missing-capability` now reach **both** spawned turns; that is forced, not stylistic, because
  those paths are part of the session-origin key the reflection turn's `--resume` recomputes. `--label`,
  `--timeout`, `--answer`/`--answer-policy`, `--on-unanswered` and the decider flags reach the graded turn
  only. `--answer`/`--answer-policy` make **gated** skills critiquable for the first time — the inner spawn
  has no TTY, so an unscripted gate previously killed the task turn before anything could be graded.
  Anything that cannot work is refused **with its reason** rather than silently ignored:
  `--session-id`/`--resume`, the `--repeat` family, `--ablate-skill`, and the rendering/preview flags.
- **`critique --prompt-file <path>`** — read the probe verbatim from a file, so a probe containing quotes,
  `$` or newlines does not have to survive shell parsing.
- **"Attached inputs" evidence section** — upload filenames and sizes, plus connected-folder mount names,
  never content. Without it the evaluator could not tell "the agent said there was no file, and correctly
  so" from a confabulation.
- **One source of truth for the `skill` flag surface** (`src/run/skill-flag-surface.ts`), where each flag's
  critique disposition is a **required** field, plus a parity guard that fails CI when a new `skill` flag
  arrives without one. The old hand-rolled subset drifted silently — this repo's recurring bug shape.

### Changed

- **Repeating a single-valued `critique` flag is now a usage error (exit `2`) instead of silent
  last-wins.** `--upload`, `--folder`, `--plugin`, `--marketplace`, `--enable` and `--answer` accumulate —
  repeating them is how you pass several. Everything else is single-valued, and `--prompt a --prompt b`
  silently discarding a probe you typed is the class of no-op this command refuses on principle. Boolean
  flags may still be repeated harmlessly. Documented in `critique --help` and
  [docs/critique.md](./docs/critique.md).

### Fixed

- **`critique --dotenv <path>` was documented but unreachable** (shipped that way in 1.5.0). The
  misplaced-global guard rejected the token after any subcommand, and the `--dotenv=x` form that slipped
  past it then hit critique's exact-match parser as "unknown flag". `critique` is now exempt from the guard
  (`--run-dir` still has no per-command meaning and stays rejected everywhere), and a missing file fails
  fast with critique's own error instead of surfacing later as an instrument-failure diagnostic.

## [1.5.0] — 2026-07-20

### Added

- **`cowork-harness critique <skill-folder> --prompt "<probe>"` (EXPERIMENTAL).** Runs a skill, asks the
  agent what confused it, then grades that self-report against a frozen record of what actually happened —
  a byte-boundary evidence snapshot taken *before* the reflection turn, a first evaluator pass that is
  structurally blind to the self-report (the text is never put in its prompt, not merely ignored), and
  mechanical citation checking that drops any claim not quoting the evidence verbatim. **A discovery
  instrument, never a gate:** findings of any classification exit 0 (including a task run that itself
  errored — that is a finding about the skill); exit 2 is reserved for a usage error or an instrument
  failure, where no critique was produced. Previously a maintainer-only script that could not run from an installed package at all.
  Costs four model workloads per critique — see [docs/critique.md](./docs/critique.md).
- **Evidence-package armoring.** The self-report was already fenced, but the evidence package — which
  carries a third-party SKILL.md verbatim into both evaluator prompts — was not, so hostile skill content
  could steer the grader directly. Untrusted content now sits inside per-run nonce markers and only
  nonce-tagged headings outside them count as instructions; a skill cannot pre-author the nonce. Verified
  by a red-team probe across three models: the structural-forgery payload that steered all three now
  matches control. Content that merely *argues* is a documented residual — fencing separates planes, it
  cannot stop persuasion.
- **`skill --repeat <N>`** (2–100), with `--min-pass-rate` / `--stop-on-diverge` / `--max-budget-usd` /
  `--allow-budget-stop`. The variance rollup already existed but was `run`-only, because the flags were
  parsed inline in the `run` command — the exploratory lane, where an iterate-across-fixes loop actually
  lives, rejected them as unknown. Both lanes now share one parse (`run/repeat-flags.ts`) and one batch
  engine, so rollup shape, JSON envelope, and batch verdict match. `skill --repeat` additionally rejects
  `--session-id`/`--resume` (both pin a single run dir, so iterations would overwrite each other rather
  than produce N independent samples) and `--decider-dir`/`--decider-cmd` (the reproducibility invariant
  `run` already enforced).
- **`result.json` `outcome`** — a one-field rollup of the `result` × `verdict.pass` × exit-code matrix:
  `errored` / `no_deliverable` / `delivered_with_verdict_fail` / `delivered_clean`. Those three signals
  legitimately disagree (a fail-severity signal flips the verdict while `result` stays `"success"`), and a
  consumer driving a loop had to reconstruct "did this iteration deliver something usable?" from all
  three. A pure function of fields the run already carries, so it cannot disagree with them; the granular
  fields stay authoritative. Absent whenever `verdict` is absent. Note `delivered_*` means "no
  stall/question signal fired", not positive evidence a deliverable exists — check `artifacts`.
- **Generation-pairing `jq` recipes** in [docs/stats.md](./docs/stats.md) — pass-rate/cost per generation,
  a per-generation verdict-signal histogram, and the before/after of a single fix, grouped on
  `skillHash`/`runLabel` over `index.jsonl`.

### Changed

- **`diff`'s exit code now honors its own documented contract.** `--help` has always said "transcript is
  advisory … tools/artifacts/meta are the gateable signal", but `identical` conjoined all four views, so
  two live runs of the SAME skill exited 1 and the signal could not separate "behaviour changed" from
  model stochasticity. `identical` now means the gateable views agree; transcript drift is reported
  separately (`transcriptDiffers` in JSON, rendered in text when you ask for that view) so it stays
  visible. `diff` also carries `skillHash` in the meta view now — a diff across a fix could not previously
  name which two generations it compared.

### Fixed

- **`fingerprint.skillHash` and `skillCommit` are now recorded on the `skill` and `probe-dispatch` lanes.**
  Both resolved their skill dirs by re-reading the session *file*, so the lanes that mount via an in-memory
  session — and pass the `"(inline)"` sentinel as the session path — emitted no `skillHash` and a null
  `skillCommit`, even though the mounts were already in scope at the call site. The resolved session object
  is now threaded through instead. Consequences, all previously broken on those lanes: `result.json` carries
  the content-exact generation key, the run-index `skillHash` column populates (so a harvest step can group
  runs by generation), and the run's own "pair critiques by `fingerprint.skillHash`" tip — which is printed
  *only* on the `skill` lane — is no longer advertising a field that lane could not emit. Scoped to the
  sentinel branch: the file-based path is untouched, so recorded cassettes and the
  staleness / `verify-run` recomputes are unaffected. A session that mounts nothing still yields no hash —
  there is nothing to hash.

### Changed

- **Reflective skill-critique prompt v2** (`REFLECTION_PROMPT_VERSION` 1 → 2; maintainer instrument, not a
  shipped surface). Adds a sub-agent question (were any dispatched, and was the skill clear about when to
  dispatch, what context to hand them, and what to expect back); replaces the "change ONE thing" cap with
  exhaustive solicitation, since a separate evaluator already triages and drops ungrounded findings, so
  capping at the source loses signal for no quality gain; drops a "fidelity tier" example that is
  cowork-harness vocabulary a third-party skill's agent never encountered; and bounds the pass-2 self-report
  now that the prompt invites longer replies.

## [1.4.0] — 2026-07-19

### Added

- **`coworkWebFetchDedup` enacted (hostloop `web_fetch`).** Real Cowork keeps a per-session negative-work
  cache: a repeat `web_fetch` of the same normalized URL within a TTL (default 15 min; cap 100; FIFO
  eviction; a hit does not refresh recency) makes **no network request** and returns a marker telling the
  model to re-use the earlier result. The harness now reproduces this on the host-API (`coworkWebFetchViaApi`)
  path — **baseline-gated** (only when the resolved baseline's `coworkWebFetchDedup` gate is on, i.e. Desktop
  ≥ 1.22209.3), keyed under both the request URL and the terminal `destination_url`, never caching errors /
  empty / non-2xx responses, and emitting **no egress event** on a hit (matching production's zero-network
  dedup). A hit is observable via the marker text (`tool_result_contains: "Already fetched"`).

### Changed

- **Platform baseline synced to Desktop 1.22209.3** (agent `2.1.215`). No prompt / spawn-env / egress-allowlist
  drift vs 1.21459.0; the sync captured the new `coworkWebFetchDedup` runtime config (enacted above) plus a
  few new (off) GrowthBook gates. The skill/README/reference version floors and agent-binary pins track the
  new baseline.

## [1.3.0] — 2026-07-19

### Added

- **`skill --allow-missing-capability`** — the open-ended-run equivalent of a scenario asserting
  `allow_missing_capability: true`. An open-ended `skill` run has no `assert:` block to carry the opt-out,
  so a self-flagged capability FALSE-NEGATIVE on the lean `core` image would hard-fail with no escape
  hatch; the flag merges the modifier onto the synthesized success assertion, suppressing both the
  post-run `missing_capability` fail and the pre-run capability abort.
- **`ended_with_question` verdict signal (WARN)** — a heuristic run-level classifier: the agent's final
  answer contains a question and the run wrote no deliverable to `outputs/` — a likely conversational
  dead-end that still exited `result:"success"`. The lenient warn-severity sibling of the strict, fail
  `stalled` (which already catches a trailing-`?` final turn with no post-gate tool work); this covers the
  residual — a mid-message `?`, or tool work after the last gate that still ended asking. Never flips a
  verdict; `verify-run` over historical results may surface it on matching old runs (benign).
- **`--decider-llm` "Other" answers are marked in gate provenance** — a decision answered via the
  `OTHER:` free-text path (or a no-option free-text gate) now carries `[via Other free-text]` in its
  `rationale`, so a `result.json` consumer can distinguish it from an offered-option pick. (Multi-select
  gates remain index-only — `OTHER:` is rejected there, now pinned by a test.)

- **Run-identity metadata for the iterate-across-fixes loop.** `skill`/`run` accept `--label <tag>`, a
  human-readable generation tag surfaced in `result.json` (`runLabel`), the run-index row, `inspect`, and
  `status.json`. Each live run also records `skillCommit` — best-effort git `HEAD` of the session's skill
  source dirs (commit provenance; `null` when the dirs span >1 repo or aren't a git work tree). These are
  ergonomics on top of the **authoritative** content-exact version key `fingerprint.skillHash` (already
  recorded on every run): a harvest step should group/pair a critique against a matching `skillHash`.
  `inspect` and the run-index row now surface a short `skillHash` prefix so a pairing check needs no
  `result.json` open. (Chat runs carry no `skillHash` and take no `--label`.)
- **`trace --full-results`** captures the FULL input + result of every tool call — successful ones too,
  not just errors (`resultTextFull`/`detailFull`, 4 KB cap) — so an external grader can ground a
  self-critique finding against the call it cites. The default view keeps its 100/120-char slices, so
  existing JSON consumers are unaffected.
- **`verify-run` now warns on skill drift for answer-less scenarios.** Previously the skillHash-drift
  check ran only when a scenario declared scripted `answers` (a hard fail). An answer-less `verify-run`
  now emits a `::warning::` ("the kept run predates the current skill … findings describe an older skill
  version") instead of staying silent — a WARN, not a fail, since re-asserting a new `assert:` block
  against a frozen run dir is legitimate.

### Fixed

- **Filesystem-evidence assertions no longer pass on incomplete evidence.** `input_unmodified` now fails
  loud when its glob matches **no** pre-run path (a typo or renamed mount was a silent vacuous pass), and
  fails evidence-unavailable when a manifest path escapes the workspace root or a matched file exceeds the
  hash cap. The pre-run baseline records its provenance, so `no_unexpected_files` / `input_unmodified` fail
  evidence-unavailable on an unreadable connected-folder baseline instead of diffing a partial tree
  (`RunResult` gains `preRunOrigin`). `no_lost_write_back` no longer silently misses a modified-but-unreadable
  or over-cap file, an authored file under an unreadable subtree, or a scratchpad deliverable behind a
  symlink/hardlink — each now surfaces as could-not-verify.
- **Run-dir consumers no longer read absent evidence as empty, or a replay re-check as run evidence.**
  `verify-run` now refuses (exit `2`, "can't verify ⇒ not green") a run dir whose `result.json` was produced
  by `replay` (`command:"replay"` — a re-check of a recorded cassette, not run evidence) or by `chat`
  (`mode:"chat"` — no assertions or verdict by contract); the refusal keys on `command`/`mode`, never on
  `workspaceFiles`, so a live run merely lacking optional evidence fields still verifies. `stats --reindex`
  skips a stray `command:"replay"` `result.json` instead of stripping the label and relabeling it `"run"`,
  and its report line separates `skipped — replay re-check, not evidence` from `skipped — missing/corrupt
  result.json`. `trace --view files` reports workspace-file evidence **UNAVAILABLE**
  (`workspaceFilesRecorded: false` in JSON) when `workspaceFiles` is absent — distinct from a run that
  genuinely wrote nothing — and no longer emits phantom "removed" diff rows against a persisted
  `preRunHashes` in that case. `inspect` likewise prints `artifacts: UNAVAILABLE`
  (`artifactsRecorded: false`) instead of `artifacts (0):` when `result.artifacts` is absent.
- **Static artifact analysis (`analyze-skill` / `no_lost_write_back` Tier A)** closes several false-green and
  false-positive holes: recognizes `axios`/jQuery and library write-backs, computed member calls
  (`xhr["open"]`), unquoted and submitter-overridden `<form>` actions, and ES-module sources; classifies URLs
  with the WHATWG parser so `localhost.evil.com`, protocol-relative `//host`, and `mailto:`/`data:` are no
  longer misread as local; scope-aware constant folding and member-mutation tracking stop live code being
  proven dead; an unresolved URL or method (including spread request options) yields could-not-verify instead
  of a silent clean; and every write-back in a file is reported, not just the first. The advertised
  `.ts/.tsx/.jsx` source extensions are dropped (no compatible parser) — treated as out-of-scope rather than
  parse-noise.
- **Runtime artifact confirmation (Tier B)** now confirms edit-fired autosaves and load-time write-backs (not
  only explicit commits), handles `fetch(Request)`, models browser-faithful XHR response/listener semantics,
  skips disabled/hidden controls and honors a submitter's `formaction`, analyzes observed writes before
  downgrading on an external script, matches loopback hosts exactly, and no longer swallows unrelated harness
  exceptions.
- **`analyze-skill` orchestration** fails could-not-verify (exit `3`) when a `references`/`agents`/`commands`/
  `skills` subtree is unreadable (was a silent clean); an ignore marker inside a fenced or block-quoted
  example no longer suppresses real findings; a mixed invocation fails on a positional that resolves to no
  scannable source; JSON coverage lists clean artifact sources; and runtime mode honors the 3 MB read cap.
- **Protocol / decision handling fails closed on drift.** Unknown control-request subtypes and duplicate
  outstanding request IDs are rejected as protocol errors; malformed user/tool-result blocks increment a new
  `evidenceErrors.protocolMalformed` counter; the ABSTAIN permission/dialog fallback reconciles answer
  delivery like a normal decision; `present_files` leak classification normalizes `..` paths; gate answers
  require a request id; and an `allow_if` expression no longer fails to compile when a permission input key is
  a reserved word.
- **CI / release gates.** The baseline-staleness check rejects non-finite, future-dated, and corrupt
  timestamps (extracted to a unit-tested `scripts/check-baseline-staleness.ts`); manual container-image
  publishes require a green CI run unless an explicit break-glass input is set; and the composite Action
  passes inputs via the environment (closing a shell-injection surface) and accepts a JSON-array `extra-args`
  that preserves quoting and spaces.
- **`analyze-skill` top-level `--help`** now documents the `--runtime` flag and exit code `3`
  (could-not-verify); previously these appeared only in the per-command `analyze-skill --help`.
- Corrected a phantom assertion key in the `record --margins` documentation
  (`max_tool_calls` → the real `tool_calls_max`).

### Documentation

- Documented previously-undocumented CLI flags: `record --force` (narrowly overrides the
  different-scenario slug-collision overwrite refusal) and `record --decider-model`; `probe-dispatch`'s
  inherited `--decider-cmd` / `--decider-dir` / `--on-unanswered` / `--ablate-skill`; and
  `skill --timeout` / `--answer-policy`.
- Clarified the scenario-schema descriptions for `user_visible_artifact` (the assertion value is
  workRoot-relative — e.g. `outputs/x.md`, not `mnt/`-prefixed) and `gate_answers_delivered`
  (documented the `: false` confirmed-non-delivery inverse). Regenerated `schema/scenario.schema.json`.
- Qualified the stable JSON-envelope contract: SPEC §11 now maps commands to envelope families by
  mechanism (`jsonEnvelope` / `jsonPayloadEnvelope` / dedicated), and README defers to it; clarified
  that `replay` exit `2` is a whole-cassette operational failure, distinct from an in-cassette
  malformation (which fails as an exit-`1` assertion).
- Added a `docs/decisions/` ADR index, `python/README.md` cross-links into the main doc spine, and
  `RELEASING.md` to `llms.txt`; signposted the specialized `docs/*.md` guides and added `lint-skill` /
  `analyze-skill` rows to the docs index.

## [1.2.0] — 2026-07-18

### Added

- **`no_lost_write_back: true` scenario assertion** — gate a scenario on "the agent didn't emit an
  interactive artifact whose Submit is lost under Cowork". It runs the shipped static Tier A analyzer
  (`analyze-artifact`, deterministic, no headless DOM) over the files the run authored — diffed against the
  pre-run manifest — so a lost relative `fetch`/XHR/`sendBeacon`/`<form method=post>` write-back becomes a
  per-scenario verdict, not just an out-of-band `analyze-skill` scan. A lost write-back on an **added**
  agent-authored source (`outputs/` or the scratchpad) fails; a **pre-existing** file the skill only modified
  on a read-write connected mount is advisory (not the skill's to own); `-suspect` findings surface but pass.
  Honest evidence-unavailable semantics: could-not-verify (fail-closed, never a silent clean) on a `--resume`
  scratchpad walk or an authored candidate that couldn't be analyzed. Runs on every live sandbox tier
  including **microvm** (its outputs are snapshotted from the VM into the run dir — see the #52 entry below).
  **Live/verify-run only** — skipped-loud on replay (a cassette embedding the key never
  hard-fails its replay); `verify-run` recomputes the authored set from the kept work dir. Only `true` is
  valid (omit to skip).
- **`tool_result_matches` / `tool_result_not_matches` scenario assertion keys** — the case-insensitive regex
  siblings of `tool_result_contains`/`tool_result_not_contains`, evaluated per captured tool result (subject
  to the same 10 KB per-result assertText cap). Useful for catching an error-signature *family* (e.g. a
  script's non-zero exit swallowed by its wrapper, but the message still printed) that a literal substring
  match can't express. Same evidence-unavailable wording as the `_contains` pair: a bad regex fails the
  assertion with a compile error, and a no-match against a display-truncated result is reported as
  could-not-verify rather than a silent pass/fail.

- **A folder-grant refusal for `request_cowork_directory`, ported from Desktop 1.22209.0.** Cowork now
  refuses (pre-prompt) a mid-session folder grant that targets a security-sensitive home-directory path —
  `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.claude`, `.config/{gcloud,gh,powershell}`, the darwin
  `Library/{Keychains,LaunchAgents,LaunchDaemons,Application Support,Cookies}` paths, or a protected shell
  dotfile (`.zshrc`, `.netrc`, etc.) — either directly, as a descendant, or as an ancestor whose grant would
  incidentally expose one (e.g. requesting the home directory itself). The harness's `hostloop` canUseTool
  gate ports this byte-faithfully, denying with Desktop's own message. **Currently dead code in a stock
  run**: no built-in workspace/cowork server registers `request_cowork_directory` yet (a pre-existing,
  separately tracked gap), so this only fires for a scenario that supplies its own `mcp_config` registering
  a matching tool name. Ported ahead of that gap closing so the refusal semantics are ready the moment it
  does. Two GrowthBook feature-gate ids Desktop 1.22209.0 introduced for a related "auto mode always-allow"
  tool-approval feature are pinned as drift sentinels (`sync`'s `PINNED_GATES`) without being behaviorally
  modeled — this harness has no persistent per-tool permission concept to model them against.

### Changed

- **`cowork-harness status <run-dir>` now resolves the newest session under a run-dir root.** Previously
  `status` only worked against the exact per-session out-dir printed at run start; pointing it at the root
  passed to `run --run-dir` failed with "no status.json". It now scans up to two levels under a directory
  lacking its own `status.json` for the newest session that has one, and reads that instead.
- **`doctor`'s two staged-agent checks are now titled distinctly** — "Staged agent binary (VM/container
  ELF)" vs. "Staged native agent binary (hostloop)" — so a failure on either is attributable to the right
  one instead of reading as an ambiguous duplicate.
- **The run-completion footer now prints a `→ result: <run-dir>/result.json` pointer**, on both success and
  failure, since the run directory is always kept on disk. Suppressed on the replay lane, which never
  writes a `result.json`.
- **The `on_unanswered=fail` unscripted-gate error now also mentions `on_unanswered: llm` as a secondary
  escape valve.** Previously it suggested only `--answer "<regex>=<choice>"`, which is the right primary
  fix but the wrong tool for a gate whose wording drifts run-to-run — a regex chases a moving target. The
  added line explicitly says "in the scenario YAML" (`--on-unanswered llm` is rejected on the CLI in favor
  of `--decider-llm`) and notes the tradeoff (non-deterministic, one model call per gate) so it doesn't
  read as unconditionally preferable to fixing the script.

### Fixed

- **Silent false-green on a missing workspace root (`#52`).** When the workspace root (`outDir/work/session/mnt`)
  couldn't be walked — the canonical case is a **microvm** run, whose outputs stage into the VM work tree, not
  into the run dir — `RunResult.workspaceFiles`/`artifacts` persisted as `[]`, **indistinguishable from a run
  that genuinely wrote nothing.** A consumer reading `result.json` (e.g. skill-creator-plus) saw "zero
  artifacts, clean." They now persist as **`undefined` (unavailable)** — the same convention replay already
  uses for "no live filesystem to scan" — with a loud `::warning::` naming the reason. Applied across the
  success, partial-salvage, and chat lanes; the walk's `complete`/root-absent health (F18) is now *consumed*
  at the call site rather than discarded. A genuinely-empty run (root present, no files) still correctly
  reports `[]`; only an unobservable root flips to unavailable.

- **microvm outputs are now observable — root-cause fix for `#52`.** A microvm run's outputs already live on
  host disk (`VM_WORK_HOST` is mounted writable into the VM at `/sessions`), just at a different path than the
  run dir the post-run pipeline walks. The run now **snapshots the session-root tree from the VM mount into
  `outDir/work/session`** (mirroring how `hostloop` snapshots connected folders) — rm-before-copy,
  symlinks copied verbatim (`dereference: false`), fail-loud if the tree is unexpectedly absent — plus captures
  the pre-run manifest on this tier. Result: **`workspaceFiles`/`artifacts`, `file_exists`, `artifact_json`,
  `user_visible_artifact`, `no_lost_write_back`, `no_unexpected_files`, and `input_unmodified` now work on
  `microvm`** instead of being evidence-unavailable — verified live to be identical to `container`. It's also
  fidelity-positive: real Cowork's VM outputs are host-observable too. (`no_scratchpad_leak` /
  `present_files_called` stay `container`-only — they key off the `present_files` tool, not workspace
  observability.) Doc/message sweep: the "use container/hostloop" carve-outs for these keys are removed.

- **`sync`'s non-macOS guard no longer blames Claude Desktop for a limitation that's actually this
  harness's own.** The error previously read "sync requires macOS (the Cowork Desktop app is macOS-only)"
  — false, Desktop ships a Windows build too; only this harness's `sync` tooling doesn't support non-macOS
  install layouts yet. The message now says so.
- **The web_fetch provenance-miss denial is synced to Desktop 1.22209.0's wording.** The message now notes
  that a URL surfaced in a WebSearch result also counts as provenance, and tells a subagent that can't ask
  the user to continue without the page and report the blocked URL rather than stall. No logic change —
  Desktop's underlying provenance rules are unchanged between releases, only the wording moved.
- **The hostloop path-gate no longer emits a spurious "cwd mismatch" warning when the run-dir is reached
  through a symlink** (e.g. macOS `/tmp` → `/private/tmp`). The diagnostic now compares the wire and
  spawner cwds after best-effort realpath canonicalization, so the same directory reached via two spellings
  no longer false-alarms; the path-gate's actual allow/deny decision was already realpath-rooted and is
  unaffected.
- **`verify-cassettes` no longer flags `claude.com` as a `domain` PII finding on every MCP-session
  cassette.** The scanner's capability-manifest exclusion (`isCapabilityManifest()`) recognized only two
  structural forms (the `system/init` event and the `initialize` registry `control_response`); it missed
  the MCP `initialize` handshake itself — both Claude Code's own `control_request` (`clientInfo.websiteUrl`)
  and the configured MCP server's `control_response` (`serverInfo`) — which fell through to the full
  `domain`/`currency` net on every recording that talks to an MCP server. The only previous workaround,
  `--allow-domain 'claude\.com'` in CI, was a class-scoped (not location-scoped) allow that would have
  silently cleared a genuine `claude.com`-hosted leak anywhere else in the same cassette. Both handshake
  forms are now recognized (shape-matched on the response side, since `serverInfo` is server-authored, not
  Claude Code's own fixed string), and the CI gate no longer needs any `--allow-domain`/`--allow-email`
  flag to pass on the committed example cassettes.
- **`hostloop`/`cowork` runs and `doctor --tier cowork` no longer hard-block when the pinned VM/container
  ELF was pruned by a Desktop update but a patch-newer sibling is staged.** At that tier the ELF is
  bind-mounted into the bash sidecar for parity and is not run by any harness-spawned process (the native
  binary is the agent), so a same-major.minor patch bump is now auto-tolerated (loud note, advisory sha) —
  matching the native binary's existing policy. The sha-pinned strictness is unchanged for
  `container`/`microvm`, where the ELF is the executed agent.
- **`doctor --tier cowork` now mirrors the resolved loop** (`decideLoopFromBaseline`) for both agent
  binaries, so it neither false-greens nor false-not-readies. When `cowork` resolves to host-loop it
  tolerates the ELF patch bump and requires the native binary (the executed agent there); when it resolves
  to VM-loop it keeps the ELF strict like `container` **and** stops requiring the native binary that a
  VM-loop run doesn't use. Previously the tier's checks were unconditional, disagreeing with the actual
  run on a VM-loop-resolving baseline.

- **`analyze-skill`: a `<script>…</script>` pair inside a docstring or comment no longer aborts a whole
  file to could-not-verify.** The lexical block extractor could pull English prose out of a docstring or
  comment as a phantom "script block"; its parse failure short-circuited the entire file to a
  could-not-verify (exit 3), discarding the verdict already computed for the file's real, parseable
  write-back block. The per-block analysis now accumulates: a block that fails to parse with no
  `fetch`/XHR-`open`/`sendBeacon`/`axios`/`.post()` write-back hint is discounted as prose, while one that
  carries a hint — or any block large enough to trip the analysis cap — is still reported as a
  could-not-verify surfaced alongside any finding. A candidate whose every isolated `<script>` block is
  unparseable stays a could-not-verify (fail-closed), never a silent clean pass. Several follow-on gaps in
  that accumulation are also closed. First: whenever at least one `<script>` block was discounted as
  prose, a parseable sibling block (or an already-flagged `<form method=post>`) no longer vouches for
  write-back surface OUTSIDE every extracted block (top-level `.js`/`.ts` code, an inline `on*=` handler,
  or surrounding template markup) — any write-back hint left in that un-analyzed remainder is now its own
  could-not-verify, reported alongside any finding rather than silently passed; a source with no
  discounted block, or an inline-handler write-back with nothing else in play, is unaffected. Second: the
  write-back hint check (and the earlier candidacy check) now also recognizes optional-call spellings —
  `fetch?.(`, `xhr?.open?.(`, `$.post?.(`, `navigator?.sendBeacon?.(` — so a source whose only write-back
  uses `?.` is neither missed as a candidate nor discounted as prose inside an unparseable block; that
  optional-call matching is also linearized (no more quadratic backtracking on a long non-matching
  whitespace run). Third: a member-spelled write-back inside a block that DOES parse —
  `window.fetch(...)`, `globalThis.fetch(...)`, `self.fetch(...)`, or the same spelling inside a same-file
  fetch-wrapper's own body — is now classified the same as a bare `fetch(...)` call instead of going
  unrecognized and falling through as clean; a bare `sendBeacon(...)` identifier call (e.g. a locally
  bound alias of `navigator.sendBeacon`) is now recognized the same way as the member-spelled
  `navigator.sendBeacon(...)`. Fourth: a `.post(...)`/`.put(...)`/`.patch(...)` call on a receiver outside
  the known `axios`/`$`/`jQuery` set — the common miss being an axios instance,
  `const api = axios.create(); api.post("/api/save", data)` — targeting a relative URL is no longer
  invisible; it is now reported as an advisory finding (never escalated to an error, since the receiver
  isn't provably a write-back client and could be unrelated code; `.delete(...)` is deliberately excluded
  from this, since it's common on non-HTTP collection types). Fifth: the axios/`$`/`jQuery` verb set
  recognized on the whitelisted identifier itself is widened from `.post(...)` alone to
  `.post(...)`/`.put(...)`/`.patch(...)`/`.delete(...)`/`.postForm(...)`/`.putForm(...)`/`.patchForm(...)`
  (the last three are axios v1's multipart form-data verb aliases; `.delete(...)` is INCLUDED here,
  unlike the any-receiver advisory case above, since the literal `axios`/`$`/`jQuery` identifier has no
  ambiguity about what it means); a bare config-object call — `axios({method:"POST", url:"/api/save",
  ...})` — and `axios.request({...})` are both recognized, whether the config argument is an inline
  object literal or a hoisted identifier (`const cfg = {...}; axios(cfg)`). This is not exhaustive: axios's
  alternate `$.ajax({...})`-style config-key vocabulary, and any computed-member, whitespace-separated, or
  aliased/re-exported spelling, remain a documented, lexically/structurally invisible accepted class (see
  the relevant doc comments in `analyze-artifact.ts`) — as does a `formaction`/`formmethod` override on a
  submit button that redirects an otherwise-remote `<form>` back to a relative, in-scope URL.
- **`analyze-skill`: a delete/remove flow that claims success now classifies as a lost write-back (error),
  not just a suspect (advisory).** The success-claim vocabulary that distinguishes a lost write-back (an
  unconditional "it worked" toast) from a merely-suspect one gained delete-flow words (`deleted`,
  `removed`, …) alongside the existing `saved`/`submitted`/`persisted`/`completed`/`success`. A relative
  `DELETE` write-back whose only success signal is a "Deleted!"/"Removed!" toast — no `resp.ok`/status
  check — is now flagged at error severity like its save-flow equivalent, since under Cowork it resolves
  non-ok against Cowork's own origin and the false confirmation is identical.

### Documentation

- **Documented an `analyze-skill --runtime` recipe for agent-generated artifacts.**
  `analyze-skill --runtime <run-dir>/work/session/mnt/outputs` confirms interactive-artifact write-backs in
  HTML the agent *generates during a run* — content the source-only static scan can't see until a run has
  happened. Notes the tier-specific output paths and the microvm/replay caveats.

## [1.1.0] — 2026-07-16

Minor: `analyze-skill` gains interactive-artifact write-back detection (static + an optional `--runtime`
headless-DOM confirmer), `lint` gains a container-only-key tier check, and the `doctor` JSON envelope is
frozen as a covered SPEC §12 surface. All additive.

### Added

- **`analyze-skill` now detects interactive-artifact write-backs lost under Cowork.** Alongside the
  existing `/sessions` path scan, it statically analyzes `.html/.htm/.js/.mjs/.ts/.jsx/.tsx/.py` sources
  under the target for a relative `fetch`/XHR/`sendBeacon`/`<form method=post>` write-back that silently
  fails under Cowork (the artifact is served from Cowork's own origin, so a relative write-back resolves
  non-ok and a page that doesn't check `resp.ok` shows a false "Saved"). Findings: `artifact-write-back-lost`
  (error — gates under `--strict`), `artifact-write-back-suspect` (advisory), and a separate top-level
  `analysisFailures` **could-not-verify** channel (a candidate that couldn't be parsed/analyzed) that
  always exits `3`, `--strict`-independent. A guard that isn't statically provable-truthy is `suspect`,
  never silently clean; the blanket `analyze-skill: ignore` marker does not silence artifact rules.
  Each `SkillFinding` now carries a `severity` (`error|advisory`); `--strict` gates on any error finding.
- **`analyze-skill --runtime`** — an optional headless-DOM confirmation that drives a materialized `.html`
  artifact in jsdom (stubbed network + synthetic user actions, run twice) to *observe* whether a relative
  write-back fires and is lost. Enrichment only (never changes the exit code); trusted-source scope. `jsdom`
  is an optional, dynamically-imported dependency — absent it reports "run `npm i jsdom` to enable".
- **`schema/doctor.json`** — the `doctor --output-format json` envelope is now a covered SPEC §12 surface
  (`oneOf` the completed-probe shape and the shared error envelope for every category). `doctor`'s normal
  JSON output is standardized through the shared envelope frame.
- **`lint` flags container-only assertion keys off-container** — `no_scratchpad_leak`/`present_files_called`
  on `fidelity: protocol|microvm|hostloop` is an ERROR, on `fidelity: cowork` a WARN, clean on `container`.

## [1.0.6] — 2026-07-15

Patch: platform baseline synced to Claude Desktop `1.21459.0`. The spawn contract and rendered system
prompt are unchanged (a new design-tools hook is deployment-gated off on first-party). No runtime or
API change.

### Changed

- **Platform baseline synced to Claude Desktop `1.21459.0`** (`baselines/desktop-1.21459.0.json`, now
  what `baseline: latest` resolves to). Routine per-release parity refresh: app version, the staged
  agent version (`2.1.205` → `2.1.209`) and its sha, and the asar fingerprint. The rendered spawn tool
  list is unchanged.
- **Spawn-contract extractor (`sync`) now tolerates an inert `CLAUDE_DESIGN_TOOLS` head spread.**
  `1.21459.0` inserts `...CLAUDE_DESIGN_TOOLS` into the agent's `tools[]` head between `Task` and
  `Bash`; it resolves to an empty array on first-party (deployment-gated off), so the rendered tool
  list — and the hand-pinned 20-entry `spawn.tools` — are unchanged. The `S6` sentinel admits the
  optional spread and a new `S6b` guard asserts it stays empty, failing the sync loud if a future build
  ever populates it (a real spawn tool set that must be modeled). No runtime or API change.

## [1.0.5] — 2026-07-15

Patch: routine pushes to `main` no longer red CI on a repo without `ANTHROPIC_API_KEY` — the live
scenario suite is best-effort now — plus a CodeQL cleanup in the release tooling. Internal tooling +
CI only; no runtime or API change.

### Changed

- `scripts/release-preflight.ts`: `changelogHasVersionSection` now finds the CHANGELOG heading with a
  literal line-prefix match instead of a regex assembled from the version string. Behavior is
  unchanged — the version is already `isValidSemver`-gated to `X.Y.Z` before this runs — and it drops
  a redundant, only-partially-escaped regex flagged by CodeQL (`js/incomplete-sanitization`). Internal
  release tooling only; no runtime or API change.
- **CI: the live scenario suite (`scenarios` job) is now best-effort, not a publish gate.** When
  `ANTHROPIC_API_KEY` is absent it soft-skips green on every event — pushes to `main` included —
  instead of hard-failing the run, so routine pushes to `main` (dependency bumps, docs, small fixes)
  no longer turn CI red on a repo without the secret set. A loud `⚠️ NOT live-validated` marker still
  flags any run that skipped live inference. The `SKIP_LIVE_SCENARIOS` admin-override variable is
  removed (nothing hard-fails, so there is nothing to override). Trade-off: `release.yml` still gates
  publish on `ci.yml` being green for the tagged commit, but a green `ci.yml` no longer proves the
  scenarios were validated against a real model — set the `ANTHROPIC_API_KEY` repo secret to actually
  run the live suite in CI. No runtime or API change.

## [1.0.4] — 2026-07-15

Patch: release workflows no longer trigger on the floating Marketplace alias tags. No runtime/API change.

### Fixed

- `.github/workflows/release.yml` and `.github/workflows/publish-image.yml` now trigger only on
  full semver tags (`v[0-9]+.[0-9]+.[0-9]+*`, prereleases included) instead of `v*`. Moving the
  packaged Action's floating alias tags (`v1`, `v1.0`) after a release previously kicked off both
  workflows, which then correctly died at the tag-vs-`package.json` version guard — four spurious
  failed runs per release. The aliases point at an already-published release commit, so nothing
  should (or now does) run.

## [1.0.3] — 2026-07-14

Patch: parity sync to Claude Desktop `1.20186.9`. No runtime/API change.

### Changed

- Synced the platform baseline to Claude Desktop `1.20186.9`
  (`baselines/desktop-1.20186.9.json`, now what `baseline: latest` resolves to). A routine
  per-release parity refresh: the app version, the native agent staging path, and the asar
  fingerprint moved; the Cowork system prompt, egress allowlist, gate states, and agent (VM)
  version are unchanged from `1.20186.1`. README and the companion skill's baseline pointer were
  updated to match.

## [1.0.2] — 2026-07-14

Patch: shorten the Action's Marketplace tagline. No runtime/API change.

### Fixed

- `action.yml`'s `description` is now under GitHub Marketplace's 125-character limit (the full
  token-free-vs-live-lane detail is retained as comments above it), so the packaged Action can be
  published to the Marketplace. `1.0.1`'s description was too long and blocked the listing.

## [1.0.1] — 2026-07-14

Patch: Action Marketplace branding + a release-tooling fix. No runtime/API change.

### Added

- `action.yml` now declares Marketplace `branding` (`shield` / `orange`) so the packaged GitHub Action
  can be listed on the GitHub Actions Marketplace. No change to the Action's inputs, outputs, or runtime.

### Fixed

- `npm run bump` now rewrites the bare `` `Pin `@>=X`` `` floor in `SKILL.md` — it previously bumped only
  the `cowork-harness@>=`-prefixed floors, so that one line stayed stale (it had drifted since `0.33.0`
  and shipped stale in `1.0.0`). A new `check:versions` invariant (5b) fails on any `@>=X` in `SKILL.md`
  that doesn't match the floor, and a regression test covers the bump path.

### Changed

- `RELEASING.md` documents maintaining the moving `v1` / `v1.0` tags on each release, so
  `uses: yaniv-golan/cowork-harness@v1` resolves to the latest 1.x.
- Pruned stale pre-1.0 versioning language now that the compatibility contract is in force
  (README, `SPEC.md`, `RELEASING.md`, `docs/maintenance.md`, this file); `SECURITY.md` now states
  that only the latest published release is supported.

## [1.0.0] — 2026-07-13

**First stable release.** The compatibility contract in
[SPEC.md §12](./SPEC.md#12-versioning--the-10-compatibility-contract) is now in force: the covered
surfaces — the CLI commands + exit codes, the scenario / session / baseline / run-result / cassette /
protocol schemas, the documented environment variables, and the packaged Action's inputs/outputs — are
stable, and a breaking change to any of them requires a major version bump. Human-readable text output
is explicitly not covered. There is **no runtime behavior change from `0.33.0`** — `1.0.0` blesses that
runtime as stable and adds the release-engineering guards below.

### Added

- **Surface-contract guard** (`test/surface-contract.test.ts`, `npm run gen:surface` /
  `npm run check:surface`) — snapshots the structured §12 surfaces (every `schema/*.json`'s field paths
  and enums including exit codes, `action.yml` inputs/outputs, and the documented `COWORK_*` env-var
  set) into `test/fixtures/surface-baseline.json`; CI reds on undocumented drift so a covered-surface
  change can't ship silently. The CLI/exit-code-semantics/`PlatformBaseline` surfaces are frozen via a
  manual review step in `RELEASING.md`.
- **`npm run bump -- X.Y.Z --write`** — rewrites every version location via targeted patterns (dry-run
  by default), leaving historical release notes, the baseline pin, and the `V=` agent pins untouched;
  self-checks `check:versions`.
- **`npm run preflight`** — a local pre-release gate (`check:versions`, CHANGELOG heading, unused tag,
  clean tree, live-key reminder); `--for-tag` additionally asserts `HEAD == origin/main` and a green
  push-event CI run for `HEAD`, mechanically preventing a tag on the wrong commit.

### Changed

- CI marks a skipped live scenario suite with a loud "NOT live-validated" job-summary banner; the
  release docs (`RELEASING.md`, `release.yml`) now state that a release tag must go on the merge commit
  (the SHA with a push-event CI run), with recovery steps.

## [0.33.0] — 2026-07-13

### Fixed

- **Empty thinking was surfaced as if the model hadn't reasoned — both `subagents[].reasoning` and the
  top-level `thinking[]`.** The 0.31.0 sub-agent field captured TEXT turns fine but every `thinking` turn
  came through as `{kind:"thinking", text:""}`, and the older top-level `thinking[]` field does the same
  on current-gen models — a consumer couldn't tell "reasoned but text unavailable" from "no thought."
  Root cause (binary-verified against the staged 2.1.205 agent, corpus-corroborated): it is a
  **request-side display mode**, not a persist-time strip — the API's `thinking.display` resolves to
  `"omitted"` (empty thinking text + a signature) for sub-agent turns always, and for the MAIN loop too
  on models whose API default is `"omitted"` (Opus 4.8, Sonnet 5; Sonnet 4.6 defaulted to `"summarized"`).
  Corpus: main-loop thinking text is 1810/1810 on Sonnet-4.6 but **0/2 on Opus-4.8 and 0/15 on Sonnet-5**,
  every empty carrying a signature; sub-agents 0/230. The harness passes no `--thinking-display` —
  faithfully to real Cowork, whose spawn passes none either. Both fields now mark such blocks
  `{text:"", redacted:true}` (`kind:"thinking"` for the sub-agent turn shape) so they read as "reasoned,
  text omitted by request"; TEXT turns are never redacted, and `redacted` is omitted (not `false`) on
  blocks that carry text.
- **New `debug.thinking_display` escape hatch** (fenced, non-Cowork — like `debug.max_thinking_tokens`).
  Set it to `"summarized"` to emit `--thinking-display summarized`, which flips **both** loops to
  summarized thinking text (the API returns no raw chain-of-thought — `summarized` is the ceiling). It
  diverges from real Cowork (which passes no such flag) and adds token cost, so it is a debug-only opt-in;
  the default stays `"omitted"`, byte-identical argv. `docs/subagents.md`, `docs/session.md`,
  `schema/run-result.json`, and the `RunResult`/`SessionConfig` types state the real capture semantics;
  the released 0.31.0 note is corrected in place.

- **Docs pointed the GitHub Action at a ref that doesn't exist.** README, `SKILL.md`, and
  `references/ci-recipe.md` all said `uses: yaniv-golan/cowork-harness@v1`, but no `v1` tag has ever
  been published — a copy-pasted workflow failed with "unable to resolve action" before running
  anything. All six references now bind `@main`; a moving major tag is a 1.0.0 question. A new
  token-free guard (`test/action-docs-sync.test.ts`) locks the ref policy and also validates that
  every documented `with:` key is a real `action.yml` input and every documented `command:` value is
  one the Action describes.
- **`llms.txt` command list was three commands stale** — `lint-skill`, `analyze-skill`, and
  `probe-dispatch` were missing. Now lists all 29, locked by a new COMMANDS ↔ llms.txt sync test
  (set-equality, so stale names fail too), and the README "Commands at a glance" guard gained the
  reverse direction (a README-only row now fails).
- **README observability prose still called a `subagents[]` field `model`** — renamed to
  `dispatchModel` (beside `resolvedModel`) in 0.30.0; the prose now names the real fields. Also
  fixed: the effort enum shorthand now lists `xhigh` (`extra` is the accepted alias) in both places,
  the CI stage table matches `ci.yml`'s declaration order, the exit-code summary notes
  `verify-cassettes`' distinct exit-`3` meaning and the reserved exit `4`, a duplicated `--keep`
  example was collapsed, and `on_unanswered: llm` is explicitly marked as a scenario-YAML key (not a
  CLI flag).
- **`status --latest-for` was undocumented in its own guide** — now covered in `docs/run-status.md`
  (with the real output shape), the `docs/README.md` index row, and the top-level `--help` status
  entry (with its own `0` found / `2` not found exit semantics).
- **`probe-dispatch --help` didn't start with a `usage:` line** like every other command; it does
  now.
- **`debugging.md` showed only the scenario run-dir layout** — it now also names `chat`'s
  `runs/chat/<sessionId>/` path. `docs/session.md`'s "all four tiers" now spells out the four
  execution tiers and that `fidelity: cowork` resolves to one of them. `examples/README.md`'s
  answer-policies pointer is now a real link. `effectiveFidelity` (the recorded resolved tier behind
  the `resolved-tier`/`unverifiable-tier` staleness classes) is now mentioned in the README fidelity
  section and `python/README.md`, not only in `docs/cassette.md`.
- **The docs told a false "default `8899`" story for `COWORK_VM_PROXY_PORT`** — when the var is
  unset, the host binds the egress proxy on an OS-assigned free port and threads that value into the
  guest firewall + `HTTP(S)_PROXY`; `8899` is only the guest-config fallback when a VM is spawned
  without an explicit port, which never happens on a normal run. README and `docs/scenario.md` now
  say so. Also closed: `COWORK_HARNESS_STATUS_CORRUPT_TIMEOUT_MS` (30s corrupt-`status.json`
  backstop on `status --follow`) was the one `COWORK_*` env var documented nowhere — now in
  `docs/run-status.md` + the README knob list; the `COWORK_HARNESS_DECIDER_DIR_POLL_MS` docs name
  the per-subsystem defaults (300 ms rendezvous / 500 ms `gates --follow`); the `semantic_matches`
  judge docs name the pinned default (`claude-opus-4-8`) in README, `docs/scenario.md`, and the
  skill's schema reference; the heartbeat bullet states its 30s default instead of pointing at a
  source file.
- **`replay --explain` was invisible from the command catalog** — the flagship false-green
  diagnosis flag was documented only in debugging prose; it's now in the `record`/`replay` command
  table row and leads the record/replay "Flags worth knowing" bullet.
- **`examples/README.md` ships in the npm tarball while the trees it describes don't** — it now
  opens with a "Reading this on npm?" callout (clone for `scenarios/`/`sessions/`/`skills/`/`data/`),
  documents `probes/` (previously invisible: used by `test/live-contract.test.ts` but absent from
  the layout and from schema validation — `examples/probes` is now in `test/examples.test.ts`'s
  scenario sweep), and links the matrices worked example; the README documentation-table row carries
  the same source-checkout caveat.
- **The companion skill's preflight sent replay-only users through `doctor`**, whose token check
  hard-fails on every tier — a new "Replay-only? Skip `doctor`" bullet carries the same carve-out
  `docs/README.md` already had. The 3,200-character single-bullet 0.32.0 feature parenthetical is
  now a scannable by-release sub-list, with every release bucket tag-verified against git history —
  which caught and fixed a long-standing wrong tag: `semantic_matches` was labeled "new in 0.27.0"
  but shipped in 0.28.0; the five path-gate keys, `agent_env`, and the `hostloop` split/
  `allow_host_writes:` now sit under their real releases (0.30.0 / 0.21.0) too.
- **`DESIGN.md` still said the staged in-VM agent is 2.1.202** — the `desktop-1.20186.1` baseline
  re-synced it to 2.1.205; DESIGN.md and `docs/protocol.md` now carry dated patch-only notes for
  1.20186.1 while the 2026-07-11 live pass stays scoped to `desktop-1.20186.0` (not restamped).

### Added

- **`test/docs-index-sync.test.ts`** — three token-free guards: every `COWORK_*` env var read in
  `src/` (dot-access **or** helper-read string literal) must be documented in README/`docs/*.md`;
  the judge-model default id in the docs must match `semantic-judge.ts` (fails loud on a const
  rename); `llms.txt` must link every top-level `docs/*.md` guide (both directions — `gotchas.md`,
  `subagents.md`, and `plugin-root.md` were missing and are now linked).

- **The Action's `version` default (`latest`) is now documented as intentional** — in `action.yml`'s
  input description, the README inputs sentence, and `references/ci-recipe.md` — with
  pin-an-exact-version guidance for reproducible CI, and why it deliberately differs from the
  companion skill's `@>=0.32.0` floor for ad-hoc CLI installs.
- **`--help` and unknown-flag structural-guard test coverage now spans all 29 commands** (previously
  16 and 17 respectively); `lint`/`lint-skill` are asserted against their `scenario.py` passthrough
  usage lines and skip cleanly when `python3` is absent.

### Documentation

- **`on_unanswered: prompt` was described as "only valid for `chat`" — wrong on two counts.** `chat`
  never reads a scenario YAML (it runs an inline interactive scenario), and `prompt` is really a
  `skill`-command policy (the adaptive-TTY default, or explicit `skill --on-unanswered prompt`);
  `run` rejects it. The schema `.describe()` (and regenerated `scenario.schema.json`) now say so.
- **`ANTHROPIC_AUTH_TOKEN` is an accepted auth source but was under-documented.** It resolves
  identically to `ANTHROPIC_API_KEY` (used only when no OAuth token is set) and was already in
  `.env.example`, but the README auth text, the `record`/`doctor` `--help` blurbs, the `doctor`
  no-token detail/remedy, the two `record` credential messages, `docs/cassette.md`, and the companion
  skill's Auth note named only the other two — all now list it as the third alternative.
- **`llms.txt` exit-code line** now flags that `3`/`1` carry per-command meanings (e.g.
  `verify-cassettes` `3` = could-not-verify, `sync` hard-fail = `1`) and links the authoritative
  SPEC §11 text, instead of implying one global meaning for `3`.
- **README** gains a platform × tier support matrix (making explicit that Linux live runs are
  `container`-only), doc-index rows for the spawn contract and `docs/decisions/`, the
  `probe-dispatch` fidelity set, and a clearer global-install-ships-`examples/replays/`-only warning;
  `docs/chat.md` notes that scaffolding a `chat` run yields an empty `assert:` block.

## [0.32.0] — 2026-07-13

### Added

- **`assertions --list` now documents that `subagent_dispatch_healthy`'s `type` matches the dispatch
  description** (not just resolvedAgentType/dispatchAgentType), so a regex can narrow to one dispatch in a
  same-agent-type fleet — previously only in `docs/scenario.md`.
- **`analyze-skill` line- and block-scoped ignore markers** — `analyze-skill: ignore-next-line` and
  `analyze-skill: ignore-start` / `analyze-skill: ignore-end`, alongside the existing file-wide
  `analyze-skill: ignore`. The file-wide marker silences EVERY finding in the file, which was too coarse
  for a SKILL.md that carries just one `/sessions`-addressed teaching example (e.g. a "don't do this"
  callout in `references/`/`agents/`): the whole file went blind to any OTHER, genuine finding. The two
  new markers suppress only the exact line (`ignore-next-line`) or fenced range (`ignore-start`/
  `ignore-end`, inclusive) they scope, reusing the same line-anchored marker matching as the file-wide
  marker (bare, `#`-prefixed, list-bullet, HTML comment, or markdown reference-link comment — never
  triggered by a marker merely documented mid-prose). An `ignore-start` with no matching `ignore-end`
  before EOF emits its own gating `unclosed-ignore-fence` finding — it still suppresses to EOF (fail-open),
  but the missing-`ignore-end` mistake itself prints and fails under `--strict` like any other finding,
  never a silent notice on a green exit.

- **`analyze-skill <dir>` now scans the UNION of every contract-bearing markdown file in the directory,
  not just `SKILL.md`.** A plugin's `/sessions` dispatch/output contracts often live in `agents/**` or
  `references/**` — scanning only `SKILL.md` there was a false green (a consumer's `agents/sub/x.md`
  could hand a `/sessions` path straight to a file tool and `analyze-skill` would never see it). A
  directory target is now expanded to every shape it matches, deduped by resolved absolute path: a
  top-level `SKILL.md` (+ its `references/**`); a plugin root (`.claude-plugin/plugin.json` or
  `plugin.json`, + `agents/**`, `references/**`, `commands/**`, and each `skills/*/SKILL.md` + that
  skill's own `references/**`); and a skill dir living inside a plugin also pulls in the enclosing
  plugin's `agents/**`, `references/**`, and `commands/**`. Every walk is RECURSIVE (Claude Code discovers
  namespaced commands/agents in subdirectories — `commands/tasks/build.md`, `agents/sub/x.md` — so a
  single-level listing silently narrowed the scan) and FOLLOWS directory symlinks, loop-guarded against a
  self-referencing symlink via a realpath visited-set, so a symlinked `references/`/`skills/<name>` is
  scanned rather than silently dropped. Zero scannable files under a directory target is now a usage error
  (exit 2) that enumerates the shapes it looked for — never a silent clean pass.

- **`analyze-skill` accepts MULTIPLE positionals + a simple `*` glob, matching `lint-skill`'s
  `nargs="+"`.** A consumer with several explicit paths (or a directory's flat `*.md` set) no longer has
  to loop `analyze-skill` once per path: `analyze-skill a/SKILL.md b/SKILL.md`, `analyze-skill skill-a/
  skill-b/`, and `analyze-skill "plug/agents/*.md"` are all one call now. Each positional resolves
  independently — a file or directory via the existing rules above, or a `*`-bearing target via a small
  HAND-ROLLED glob matcher (no new dependency, no `engines.node` bump): `dir/*.md` matches shallowly,
  `dir/**/*.md` matches recursively (reusing the same symlink-following, loop-guarded walker the
  directory-target union scan already uses). Every positional's files are UNIONed and deduped by
  resolved absolute path across the WHOLE invocation, extending the existing single-target dedup to
  span all of them — a file reached
  both directly and through a dir/glob positional is analyzed once. Zero scannable files across ALL
  positionals remains the usage error (exit 2); a bad single positional (missing path, unrecognized glob
  shape) fails the whole invocation.

### Changed (breaking, pre-1.0)

- **`lint-skill`'s `subagent-type-not-found-in-plugin` finding is now WARN, not INFO** — so
  `lint-skill --strict` newly gates on it. This is the one `subagent_type` outcome that's a *provable*
  typo: a `<this-plugin>:<agent>` value whose prefix names the SKILL.md's own enclosing plugin, where
  that plugin's `agents/*.md` was fully enumerated and doesn't contain the agent — the namespace prefix
  already commits the value to this plugin, so a miss can never be another binary's built-in hiding
  from static analysis. The other two `subagent_type` outcomes stay INFO, unchanged, because they
  genuinely can't be disproven: `subagent-type-unresolvable` (a `<other-plugin>:<agent>` — belongs to
  a plugin this linter didn't scan) and `subagent-type-unknown` (a bare value with no in-plugin match —
  may be an agent-binary built-in). A `lint-skill --strict` run that previously passed clean may now
  fail if it carries this exact typo shape; fix the agent name (or add the missing `agents/<agent>.md`)
  to restore a clean `--strict` run.
- **`analyze-skill <dir> --strict` may newly fail where it passed clean before**, if `references/`/
  `agents/`/`commands/` carries a `/sessions`-addressed teaching example that the old SKILL.md-only scan
  never looked at — including one nested under a subdirectory or reached only via a symlink, both now
  scanned. Annotate the example with `analyze-skill: ignore-next-line` (or an `ignore-start`/`ignore-end`
  fence) to restore a clean `--strict` run — there is no `--skill-md-only` compatibility flag; the
  narrower scan was the bug this closes.
- **`analyze-skill --output-format json`'s single-file shape changed.** The flat
  `{file, findings, suppressed, strict}` payload is now always `{files: [{file, findings, suppressed}],
  scanned, unscanned, strict}`, for uniformity with a directory target's multi-file result. An external
  `jq '.findings'` / `jq '.file'` recipe needs `jq '.files[0].findings'` / `jq '.files[0].file'` instead.
- **`analyze-skill`'s JSON envelope `ok` now mirrors the exit code, not "zero findings."** Previously
  `ok = findings.length === 0`, so an ADVISORY run (the default — findings print but exit 0) reported
  `ok:false` even though the process exited 0 and `action.yml`'s own documented contract (`ok` "mirrors
  the command's exit code") said otherwise; the packaged Action's job-summary reporter then rendered
  "Overall: ❌ fail" for a run that hadn't actually failed. `ok` is now `true` on an advisory exit-0 run
  even with findings present, and `false` only under `--strict` with findings or the exit-2 usage error
  — the same rule `lint`/`lint-skill --output-format json` follow (see the Fixed entry below). A `jq
  '.ok'` consumer that was treating `ok:false` as "any findings at all" should switch to checking
  `.files[].findings` directly; the exit code (and `ok`) now only reflect `--strict` gating.

### Fixed

- **The packaged Action's `lint`/`lint-skill` lanes were broken.** `action.yml` always appends
  `--output-format json` to every command it drives, but the bundled `scenario.py`'s `lint`/`lint-skill`
  only understand `--json` — `--output-format` was an unrecognized argument to python's argparse (exit 2,
  empty stdout), so `command: lint` / `command: lint-skill` in the Action always failed with an
  unhelpful `ok:false` and no findings. `cowork-harness lint`/`lint-skill` now detect json mode
  themselves, strip `--output-format json|text|=…` before forwarding to python, pass python's own
  `--json` in json mode, and re-wrap the child's bare findings array in the harness's standard
  `jsonPayloadEnvelope("lint"/"lint-skill", ok, { findings })` (`ok` mirrors the child's exit code). Text
  mode (the default) is unaffected in output — `stdio: "inherit"` as before — but now also strips the
  flag first, since python didn't know the text form either. A python-level usage error in json mode
  (e.g. a missing required path — argparse exit 2, empty stdout) now surfaces as a `jsonError("usage",
  …)` envelope instead of a raw `JSON.parse` crash. `action.yml` also now documents `lint-skill` and
  `analyze-skill` in its `command` input, and no longer forwards the replay-only `--fail-on-skill-drift`
  flag to any command other than `replay`.

## [0.31.0] — 2026-07-12

### Added

- **`cowork-harness lint-skill <dir|SKILL.md>`** — the skill-authoring linter (`scenario.py lint-skill`)
  is now shipped in the npm package and reachable as a first-class subcommand, the same fidelity
  `lint` got in 0.4.0: a consumer who `npm i`s the harness (with no skill checkout) can run the
  host-loop-footgun / `subagent_type`-resolution checks in CI, not just via the bundled `scenario.py`.

- **`RunResult.subagents[].reasoning`** — a sub-agent's own THINKING and TEXT turns, in transcript order,
  surfaced per dispatch. The SDK suppresses sub-agent thinking on the parent event stream entirely, so
  the only channel for "did the sub-agent reason over the right rubric" was previously unavailable; this
  reads the on-disk child session transcript the agent binary writes per `Task` dispatch
  (`<configDirRoot>/projects/**/subagents/agent-<id>.jsonl`), joined to its `RunResult.subagents[]` entry
  via the sibling `agent-<id>.meta.json`'s `toolUseId` (an exact match — no path reconstruction). Resolved
  per fidelity tier (hostloop vs. the container/microvm sandboxed config dir) at finalize, LIVE/record
  lane only — `undefined` on replay, same as `resources`/`mcpErrors`. Capped the same way the top-level
  `thinking[]` field is (~50 entries, ~10KB/entry each), with `reasoningElided` counting the overflow. A
  missing or malformed child transcript never fails the run — the affected dispatch's `reasoning` is just
  left absent.
  - **Correction (see Unreleased):** in practice only the TEXT turns carry content — the harness's
    non-interactive spawn forces the API's `thinking.display` to `"omitted"` for sub-agent turns, so
    `thinking` turns come through empty (signature-only). The Unreleased `redacted` marker distinguishes
    "reasoned, text omitted by request" from "no thought"; the "THINKING … turns" wording above
    overstated what this captures by default.

- **`status --latest-for <scenario-name-or-slug>`** — resolves and prints the NEWEST run dir for a
  scenario by actual run time, replacing the fragile `ls -td runs/<scenario>/* | head -1` idiom: bare
  directory mtime is NOT run recency (it bumps on any later write inside the dir — an `inspect`, a `trace
  --translate-paths`, a slow finalize — independent of when the run itself happened), so it can readily
  return a stale prior-session dir instead of the one you actually just kept. Recency is instead resolved
  from the run's own `.origin` marker `createdAt` (pinned `--session-id` runs) or `result.json`'s mtime
  (the common ephemeral-run case), falling back to `status.json`'s `startedAt` for a run dir with neither
  yet; a run dir with no usable recency signal at all is skipped rather than silently falling back to its
  own mtime. `--output-format json` emits `{scenario, outDir, createdAt, verdict?}` — `verdict` surfaces
  opportunistically from a persisted `RunResult.verdict` when the kept run has one. A scenario with no
  runs on disk fails clean (a message naming the scenario + runs root, exit 2) rather than crashing.
  `outDir` (printed here and by every `run`/`skill`/`chat` invocation) is documented as the canonical
  run-dir handle in docs/scenario.md's "Output" section.

- **`RunResult.verdict`** — a kept run's `result.json` now persists the overall pass/fail: `{pass,
  exitCode, signals, guards, failures}`, `computeVerdict`'s (the single verdict source) full `Verdict`
  shape, persisted VERBATIM. This is the SAME shape the `--output-format json` stdout envelope attaches
  to every result — the persisted and the streamed verdict are one `computeVerdict` shape, so the two
  channels can never diverge. Previously the ONLY way to see why a kept run failed was to re-run
  `verify-run`; `jq '.verdict' result.json` now answers it directly, with `failures[]` naming the
  failing assertion key (when a failure traces to one) or a hard-verdict guard reason (an infra error,
  an unanswered gate, a scan-based host-path leak, …) otherwise. Populated on both the success path and
  a salvaged (unanswered-gate) partial run — a whiffed gate is itself a verdict fail, and its
  `failures[]` names the gate reason rather than a generic placeholder. Scope: the run/asserted lane
  only — `chat` carries no assertions and no verdict, so the field stays absent (undefined) there, same
  as it always has for every other verdict-adjacent field.

- **`probe-dispatch <skill-dir> "<prompt>"`** — a cheap, focused mechanics probe for a single `Task`
  dispatch. A THIN wrapper over `skill` (same inline session/scenario construction, same `runOneScenario`
  execution; default fidelity `hostloop`, since path-fidelity — this probe's whole reason to exist — only
  matters there): scope the prompt to trigger ONE dispatch, and it prints just that dispatch's
  `{resolvedAgentType, pathDenials, delivered}` instead of the full run transcript. No new `RunResult`
  field backs it — it's a pure projection of data `skill`/`run` already produce
  (`subagents[]`/`fileToolAttempts`/`pathDenials`/`toolResults`); `pathDenials` is scoped to the specific
  dispatch by joining a denial's own `toolUseId` through `fileToolAttempts[].parentToolUseId` (falling
  back to the run-level list, clearly labeled, when `fileToolAttempts` isn't available), and `delivered`
  mirrors the `subagent_dispatch_healthy` assertion's own paired-write computation. `--expect-write
  <suffix>` narrows `delivered` to a specific target path; `--output-format json` emits a compact
  `{dispatches: [...], verdict}` envelope. "One dispatch" is PROMPT-SCOPED, not enforced — Cowork imposes
  no in-conversation dispatch cap — so the probe just asserts it (`subagent_dispatched` +
  `dispatch_count_max: 1`) and reports a failed verdict if the prompt fanned out.

- **`RunResult.subagents[].referencesRead`** — the skill `references/*` / `scripts/*` files a SUB-AGENT
  dispatch actually **Read**, attributed per-dispatch (skill-relative, deduped in first-seen order, same
  filter as the existing top-level `referencesRead`). Previously a sub-agent's Reads were dropped
  entirely even though its `tool_use` blocks already ride the parent stream — this closes that gap
  without touching the top-level (main-agent-only) `referencesRead`, which is unchanged. Present on live
  and replay.

- **`analyze-skill <SKILL.md | skill-dir/>` — a token-free static ADVISORY scan for the "skill hands a
  `/sessions/...` path to a file tool" defect class.** Previously the only way to discover that a skill's
  dispatch prompt or file-tool directive points at a `/sessions/...` VM path — which production's
  host-loop path gate denies unconditionally, since the agent's file tools run on the host filesystem —
  was a paid live host-loop run. `analyze-skill` scans a SKILL.md's text and reuses the harness's own
  ported `/sessions` path-gate predicate (`isVmSessionsPath`, new export in `src/vm-paths.ts`) as the
  deny decision; only the extraction of candidate paths from markdown is heuristic, and it is
  conservative by design — a `/sessions` token inside a fenced bash/sh/shell/zsh block, an
  anti-instruction line ("never write to `/sessions/...`"), or plain prose with no file-tool/output
  context is never flagged. Findings from two rules (`sessions-path-to-file-tool`,
  `sessions-find-into-file-read`) print as advisory warnings and exit 0 by default — the extraction is
  heuristic enough that a hard gate would over-flag innocent documentation; pass `--strict` to fail
  (exit 1) on any finding instead, and put a line containing `analyze-skill: ignore` (bare, or inside an
  HTML comment) in a SKILL.md to silence every finding for that file, even under `--strict`. Exit 2 on a
  usage error. See [docs/subagents.md](./docs/subagents.md#static-path-fidelity-check-analyze-skill) — a
  clean/suppressed result is a PRE-FLIGHT signal only, not proof of on-tier resolution; the runtime
  `no_vm_path_file_op` / `vm_path_denied` assertions remain authoritative.

- **`scenario.py resolve-agent-types <plugin-dir>` + a `subagent_type` check folded into `lint-skill`
  — static resolution of a pinned `subagent_type` against a plugin's own agents.** A `Task` dispatch
  pinning a `subagent_type` that doesn't actually resolve (e.g. `founder-skills:cap-table` when the
  agent is named `captable`) fails a definition lookup at dispatch time — previously only discoverable
  by paying for a live run. `resolve-agent-types` reads a plugin's `name` from
  `.claude-plugin/plugin.json` (fallback `plugin.json`) and each `agents/*.md`'s `name:` frontmatter
  (filename-stem fallback) to build the plugin's valid `<plugin>:<agent>` set (`--json` for a machine
  array); `lint-skill` now extracts every pinned `subagent_type` in a SKILL.md (YAML and
  dispatch-prose forms, not limited to fenced blocks), resolves the enclosing plugin, and flags a
  value that doesn't resolve as `subagent-type-unresolvable` (belongs to another plugin) or
  `subagent-type-unknown` (unresolved bare value). Both are **INFO, never WARN** — there is no
  harness registry of built-in agent types to disprove an unknown value against (only
  `general-purpose` is harness-known), so an unresolved value is always surfaced, never failed. See
  [docs/subagents.md](./docs/subagents.md#static-subagent_type-resolution-resolve-agent-types--lint-skill).

- **`lint-skill` gained a `guard-pattern-mismatch` WARN: a `${CLAUDE_PLUGIN_ROOT}` self-heal `find`
  that targets a different skill/plugin than the one being linted.** The mount-discovery self-heal
  pattern recovers `${CLAUDE_PLUGIN_ROOT}` by `find`-ing the plugin's own mount at runtime, but a
  copy-pasted `-path` glob naming another skill's or plugin's directory silently fails to discover
  THIS skill's mount instead. `lint-skill` now extracts the `-path` glob's skill/plugin/scripts-segment
  token and compares it against the SKILL.md's own frontmatter `name:` (or parent-directory name) and
  enclosing plugin name, warning when they don't match. See
  [docs/plugin-root.md](./docs/plugin-root.md#catch-both-before-a-paid-run).

- **`lint-skill`'s `subagent_type` check gained a third outcome: `subagent-type-not-found-in-plugin`
  (INFO).** A pinned `subagent_type` whose `<plugin>:<agent>` prefix names THIS skill's own enclosing
  plugin, but whose `<agent>` isn't among that plugin's enumerated `agents/*.md`, can never be another
  binary's built-in — the namespace prefix already commits it to this plugin, and the plugin's agent
  set was fully enumerable — so it's reported as `subagent-type-not-found-in-plugin` rather than the
  more equivocal `subagent-type-unknown`. Still INFO, not WARN, consistent with the rest of the
  `subagent_type` ladder's honest-limit posture. See
  [docs/subagents.md](./docs/subagents.md#static-subagent_type-resolution-resolve-agent-types--lint-skill).

- **`subagent_dispatch_healthy: {type?, delivered?, path?, path_suffix?, no_vm_paths?}` — a composite
  assertion for a single dispatch's per-dispatch correlation.** `subagent_file_write` matches ANY
  sub-agent-origin write, so it can't distinguish a delivery from the SELECTED dispatch from one made by
  a sibling dispatch. `subagent_dispatch_healthy` selects dispatch(es) by `type` (same matching as
  `subagent_dispatched`; omit to require every dispatch healthy) and, for each, checks its OWN paired
  non-error write (`delivered`, default `true`, optionally narrowed by `path`/`path_suffix`) and its OWN
  freedom from any `/sessions` VM-path attempt (`no_vm_paths`, default `true`) — both tied to that
  dispatch's `parentToolUseId`, never any other dispatch's. Hostloop-only (the VM-path conjunct can't
  verify off that tier); content-class (`RunResult.fileToolAttempts` + `RunResult.toolResults`),
  replay-checkable without `controlOut`.

### Changed

- **`toolCounts` shape pinned + clarified.** `RunResult.toolCounts` is always a `{tool: number}`
  call-count map — the schema now strictly pins the value type (including the per-window
  `skillActivity[].toolCounts`, previously unconstrained), and the description distinguishes it from the
  separately-shaped `toolErrors` (`{tool: {calls, errors}}`) and `toolDurations`
  (`{tool: {calls, totalMs, maxMs}}`) so a `jq` recipe can't conflate the three rollups.
- **Breaking (pre-1.0): `verify-cassettes` now distinguishes "could not verify" from "verified and
  found a real problem" in its exit code.** Previously every non-clean outcome exited `1`, so a
  consumer's non-zero-exit tripwire couldn't tell a genuine finding apart from a cassette verification
  simply couldn't run against (e.g. one written by a newer harness) — a version-refused cassette could
  false-green an inverted "must-fail" canary for the wrong reason. Exit `1` is now reserved for
  verification that RAN and found a real problem (a PII finding, a genuine — non-`unverifiable-*` —
  staleness drift, or scenario-prompt drift); exit `3` covers everything that means verification could
  NOT complete (any `unverifiable-*`-class staleness finding, a cassette from a version this harness
  doesn't understand, or a per-file read error/crash). A real finding still wins exit `1` when both occur
  in the same run. The JSON envelope (`schema/verify-cassettes.json`) gained a matching `unverifiable[]`
  bucket per result, split out of what used to be a class-blind `staleness[]`; text output now marks
  those rows `[unverifiable]` instead of `[stale]`.

### Fixed

- **The `no_delete_in_outputs` outputs-delete scan (`isOutputsDelete`) now parses the actual delete
  TARGET by default, instead of flagging on whole-command token co-occurrence.** A binary-verified read
  of real Cowork's own enforcement showed it denies outputs deletes STRUCTURALLY, by the resolved
  target's mount (the `outputs` mount is `rw` without the delete bit) — not by scanning command text —
  so a target-based scan is MORE faithful, not less safe. Previously `T=$(mktemp); …; rm -f "$T"` was
  flagged just because "outputs" appeared elsewhere in the same command, even though the `rm` target was
  `/tmp`. Now each rm-family delete statement's own target(s) are checked; a delete is suppressed only
  when every target is *provably* outside outputs — an absolute/relative path clear of `outputs/`, or a
  path under a safe prefix. `/tmp/` and the literal `$TMPDIR`/`${TMPDIR}` idiom are safe by DEFAULT
  (including a `VAR=$(mktemp …)`-sourced `$VAR`, resolved by a narrow, source-order-aware pass);
  `COWORK_HARNESS_SAFE_STAGING_PREFIX` remains available to union in operator-specific prefixes. An
  unresolved/command-substituted target (anything other than the recognized `mktemp` idiom) still always
  flags — the guiding invariant, "prefer a false positive over a false negative when a target is
  genuinely unprovable," is unchanged. Also fixed in the same pass: `splitStatements` now joins bash
  backslash-newline line continuations before splitting, so a line-wrapped `mv \` / `outputs/a.txt \` /
  `/tmp/b.txt` is scanned as one logical statement instead of being shredded into fragments too small for
  the `mv`-direction check to see both operands (previously an under-detection).

- **The staged NATIVE agent binary (hostloop/cowork tiers) now tolerates a patch-level staging drift by
  default, instead of forcing `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1`.** A mid-session Claude Desktop
  auto-update prunes the pinned native version dir and stages a newer one; since the native binary
  carries no sha256 pin, a same-major.minor patch bump is now auto-accepted (with a loud stderr note
  naming the pinned and substituted versions) rather than hard-failing. A major/minor drift keeps the
  existing behavior — env-gated fallback or a hard throw. `doctor`'s native-binary check surfaces the
  same substitution as an `ok` status with a version-substitution note, sharing one classifier with the
  resolver so the two can't disagree. The sha256-pinned VM ELF resolver is unchanged — it keeps its
  strict exact-or-env-gated-or-throw behavior on a patch-only sibling, verified by a regression test.

- **`lint-skill --strict` no longer fails on an INFO-only result.** The `subagent_type` ladder
  (`subagent-type-unresolvable` / `-not-found-in-plugin` / `-unknown`) is always INFO by design — there
  is no harness registry of built-in agent types to disprove an unknown value against — but `--strict`
  was exiting non-zero on ANY finding, INFO included, contradicting its own `--help` text ("exit
  non-zero on WARN too, not just ERROR") and failing a correctly-authored skill that merely pins a
  built-in `subagent_type` (e.g. `Explore`). `--strict` now fails only on WARN or ERROR severity.

### Docs

- **A "mechanics-only cheap-model" recipe for observing a skill's plumbing without paying for
  analytical quality.** No new code — this documents combining existing knobs (`--model <cheap-id>` on
  `skill`/`run`, a session's `model:` field, `run --matrix`'s `models:` axis for the main loop;
  `agent_env.subagent_model` for sub-agents) with the path/dispatch telemetry a run already produces
  (`fileToolAttempts`, `pathDenials`, `subagents[].resolvedAgentType`/`dispatchTypeOmitted`) and its
  matching assert keys (`no_vm_path_file_op`, `path_denied`/`vm_path_denied`, `subagent_dispatched`,
  `subagent_dispatch_healthy`) — none of which depend on model quality to be meaningful. Cross-links
  the static, token-free `analyze-skill` scan as the first line and the cheap live run as the second.
  Also states the honest limit: there is no scripted-step driver, so a cheap model still walks a
  skill's steps unassisted and may never reach the step you wanted to observe. See
  [docs/subagents.md](./docs/subagents.md#observing-mechanics-cheaply).

- **`docs/scenario.md`: cross-linked the two independent assert axes.** A scenario's `assert:` block is
  evaluated per-key along two SEPARATE axes — evaluable-on-replay vs. live-only, and content-class vs.
  frozen-by-default — and conflating them invites the misread "my `assert:` block is content-class, so
  editing my YAML re-evaluates it against the frozen cassette on replay." It doesn't: a frozen-by-default
  cassette replays its OWN recorded assert block unless `--assert-from` (or an embedded re-assert) opts
  it back onto the live YAML, independent of whether the individual keys involved are evaluable on
  replay at all. The two axes are now cross-linked at each other's definition so neither reads as
  standalone. See
  [docs/scenario.md](./docs/scenario.md#which-assertions-survive-replay-ci-placement) and
  [Where `replay` reads `assert:` from](./docs/scenario.md#where-replay-reads-assert-from--frozen-by-default-on-disk-by-opt-in).

- **`docs/subagents.md`: new "Stream observability" subsection.** Names the wire channels
  `RunResult`'s sub-agent and path telemetry are actually derived from — the `task_started` event
  family behind `subagents[].resolvedAgentType`/`dispatchTypeOmitted`, the `toolUseResult` envelope
  (`subagent_result_meta`) behind `resolvedModel`/`output`, the three filtered `pathDenials[]`
  producers (`pretooluse`/`can_use_tool`/`permission_denied`), and the `parent_tool_use_id`
  attribution mechanism behind `toolsUsed`/`referencesRead`. Documents the honest limit that
  sub-agent `thinking` blocks are parsed without a `parentToolUseId` at all, so sub-agent
  reasoning cannot be attributed to a dispatch and never appears in the run artifact — a real gap,
  not a harness omission.

## [0.30.0] — 2026-07-12

> **Upgrade notes.**
> - **Breaking (pre-1.0): `subagents[].agentType` renamed to `dispatchAgentType`, and
>   `subagents[].model` renamed to `dispatchModel`.** A consumer reading either old field name off
>   `result.json` now gets `undefined`. Both keep their original (dispatch-input) meaning — the
>   resolved counterparts (`resolvedAgentType`/`resolvedModel`, below) are new, separate fields.

### Added

- **Parity baseline for Claude Desktop 1.20186.1.** `baseline: latest` now resolves to `desktop-1.20186.1`
  — a patch-only Desktop release (egress allowlist, spawn config, and the Cowork system-prompt
  fingerprint are unchanged from 1.20186.0). The pinned VM agent ELF was re-synced from 2.1.202 to
  2.1.205 after a live Desktop self-update within the same Desktop build, restoring agreement between
  the pinned agent version and what's staged on disk so the host-loop live lane resolves its binary.
- **Cassette prompt-asset fingerprint.** Prompt identity was previously keyed on `appVersion` alone, so
  editing a committed prompt-asset file (`spawn.promptTemplate` / `subagentAppend` /
  `subagentAppendHostLoop`) under the *same* app version silently replayed old-prompt behavior. A cassette
  now records a hash over the referenced asset files (`fingerprint.promptAssetsHash`); a mismatch is a new
  warn-by-default staleness finding (`prompt-assets`, fails under `--strict`), an unhashable pointer is a
  distinct can't-verify finding (`unverifiable-prompt-assets`), and a cassette recorded before this field
  existed surfaces a non-failing informational note instead of either.
- **Host-loop sub-agent tool aliasing and gated `web_fetch`.** The host-loop initialize request now
  carries production's `Bash → mcp__workspace__bash` / `WebFetch → mcp__workspace__web_fetch` aliases
  (single-hop; an alias never grants a tool a sub-agent's frontmatter didn't already bind).
- **Five new assertion keys for sub-agent path fidelity.** `no_vm_path_file_op: true` (hostloop-only —
  no gated file tool attempted a `/sessions`-exact-or-prefixed path); `vm_path_denied: true`
  (hostloop-only — at least one recorded denial targeted a `/sessions` path; needs `controlOut` on
  replay); `path_denied: {tool?, path_matches?, source?, agent_scope?}` (hostloop-only — a denial
  matching all given matchers, `source` ∈ `pretooluse`/`can_use_tool`/`permission_denied`); `no_path_denied:
  true` (hostloop-only — no path denial recorded at all); and `subagent_file_write: {path?, path_suffix?,
  tool?}` (**tier-agnostic** — a sub-agent-origin write/edit attempt at the given path, exact or suffix,
  with a paired non-error tool result — the causal half of a delivery probe, pairs with `artifact_json` for
  content). The four hostloop-only keys fail "cannot verify" (never vacuous-pass) on any other tier, since
  `/sessions/...` is a valid path there.
- **`RunResult.fileToolAttempts`** — attempt-level telemetry (raw `file_path`/`path` as sent, the
  first-match gate path, and `origin: main|subagent|unknown`) for every gated file-tool call
  (Read/Write/Edit/Glob/Grep/MultiEdit), re-derivable on replay from the frozen tool_use stream.
- **`RunResult.pathDenials`** — decision-level path-denial telemetry merged from all three producers that
  can deny a gated file-tool call on path grounds: the PreToolUse path gate's own callback, a denied
  `can_use_tool` ask on a gated file tool with a path, and a pre-ask `permission_denied` correlated to a
  recorded attempt. The `can_use_tool` source is reconstructible on replay only when the cassette carries
  `controlOut`; without it the field is undefined (evidence-unavailable), never a vacuous `[]`.
- **`RunResult.subagents[].resolvedAgentType` / `.resolvedModel`.** The agent stream states the
  binary-*resolved* child type (via `task_started`) and the resolved child model (via the dispatch's own
  `tool_use_result` envelope) — previously discarded. Both are joined strictly by `toolUseId` and
  corroborate each other without overwriting stronger evidence. `subagent_dispatched` and
  `subagent_output_contains` now match on dispatch type, resolved type, *or* description, so a type-less
  dispatch that resolved to e.g. `general-purpose` is selectable by either assertion.
- **A loud warning on type-omitted sub-agent dispatches.** A `Task` dispatch that carries no
  `subagent_type` at all falls back to the built-in `general-purpose` agent (`tools:["*"]` — the wildcard
  surface, including workspace bash) — faithful production behavior, and one that fires routinely, not
  just at the edges. The harness now warns loudly when this fallback is observed (an *explicit*
  `subagent_type: "general-purpose"` is a deliberate author choice and does not warn) and records the
  omission on the run (`subagents[].dispatchTypeOmitted`), so it's visible in the run's own record, not
  only in a live terminal warning.
- **`agent_env` session config knob** (`subagent_model`, `tool_search: "auto"|"off"`,
  `disable_experimental_betas`) applies `CLAUDE_CODE_SUBAGENT_MODEL` / `ENABLE_TOOL_SEARCH` /
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` **uniformly across all four fidelity tiers**. Previously an
  operator-exported value of any of these three leaked into hostloop/protocol (which spawn over the full
  operator shell env) but never into container/microvm (a constructed allowlist) — the same session
  behaved differently depending only on which tier it ran at. The three keys are now also scrubbed from
  the operator layer on the two inheriting tiers before any baseline/knob overlay, so a stray shell value
  can never leak through on some tiers and not others; setting any `agent_env` field moves the session
  fingerprint so `verify-cassettes` surfaces the drift on an older cassette.
- **`sync` now guards sub-agent prompt and path-gate fidelity.** Two new structural sentinels pin the
  two-branch (`subagent_env_hl`/`subagent_env_vm`) sub-agent append — the branch-selection ternary,
  the per-branch content fingerprint, and the substitution map's keys *and* values (a host/VM cwd swap
  fails) — and the host-loop path gate's module-bounded shape (gated/excluded tool sets, every deny text,
  the read-only-guard-before-containment order). A separate pinned gate hard-stops the sync (not just
  warns) if production flips on a server-delivered override of the sub-agent append text, since that flip
  is invisible to the content sentinel and the harness has no captured override text to fall back to.
- **`docs/subagents.md`** — the sub-agent capability/path reference: the tier-qualified outputs-addressing
  contract (host-loop's cwd-relative `artifacts/...` vs. the VM loop's `mnt/outputs/artifacts/...` —
  there is no single cross-tier literal form), a full capability/path matrix, the sub-agent tool-composition
  rules (frontmatter allowlists, the `"*"` wildcard, `disallowedTools`, tool aliases, never-subagent
  tools), the type-less dispatch trap, model-resolution precedence, and lifecycle notes (no resume, a
  depth cap of 5 with no fan-out cap, fork-dispatch environment-append exclusion).

### Changed

- **Cassette v9 read floor.** `readCassette` now refuses cassettes recorded below v9
  (`MIN_SUPPORTED_CASSETTE_VERSION`) with a clear re-record error instead of silently tolerating
  legacy formats; the pre-v9 reconstruction branches (`contentSigAlgoOf`, `buildFolderPrefixMap`'s
  session-fallback, `cmdRehash`'s pre-v3/pre-v6 checks) are deleted as unreachable, and SPEC.md's
  stability contract states the floor. The superseded `schema/cassette.v2`–`v8.json` files are
  removed (v9/v10 remain).
- **`verify-run` fails closed on degraded evidence.** A `result.json` that parses but is
  structurally invalid (no `"success" | "error"` result field) refuses instead of being certified
  as success; an `events.jsonl` with unparseable lines, or one yielding fewer gates than
  `trace.json` recorded questions, refuses instead of passing answer coverage at a hollow 0/0.
- **Verdict honesty for missing scan evidence.** When post-run scan evidence is unavailable, the
  `host-path` / `outputs-delete` guards report `?` (unverified) instead of a false ✓, and a new
  warn-severity `scan_unavailable` signal surfaces in the verdict JSON.
- **Release gates hardened.** The CI scenario suite hard-fails on the canonical repo when
  `ANTHROPIC_API_KEY` is missing on non-PR events (fork and Dependabot PRs keep the warn+skip);
  image publishing now waits on ci.yml success for the tagged commit and verifies tag↔package
  lockstep via a composite action shared with the npm release gate (`workflow_dispatch` remains
  the documented manual-republish escape hatch). An admin can deliberately skip the live scenario
  suite for a single release by setting a `SKIP_LIVE_SCENARIOS` repo variable to that exact commit
  SHA — an explicit, auditable, per-commit override (a later commit can't inherit it), not a silent
  skip; see [RELEASING.md](./RELEASING.md).
- `ResourceSummary.probeFailures` (shipped at runtime in 0.29.0) is now declared on the RunResult
  type and JSON Schema; assertion-side consumption remains deferred.
- **Breaking (pre-1.0): `subagents[].agentType` renamed to `dispatchAgentType`, and `subagents[].model`
  renamed to `dispatchModel`.** Both keep their original (dispatch-input) meaning — the rename exists only
  because a *resolved* type/model now lands beside each (`resolvedAgentType`/`resolvedModel`, above) and
  the old names would have been ambiguous between "what the dispatch asked for" and "what the binary
  actually ran." No deprecation window; a consumer reading the old field names gets `undefined`.
- **The host-loop `PreToolUse` path gate is re-ported to Desktop 1.20186.1 semantics.** Plugin/skill
  content loses its blanket path exemption and becomes a read-only category instead (a mutating tool
  targeting it is now denied, with its own message, rather than silently passing through); the read-only
  guard gains the two other production categories — an uploads hardlink write-block and spooled tool
  results (`projects`) — each with per-session-type deny text; the spool dir joins the readable roots. The
  harness's own `mode: r` connected-folder extension and the `/sessions` MultiEdit message-selection
  nuance are preserved across the re-port.

### Fixed

- **Host-loop sub-agent dispatches now receive the correct environment description.** The harness always
  sent sub-agents the VM-branch environment text, telling them their files exist only in a sandbox while
  their file tools actually reach the real host filesystem — one of two prompt bugs that could seed
  `/sessions/...` paths into a host-loop sub-agent's dispatch. A new host-loop-specific append
  (`subagent_env_hl`) is now selected whenever `effectiveFidelity === "hostloop"` (container/microvm keep
  the existing VM-branch text; `protocol` sends neither, a documented divergence), delivered on **both**
  the `run`/`skill` and `chat` lanes (previously `chat` sent no sub-agent append at all).
- **The host-loop "Shell access" prompt's outputs bullet no longer teaches VM paths to native file tools.**
  Its file-tool side substituted the VM session root where production substitutes the host outputs
  directory — the other of the two prompt bugs behind stray `/sessions/...` sub-agent paths.
- **`web_fetch` on host-loop is now gated through a single `can_use_tool` decision, matching production**,
  instead of being pre-approved directly by the workspace handler. Bash stays pre-approved for the whole
  session; a fetch now emits a real permission ask, answered once by the shared provenance/domain
  decision (which marks provenance on allow) — closing the prior two-decision, self-approving shape.
- **Raw run logs are scrubbed on every exit path.** Previously only the success and
  unanswered-gate paths scrubbed `events.jsonl`/`control-out.jsonl`, and `agent.stderr.log` was
  never scrubbed — a mid-run fault kept raw (potentially secret-bearing) logs on disk. An
  outermost finally now scrubs all three on success, salvage, and every rethrown fault, in the
  run and chat lanes alike; leak/capability scanners still read the raw stream first.
- A truncated `present_files` result (fewer returned paths than inputs, or extras) now counts as
  malformed evidence, so `no_scratchpad_leak` fails "cannot verify" instead of green-lighting
  only the pairs that came back.
- Baseline pins caught up to `desktop-1.20186.1` (the parity sync landed the baseline file
  without bumping them, leaving `check:versions` red).
- `docker/Dockerfile.agent` preinstalls `pyyaml==6.0.3`, matching real rootfs provisioning (the
  container tier no longer exercises the vendored-YAML fallback the real environment never needs).

### Removed

- The subagent-grant canary (`src/canary/`, its fixture, test, and empty snapshot) — never wired
  to `sync`, and its drift snapshot could never fail.
- `scripts/boot-rootfs-vz.ts` — the tested-infeasible generic-VZ boot attempt; its finding is
  preserved in `docs/fidelity-gaps.md`.
- From the npm tarball: the 1.5 MB README banner and the compiled critique evaluator (relocated
  to `scripts/lib/critique/`, dev-only) — the package drops from 2.57 MB to ~1.05 MB compressed.

### Docs

- README's `## Status` section collapsed to the baseline-pin sentence (the perishable
  verification narrative lives in this changelog; the feature catalogue lives in the sections
  above it).
- `docs/cowork-spawn-contract-1.12603.1.md` is frozen as historical research and no longer a
  release version-pin; `check:versions` gates on the SKILL.md and README pins only.
- Dropped the stale first-run egress-race gotcha (proxy startup has been synchronous for a
  while); documented `verify-run`'s fail-closed refusal family in `docs/scenario.md` and the
  companion skill.
- `docs/subagents.md` (new — see Added) is cross-linked from `docs/boundary.md` and `docs/scenario.md`;
  `docs/plugin-root.md`'s tier table is corrected — `CLAUDE_PLUGIN_ROOT` is absent from a Bash-tool
  subprocess's env on **every** tier, not host-loop only, as the table previously implied.

## [0.29.0] — 2026-07-11

### Added

- **Parity baseline for Claude Desktop 1.20186.0.** `baseline: latest` now resolves to `desktop-1.20186.0`
  (VM agent ELF 2.1.202 unchanged; native host app 2.1.205). The 1.20186.0 asar was a minifier re-anchor —
  the value-resolved spawn contract is byte/behaviourally identical; the sync extractor's structural anchors
  were re-anchored to the new bundle shapes (hoisted helpers became namespace-method calls; const spreads
  became export aliases). Verified live across the `protocol`, `container`, and `hostloop` tiers.
- **`sync` now guards Cowork system-prompt drift.** Each sync fingerprints the prompt (a minifier-independent
  content hash plus a `{{placeholder}}` / `<section>` inventory) and **refuses to write** when the content
  drifts from the committed fingerprint until a new fingerprint entry is added, and **hard-fails** on a
  `{{placeholder}}` the renderer neither substitutes nor explicitly allowlists. This closes a gap where a
  prompt change (e.g. the deployment-gated `{{modelIdentity}}` placeholder added in 1.20186.0, which is
  stripped on first-party so the rendered prompt is unchanged) could slip past the coarse `asarFingerprint`.
- **Usage/quota-limit runs are now classified as `resultErrorKind: "usage_limit"`.** A session/weekly/model/
  spend/org quota-exhaustion arrives as an `is_error` result with the SDK's misleading `subtype: "success"`
  and HTTP 429 — previously an undifferentiated error, indistinguishable from a real skill regression.
  Detection is conjunctive (`api_error_status === 429` **and** a terminal usage-limit message; a bare 429 is
  a transient overload and is not reclassified). `resultSubtype` is kept verbatim (faithful SDK passthrough).
  Surfaced on `RunResult`, `status.json`, and a distinct verdict signal ("retry after reset") so a batch can
  halt-fast; the `claude -p` decider transport fails fast (non-retryable) on a usage limit instead of
  retrying into a spent quota.
- **`input_unmodified` can now guard uploaded files (`uploads/**`).** Uploads are captured as a read-only
  input root (hash-only in cassettes — a private upload is never inlined), so a scenario can assert the agent
  didn't mutate an uploaded file; a mutation is attributed to the agent (not excused as an external edit).
  Previously only connected-folder inputs were guardable.
- **`RunResult.command`** records the exact command that produced a result (`run`/`skill`/`record`/`chat`/
  `replay`) — finer than `mode` (which only distinguishes run vs. chat, so a `skill`/`record` run was
  indistinguishable from a plain `run`). `reindex` now prefers this field, so a rebuilt run index no longer
  relabels a `skill`/`record` run as `run`; it falls back to a prior index row, then to `mode`, on older
  results that predate the field.
- **`RunResult.evidenceErrors.egressParse`** counts proxy-log lines the egress sidecar dropped as malformed
  (bad JSON, missing host, unknown decision) — previously filtered out silently. Observability only (egress
  assertions are positive, so a dropped line already fails loud), but now visible.
- **`subagents[].outputTruncated` and `toolResults[].assertTextTruncated`** flag when a captured value was cut
  at the 10 KB assertion cap, so `subagent_output_contains` (and the equivalent substring checks) report
  "evidence unavailable" instead of a false "not found" when the searched text could lie past the cut.
- **`fingerprint.frozen`** marks, on the replay lane, that the staleness fingerprint is the cassette's
  record-time snapshot rather than a fresh recompute, so a consumer can't mistake one for the other.
- **Replay results now populate `prompt` and `toolResults`** (the scenario prompt that drove the re-drive and
  the tool-result records already built for evaluation) — both were previously always `undefined` on replay.
- **`ResourceSummary.probeFailures`** counts resource-sampling probes that actually failed (nonzero exit,
  timeout, parse error), distinct from a tier that was never sampleable (protocol/replay) — "sampling broke"
  is now told apart from "sampling wasn't attempted."
- **`chat` now samples real resources on the `container`/`hostloop` tiers.** Previously no `ResourceSampler`
  was ever started for a chat session on either tier, so `resources.jsonl` was always empty despite
  `chat-result.ts`'s doc-comment claiming resource parity with `run`; a protocol-tier chat legitimately has
  none (no container/process id to probe against the host `claude` binary).

### Changed

- **`input_unmodified` accepts a single glob string** as well as an array (`input_unmodified: 'uploads/**'`
  no longer errors "expected array").
- **`sessionFingerprintDrift` keeps an unresolvable session fingerprint non-failing (informational)** and
  downgrades a mismatch to a non-failing note when the cassette's session was only resolved via a
  name-lookup fallback (the SAME low-confidence signal `scenarioContentDrift` already downgrades on) —
  a relocated cassette whose relative-offset resolution lands on an unrelated same-named session file no
  longer reads as a false "session shape drifted."
- **`artifact_json`'s replay remedy names an uploaded input distinctly** — a body-less target that was
  captured hash-only because it's an *upload* now says so directly, instead of the prior combined
  readonly-or-over-cap wording that didn't cover the uploads case.
- **`scenario.py lint-skill`** downgrades a `${CLAUDE_PLUGIN_ROOT}`-in-VM-bash use to a `plugin-root-guarded`
  **INFO** (from WARN) when the same bash block self-heals it at runtime (`[ -d ] || find /sessions …`), so a
  correctly-guarded block no longer shares the alarming WARN class with a genuinely-unguarded use.
- **`no_unexpected_files` now requires a complete post-run filesystem walk.** An unreadable subtree
  (permission error, race) previously collapsed to "no files found there" and could vacuously pass; the check
  now fails "evidence unavailable" when any part of the tree couldn't be observed.
- **`semantic_matches` refuses to grade over incomplete authored-file evidence.** When a file the run authored
  was dropped at the capture-size budget or was unreadable at read-back (or, on `--resume`, the scratchpad was
  skipped to avoid misattributing a prior turn's files), the assertion fails "evidence unavailable" rather than
  trusting a judge grade made without that content. The judged document is also size-capped now (per-section
  and total, with an explicit truncation marker) so a long run can't overflow the judge's context; secret
  scrubbing runs before the cap, so a secret can never be exposed by falling on a truncation boundary.
- **`task_status` now honors corrupt task telemetry** — when a `TaskCreate` result was unparseable it fails
  "malformed" instead of matching against the surviving subset, consistent with `all_tasks_completed` /
  `task_count_min`.
- **Empty or regex/brace-expansion tool globs are rejected at load.** `tool_called` / `tool_not_called` /
  `subagent_tool_used` / `subagent_tool_absent` values that are empty or contain regex/brace metacharacters
  (`.*`, `|`, `[]`, `{}`, …) match no real tool name and used to pass a `_not_`/`_absent` assertion vacuously;
  they are now a hard schema error for authored scenarios and recorded cassettes alike.
- **`readRunStatus` validates the shape of `status.json`**, not just that it parses — a truncated or otherwise
  structurally-invalid write (e.g. `{}`) is reported malformed instead of being trusted as a valid status; a
  `--follow` loop resolves only after observing a genuinely valid status.
- **Answered gates reconcile against actual delivery.** A control-response that was optimistically reported
  delivered (queued) but whose write later failed before reaching the agent is corrected once the run
  completes, so delivery telemetry and `trace --view questions` read the true outcome.
- **A `TaskCreate` / `WebSearch` / `present_files` call whose result never arrived before the stream ended now
  counts as incomplete evidence** (`evidenceErrors.*`) instead of silently vanishing from the resolved set, so
  the dependent assertion fails "cannot verify" rather than grading a truncated subset as complete.
- **Bounded hashing/reads.** `classifyWorkspaceFiles` caps per-file hashing (50 MiB, matching the pre-run
  manifest) and reports `hashError: "over-cap"` instead of reading a huge file whole; authored-file capture
  reads only the bytes it retains.

### Fixed

- **`sync` no longer derives a phantom `nativeStagedPath`.** The native macOS agent app (`claude-code/`) and
  the container/microvm Linux ELF (`claude-code-vm/`) version on independent cadences; `sync` derived the
  native (hostloop) path from the VM `.sdk-version`, producing a path that did not exist whenever the two had
  drifted — and freezing that phantom into the written baseline. It now resolves the native path from the
  newest app actually staged under `claude-code/`, falling back to the version-derived convention only when no
  native app is staged at all.
- **Two anonymous sub-agent dispatches in different assistant turns could collide on the same synthesized id**
  (the fallback id was derived only from the block's position within its own message). It now derives from the
  message id plus block index — unique across the run and stable across record→replay — fixing dispatch nesting
  in `trace --view dispatches` for skills that dispatch multiple unnamed sub-agents.
- **The semantic judge's recorded model could name the wrong one.** `assertions[].judgeModel` was stamped from
  the requested alias (e.g. `opus`) before the call; the transport resolves an alias to a concrete model per
  call, so the resolved model is now recorded after the call completes.
- **`matrix --repeat`'s per-cell pass/fail glyph didn't honor `--allow-budget-stop`**, though the aggregate
  "N/M cells passed" count did — a cell that passed under a permitted budget stop could print as failed next to
  its own row while counting as a pass in the summary.
- **The resource sampler could miss a short run's only sample.** `stop()` now waits (bounded) for an in-flight
  probe before returning, so a run shorter than one sampling interval reliably records its first sample instead
  of racing teardown.
- **A corrupt `timeline.jsonl` header was indistinguishable from an absent timeline** — both read as "no
  timeline," so a corrupt read could be baked into a recorded cassette as a clean empty timeline. A corrupt
  header now reads as a distinct "present but corrupt" state, kept out of both live results and cassettes.
- **A malformed `system/init` frame** (a non-array `tools`/`mcp_servers`/`skills`, or a non-object content
  block) could crash with an uncaught `TypeError`; it is now rejected as a typed protocol error at parse time,
  and the `trace` reconstruction lane skips it instead of aborting.
- **`verify-cassettes` no longer aborts the whole batch on a nameless cassette.** A lenient cassette with
  no `scenario.name` (and no `scenarioSource`) threw inside the per-file verification, which aborted the
  entire run (`results: []` — a false-green by abort) instead of reporting that one file's error and
  continuing. Each file's verification is now wrapped so a per-file crash becomes that file's error row
  (mirrors `replay`'s existing per-file catch).

### Internal

- **Eval-gate hardening** (`scripts/eval-gate.ts`, maintainer instrument — not shipped with the skill): a
  missing/edited scenario or discriminating claim now fails the gate (opt-out `--allow-unmatched`); a mixed-model
  capture, a null candidate model against a concrete baseline, and a malformed profile/fraction are refused
  instead of silently collapsing; child runs are bounded by a timeout, output cap, and process-group kill.
- **Skill-critique hardening** (`scripts/skill-critique.ts`, `src/critique/*`): the reflection turn's exit,
  envelope, and session/output continuity are validated before evaluation; a corrupt or missing turn archive is
  reported rather than substituting turn-2 data; the untrusted self-report is fenced as inert data before the
  evaluator prompt; child turns are bounded and orphaned process groups are killed on interrupt.

## [0.28.0] — 2026-07-10

### Added

- **`trace --view tool-errors|files|usage`** — three new views: `tool-errors` (one row per errored
  tool call with the full multi-line stderr, capped at 4KB, vs. the 120-char preview in `tools`);
  `files` (`workspaceFiles` as a class-grouped tree with an added/modified/removed/unchanged diff
  column vs. `preRunHashes`); `usage` (the full per-model token/cost/cache breakdown behind the
  default view's combined cache-ratio footer).
- **`replay --explain`** — prints the concrete evidence behind every *passing* assert (which
  `computer://` link resolved, which file matched, which value satisfied a bound), so a green run can
  be told apart from a vacuous one (e.g. a presence-gated key that matched zero links).
  `--output-format json` already carried `assertions[].evidence`; `--explain` governs the text render.
- **`replay --reassert --write`** — persists a token-free-revalidated assert block back into the
  cassette when *only* the assert block changed, closing the gap where a pure assert-semantics edit
  (`max_tool_errors`, `task_count_min`, `computer_links_resolve_if_present`, `allow_stall`, …) cost a
  paid re-record. Refuses to write any added key that would silently skip on this cassette
  (evaluability guard), refuses a failing reassert verdict without `--allow-failing`, and redacts only
  the spliced assert block (events/controlOut/fingerprint stay byte-identical).
- **`verify-cassettes --margins`** — replays every cassette carrying a count-bound assert and reports
  recorded-vs-budget with a margin ratio (e.g. `recorded=15, budget=30` → `2.0×`), flagging a tight
  count budget without a paid `run --repeat`. Diagnostic only; never changes the gate verdict.
- **`scenario.py lint-skill <dir|SKILL.md>`** — catches two Cowork host-loop authoring footguns before
  a paid run: `${CLAUDE_PLUGIN_ROOT}` used as an in-VM bash path (it's unset in the host-loop VM), and
  a hook that writes env vars or `/tmp` for the in-VM agent to read (host-side hook writes aren't
  VM-visible). Consumer-aware — doesn't flag the token in host-side prose or `Read`/`Grep` directives.
- **Cassette format v10 — symlink/hardlink-aware recording.** Manifest entries gain `linkKind`; links
  record path-only (no dereference, sha256 `""`) and materialize on replay as placeholders. Pre-v10
  cassettes keep replaying unchanged (no forced re-record).
- **Cowork system-prompt drift fingerprint** (`baselines/prompts/cowork-system-prompt-fingerprints.json`):
  the SHA-256 + code-point/section-tag counts of the raw Cowork system-prompt constant per Desktop build,
  so prompt-append drift is detectable across releases without publishing the proprietary verbatim text.
  The append is verified **unchanged** from 1.18286.0 to 1.18286.2 (identical code-point count and section
  structure).
- **Execution-location taxonomy** — four additive, absent-compatible fields so a future cloud-run
  artifact can never be silently mislabeled as a local one, and filesystem-dependent guards degrade to
  evidence-unavailable rather than false-passing: `RunResult.execution` (`{location, environmentId?,
  taskKind?}`, stamped `location:"local"` on every locally-executed run, wired through all five
  `RunResult`-assembling call sites — a replay honestly passes through the recording's own location
  instead of guessing); `Cassette.environment` (recording-time provenance stamp, no `cassetteVersion`
  bump); a manifest-local `origin` field on the pre-run manifest (`"local-walk"` today; a
  `"remote-unavailable"` producer would make `no_unexpected_files`/`input_unmodified` fail loud instead
  of vacuously passing on an unwalkable tree); and a reserved `Scenario.execution` enum
  (`"local"` default | `"cloud-describe"`, which hard-errors at load time — like
  `replay_protocol_fidelity` — since no runner exists for it yet, rather than being silently accepted
  and ignored). No cloud execution capability is added; these are purely descriptive/forward-compat.
- **`semantic_matches` assertion** — a live-only, LLM-judged assertion that grades a fixed `rubric` of
  claims against the run's answer — the **union of the agent's final result text (`RunResult.finalMessage`),
  the transcript, and the final on-disk content of any files it authored during the run**, so a claim about
  content the skill led the agent to *write to a file* grades as reliably as one about inlined prose — one
  pass/fail per claim. Per-claim results are recorded on `RunResult.assertions[].semanticClaims`
  (`{index, claim, pass}`), so a candidate run's claim-level profile can be diffed against a baseline instead
  of only reading a single summary verdict; a rep whose grade can't be parsed (after one retry) is marked
  `RunResult.assertions[].judgeInvalid` and **never silently dropped** — it is excluded from the pass
  denominator, and the guard against a misleading score from that exclusion is the eval gate's
  minimum-valid-rep floor (`MIN_VALID` ≥ 4) plus this visibility, not a claim that denominator-shrinking
  inflation is impossible. Within a rep, a grade still unparseable after the retry fails that assert outright
  (evidence-unavailable, not a vacuous pass). Supports a
  `min_pass` threshold (default: all claims) and a per-assert `judge_model` override (default
  `claude-opus-4-8`, also settable via `COWORK_HARNESS_JUDGE_MODEL`) — the override is now actually
  honored per assert, and the model that graded is recorded on `RunResult.assertions[].judgeModel` so a
  before/after eval can verify the judge was held constant. Classified live-only alongside `egress_*` —
  stripped on replay (skipped-loud), never a vacuous pass.
- **`RunResult.referencesRead`** — the skill's `references/*` / `scripts/*` files the agent actually
  **Read** during the run (skill-relative, deduped in first-seen order): a progressive-disclosure signal
  for "did the agent reach this content?" skill-quality measurement. Main-agent Reads of `references/`/
  `scripts/` (not `assets/`, not sub-agent reads); `SKILL.md` is delivered whole (never Read as a file),
  so it never appears. Present on live and replay.
- **`RunResult.finalMessage`** — the agent's final answer text: the SDK result message's own designated
  answer, not the joined transcript of every assistant turn. Lets a consumer read what the agent actually
  answered without parsing `run.jsonl`. Threaded through every `RunResult` producer (live success and
  salvaged-partial, replay re-drive, `chat`); `undefined` on a truncated/error cassette.

### Fixed

- **`tool_called` / `tool_not_called` / `subagent_tool_used` / `subagent_tool_absent` are now GLOB-matched,
  not exact-string.** These four keys did an exact tool-name lookup, so a family pattern like
  `tool_called: mcp__workspace__*` was unsatisfiable (it searched for a tool literally named
  `mcp__workspace__*`). They now match a glob — `*` = any run, `?` = one char, everything else literal,
  anchored + case-sensitive — so `mcp__workspace__*` matches any workspace tool while an exact name (`Write`)
  still matches only that tool (no over-match: `Edit` ≠ `MultiEdit`). Existing exact-name asserts are
  unchanged. A pattern carrying a regex-only metacharacter (`.*`, `|`, `[…]`) is warned, since it matches no
  tool name under glob and could otherwise silently pass a `_not_`/`_absent` assert. Failure messages now
  list the tools that actually ran. (Distinct from `tool_available`, which stays a regex.)
- **A resumed turn no longer clobbers an earlier turn's `run.jsonl` / `result.json`.** Both were
  rewritten in full each turn, so after a `--session-id` + `--resume` session you could not recover
  turn 1's transcript or result — while `events.jsonl`/`timeline.jsonl` (append-mode) blended turns.
  `run.jsonl` and `result.json` now stay the **latest** turn (unchanged for their readers) and
  `RunResult` carries a `turn` number; each prior turn is preserved as `run.turn-<N>.jsonl` /
  `result.turn-<N>.json`, so every turn's transcript and result remain recoverable and attributable.
- **`sync`'s asar-bundle reader followed a stale assumption about Desktop's Vite build output.** A
  Desktop release that code-splits `.vite/build/index.js` into a small entry stub plus a
  content-hashed chunk file (rather than one monolithic bundle) was silently read as near-empty
  content, misreporting real spawn-contract/mount-mode/web_fetch facts as broken. `readMainBundle()`
  now follows the entry's local `require()` references transitively so both bundle layouts read
  correctly.

- **`--output-format json` output from `replay`/`record`/`verify-cassettes`/`rehash`/`doctor` no longer
  silently truncates past 64KB.** These commands wrote their JSON envelope via the async
  `process.stdout` stream then exited; on a pipe, the buffered tail past the ~64KB pipe buffer was
  dropped at exit — corrupting any `| jq` or `subprocess.run` consumer at exactly 65536 bytes (a file
  redirect drained fully, hiding the bug). 0.27.0's richer replay envelope pushed real cassettes past
  the threshold, exposing it. Both emitters now use synchronous `writeSync`, matching the CLI's
  existing mitigation.
- **Closed a symlink/hardlink blind spot spanning recording, containment, and assertions** that let an
  agent-created link silently pass (or a legitimate one silently fail):
  - `no_unexpected_files` and the pre-run baseline didn't see symlinks/hardlinks at all — a stray link
    could ship a false-green. Both now walk a link-aware path collector.
  - Live host-shaped and VM-shaped `computer://` containment checks were symlink-blind (lexical join,
    following the link on `existsSync`) — an in-tree symlink escaping the work root could resolve as
    contained. Both now realpath-resolve once the candidate exists.
  - `input_unmodified`'s pre-run manifest skipped hardlinked inputs entirely (a real inode with
    in-root content, common in `pnpm`/`cp -l` trees) — now hashed like any other file. Symlinks stay
    path-only (correctly excluded from content hashing).
  - On replay, a recorded link materialized as a placeholder file indistinguishable from a real one,
    so `file_exists`/`user_visible_artifact`/`computer_links_resolve` PASSED where live could RED a
    dangling or escaping symlink. These three now fail evidence-unavailable on a link path instead.
  - `verify-run`/`--resume` against a pre-v10 run dir now compares on the same links-blind basis as
    its baseline (new `RunResult.preRunLinkAware`), instead of false-straying every pre-existing
    symlink as "created".
  - A marketplace `entry.source` resolving to the marketplace root itself (`""`, `"."`, `"./"`) is now
    rejected at the traversal guard — it previously staged the entire marketplace as one plugin.
- **`CLAUDE_PLUGIN_ROOT` is left unset in the host-loop VM sidecar**, matching production (live-probed:
  real host-loop leaves it unset and the agent self-heals via `find`). The harness previously injected
  a bogus `/host/plugins/unmounted` sentinel that leaked a fake host path into guest bash. Skills that
  read the token in the wrong context are now caught by `lint-skill` above.
- **`remote_plugins` mounts to `.remote-plugins/plugin_<id>`**, matching a migrated Cowork install
  (UI-uploaded / org-remote plugins), not `.remote-plugins/<basename>` — which also fixes a basename
  collision when two `remote_plugins` entries shared a name. The synthetic id is derived from the
  *declared* source string (not a resolved absolute path), so it stays stable across machines/checkouts.
- **Nested sub-agent dispatch trees now reconstruct from `result.json`.** `parentToolUseId` was
  silently dropped when a sub-agent record was pushed, so `trace --view dispatches` couldn't nest a
  grandchild agent under its parent.
- **Nested connected folders now remap to the correct mount on replay** regardless of the order they
  were declared in (longest-prefix-first matching).
- Several evidence-honesty corrections so `result.json` doesn't misreport what was actually observed: a
  zero-task run now emits `tasks: []` (not `undefined`); `context.tools`/`context.mcpServers` are
  unseeded (not a false empty inventory) when a crash happens before init; a `tool_result_contains`
  match against a display-truncated result reports evidence-unavailable instead of claiming the string
  is absent; host-path leak detection also flags `/private/var/`, `/var/folders/`, and `/Volumes/`; an
  all-malformed resource log reports `malformedLines` instead of looking never-sampled; gate-provenance
  pairing in `trace --view questions` uses the persisted `requestId` (retry/duplicate-safe) instead of position.
- `record`/`replay`/`verify-cassettes`/`rehash`'s `--output-format json` **error paths** now conform to
  the shared error envelope (previously bare plain-text on some paths); `verify-run`/`assertions`/
  `trace`/`diff`'s **success** JSON is now wrapped in the same envelope for cross-command consistency
  (additive — every existing field and exit code is preserved).
- **Un-pinned the minified gate-check helper name in the spawn-env extractor.** Desktop 1.18286.2
  re-minified the renderer, renaming the GrowthBook gate-check helper (`At`→`et`). The extractor matched
  it by literal name at four sites in `src/sync/cowork-sync.ts`, so `sync` reported unknown deltas and —
  more importantly — one site silently failed open (an off-gate `MCP_CONNECTION_NONBLOCKING` spread would
  have leaked `"0"` over the base env with no flag). The extractor now matches the helper by shape, still
  guarded by the closed `SPAWN_GATES` set and the S18 anchor; a rename-regression test covers it.
- `artifact_json` no longer crashes on a stat race between the existence check and the read (fails the
  assertion instead). A `config_dir` that exists but isn't a directory now gets a clear error instead
  of a raw `ENOTDIR`. Protocol staging now fails loud (`BoundaryError`) if a *required* mount's source
  vanishes between plan-build and staging, instead of silently staging an empty tree.
- **The companion skill's own docs pointed at repo-only files** (`docs/`, `README.md`) that a
  marketplace-installed agent never receives — only `SKILL.md` + `references/` + `scripts/` are staged.
  Every such pointer is now prose describing where the fuller doc lives in the source repo, not a
  markdown link, so it can no longer render as a dangling link for an installed agent.

### Documentation

- Added `docs/plugin-root.md` — the `${CLAUDE_PLUGIN_ROOT}` two-namespace resolution model (host-side
  reads vs. in-VM bash), the single most common Cowork authoring footgun.
- Documented the assertion-edit-to-CI propagation chain (scenario edit → `--reassert`/`--assert-from`
  validates free → embed via re-record or `--reassert --write`) next to the frozen-vs-on-disk rules.
- Reorganized the skill's debugging guidance around the kept-run-dir → `trace`/`result.json` →
  `verify-run` loop as the primary, first-class debugging path (previously buried under interactive
  `chat`).
- **Companion skill restructured around the three loops — author → run → debug.** `SKILL.md` now reads
  Preflight → Orient → Part I (Author a scenario) → Part II (Run, record & lock) → Part III (Debug) →
  Gotchas → References, with debugging a first-class Part reachable from the top rather than a
  sub-section. Every prior section was re-homed, not dropped, and cross-references now cite stable
  section titles instead of numbers so a future move can't silently break them.
- **Single-source debug triage.** A link-free triage decision-table — which tool to reach for when "the
  skill misbehaved" vs. when "a green you don't trust" — is authored once and kept byte-identical
  between the shipped skill and `docs/debugging.md` by a test, so the two surfaces can't drift apart.
- **Documented how uncommitted skill edits are staged.** The harness stages git-*tracked* files but
  copies their *working-tree* content, so an uncommitted edit to an already-tracked skill file is tested
  without committing (only brand-new files must be `git add`-ed to appear). Because real Cowork installs
  the committed tree, commit before recording the locking cassette — a green on uncommitted edits isn't
  yet a green on what ships.
- **Companion skill: documented `semantic_matches` end to end, with a new recipe.** It walks authoring
  Q&A gate scenarios that install the skill, writing discriminating rubric claims verified against
  ground truth, confirming `skillsInvoked` (a rep where the skill never triggered measures the model's
  own priors, not the skill's guidance), running several reps and reading the per-claim pass profile
  rather than a single all-or-nothing run, and gating a change on the profile diff. Also documents two
  guarantees the harness already provided but hadn't stated: batch `record` writes each cassette
  atomically (same-directory temp file + rename, so an interrupted or OOM-killed batch never leaves a
  partial/corrupt cassette), and each scenario gets full isolation under `--concurrency` (its own egress
  sidecar network and proxy, its own run directory). And documents the actual
  `--allow-domain`/`-email`/`-path` matching semantics: whole-token anchored, but case-sensitive unless
  the pattern's regex carries an `i` flag.

### Internal

- **`schema/run-result.json` is now kept in sync with the `RunResult` type automatically.** A new
  name-level drift test derives the type's field set from `src/types.ts` (TS compiler API) and asserts
  the schema declares exactly those fields, both directions — closing the gap where an added type field
  could ship undeclared in the §12 schema (six such fields — `finalMessage`, `resources`,
  `contextEvents`, `mcpErrors`, `hookEvents`, `presentedFiles` — were backfilled). Complements the
  existing value-shape validation; the hand-authored descriptions/shapes are preserved (no fragile full
  regenerator).
- **Answer-quality regression gate** for the project's own companion skill — one tool
  (`scripts/eval-gate.ts`; `test/evals/`, not shipped as part of the skill; live, not in `npm run ci`).
  `--rebaseline` records a per-claim pass-rate baseline; `--calibrate` tags which claims the skill actually
  drives via skill-ablation (a claim that still passes without the skill is excluded from the gate); the
  default run gates a candidate skill edit with a one-sided Fisher-exact test per discriminating claim
  (α=0.05) plus a trigger-rate check. The baseline records the judge + answerer models it was captured
  under, and the gate refuses to diff across a model change (which would report model drift as a skill
  regression). Replaces an earlier per-claim diff + baseline-profile aggregator that never composed.
- **Reflective skill-critique loop** (`scripts/skill-critique.ts`; a maintainer discovery instrument,
  not shipped with the skill, never in CI) — runs a skill against a probe, resumes the session for the
  agent's own subjective account, then has a separate, log-grounded two-pass evaluator classify each idea
  against turn-1-only evidence (`grounded-and-actionable` / `already-covered` / `confabulated` /
  `not-adjudicable`) with mechanically-validated verbatim citations. Emits triaged, human-adjudicated
  recommendations; it never edits the skill and always exits 0.

- **Programmatic multi-turn (`cowork.skill(folder).conversation([...])`)** — feed N user turns to one
  persisted session and get a `Result` per turn: turn 1 pins `--session-id`, later turns add `--resume`
  so the agent reloads the conversation. Makes the natural "ask → inspect → follow-up" loop
  (self-report, iterative probing) a single first-class call instead of hand-stitched session/resume
  calls. Backed by a new **container-tier `--resume` continuity integration test** that proves the agent
  session actually survives the container boundary (a fresh turn-2 container recalls a fact established
  in turn 1) — the plumbing was argv-tested but never proven end-to-end before.
- **`--ablate-skill`** (on `run` / `skill`) — run the same prompt with the skill(s)-under-test removed:
  a deterministic negative control for skill-lift measurement (with-skill vs. without). All plugin/skill
  discovery is stripped so nothing mounts and the agent answers from its own priors; model/folders/egress
  are preserved. The result is stamped `RunResult.ablated: true` so a consumer never reads an ablated run
  as a real (with-skill) pass. Pairs with the `semantic_matches` per-claim profile to quantify how much a
  claim depends on the skill vs. the model's priors.
- **`prune --pinned-older-than <N>d|h|m`** — opt-in reclaim for pinned (`--session-id`) run dirs, which
  are otherwise retained unconditionally. A programmatic consumer that mints one pinned session per run
  (e.g. one per eval × rep) previously leaked them forever with no policy; this reclaims pinned sessions
  whose last activity is older than the window, while fresh ones survive. Nothing pinned is touched
  without the flag; `--dry-run` previews.

### Removed

- **`trace`'s legacy `--tools` / `--gates` / `--dispatches` flag aliases.** Use `--view tools` /
  `--view questions` / `--view dispatches` instead (the canonical form since the view set grew to seven
  views). The retired spellings now fail loud as an unknown flag (exit 2) rather than silently
  selecting a view, so a stale script surfaces immediately instead of tracing the wrong thing. Exit-code
  semantics (0/1/2/3/127) and the `--output-format json` envelope are unchanged. The shipped Python
  wrapper's `cowork.trace(..., tools=True)` now drives `--view tools` and keeps its signature.

### Changed

- **Synced the platform baseline to Claude Desktop 1.18286.2** (`baselines/desktop-1.18286.2.json`).
  The staged agent ELF moved to **2.1.202** (measured sha256 recorded). `sync` re-derived the volatile
  facts: the full spawn contract (env, mounts, egress, gates) is **byte-identical** to `1.18286.0` — only
  `appVersion`/`agentVersion`/`agentBinary`/`asarFingerprint` moved, no unknown deltas.

## [0.27.0] — 2026-07-07

An observability pass: `RunResult` now surfaces per-tool timing, error/redundancy rollups, model
attribution and spend, sub-agent and skill-level detail, context/progress/workspace panels,
in-place mutation detection, hook/MCP/egress/crash diagnostics, and sandbox resource usage — plus a
`chat` session now leaves the same trail (`result.json`, trace, run-index row) as a scripted run.

> **Upgrade notes.**
> - **`RunResult.subagents[].toolsUsed` changed from `string[]` to `Array<{ name, count }>`.** A
>   consumer reading a sub-agent's tool usage directly off `result.json` must update — the field now
>   carries per-tool call counts instead of a bare list of names.
> - **`RunResult.artifacts` is now a derived view of `workspaceFiles`.** Same shape
>   (`{ path, bytes }[]`), so no consumer action is needed unless you were relying on it being stored
>   independently.

### Added

- **Per-tool durations and per-message model attribution.** `RunResult.toolDurations` (per-tool call
  count / total ms / max ms) and `RunResult.models` (distinct model ids seen, first-seen order). New
  `trace --view tool-durations`.
- **Tool-error rollup, redundant-call detection, reasoning capture, and per-model usage.**
  `RunResult.toolErrors` (per-tool call/error counts), `RunResult.redundantToolCalls` (repeated
  identical `{name, args}` calls), `RunResult.thinking` (capped reasoning blocks), and
  `RunResult.modelUsage` (per-model tokens/cost/cache, denormalized from the SDK result). New
  assertions `tool_no_error`, `max_tool_errors`, `max_redundant_tool_calls`. New
  `stats --metric cache-tokens|model-cost` and a cache-ratio footer on `trace`.
- **Sub-agent enrichment.** `RunResult.subagents[]` entries gain `prompt`, `model`, `output`, and
  `attributedSkillId`. `trace --view dispatches` now prints each node's prompt/output/model. New
  assertion `subagent_output_contains`.
- **Skill-to-tool-call attribution.** `RunResult.skillActivity[]` — per-skill-activation-window tool
  tallies and durations. New assertion `skill_tool_used`.
- **Context, progress, and working-folder panels.** `RunResult.context` (the init manifest's `tools`,
  `mcpServers`, `availableSkills`), `RunResult.tasks[]` (from the agent's TaskCreate/TaskUpdate calls),
  and `RunResult.workspaceFiles[]` (every user-visible file, classified `output` | `mount` | `input`,
  with `bytes` and `sha256`). New assertions `all_tasks_completed`, `task_status`, `skill_available`,
  `connector_available`, `tool_available`.
- **`input_unmodified` assertion** — an in-place mutation detector backed by a new
  `RunResult.preRunHashes` (per-path sha256 of the pre-run tree, size-capped): every pre-existing file
  matching a glob must keep an unchanged content hash after the run. Complements
  `no_unexpected_files`, which only sees newly created files.
- **Hooks, MCP, egress, uncaught context events, and crash diagnostics.** `RunResult.hookEvents`
  (PreToolUse fire/block), `RunResult.mcpErrors` (failed MCP round-trips), `RunResult.contextEvents`
  (uncaught system events, including compaction boundaries); richer per-request egress detail
  (method/path/port/bytes plus deny reason and timestamps); a finer-grained `RunResult.errorSource`
  (spawn/protocol/exit/agent/result) and `RunResult.stderrLogPath`; the denied tool input is now
  recorded in `decisions[].detail`. New assertions `hook_blocked`, `no_hook_blocked`,
  `no_mcp_error`, `compaction_occurred`.
- **Sandbox resource-usage telemetry.** `RunResult.resources` (peak RSS, avg/peak CPU%) sampled while
  the run executes on every live tier (container/hostloop/microvm); sample interval tunable via
  `COWORK_HARNESS_RESOURCE_INTERVAL_MS`. New live-only assertion `max_peak_rss_bytes`.
- **`chat` sessions now write `result.json`, a trace, and a run-index row** (tagged `mode: "chat"`,
  no verdict), so an interactive exploration is visible to `stats`, `trace`, and `scaffold` the same
  way a scripted run is.

The timing/resource/model fields above are informational — they never affect a scenario's pass/fail
verdict on their own. `no_mcp_error` and `max_peak_rss_bytes` are live-only and excluded on replay;
`hook_blocked`/`no_hook_blocked` need a `controlOut` cassette on replay; `input_unmodified` needs the
pre-run hash manifest (container/hostloop — not captured on microvm). All new assertion keys are
additive: existing cassettes keep replaying with no cassette-version bump.

- **Legible terminal-error reasons.** A failed run no longer reads as a bare `error`. `RunResult` (and,
  new, `status.json`) now carry `errorSource` — extended with `no_result` (the stream ended with no
  terminal event, i.e. turn/time exhaustion) and `timeout` — plus `resultSubtype` (the SDK result
  subtype verbatim, e.g. `error_max_turns`) and `stderrLogPath`. The CLI failure line names the reason
  (`✗ error (error_max_turns)`, `✗ error (no_result)`, …). Diagnostic only — not read by the verdict.
- **Turn and wall-clock budgets.** Session `agent_max_turns` raises the agent's turn ceiling via the
  agent's own `--max-turns` (omitted by default → faithful to interactive Cowork, which passes none);
  scenario `timeout_ms` (or `skill --timeout <ms>`) sets a wall-clock budget — on expiry the harness
  kills the agent and the run ends `result:error` / `errorSource:timeout`. Both are distinct from the
  `max_turns` *assertion* (a post-hoc upper-bound check).
- **`verify-cassettes` now catches scenario prompt drift.** A committed scenario whose `prompt` diverged
  from the cassette's frozen prompt (invisible to the skill/baseline fingerprint) is a hard fail, in its
  own `scenarioDrift` envelope bucket; an unresolvable/unparseable source degrades to a non-failing note.
  Opt out with `--skip-scenario-drift`. `replay` surfaces the same drift as a non-failing notice.
- **`present_files` delivery is now served and observable on the container tier.** A new `cowork`
  sdk-MCP server promotes a scratchpad file to `mnt/outputs` on `present_files` (with realpath/symlink
  containment on the host-local copy), then injects a synthetic `notifySession` user turn so a
  multi-turn skill learns the promoted path instead of continuing to write to the stale scratchpad one.
  New `RunResult.presentedFiles` (one entry per presented file, classified `promoted` / `leaked` /
  passthrough) and the `no_scratchpad_leak` assertion, both content-class (re-derived from the ordinary
  `tool_use`/`tool_result` stream, so they replay identically). **Container tier only** — hostloop and
  microvm don't serve `present_files`, so a scratchpad-delivered file on those tiers is neither promoted
  nor detected; use `fidelity: container` for `present_files`-based delivery.
- **`RunResult.decisions[].questions`** — the full `AskUserQuestion` option set (label + description per
  offered option, plus `header`/`multiSelect`) as originally offered by the model, additive alongside
  the existing `detail` (flat chosen-answer) field.
- **Structured `WebSearch` capture.** `RunResult.webSearches` now carries the query and per-result
  `{title, url}` pairs, parsed from the paired tool_result's link listing, instead of being dropped as
  unrecoverable. Collapses to `undefined` (matching `models`/`thinking`/`tasks`) when the run made zero
  `WebSearch` calls — cross-reference `toolCounts.WebSearch` if a zero-calls vs. all-parses-failed
  distinction ever matters.
- **`RunResult.thinkingElided`** — count of reasoning blocks dropped past the 50-block cap on
  `thinking[]`, so a consumer can tell "this is everything" from "this is the tail of a much longer
  chain." `0` whenever `thinking[]` exists at all (a meaningful "never hit the cap" signal); `undefined`
  only on lanes where no run/record ever existed.

### Fixed

- **A non-interactive `chat` session (piped/redirected stdin) no longer crashes with a readline error
  before writing its result.** It now exits cleanly and still writes `result.json`.
- **`record` no longer prints a spurious `cassette stale: skill dirs not resolvable` warning on every
  redacted recording.** The redaction verdict-preservation self-check replayed the cassette without its
  directory, so the relocatable (relative) session path couldn't resolve and the skill-staleness check
  always reported "can't verify". It now threads the cassette dir through, exactly as `verify-cassettes`
  does — the warning fires only on genuine drift.
- **A `context:fork` skill's (or explicit `Agent(subagent_type:"fork")`) inner tool calls now count as
  main-agent work.** They carry `parentToolUseId` = the `Skill` call's id, but the `Skill` call was never
  a registered sub-agent dispatch, so they were silently dropped from `toolCounts`, `toolsCalled`,
  `toolErrors`, and `redundantToolCalls`. A fork inherits the main agent's context, so its tools are the
  run's own work; real (non-fork) sub-agent dispatches are unaffected — their inner tools stay isolated
  in `subagents[].toolsUsed` exactly as before.

### Changed — verification is now strict-by-default ("can't verify / incomplete is not green")

A hardening pass over the false-green surface. Several assertions and lanes that previously passed on
missing, malformed, or incomplete evidence now fail. This can flip a currently-green run to red — see
the upgrade notes below.

- **Missing/malformed telemetry fails "cannot verify"** instead of passing silently. Task tracking,
  `present_files`, `WebSearch` parse, and resource samples now record error counters
  (`RunResult.evidenceErrors`, and `resources.malformedLines`) that make the dependent assertion fail
  malformed rather than dropping the bad data; an unreadable workspace file records `hashError` instead
  of an empty hash.
- **Presence-required assertions.** `tool_no_error`, `all_tasks_completed`, and `computer_links_resolve`
  now require at least one matching element (a regex that matched nothing, zero tasks, or zero links
  fails, so a typo can't pass vacuously). New opt-in siblings preserve the lenient behavior:
  `tool_no_error_if_called`, `task_count_min`, `computer_links_resolve_if_present`.
- **`no_scratchpad_leak` is gated to the container tier** (the only tier that serves `present_files`);
  on any other tier it is evidence-unavailable, never a vacuous pass.
- **Verdict modifiers (`allow_*`) are `true`-only** — `allow_x: false` is now a schema error (it
  suppressed nothing but read as intentional). **`artifact_json` requires a non-empty `artifact`** and
  rejects an explicit empty `path`. **A typo'd `requires_capabilities` family hard-fails** as an
  authoring error instead of being silently ignored.
- **Incomplete batches fail by default.** A truncated `--matrix` and a budget-stopped `--repeat` now
  fail unless you pass `--allow-truncated-matrix` / `--allow-budget-stop`.
- **Strict replay.** A cassette from a NEWER format version fails unless `--best-effort-future-cassette`;
  an unrecognized/malformed assertion in a current-or-older cassette is rejected (it would otherwise
  drop silently from replay); the assertion schema rejects unknown keys at scenario parse too.
  `verify-cassettes` hard-fails **all** recording-shaping drift (baseline, fidelity, answers, skills,
  capabilities — not just prompt) when the persisted source resolves exactly.
- **`record --rerecord-stale` refuses the embedded-snapshot fallback** when no on-disk source resolves
  (it would silently drop scenario edits) — pass `--from-embedded` to opt in; `record` also refuses to
  overwrite a default-path cassette belonging to a different scenario (slug collision) unless `--force`.
- **Infrastructure errors (egress/VM sidecar crashes) are a hard verdict fail on both lanes** and are
  not author-suppressible — the run's evidence is contaminated.

> **Upgrade notes (verification strictness).**
> - Scenarios relying on any vacuous pass above will now fail; add the matching element, adopt the
>   `*_if_present`/`task_count_min` sibling, or pass the relevant opt-in flag.
> - **Cassette format v9.** New cassettes carry a session fingerprint and a persisted record-time folder
>   map, so replay resolves host-shaped `computer://` links against the recorded correspondence rather
>   than re-reading the current session. Existing v8-and-earlier cassettes keep replaying unchanged
>   (backward-compatible); re-record to adopt the new staleness checks.
> - `verify-cassettes`, `record --dry-run`, and `rehash` now emit the standard `{tool, version, ok,
>   error}` JSON envelope under `--output-format json`.
> - `verify-run` now treats `input_unmodified` as filesystem-bound (refuses "can't verify" when the work
>   dir is gone, instead of a spurious removed-file failure).

The additive pieces: new assertions `tool_no_error_if_called`, `computer_links_resolve_if_present`,
`task_count_min`; flags `--allow-truncated-matrix`, `--allow-budget-stop`, `--best-effort-future-cassette`,
`--from-embedded`, `--force`; `RunResult.infraErrors` and `RunResult.evidenceErrors`.

The corrections: `present_files` restricts mount presentation to the real Cowork root allowlist
(`outputs`/`uploads`/`.host-home`/`.auto-memory`/connected folders) instead of any `mnt/` path (binary-
verified); egress host-matching strips IPv6 brackets and supports `*.` wildcards in assertions, without
IDNA-folding allowlist entries (matching the sandbox proxy); resource sampling takes an immediate first
sample (short runs are no longer unmeasured) and warns on an invalid interval env var; the egress sidecar
no longer builds `dist/` at runtime and surfaces a fatal proxy error; `--run-dir ~/x` and session
`~user` paths expand correctly; a non-array `present_files` argument returns a structured MCP error
instead of throwing; output deletions via a script/non-bash tool are caught by a filesystem pre/post
diff; and a read-only connected-folder file changed mid-run is attributed as external mutation rather
than an agent violation.

## [0.26.0] — 2026-07-05

Cassette/run-result **format-freeze** pass before 1.0 — fixes the parts of these schemas that become
irreversible once 1.0's semver contract freezes them.

> **Upgrade notes.**
> - **Staleness-hash framing changed → `cassetteVersion` 8.** A pre-v8 cassette's staleness fingerprint
>   is non-comparable with v8, so `verify-cassettes`/`rehash` route a pre-v8 cassette to **re-record**
>   with an honest "algorithm changed" message (not a misleading "content changed"). Re-record your
>   committed cassettes. (Cassettes without a `skillHash` are unaffected and keep replaying.)
> - **`RunResult.unanswered` renamed to `nonReproducibleAnswers`.** Consumers reading
>   `result.unanswered` must switch to `result.nonReproducibleAnswers` (the field never held literally
>   unanswered gates — it holds gates answered by a non-reproducible source).
> - **Cassette-level `readonlyFolderRoots` removed** in favor of per-entry
>   `ManifestEntry.truncationReason`. No consumer action unless you parsed the cassette directly.

### Fixed

- **Two staleness-hash framing collisions (a false-negative — the risk the gate exists to prevent).**
  `skillHash` folded raw file content after a `F:<path>\0` marker, so a file whose content embedded that
  marker could hash identically to a two-file tree; it now folds the fixed-length content SHA
  (self-delimiting, charset disjoint from the `F:`/`L:` prefixes). `contentSig` lacked a type marker and
  used `:` between path and sha, so a file named `a:lnk` could collide with a symlink `a`; entries are now
  type-prefixed (`F:`/`L:`) and NUL-framed, and the `L:` link line NUL-separates path from target. Only
  fixable before the hash algorithm freezes at 1.0.

### Changed

- **Cassette format v7 → v8** (`CONTENTSIG_ALGO` 3 → 4). See the framing fix above and the upgrade note.
- **`RunResult.unanswered` → `nonReproducibleAnswers`** — a self-admitted misnomer in the frozen
  run-result envelope, renamed before the 1.0 freeze.
- **Body-less manifest entries now carry `ManifestEntry.truncationReason`** (`size` | `readonly` |
  `unreadable`) instead of a cassette-level `readonlyFolderRoots` list — self-describing and
  redaction-immune. Replay reads the reason to give `artifact_json` the precise remedy on every lane
  (assert on a deliverable vs. raise `--max-artifact-bytes`).
- **`schema/run-result.json` completed** (added `fingerprint`, `userVisibleRoots`, `readonlyFolderRoots`,
  `preRunPaths`, `toolResults`) and now strict-validated by a test, and the `cassette.v8.json`
  `ManifestEntry` shape is fully described — so the schemas frozen at 1.0 match what ships. Corrected the
  git-mode-default documentation (git is the default unless `COWORK_HARNESS_GITSET=0`).

## [0.25.0] — 2026-07-05

> **Upgrade notes.**
> - **`verify-cassettes --allow-file` was renamed to `--allow-patterns-file`** and the old spelling is
>   removed (exits 2). Update any CI step or allowlist wiring that passed `--allow-file`.
> - **`gate_answers_delivered: true` now passes vacuously when zero gates fired.** If you relied on it
>   as an implicit "a gate must fire" check, add `gate_answer_count_min: 1` alongside it.
> - **Read-only (`mode: r`) connected-folder inputs are now captured body-less.** Re-record affected
>   cassettes to drop the `--allow` entries they previously required and shrink them; an `artifact_json`
>   assertion pointed at a read-only input now reports evidence-unavailable (assert on a deliverable).
>   This changes committed cassette *contents* (not the staleness hash) — a re-record is cosmetic, not
>   required for correctness.

### Added

- **`gate_answer_count_min: <N>` assertion** — the presence companion to `gate_answers_delivered`:
  fails unless at least N `AskUserQuestion` gates fired AND were delivered non-error. Pairs with
  `gate_answers_delivered`'s new zero-gate vacuous-pass (below) the way `transcript_contains` pairs
  with `computer_links_resolve`'s zero-link vacuous-pass. Evaluated on replay only with a `controlOut`
  cassette, like the other gate keys; fails as evidence-unavailable (not vacuous-pass) when
  gate-delivery telemetry is absent from `result.json`.

### Changed

- **`gate_answers_delivered: true` now passes vacuously when zero `AskUserQuestion` gates fired**,
  instead of hard-failing. Whether a gate fires is model-dependent, so any skill with optional gating
  could not use the assertion under the old hard-fail. The bad-delivery check (an answered gate whose
  answer wasn't confirmed delivered) is unchanged — it only ever mattered when gates fired. Missing
  gate-delivery telemetry (an old/partial `result.json` on the verify-run lane) still fails loud as
  evidence-unavailable, never vacuous-pass — this is NOT the same as "no gate fired" and preserves the
  bug-#33 false-green fix. Pair with the new `gate_answer_count_min` (below) to also require presence.
- **`verify-cassettes --allow-file <path>` renamed to `--allow-patterns-file <path>`.** The old name
  read as "allow this file" and was routinely confused with `--allow <regex>` (a pattern matched
  against a finding) — reaching for `--allow-file <artifact-path>` failed with an ENOENT/invalid-regex
  error instead of doing what the user meant. `--allow-patterns-file <path>` is self-documenting: the
  path names a **file of patterns** (one regex per line), not a path to allow. Pre-1.0 rename with **no
  deprecation window** — the old `--allow-file` spelling is hard-removed and now exits 2 with an
  unknown-flag error. The binary-finding recourse message and both `--help` texts now spell out the
  distinction between the two flags.

### Fixed

- **Read-only (`mode: r`) connected-folder inputs are captured body-less (path + hash) instead of as
  full binary bodies.** `record` used to sweep a `mode: r` folder's files into the cassette
  `artifacts[]` as full base64 bodies — an input the agent only reads, not a deliverable — causing
  cassette bloat and a hard `binary` privacy finding that forced `--allow`. The manifest entry now
  carries `path` + `bytes` + `sha256` with `truncated: true` and no `body`, reusing the same
  representation the 64-KiB inline cap already produces. The entry still survives in the manifest (it
  is NOT excluded), so `computer_links_resolve`/`file_exists` resolve identically on live and replay.
  `artifact_json` against a body-less target (a read-only input, or any artifact over the body cap)
  reports a clear **evidence-unavailable** on every lane — live, verify-run, and replay all agree, so
  a cassette can't record green and replay red. The cassette persists the read-only-folder set
  (`readonlyFolderRoots`, a subset of `userVisibleRoots`), so replay knows *why* an entry is body-less
  and gives the **precise** remedy — "assert on a deliverable" for a read-only input, "raise
  `--max-artifact-bytes`" for an over-cap artifact — instead of a cryptic JSON parse error or a
  guessed hint. A `mode: rw`/`rwd` folder's contents are unaffected and keep their full body.
- **`trace --view questions` and the `scaffold` helper disagreed with `questions_count_max` on what
  "a question" counts.** The assertion counts **sub-questions** (one `AskUserQuestion` bundling K
  sub-questions counts as K — the better spam/burden budget, since per-tool-call counting would miss
  a 10-in-1 bundle), but `trace --view questions` collapsed a bundle into one row with no count, and
  the scaffold helper emitted `questions_count_max: <gate count>` — a budget that could start BELOW
  what the assertion computes and false-red on the first real run. No behavior change to the
  assertion itself: `trace --view questions` now annotates each gate row with its sub-question count
  and prints a footer total (`N gate(s), M sub-question(s) total`) that matches what
  `questions_count_max` compares against. The static `scaffold` helper can't know the sub-question
  count offline, so instead of fabricating a value it now emits `questions_count_max` **commented
  out** as a calibration TODO pointing at `trace --view questions` (a budget must come from
  observation, not a guess — a fabricated one either false-reds or is a dead tripwire). The count
  definition is now documented in `docs/scenario.md`, `docs/cassette.md`, `SPEC.md`, and the skill's
  `references/scenario-schema.md` / `SKILL.md` gotcha list.

## [0.24.0] — 2026-07-05

### Added

- **`no_unexpected_files` assertion** — per-scenario glob allowlist over **newly created** files under the
  user-visible roots (workRoot-relative paths; `**` matches any depth). Post-hoc stray-file / fabricated-
  artifact detection for the founder-skills hand-off contract (consumer ask, 2026-07-04); pairs with their
  script-side `_produced_by` / `UNVALIDATED_ARTIFACT` check for overwrite-in-place bypasses this key cannot
  see. Records a pre-run path baseline (`preRunPaths` on the cassette + `pre-run-manifest.json` on kept runs;
  optional field, no cassetteVersion bump). **Live/verify-run** without a baseline ⇒ evidence-unavailable
  hard-fail; **replay** without `preRunPaths` ⇒ loud exclude (pre-0.24 cassettes). **Microvm** does not
  capture (existing artifact-tree gap) — use container/hostloop. Live runs capture the baseline when the
  scenario asserts the key; recordings always capture it, so a later assert-add replays without re-record.

- **Two new documented fidelity gaps: guest runtime identity and session-slug shape.**
  Runtime forensics over a local install's Cowork VM disk images (coworkd's own logs) established
  that production provisions a **dedicated Unix user per session** inside the VM (`useradd`,
  name = session slug, uid=gid sequential ≥1014, `HOME=/sessions/<slug>`) and spawns the agent and
  every bash call as that user via `oneshot-<uuid>` supervisor jobs — where the harness's
  container/microvm tiers run static uid-1000 `ubuntu` with `HOME=/tmp`. Production's in-VM slugs
  are Docker-style name triples (`beautiful-bold-planck`), not the harness's `local_<hrtime36>`;
  the `local_<uuid>` shape exists in production only as Desktop's host-side session-record
  filenames. Both are recorded in `docs/fidelity-gaps.md` with observable consequences (`whoami`,
  `id -u`, `~`-relative writes, cwd shape); the `Dockerfile.agent` uid-1000 comment no longer
  claims runtime parity. Initial lead credit: the founder-skills project's journald forensics,
  independently re-verified here against this machine's own VM images before documenting.

- **The `verify-cassettes` JSON envelope is now a published, 1.0-covered contract surface.**
  SPEC §12's covered list previously named the RunResult envelope but was silent on §11.1's
  `verify-cassettes` envelope — even though the CI recipe and the packaged GitHub Action steer
  consumers to parse exactly that output, and an uncovered machine-output shape can rot a consumer's
  `jq` gate silently (a renamed key yields `null`, and the gate stops gating). The envelope is now:
  listed in §12 (rename/removal = MAJOR; additive growth stays MINOR), published as
  `schema/verify-cassettes.json` in the npm package, and pinned by
  `test/verify-envelope-schema.test.ts`, which validates real CLI output against the schema in both
  directions (a required key the CLI stops emitting fails, and — via a strictened copy — a key the
  CLI starts emitting without a schema update also fails). Writing the schema immediately caught one
  doc drift: the per-file `version[]` channel (newer-harness cassette → hard fail) was emitted but
  missing from §11.1's envelope block; the SPEC block, `ok` formula, and exit-code line now include it.

- **Skill-effectiveness workstream.** Three deliverables, all targeting the same failure mode
  observed in real skill adoption: the facts existed across the docs, but nothing composed them
  into the task a scenario author actually faces:
  - **`references/task-recipes.md`** — four end-to-end recipes that consumers previously had to
    reverse-engineer from scattered reference docs: evolve a cassette's `assert:` block (usually token-free via
    `replay --assert-from`; the recording-shaping-drift caveat spelled out), audit a fleet for tier
    drift (`effectiveFidelity` + the new `resolved-tier`/`unverifiable-tier` classes + a cassette
    anatomy table), set up redaction before the first hostloop/protocol record (`init-redact`,
    search set, scanner relationship, `--allow-*` scoping idioms), and derive budget assertions
    from an existing run instead of a two-pass record.
  - **Four new eval cases** (`evals/evals.json` 5 → 9, ids 6–9), each a question a real consumer
    hit, passing iff the agent reaches the cheap path: assert evolution without a
    fleet re-record, reading a cassette's recorded tier (with a fixture cassette via `files[]`),
    the exact `--allow-file` format (and its all-class scope trade-off), and batch `record`
    atomicity semantics.
  - **Doc-drift tripwire** (`test/skill-docs-sync.test.ts`), scoped to the kinds of drift that
    actually happened (NOT a naive new-CLI-flag gate, which would have caught neither motivating
    example): extends the `cassette-docs-sync` pattern to pin the skill's assertion catalog against
    `schema/scenario.schema.json` and the skill docs against the current cassette schema's
    top-level field list. Plus a CONTRIBUTING checklist line for consumer-visible workflow changes.

### Fixed

- **Gate `1648655587` was mislabeled as a Task-dispatch cap; it is the scheduled-task session
  limiter.** A binary-verified forensic pass (asar 1.18286.0, `class L9t "[ScheduledTasks]"`) plus one
  adversarial-review round established that gate `1648655587` (`{perTask:1, global:3}`) governs
  Cowork's **scheduled/recurring (cron) task** session scheduler — ≤1 concurrent session per
  scheduled task, ≤3 concurrent scheduled-task sessions globally — **not** the in-conversation
  `Task` tool. The Desktop imposes **no** cap on `Task`-tool sub-agent fan-out at all (the `Task`
  PreToolUse hook only blocks `run_in_background`). SPEC §10, `docs/fidelity-gaps.md`,
  `docs/scenario.md`, the skill (SKILL.md gotcha 6 + `references/scenario-schema.md`), the
  1.18286.0 baseline gate note, and `dispatch_count_max`'s failure message are all corrected;
  `dispatch_count_max` is now described as an author-chosen budget assertion, not enforcement of a
  (non-existent) production Task cap. The `PINNED_GATES` rename
  (`taskDispatchLimiter → scheduledTaskSessionLimiter`) also landed, regenerated through `sync`
  against the same Desktop 1.18286.0 install (never hand-edited): the 1.18286.0 baseline now
  carries the corrected gate key, older baselines keep the historical label, and the sync
  gate-merge now matches previous entries by gate **id** (not exact `name:id` key) so a rename
  carries the note/state across and can't resurrect the old key as a stale duplicate. This
  supersedes the earlier "faithful Task-dispatch runtime limiter is planned" language — there is
  no production behavior to mirror.

- **`schema/cassette.v7.json` was missing `userVisibleRoots` and `scenarioSource`** — both fields
  are written by `record` (since format v4 / 0.8.0 and 0.20.0 respectively); `userVisibleRoots` was
  even named in the schema's prose `description` while absent from `properties`. Found by the new
  skill-docs tripwire while pinning the field list.

- **Redaction preflight + `init-redact`.**
  `record` now warns (`::warning::`) **before the agent spawns** when a scenario about to record at a
  host-path-bearing tier (`hostloop`, or `protocol`) has an EMPTY assembled redaction policy — that
  combination commits real host paths, which `verify-cassettes`' `path` scanner then hard-fails; the
  empty-policy discovery used to happen only at the post-run policy load, after the run was paid for.
  Batch `record <dir>` and `--rerecord-stale` preflight ONCE for the whole batch, before the first
  spawn (never N interleaved duplicates). A malformed `.cowork-redact.json` now also fails pre-spawn.
  The reference `.cowork-redact.json` (generic local-path prefixes + email regex) now ships in the npm
  package, and the new `cowork-harness init-redact [--force]` copies it into the cwd — the copy is
  load-bearing, since the policy search set (now documented in `docs/cassette.md` and the skill's
  ci-recipe) is cwd → scenario dir → cassette dir (+ `COWORK_HARNESS_REDACT_*` env), never the package
  dir. The always-on privacy scanner remains the universal net — container-tier recordings can trip it
  too.

- **Lint catches fidelity/assert combinations that fail by design.**
  `scenario.py lint` (and the `cowork-harness lint` wrapper) now ERRORs on
  `transcript_no_host_path` + `fidelity: hostloop` or `protocol` (the agent legitimately runs on real
  host paths at those tiers — the assertion can never be a meaningful check there; lint is
  deliberately stricter than the runtime's run-start warning), WARNs on `transcript_no_host_path` +
  `fidelity: cowork` naming the host-loop gate-resolution dependency (the linter stays offline — the
  message carries gate id `1143815894` instead of reading a baseline, pinned against the
  `cowork-sync.ts` gate table by a sync test so a Desktop re-key can't rot it), and ERRORs on
  non-empty `requires_capabilities` + `fidelity: protocol` without `allow_missing_capability` (the
  capability probe can't run at protocol tier, so the run hard-fails as unverifiable).

- **Resolved-tier staleness detection.** A
  `fidelity: cowork` cassette records the tier the loop-decision gate resolved to
  (`effectiveFidelity`); `verify-cassettes` / `replay` now detect when the current baseline resolves
  that scenario differently (gate `1143815894` flipped since record) and emit a new `resolved-tier`
  staleness finding — the recording exercises the wrong tier. Resolution is baseline-only (the
  scenario's pinned `baseline:` when present, else `latest`; the `CLAUDE_FORCE_HOST_LOOP` env override
  is suppressed) so verify results can't differ across machines. A `cowork` cassette whose tier can't
  be verified (predates `effectiveFidelity`, or its pinned baseline fails to load) gets a loud
  `unverifiable-tier` finding — never a silent skip, never an aborted sweep. Both classes hard-fail
  `verify-cassettes` (class-blind gate) and warn-by-default on `replay` (`--strict` escalates;
  `--fail-on-skill-drift` ignores them — they are not skill-source drift). A pre-`effectiveFidelity`
  cassette with an *explicit* tier is statically knowable: it passes with a non-failing informational
  note in the new per-file `notes[]` of the `verify-cassettes` envelope (a `·` row in text output).
  `schema/run-result.json` now also declares `staleness` (full class enum) and `skippedAssertions`,
  closing a pre-existing gap vs SPEC §11.

## [0.23.0] — 2026-07-04

### Added

- **The baseline `spawn.env` is now binary-derived and drift-alarmed, not hand-transcribed.** `sync`
  enumerates the Desktop→agent spawn env directly from the `app.asar` construction (three windows +
  gate/const value resolution) and writes the resolved map into the baseline, guarded by a
  `checkSpawnContractFacts` sentinel over the scalar options/tools/prompt structure. Additions,
  removals, and value changes in the spawn contract now surface as loud `sync`-time signals instead of
  drifting silently. This closed real, already-present drift: seven env keys the production agent
  receives (`MCP_TOOL_TIMEOUT`, `API_TIMEOUT_MS`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`,
  `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`, `USE_STAGING_OAUTH`, `USE_LOCAL_OAUTH`)
  were missing from the committed baseline and are now pinned. A hand-transcribed golden fixture
  cross-checks the generator so a resolver bug can't silently rewrite the contract.
- **`sync` surfaces stale-allowlist prune hints instead of discarding them.** When a
  `SPAWN_ENV_ALLOWLIST` entry is no longer constructed anywhere in the asar, `partitionSpawnFlags`
  routes it into `SyncResult.notes` (distinct from the hard-fail deltas above) and the CLI prints it
  under a non-blocking `notes (non-blocking):` line — a prune candidate to review, not a drift alarm.
- **TUI forward-compatibility set** (three items hardening the display seam for future frontends):
  - **The display-policy seam is now an explicit contract.** `src/run/display-translate.ts`'s header
    states it is the single policy seam for translating model-visible VM paths for human display
    (hostloop-only / identity-without-ctx / identity-when-shareable), locked by a 20-row table-driven
    contract test; `docs/debugging.md` explains why hostloop shows `/Users/…` while other tiers show
    `/sessions/…`.
  - **Per-run `mounts.json`.** Every run dir now records the VM-path context (`{v:1, sessionId,
    effectiveFidelity, outputsHostDir, uploadsHostDir, folders}`) — best-effort, never load-bearing,
    derived from the same call that feeds the live display translator. `loadVmPathContext` lets any
    historical-run consumer rebuild the context (null → degrade to identity). First consumer:
    `trace --translate-paths` (text output only) renders hostloop runs with host paths, threaded into
    row construction pre-slice. Cassettes structurally cannot carry the file.
  - **OSC 8 terminal hyperlinks.** On a real TTY (not CI, not `--compact`/`--demo`, opt-out
    `COWORK_HARNESS_NO_HYPERLINKS=1`), host-shaped `computer://` links in assistant text render as
    clickable `file://` hyperlinks (`normalizeEncodePath`, decode-then-re-encode; backtick code spans
    and VM-shaped links pass through; tool lines are excluded — they truncate at ~80 chars and a
    sliced URL would link to a wrong target). Piped/non-TTY output stays byte-identical.

- **`machine-inventory` cassette privacy scan class.** `verify-cassettes` now flags the sentinel
  phrases a capability-manifest recording leaks ("applications on this machine", "installed
  integrations/apps/extensions", …) — prose mentions of an app never trip it — with a scoped
  `--allow-machine-inventory <regex>` to whitelist provably-synthetic values. The capability-manifest
  filter line is recognized so the manifest itself doesn't false-trip the other classes. Tightening the
  privacy gate before the 1.0 contract freezes keeps it from becoming a breaking change to consumers'
  committed cassettes later.
- **The 1.0 compatibility contract (SPEC.md §12).** Enumerates the surfaces semver covers from `1.0.0` —
  CLI commands/flags + exit codes, the scenario/session/baseline/`RunResult`/cassette(v7)/protocol
  schemas, the documented `COWORK_HARNESS_*` (+ `COWORK_AGENT_BINARY`/`COWORK_AGENT_IMAGE`) env vars, and
  the packaged Action's inputs/outputs — and states what is explicitly NOT covered (human-readable
  terminal text, `trace` row shapes, the paraphrased prompt append). Cross-linked from README and
  RELEASING.md.
- **First committed `hostloop`-tier replay cassette + live two-tier `computer_links_resolve`
  coverage.** `examples/replays/hostloop-computer-links.cassette.json` (from a new purpose-built
  `fidelity: hostloop` scenario) is the first committed cassette at the newest/headline tier — the one
  the token-free replay lane never exercised — and asserts that a `computer://` link the model shares
  resolves to its real collected artifact. Verified live at both `container` (VM-shaped link) and
  `hostloop` (host-shaped link); wired into CI's replay + privacy-scan gates.
- **Host-platform / workspace-host-paths identity env vars.** The spawn env now emits
  `CLAUDE_CODE_HOST_PLATFORM` (`process.platform`, on every tier that assembles the Cowork spawn env —
  container/microvm/hostloop; protocol (L0) spawns with the plain base env) and `CLAUDE_CODE_WORKSPACE_HOST_PATHS`
  (connected-folder host paths, hostloop only when folders are present) — matching what the real Cowork
  spawn sets, binary-verified against the in-VM ELF and Desktop asar. The account-identity and `OTEL_*`
  vars stay unset (they need live Desktop account state the headless harness can't know; documented in
  `docs/fidelity-gaps.md`).
- **Reserved exit code `4` on the `run`/`skill` family** for a future "needs input / surfaced question"
  outcome — documented in SPEC.md so a later addition is additive rather than a renumbering of the
  burned `0`/`1`/`2`/`3` space.

### Removed

- **The `profile:` scenario-field alias.** The top-level `profile:` key (an earlier name for
  `baseline:`) is no longer accepted — it was silently remapped with a deprecation warning; it now
  errors as an unknown key. Use `baseline:`.
- **The deprecated `Profile` re-export (library API).** The `Profile` const/type in `src/types.ts` was
  renamed to `PlatformBaseline` with a "remove next minor" promise that never fired; removed now so the
  1.0 API contract doesn't freeze retired vocabulary in. Import `PlatformBaseline`.
- **The `scaffold --from-run <id>` flag.** `scaffold` had two spellings for one thing; the canonical
  positional `scaffold <run-id | run-dir>` stays, and `--from-run` now errors as an unknown flag
  (exit 2) with the usage string pointing at the positional form.
- **The `-V` short form for `--verbose`.** `-v` (version, per `node -v`/`npm -v`) and `-V` (verbose)
  were a shift-key-typo collision that silently flipped meaning. `--verbose` is now long-only on every
  command that accepts it (`run`/`skill`/`chat`/`decide`/`record`/`replay`/`verify-cassettes`); `-v`
  still prints the version and `-q` still means `--quiet`.
- **The dead `forceDisableHostLoop` loop-decision key.** It was never populated by `sync` and its
  branch could never fire — a config key that silently does nothing is a trap in a 1.0 schema. The
  field and its branch are removed (re-add with real semantics if `sync` ever derives it).

### Changed

- **CI's boundary job now pulls the published GHCR agent image the packaged Action pins**, retagging it
  for the sandbox probes so a bad publish surfaces in our own CI instead of only in a consumer's runner
  (it previously only ever `docker build`t the image locally). A pull failure now hard-fails
  (`::error::` + `exit 1`) on the canonical repo instead of silently rebuilding; forks and pre-publish
  runs (no GHCR read access yet) keep the local-build fallback with a warning. Live-verified on the
  0.23.0 release PR's CI run: `docker pull ghcr.io/yaniv-golan/cowork-agent-base:2` resolved and
  retagged successfully (image name, `linux/arm64` platform, and the default `GITHUB_TOKEN`'s GHCR
  read access are all confirmed working, not just implemented).

### Fixed

- **Redaction could destroy a `computer://` link and manufacture a VACUOUS `computer_links_resolve`
  pass on replay.** The repo's local-path redaction pattern didn't exclude `)` from its character
  class, so it ate a markdown link's closing paren — replay's extractor then saw an unterminated link,
  found zero links, and the presence-gated assertion passed while checking nothing (the first committed
  hostloop cassette shipped exactly this). Three-part fix: the redaction patterns now redact only the
  machine-specific path prefix (stopping before `/mnt/`, so replay's structural-marker resolution still
  works) and exclude link delimiters; `record`'s verdict-preservation guard gained a fourth check that
  compares `computer://` link counts pre/post redaction and refuses to write a cassette whose links
  redaction destroyed; and the hostloop cassette was re-recorded — its replay now extracts and resolves
  the link for real.
- **Scenario-schema violations now surface as category `usage`, not `internal`.** A typo'd or retired
  key (e.g. `profile:`) threw an uncaught Zod error that the top-level catch labeled `internal` — a
  user mistake masquerading as a harness bug. `parseScenarioFile` now wraps schema errors in a
  `UsageError` that names the offending file; exit stays 2.
- **The `protocol-smoke` example no longer fails by design on a live run.** `protocol` (L0) runs the
  agent's file tools on the real host cwd with no sealed filesystem — exactly like `hostloop` — so a
  host path in a tool result is expected there, not a leak. The `host_path_leak` default-fail is now
  exempted at `protocol` as well as `hostloop` (emitting a notice), so the flagship example passes its
  own assertions on every advertised lane. The signal stays a hard fail at the sandboxed
  `container`/`microvm` tiers (where a host path IS a regression), and an explicit
  `transcript_no_host_path` assertion still enforces cleanliness at any tier.
- **The LLM decider prompt no longer travels via `argv`.** `claude -p <prompt>` put the gate/skill
  text in the process's argument vector, world-readable via `ps` on shared hosts. The prompt is now
  delivered on stdin (the same channel the microvm auth-token uses); argv carries only
  `-p --model … --output-format json`. Off-brand for a tool that privacy-scans its own cassettes.
- **Malformed decider env knobs now fail loud instead of silently reverting.**
  `COWORK_HARNESS_LLM_TIMEOUT_MS` / `COWORK_HARNESS_LLM_MAX_BYTES` went through `Number(…) || default`,
  so a typo (`5m`) or an explicit `0` silently became the default. Both now route through
  `envPositiveNumber`, which warns loud on a set-but-unparseable/non-positive value (an unset var still
  uses the same default).
- **The bundled `cowork-harness` skill's CI recipe no longer breaks under bash/zsh.** The recommended
  `npm i -g cowork-harness@>=0.22.0` was unquoted — `>=` is a shell redirection, so the snippet failed
  as written in bash (GitHub Actions' default `run:` shell) and zsh alike. Now quoted at all sites. Same pass corrected the skill's command inventory (`status` was
  missing), a wrong `CLAUDE_PLUGIN_ROOT` scaffold path, missing `requires_capabilities` /
  `extended_thinking` / `account_name` schema docs, stale gotcha citations, a `scenario.py` regex-lint
  false-positive, and thin eval coverage.
- **`doctor --tier microvm` now detects an unprovisioned Lima instance.** It previously checked only
  for `limactl` itself, not whether `vm init` had actually provisioned the instance for the current
  config — a missing VM image could slip past `doctor` and only surface as first-run VM-boot latency
  on the next live `microvm` run (which self-provisions). New `vm-instance` check is advisory (`warn`,
  non-blocking, matching `microvm.ts`'s self-provisioning behavior), skipped when `limactl` itself is
  already the reported problem. Live-verified against a real, unprovisioned Lima install.
- **Top-level `--help` printed an invalid combined flag shorthand.** `--allow-domain/-email/-path
  <regex>` is not something the parser accepts — the three flags are independent and parsed
  separately (`verify-cassettes`'s own usage string already had this right). Fixed to list the three
  flags separately, matching the dedicated usage string.

### Documentation

- **Documented the Task-dispatch cap divergence in `docs/fidelity-gaps.md`.** Real Cowork skips agent
  Task dispatches beyond `{perTask:1, global:3}` (a binary-verified gate); the harness does not cap at
  runtime, mitigated by the `dispatch_count_max` assertion. The faithful runtime limiter is deferred
  post-1.0.
- **Doc-vs-code audit (post-0.22.0) — corrected several doc claims that had drifted from the
  implementation, found by a systematic docs-and-skill sweep.**
  - **Baseline pin staleness.** README, DESIGN.md, SPEC.md, the companion skill's `SKILL.md`, and
    `docs/cowork-spawn-contract-1.12603.1.md` all still pinned `desktop-1.17377.1`/`.2` after the
    platform baseline had moved on to `desktop-1.18286.0`. Reconciled the plain "current baseline"
    pins; deliberately left DESIGN.md's point-in-time verification stamps (§ Control protocol /
    Spawn contract) untouched, since bumping those would assert re-verification work that hasn't
    actually happened. README's "Status" paragraph had the same unresolved tension one section
    down (claiming `1.18286.0` is latest two sentences after a `1.17377.1` verification stamp) —
    added a clarifying parenthetical instead of silently picking one number.
  - **`docs/chat.md` self-contradiction.** Its `--folder` behavior rows named `protocol`/`container`/
    `microvm` in two places despite `chat` never accepting `microvm` (already correctly excluded
    elsewhere in the same file).
  - **`docs/cassette.md`'s assertion table** was missing six replay-evaluated keys (`skill_triggered`,
    `no_skill_triggered`, `max_cost_usd`, `max_tokens`, `tool_calls_max`, `max_turns`) despite already
    documenting all six correctly in `docs/scenario.md`.
  - **`docs/session.md`** never documented the real, live `account_name` session field.
  - **`docs/scenario.md`'s `run --matrix` example** pointed `skill_dirs` at a fabricated
    `../variants/v1/…` path that doesn't exist anywhere in the repo. Repointed the section at the new
    `examples/matrices/csv-metrics-matrix.yaml` fixture (baselines-only axis — this repo has no second
    `csv-metrics` variant to matrix against, so the shipped example omits `skill_dirs` rather than
    inventing fake paths).
  - **`docs/discovery.md`** left the `<proj-slug>` placeholder in its "find the VM session log" path
    unexplained. Documented what it is (Claude Code's own project-slug derivation, opaque to this
    repo) and gave a practical `ls`-based workaround instead of guessing at undocumented CLI internals.
  - **Doc-index and cross-link gaps.** `docs/README.md`'s guide table and `llms.txt`'s command list
    were both missing `stats`/`status`/`diff`; the `decide` reference row cited only `decide --help`
    despite a full worked "dry-running a decider" subsection already existing in `docs/scenario.md`;
    the README architecture diagram had no `hostloop` representation; `docs/maintenance.md`'s
    `sync --diff` example (real but the two oldest baseline files in the repo) wasn't flagged as
    illustrative; and README's `doctor` section read as if bare `doctor` were more general than
    `--tier container`, when bare `doctor` **is** `--tier container` by default.
  - **README command-table / flag-reference gaps.** `--compact`/`--demo` (output trimmed for
    shareable screenshots/GIFs) were undocumented in the `skill`/`run` command-table rows;
    `record`'s row omitted `--no-redact`/`--allow-failing`/`--dry-run`; the reproducibility-knobs
    section omitted `COWORK_HARNESS_VERIFY_AGENT_SHA`; the exit-code summary claimed a uniform
    `0`/`1`/`2`/`3` "on every command" when `diff`/`lint` have documented per-command exceptions
    (SPEC.md already had the accurate table — README's summary now points at it instead of
    overstating); and a note was added near the Prerequisites block that the worked
    `examples/scenarios/...` commands need a source checkout, not a global `npm install -g`.
  - Added **`examples/matrices/csv-metrics-matrix.yaml`**, a worked example for `run --matrix` (no
    prior fixture existed) — live-verified: both baseline cells pass.

### Internal

- **`scripts/check-versions.ts`'s version-lockstep guard now also cross-checks the `(baseline
  desktop-X)` pins** across README/`SKILL.md`/the spawn-contract doc against the newest committed
  `baselines/*.json`, closing the exact class of drift the doc audit above found so it can't silently
  recur. Deliberately excludes DESIGN.md's verification-stamp lines (see above).
  - `alwaysContentKeys`/`questionGateKeys`/`manifestKeys` in `src/run/cassette.ts` are now exported
    (previously function-local); `test/cassette-docs-sync.test.ts` asserts `docs/cassette.md`'s
    assertion table stays in sync with their union.
  - `test/cli-help.test.ts` gained a check that every CLI command appears in README's "Commands at a
    glance" table, on the same "doc can't silently drift from code" principle.
- **`test/vm-path-ctx-file.test.ts` gained a structural cassette-privacy regression test.** Asserts
  the committed `examples/replays/example-pdf-skill.cassette.json`'s top-level key set is closed and
  contains no `mount`-named field — guards the cassette assembler itself (not just `buildManifest`'s
  walk scope), so a future edit that adds a mounts-bearing field to the cassette literal is caught
  without needing a live re-record.

## [0.22.0] — 2026-07-03

### Added

- **`computer://` link modeling — the prompt now instructs file links exactly as production does.**
  Four pieces landed together, grounded in binary research against the Desktop app:
  - `src/vm-paths.ts` — a faithful port of Desktop's display-side VM→host path transform
    (`deepTranslateVMPaths` / `mapVMPathToHostPath` / `encodeComputerUrlsForHostLoop`): markdown-link,
    backtick, bare-token, and prose rewrite positions; per-segment percent-encoding; traversal
    rejection; dormant `.host-home` / `.auto-memory` mount branches.
  - **Hostloop display translation** (`src/run/display-translate.ts`): at hostloop fidelity the
    `run`/`chat` renderer shows production-identical host paths in assistant text and tool lines.
    Hostloop-only by design (container staging paths would be less faithful than VM paths), identity on
    replay (no live ctx), suppressed in `--compact`/`--demo` (the shareable no-host-paths contract).
    Hostloop prompt tokens now render HOST paths (`{{cwd}}` / `{{workspaceFolder}}` / `{{skillsDir}}` +
    the dedicated `{{cwd}}/mnt/uploads` pre-replacement), matching the Desktop builder's own host-loop
    substitution recipe.
  - **New assertion `computer_links_resolve: true`** — every `computer://` link in the transcript must
    resolve to an artifact that exists (live/verify-run: filesystem; replay: the cassette's artifact
    manifest, with host-shaped links normalized via the recorded session folders). Zero links pass;
    dangling links report which target was checked. Assert links with this key, not literal link text.
  - The `sharing_files` prompt section now instructs `[View your X](computer://{{workspaceFolder}}/x.ext)`
    links faithfully — the prompt-reconstruction divergence for links is retired (docs/fidelity-gaps.md
    updated).
- **Dark-feature gate sentinels.** Four newly discovered GrowthBook gates pinned in the baseline
  (host-fs skeleton `2614807392`, standard-session auto-memory `123929380`, memory-guidelines env
  `1696890383`, memory extra-guidelines `2860753854`) — all dark or inert-default for standard cowork
  sessions today; pinned so a production flip surfaces as a `sync --diff` delta. Absent-from-fcache
  dark gates record an explicit `source:"absent"` marker (the fcache re-key guard's semantics are
  preserved).

- **`stats` command + cross-run result index.** Every `run`/`skill` invocation (and `record`'s live
  execution) now appends one JSON line to `<runsRoot>/index.jsonl` at the same moment it writes
  `result.json` — a durable, queryable history independent of whether the run dir itself survives a later
  `prune`. `cowork-harness stats [<scenario>]` reads it back: run count, pass rate, cost/duration/token/turn
  p50/p95, and the last-green timestamp, filterable by `--since`/`--baseline`/`--branch` and windowable by
  `--last <n>` (per-scenario, not globally). `--reindex` rebuilds the index from the physical run-dir tree
  — the migration path for runs that predate the index. `trace`/`inspect`/`scaffold`/`status`'s existing
  run-id/fragment resolution now checks the index FIRST (faster, and the source of truth going forward),
  falling through to the pre-index filesystem walk automatically and unchanged for any run that predates
  the index or was never indexed — same commands, same output, same ambiguity-handling behavior either
  way. See [docs/stats.md](./docs/stats.md).
- **`run --matrix` matrix runner.** Runs one scenario across the cross-product of baseline/model/skill_dir
  axes declared in a `matrix.yaml` file (any axis optional; an absent axis contributes one unmodified
  cell) and reports one row per cell instead of a single pass/fail. `--max-cells` caps the cross-product
  (default 16, warns and truncates rather than silently dropping cells); `--concurrency` (default 1, max 8)
  runs cells N at a time via the same bounded pool `record --concurrency` uses. Exit is non-zero if ANY
  cell fails — a real assertion failure or a cell-level infrastructure error (e.g. the pinned baseline's
  agent binary isn't staged), rendered as a distinct `cell error: …` line rather than a fake assertion
  failure. The `skill_dirs` axis substitutes the session's single `plugins.local_plugins` entry; candidates
  must share that entry's directory basename (the mount name derives from it, with no author-chosen
  override anywhere in the harness) — a mismatch is a loud, explicit usage error. `--concurrency > 1`
  cannot combine with `--decider-dir`/`--decider-cmd` (the external decider channel is one shared object
  across every cell, and every channel implementation is strictly serial over shared mutable state — not
  safe for concurrent gate answers; `--concurrency 1`, the default, is genuinely serial and fine). The
  JSON envelope gains an additive `matrix: {cells[]}` field; `ok`/the exit code are `!matrix.anyFail` for
  this mode.
- **`--matrix` composes with `--repeat`.** Each cell now runs as its own repeat batch (N iterations of that
  cell's axes-overridden scenario) through the same `runRepeatBatch` helper standalone `--repeat` uses —
  same unanswered-gate, error, and budget-cap handling — with `MatrixCellRepeatResult`/`MatrixRepeatRollup`
  carrying each cell's full `RepeatRollup` (pass rate, per-assertion attribution, signal histogram,
  stoppedEarly) rather than a single pass/fail. The matrix verdict judges each cell's rollup against
  `--min-pass-rate`; the JSON envelope gains an additive `matrixRepeat: {cells[]}` field, checked before
  `matrix`/`rollups` when present. Also closes the previously-ungated `--repeat` + `--decider-cmd`
  combination (rejected for the same live-decider reasoning as `--decider-dir`).
- **Packaged GitHub Action** (`uses: yaniv-golan/cowork-harness@v1`, [`action.yml`](./action.yml)) wrapping
  `replay`/`lint`/`verify-cassettes`/`run` with a PR job-summary reporter (verdict table, staleness
  findings, the skipped-live-only-assertions honesty line, cost/turns when available). Token-free lane runs
  on any `ubuntu-latest` runner; `run` (live lane) needs a self-hosted runner with Docker + the agent binary
  already provisioned — the action does not stage either, by design (staging Anthropic's binary is a call
  about your own distribution-terms relationship, so it stays a step in your own workflow, not something a
  third-party action automates for you). README and the companion skill's `ci-recipe.md` both carry a
  worked self-hosted-runner example for the live lane. Self-tested in CI (`uses: ./` against a packed
  tarball of the current commit, a passing case, a usage-error case, and a genuine assertion-failure case).
  A `publish-image.yml` workflow pushes `ghcr.io/yaniv-golan/cowork-agent-base:2`/`cowork-agent-full:2` on
  release tags for consumers (and this repo's own CI) to `docker pull` instead of building from scratch.
- **`skill_triggered` / `no_skill_triggered` assertions.** Skill invocation (the top-level `Skill` tool_use)
  is now a first-class assertable event, recorded as `RunResult.skillsInvoked[]` and evaluated as a regex
  match, matching the `subagent_dispatched` convention. Fails as evidence-unavailable (never a vacuous pass)
  when the agent's init tool list has no `Skill` tool (agent-version drift) or, for the negative form, when
  invocation data itself is absent (an old run predating this key). Replay-checkable (content key).
- **`max_cost_usd` / `max_tokens` / `tool_calls_max` / `max_turns` budget assertions**, built on Wave 0's
  cost/turns seam. Each fails as evidence-unavailable (never a vacuous pass) when the underlying telemetry
  is absent. `max_cost_usd`/`max_tokens` are honest about the replay lane: they assert the *frozen
  recording's* spend, not fresh spend — a live `run` is where a real budget regression is caught.
  `tool_calls_max`/`max_turns` are meaningfully replay-checkable (the re-drive recomputes `toolCounts`/turn
  count deterministically).
- **`diff <a> <b>` command.** Compares two committed platform baselines (`--changelog` renders known-field
  prose — agent/Desktop version bumps, egress allowlist changes, gate flips — from a proper recursive
  structural differ, replacing the old one-level diff that dumped a whole subtree on any nested change;
  `sync --diff` now uses the same differ), two runs, two cassettes, or a run and a cassette (kind
  auto-detected by CONTENT, not filename — a cassette-shaped file not literally named `*.cassette.json`
  still detects correctly). Run/cassette mode has four views (`tools`/`transcript`/`artifacts`/`meta`, or
  `all`) with normalization masking per-run noise (tool-use ids, UUIDs, session-dir markers, timestamps,
  host paths) so two runs of the *same* scenario diff as identical despite that noise; `--no-normalize`
  compares raw values for forensics. Comparing runs of two *different* scenarios is allowed (useful for
  skill-variant comparison) but warns on stderr — added/removed rows may then reflect scenario
  differences, not drift. Token-free — no live Desktop install or Docker needed either way.
- **`run --repeat N` variance rollup.** Runs each resolved scenario N times (2-100) and aggregates a
  rollup (pass rate, per-assertion pass/fail attribution, a verdict-signal histogram, cost/token totals,
  non-deterministic-run count) instead of a single pass/fail. `--min-pass-rate` sets the batch threshold
  (default 1.0 — no flakiness tolerance); `--stop-on-diverge` stops the loop as soon as both a pass and a
  fail are observed (that batch always fails — divergence IS the failure being measured for);
  `--max-budget-usd` stops the loop once cumulative cost would exceed it (an incomplete-but-clean stop is a
  warning, not a failure by itself). `--repeat` rejects `--decider-dir`/`--decider-cmd` (an interactive
  driving agent × N runs is not a measurement). The JSON envelope gains an optional `rollups[]` array;
  `ok`/the exit code are
  redefined for this mode from the rollups, not from `results.every(pass)` — `results[]` still holds every
  raw run.
- **E9: a hand-authored draft-07 JSON Schema for the harness's own control-channel wire protocol**
  (`schema/protocol.v1.json`) — the `initialize` handshake, `can_use_tool` permission/question gates
  (incl. AskUserQuestion's `questions[]`), `hook_callback`/`mcp_message` round-trips, and the nested
  `control_response` envelope + the `answers` wire-shape — formalizing the prose in DESIGN.md §6/SPEC.md
  §4-5. Deliberately does NOT schema the Claude Agent SDK's own event stream (Anthropic's surface).
  Ships with a golden vector pack (`fixtures/protocol/v1/*.json` — real cassette-extracted where
  possible, synthetic-via-the-real-`session.ts`-envelope-builders otherwise) and conformance tests
  (`test/protocol-schema.test.ts`) that validate every committed cassette's control-channel lines plus
  the real envelope-builder functions' actual output, and guard the schema/vector-pack lockstep. See
  [docs/protocol.md](./docs/protocol.md) for the versioning policy and the explicit
  descriptive-not-normative scope statement.

### Parity

- **Synced the platform baseline to Claude Desktop 1.18286.0** (`baselines/desktop-1.18286.0.json`).
  The staged agent ELF is unchanged (`2.1.197`; measured sha256 matches the official release manifest).
  `sync` re-derived egress/gates/mount/web_fetch facts — no unknown deltas; the egress allowlist (15
  domains) and all 6 pinned GrowthBook gates held. `asarFingerprint` moved (`0b2f2fb6 → edff6926`);
  the host-loop `## Shell access` generator and the subagent append were re-verified against the new
  asar (unconditional fragments still byte-faithful).
- **Re-authored the system-prompt append reconstruction for 1.18286.0**
  (`baselines/prompts/desktop-1.18286.0/system-prompt-append.md`). The real append was RESTRUCTURED
  at this release (constant `aui`, 37.9KB): a new `<claude_behavior>` wrapper plus new
  behavior-driving sections — AskUserQuestion-before-work, task-list/verification, citation,
  file-creation/computer-use guidance, web-fetch no-fallback restrictions, sharing/package/examples,
  an `<env>` block — and the skills/file-handling sections moved inside `<computer_use>`. The
  reconstruction (paraphrased per the no-bundling rule) now carries these; generic refusal/safety
  policy stays elided, and the deliberate divergences (artifacts renderer catalog trimmed,
  `computer://` links described-not-instructed) are logged in the asset header. New `<env>` tokens
  `{{currentDateTime}}` / `{{currentTimezone}}` / `{{accountName}}` (session `account_name`,
  default `"User"`) render in `src/prompt.ts`. New tests guard baseline→asset references, token
  hygiene, and the `/sessions/` link-leak trade.
- **Annotated `desktop-1.17377.2` as append-unverified** (`$comment_prompts_unverified`): its own
  asar was never prompt-spot-checked and is no longer obtainable locally, so whether the 1.18286.0
  restructure landed there or later is unverifiable; the pin carries the last-verified 1.15200.0
  reconstruction.

### Added

- **Agent-binary provenance in baselines.** Each baseline's `agentBinary` now records the Linux/arm64 ELF's
  `sha256` plus `shaProvenance` — `measured-local` (hashed from the staged binary at `sync` and cross-checked
  against the official release manifest) or `official-manifest` (copied from the manifest for a version not
  staged on the syncing machine; staging-identity unverified) — and, on measured rows, `manifestChecksumMatch`.
  `sync` computes these and stays offline-capable (an unreachable manifest records `"unknown"` and never fails
  the sync). All committed baselines back-filled. (No `nativeSha256`: the signed native Mach-O never equals a
  manifest hash.)
- **Default-on agent-ELF integrity check.** The resolved ELF is verified against the recorded `sha256` at run
  time **by default** (opt out with `COWORK_HARNESS_VERIFY_AGENT_SHA=0`; ELF only). Hard-fails only on a
  `measured-local` mismatch at the baseline's own staged path; intentional substitutions (`COWORK_AGENT_BINARY`
  / newest-sibling fallback) and `official-manifest` hashes advisory-warn. `doctor` now shows a
  `[sha256 ✓ vs baseline, …]` provenance line. Old agent versions are re-downloadable and verifiable — recovery
  runbook in `docs/maintenance.md`.

### Changed

- **`RunResult.cost`/`.usage` retyped** from opaque `Record<string, unknown>` to structured shapes.
  `cost` is now `{ usd?, raw? }`: `usd` is the SDK result message's `total_cost_usd`, newly extracted (was
  previously dropped on the floor); `raw` is the pre-existing `api_metrics` payload, now nested under `raw`
  instead of being the whole `cost` object. `usage` gains a `turns?: number` field, from the SDK's
  `num_turns` (also newly extracted). Breaking shape change for anything reading `result.json`'s `cost`
  field directly — see SPEC.md's `RunResult` reference for the new shape. No cassette-format bump (derived
  reporting, not a stored format change).

### Fixed

- **Replay now surfaces `usage`/`cost` in `result.json`.** `replayCassette` previously omitted both fields
  entirely from every replayed `RunResult`, regardless of what the cassette recorded — a replay-lane blind
  spot, not a live-only limitation. Both are now re-derived from the cassette's re-driven record, same as
  the live/partial-run lanes.

## [0.21.0] — 2026-07-03

### Added

- **`verify-cassettes`'s privacy scanner gained a `path` class** for local absolute filesystem paths
  (`/Users/`, `/home/`, `/root/`) — closing a real gap where a committed cassette's capability-manifest
  (`system/init`, the `initialize` registry) could leak the recording machine's username, plugin-cache
  paths, and installed-plugin/marketplace names with nothing to catch it (the existing `email`/`currency`/
  `domain` classes don't match a path shape at all, and `currency`/`domain` are additionally excluded on
  manifest lines by design). `path` runs on manifest lines too — unlike the noisy classes it isn't
  excluded there, since a real local path is never legitimate catalog boilerplate. New `--allow-path
  <regex>` flag, scoped like `--allow-domain`/`--allow-email`.
- **A default `.cowork-redact.json` recording-redaction policy at the repo root** (two pattern rules:
  local absolute paths — `/Users`, `/home`, `/root`, matching the scanner's `path` class roots so
  redaction and detection stay aligned — and email addresses). `record` has always applied content
  redaction uniformly to every event, including capability-manifest lines, but with no policy file
  anywhere in the repo it ran as a structural no-op; cassettes recorded here now get those classes
  redacted at the source, complementing the scanner's after-the-fact check. (Repo-local — the policy
  file is not part of the npm package.)
- **A committed synthetic multiSelect cassette** (`examples/replays/example-multiselect-gate.cassette.json`)
  covering the multiSelect AskUserQuestion gate / `controlOut` answer path on the replay lane, wired into
  CI. Its capability-manifest is a small synthetic catalog, not a live-recorded environment.

### Fixed

- **`hostloop` fidelity now spawns the agent loop as a native host process, matching production, closing a VM-absolute-path false-green.** Previously, `hostloop` ran the entire agent — including its native file tools — inside one Docker container, with connected folders copied in rather than bind-mounted. A skill that hardcoded a VM-absolute path (`/sessions/<id>/mnt/...`) in a `Read`/`Edit`/`Write` call would silently succeed under that design while genuinely failing in real Cowork, where the agent loop is a native macOS process and no such path exists on the host filesystem. `hostloop` now spawns the agent directly on the host (discovered via a second staged Desktop binary, `claude-code/<ver>/claude.app/Contents/MacOS/claude`); only `bash`/`web_fetch` still route into a Docker VM sidecar (which no longer runs an agent at all). Connected folders are bind-mounted — never copied — into both views, with a run-end snapshot preserving the existing artifact-collection pipeline unchanged.

  With no container around the native file tools, a new byte-faithful port of production's own PreToolUse path-containment hook (`src/hostloop/pretooluse-path-hook.ts`) is the security boundary, backed by a runtime tripwire that hard-fails a run if a gated tool call ever completes with no evidence the hook fired. Because this gives the agent genuine, software-checked-only host filesystem access when a connected folder is writable, that combination now requires explicit consent: a new **`allow_host_writes: true`** scenario field (and `--allow-host-writes` for `chat`) — the harness refuses to spawn otherwise. `docs/boundary.md` documents the full safety posture; see also `docs/scenario.md` and `docs/session.md`.

  `computeVerdict`'s `host_path_leak` default-fail is now skipped at `hostloop` fidelity (real host paths there are expected, not a leak); `transcript_no_host_path` is consequently incompatible with `hostloop` and the harness warns loud if a scenario asserts it there anyway. Live-verified end-to-end against the real staged native binary and Docker: the gate blocks a VM-path `Read` with the expected denial (and the model self-heals via `bash`), and allows/executes a real `Read`/`Write` against the actual host path, with the PreToolUse hook firing for both calls.

- **`--compact`/`--demo` no longer leak a host path via the `[status]` line.** 0.20.0's run-start
  `[status] <outDir>` line prints a raw, un-tildeified absolute path by machine-capture contract — but it
  was emitted unconditionally, so under `--demo` (the "shareable, no host paths" preset) it exposed
  `/Users/<name>/.cowork-harness/…`, the exact leak `--demo` exists to prevent. The line is now suppressed
  under `--compact`/`--demo` (a human sharing a clip isn't scripting `status`; a machine/CI caller that
  needs the path doesn't pass `--compact`, or reads `status.json` / `--session-id`). `status.json` is still
  written either way, so `cowork-harness status` is unaffected.
- **`--compact` now collapses the session-root in tool-result outcome lines too.** 0.20.0's new
  `tool_result` `→`/`✗` outcome lines (under each top-level tool call) bypassed the `--compact`
  `/sessions/<id>/mnt/ → mnt/` collapse that already applied to `-V` tool *inputs*, so shareable output
  showed long in-container paths on the outcome lines only. The collapse is now a shared `collapseSessionRoot`
  helper applied to both. Display-only; `run.jsonl` keeps the true paths.
- **All CLI usage/runtime errors now honor `--output-format json`.** Dozens of error sites in
  `cli.ts`/`doctor.ts` bypassed the shared JSON envelope and emitted plain stderr text even when JSON
  output was requested. Every remaining `log()`+`process.exit()` site now routes through the shared
  `fail()` helper (relocated to `src/run/envelope.ts`), preserving every existing exit code exactly.
  The two sites that legitimately keep a custom wire shape (`decide`'s ABSTAIN/catch and `main()`'s
  top-level catch) are explicitly marked, and a new CI guard bans any other bare `process.exit(1|2)`
  in those two files so the fix can't silently regress.
- **`doctor --tier hostloop` now validates the native macOS agent binary the tier actually spawns.**
  It only checked the Linux/arm64 agent ELF (`resolveAgentBinary`), never the separate native host
  binary (`resolveHostAgentBinary`) that `hostloop`'s agent loop runs directly on the host — so
  `doctor` could report ready while the one binary that tier needs was missing. New `hostAgent`
  check for the `hostloop`/`cowork` tiers, gated the same way as the existing agent check.
- **The npm package now ships `AGENTS.md`, `SPEC.md`, `DESIGN.md`, `llms.txt`, `SECURITY.md`, and
  `CONTRIBUTING.md`** — previously absent from the tarball's `files` allowlist, so links to them from
  the packaged `README.md`/`llms.txt` dangled in an installed copy.

### Parity

- **Synced the platform baseline to Claude Desktop 1.17377.2** (`baselines/desktop-1.17377.2.json`).
  The staged agent ELF is unchanged (`2.1.197`). `sync` re-derived egress/gates/mount/web_fetch facts —
  no unknown deltas; only `asarFingerprint` moved (`290341ff → 0b2f2fb6`), and none of the 6 pinned
  GrowthBook gates drifted. Re-verified: the live container-tier scenarios pass against the new
  baseline.
- **Added the missing `.claude/skills` row to the `1.17377.2` `mountLayout`.** VM-rootfs forensics
  (the `sessions-<name>-mnt-.claude-skills.mount` systemd unit in `rootfs.img`, reproduced across two
  independent investigations) show the real VM mounts skills as a dedicated read-only row; the original
  mount-fidelity plan had folded skills into the plugin mounts and never added one.

### Docs

- **`docs/invariants.md`** — a consolidated index of the harness's cross-cutting invariants, one row
  per invariant with its enforcement point and test anchor.
- **Scenario-schema description pass.** Every top-level scenario field in `schema/scenario.schema.json`
  now carries a description (for schema-driven editor tooling/autocomplete), including why the
  replay-only `replay_protocol_fidelity` is listed despite being rejected at load time; the `answers`
  and `baseline` descriptions were corrected (the tool-permission `when_tool` matcher was omitted;
  `baseline`'s `profile:` alias is deprecated, not retired).
- Doc-audit sweep (2026-07-03): stale `>=0.19.0` version floors bumped, wrong `BoundaryError` exit
  code (2 → 3), stale CI job name, `--decider-model` / `--allow-path` help-text coverage, the
  marketplace-install-bundles-same-files claim, and stale "not yet landed" notes.

### Internal

- CI's `parity-drift` job now fails if the newest committed baseline exceeds a 90-day staleness
  ceiling, so the parity promise can't silently rot.
- The multiselect decider smoke scenarios run in the live CI scenario suite.
- `npm pack`'s `files` array explicitly negates local gitignored cruft (`docs/superpowers`,
  `__pycache__`, `egg-info`) so the pre-tag `npm pack --dry-run` check is trustworthy regardless of
  working-directory state (published tarballs were never affected).

## [0.20.0] — 2026-07-01

### Added

- **`status.json` + `cowork-harness status <dir> [--follow]`.** Every run now writes a lightweight
  `status.json` into its output directory from the moment `outDir` is created through completion
  (`running` → `done`/`error`), with live tool/sub-agent counts. Two layers keep it from ever getting
  stuck reporting a dead run as `"running"`: an exit-handler crash-safety net for an uncaught
  throw/`SIGTERM`, and `updatedAt`-based staleness detection (both in `status` and `status --follow`) for
  a hard `SIGKILL`/OOM-kill, which no exit handler can catch. `cowork-harness status <run-id | run-dir>`
  reads it (one-shot, or `--follow` streaming one JSON line per change, bounded by a fail-loud
  timeout/staleness check rather than a silent hang) so a script or driving agent can check whether a
  background run is still alive WITHOUT `ps aux` — which only sees processes in the checker's own PID
  namespace and is unreliable from inside a sandbox/container. The harness prints `[status] <outDir>` to
  stderr as soon as it's known, so a caller doesn't need `--session-id` to discover the directory. See
  `docs/run-status.md`.
- **Gate provenance in run output.** `result.json` now carries a `gateProvenance` block (`total`,
  `bySource` histogram, per-gate `{question, answeredBy, answer, model?}`) recording how each
  AskUserQuestion gate was answered (scripted / decided(llm|external) / first-option / prompt). The
  verdict footer prints a counts-only one-liner (e.g. `gates: 3 · 2 decided(llm), 1 scripted`) and
  `trace --view questions` annotates each gate with its `by`/`model`. Informational — it never changes
  the verdict; it makes the residual non-determinism legible so a reviewer sees which assertions sit
  downstream of a decided (non-reproducible) gate. `bySource` keys are the raw decision sources, so e.g.
  a replay-lane decision reads `replay`; the block itself is a live/partial-lane surface and is absent on
  the replay lane (which reports reproducibility via `nonDeterministic: false`).
- **`--compact` and `--demo` for shareable output** (`skill`/`run` — `chat` has its own flag parser and
  isn't wired to either yet). `--compact` drops the
  informational `[capability]` `::notice::` lines (the pre-flight, the "image omits…", and the "not used"
  notes) — but the capability probe still runs and a real false-negative still **hard-fails**, unlike
  `COWORK_SKIP_CAPABILITY_PROBE=1` which disables the safety net. `--demo` is the shareable preset:
  `--compact` plus suppression of the `runs →` location header. Runs stay in the durable default location
  (no temp redirect), so `scaffold`/`trace`/`inspect <run-id>` still resolve the run afterward; combined
  with the `$HOME`→`~` collapse, demo output carries no host paths. Under `--compact`, `-V` tool inputs
  also collapse the ephemeral cowork session root (`/sessions/<id>/mnt/` → `mnt/`) — display-only, so the
  long in-container paths don't clutter shareable verbose output (`run.jsonl` keeps the true paths; the
  L0/`protocol` tier uses host `work/` paths and is unaffected).
- **`replay --assert-from <scenario.yaml>` / `--reassert` — token-free re-check against on-disk assertions.**
  By default `replay` still evaluates the assertions **frozen in the cassette** (byte-deterministic, ignores the
  working tree); a plain `replay` now prints a `::notice::` when a sibling scenario's `assert:` differs, instead
  of silently using the frozen copy. The new flags opt into re-evaluating against the **on-disk** `assert:`
  (+`expect_denied:`) — the "edit the assert, re-check without a paid re-record" loop. `--assert-from <file>`
  takes an explicit sibling scenario; `--reassert` auto-discovers it (persisted `scenarioSource`, else a
  name lookup) — no argument needed. The opt-in path is safe by
  construction: it **hard-fails** on recording-shaping drift (`prompt`/`baseline`/`fidelity`/`answers`/`skills`/
  `requires_capabilities`) and on skill-content staleness (it implies `--fail-on-skill-drift`, when a skill
  fingerprint was recorded), warns on on-disk assert keys that can't be evaluated on replay (filesystem/gate/egress)
  and on an edited `expect_denied`, and notes that the `session` (model/mounts/discovery) is **not** verified.
- **Per-result `verdict` in the `--output-format json` envelope.** Each entry in `results[]` now carries
  `verdict: { pass, exitCode, signals[], guards[] }` (a non-mutating projection of `computeVerdict`), so a consumer
  can read each result's pass/fail **and why** (e.g. an all-green-assertions run that is `pass:false` purely on a
  `stalled` signal) without recomputing. The top-level `ok` is derived from the same per-result verdicts.
- **`chat` / `skill` / `run --verbose` live-output legibility pass.** Six small, no-new-dependency
  improvements to the stderr renderer (`src/run/renderer.ts`) and `PromptDecider`'s TTY gate prompts
  (`src/decide/decider.ts`) — informational-only, nothing here touches verdicts, `result.json`, or replay.
  Tool call markers are now category-specific glyphs instead of a uniform `·`: `@` read (Read/Glob/Grep/…),
  `#` mutate (Write/Edit/…), `!` shell (Bash/…), `?` network (WebFetch/…). Truncated `-V` tool-input
  summaries now show how much was cut (`… [+N chars]` instead of a bare `…`). Each turn now ends with a
  `── +N.Ns ──` separator carrying that turn's elapsed time (derived from the SDK's per-turn `result`
  event, which the renderer previously dropped entirely). `tool_result` events — likewise previously
  dropped — now render a one-line `→ …` / `✗ …` outcome under each top-level tool call. Nested sub-agent
  dispatch lines (`--verbose`) now indent proportionally to dispatch depth instead of always rendering
  flat. And permission / `AskUserQuestion` TTY prompts now render inside a `┌─/│/└─` box so they visually
  stand out from the progress markers sharing the same stderr stream.

### Changed

- **`run` now accepts `--keep` as an explicit no-op** instead of erroring. `--keep` is meaningful on
  `skill` (which otherwise discards runs); `run` always keeps runs, so passing `--keep` (muscle memory
  from `skill`) prints a one-line note that it had no effect rather than the loud "unexpected argument"
  reject. Exact-token only — a genuinely unexpected flag still rejects loudly.
- **The default `--decider-llm` answering model now floats to the latest Sonnet** (the CLI alias `sonnet`)
  instead of the id pinned in 0.19.0 (`claude-sonnet-4-5`), so the default keeps tracking Anthropic's
  current Sonnet without a repo edit. `gateProvenance`/`result.json`'s `decisions[].model` is unaffected —
  it now records the CONCRETE model the alias resolved to for that run (via `claude -p --output-format
  json`'s `modelUsage`), never the literal string `"sonnet"`, so per-gate auditability is exactly as precise
  as it was under the old pinned default; an envelope that doesn't resolve to exactly one concrete model
  fails loud rather than recording an empty/ambiguous value. `--decider-model <id>` /
  `COWORK_HARNESS_DECIDER_MODEL` still pin an exact id — the way to get byte-for-byte reproducible decider
  behavior across runs (as much as a stochastic model allows), since the floating default can answer
  differently over time as Anthropic ships new Sonnet releases.

### Fixed

- **A blocking `--on-unanswered prompt` wait now announces itself immediately.** When `skill` blocks at
  the TTY for an unscripted question (the adaptive default when a human is attached), it prints a one-time
  `::notice:: [input] waiting for an answer…` the instant it blocks — instead of only the ~30 s heartbeat —
  so a recording/wrapper/automation context isn't left silently hung. The notice is per-run (a fresh
  decider per scenario, so a `run dir/` batch announces each blocking scenario), and only for the real TTY
  asker (the `chat` REPL's own prompt is left alone). For non-interactive use, `--on-unanswered fail`
  remains the way to never block.
- **Human output no longer prints absolute `$HOME` paths.** The `runs →` location line, the `--keep`
  run-dir/outputs lines, the `scaffold` tip, the failure `→ full run:` line, and the failure branch's
  own `→ outputs:` line now collapse a leading `$HOME` to `~`, so a screenshot / pasted log / bug report
  doesn't leak your username and filesystem layout. Display-only (`~` re-expands in a shell); set
  `COWORK_HARNESS_RUNS_DIR` for full neutralization.
- **A plugin/skill mounted from an untracked git working copy no longer fails silently.** Staging delivers
  the git-**tracked** set (the fidelity boundary — real Cowork installs from a repo and sees only committed
  files), but an all-untracked source used to mount **EMPTY** with no signal: the agent reported "the skill
  isn't installed" and did the work itself — a green-looking run where the skill never loaded. Now the filter
  is **visible in both directions**: a would-be-empty plugin/skill mount **hard-fails** with a `BoundaryError`
  (clean exit 3) naming the dir and the fix (`git add`, or `COWORK_HARNESS_GITSET=0`), and a partially-tracked
  source emits a loud `::notice:: [stage]` listing the excluded untracked files. The staged-set count and the
  delivered set now come from one `git ls-files` snapshot (no TOCTOU). The guard is correctly skipped on
  `--resume` (which re-stages nothing) — which also fixes a latent resume false-fail where a since-removed
  skill source would throw. The sibling symlink-escape staging errors are now `BoundaryError`s too (clean
  exit 3 instead of a stack trace).
- **`trace --view questions` no longer misattributes `by`/`model` after a denied gate.** It paired each
  gate row with `summarizeGateProvenance(...).gates[i]` by array index — but that array **drops**
  denied/mismatched gates (`mismatch→deny`), while the trace rows include every gate asked. One denied
  gate in the middle of a run shifted every later row's `by`/`model` onto the wrong question, and the true
  owner of that data got none. Now pairs against every question-kind decision (answered **or** denied,
  interleaved tool-permission decisions excluded), which keeps the common case aligned; a denied gate is
  correctly left unannotated instead of stealing the next answered gate's provenance. Informational display
  only — never affected pass/fail.
- **CLI `--help` drift.** The top-level `chat` summary now lists `protocol` (the command already accepted
  it); `--version` documents its `-v` alias; and the `gates` / `answer` / `scaffold` usage strings now show
  the `--output-format` flag they already parse.
- **`sync --diff` no longer goes silent on a genuine Desktop version bump.** It previously diffed `next`
  against `baselines/desktop-<NEW version>.json` — which doesn't exist yet on a real bump — so it always
  printed `(no committed baseline yet)` instead of the `appVersion`/`agentVersion`/etc. field diff
  `docs/maintenance.md` documents. It now diffs against `base` (the latest committed baseline `next` was
  actually merged onto), which is the previous version on a bump and the exact same content on a
  same-version re-sync. The diff header now names which baseline it's comparing against. `docs/
  maintenance.md`'s example output and noise callout (`$comment` also moves alongside `capturedAt` on every
  run) updated to match.

### Documentation

- **Doc-vs-code audit — corrected several doc claims that diverged from the implementation.**
  - **Host-loop tier wording.** README, `docs/boundary.md`, `docs/chat.md`, and the skill `SKILL.md` said
    the `hostloop`/`cowork` "agent loop runs host-side." It does not: the agent process runs **in the
    container** like `container`, but native Bash/WebFetch are disabled and routed host-side via the
    workspace SDK-MCP server (bash via `docker exec`, `web_fetch` via host `curl`). Only `protocol` runs
    the agent on the host. Reworded to describe the **tool-routing** split, not an agent-loop split, in
    README, `docs/boundary.md`, `docs/chat.md`, and `SKILL.md` — plus, in a 2026-07-01 follow-up, the three
    files this pass missed: `docs/scenario.md`, `docs/fidelity-gaps.md`, and the skill's
    `fidelity-and-answers.md` (and the misleading code comment in `src/runtime/hostloop.ts`).
  - **Artifact replay.** The skill references (`scenario-schema.md`, `ci-recipe.md`) claimed a replay PR
    gate "cannot verify an artifact's content." It can — `file_exists` / `user_visible_artifact` /
    `artifact_json` evaluate on replay **when the cassette carries an `artifacts` manifest** (already
    correct in `docs/cassette.md`). Fixed the two contradicting copies.
  - **`boundary-check` scope.** Clarified it probes the **L1 Docker** path only (covers `container` and
    `hostloop`, which share that sandbox); the `microvm` guest-iptables firewall is not exercised by it.
  - **`microvm` isolation.** `docs/scenario.md` said microvm "shares the container sandbox"; it actually
    enforces the same allowlist inside a real Lima/Apple-VZ VM via a guest firewall.
  - **Egress mechanism.** `docs/boundary.md` cited `docker/compose.yml` as the live enforcer; the runtime
    creates **per-run** Docker networks in `src/egress/sidecar.ts` and never invokes compose (now marked
    reference-only).
  - **Onboarding / DX.** Added a "Which path am I on?" box (replay / protocol / live tiers / invocation)
    and a three-names note to the README quick start; surfaced `doctor` / `python3` / `vm init` in the
    docs reading order; aligned `docs/discovery.md` with the worked examples; documented the previously
    undocumented `COWORK_*` / `PYTHON` env vars; noted the latest baseline is `desktop-1.15962.1`
    (runtime-identical to `…0`).
  - **Command/assertion reference.** Documented `doctor --tier cowork`, the `prune [<runs-dir>]`
    positional, the `sync --force` alias, the `artifact_json` bare-existence mode, the
    `tool_result_not_contains` fail-loud on truncated evidence, and that `expect_denied` is scenario-level
    shorthand (not an assertion key).

### Parity

- **Synced the platform baseline to Claude Desktop 1.17377.1** (`baselines/desktop-1.17377.1.json`). The
  staged agent ELF moved **2.1.187 → 2.1.197**. `sync` re-derived egress/gates/mount/web_fetch facts — **no
  unknown deltas**; only `asarFingerprint` moved (the mount-mode and web_fetch drift-guard regexes both
  still matched) and `api.claude.ai` joined `network.allowDomains`. None of the 6 pinned GrowthBook gates
  drifted (loop / dispatch-cap / web_fetch-routing / transport / plugin-sync / CLI-plugin-broker all held
  their prior on/off state). Re-verified end-to-end — the live scenario suite (`protocol` + `container`
  tiers) passes against the new baseline.
- **Spot-checked the reconstructed system-prompt / host-loop content against the new asar** (this is
  hand-authored, not something `sync` extracts): the `<application_details>` identity block — including the
  load-bearing "is NOT Claude Code" correction — the host-loop `## Shell access` marker, subagent-append
  gating, the `computer://` scheme, `request_cowork_directory`, and `coworkNativeFilePreview` are all
  present and substantively unchanged since the `1.15200.0` reconstruction (only non-substantive
  punctuation-level rewording). No re-authoring of `baselines/prompts/desktop-1.15200.0/` was needed.
- **Doc-pin sweep to `desktop-1.17377.1` / agent `2.1.197`** across README, DESIGN, SPEC, the spawn-contract
  doc, and the skill's reference docs.

## [0.19.0] — 2026-06-30

### Changed

- **The default `--decider-llm` answering model is now Sonnet (`claude-sonnet-4-5`), not Haiku.** A
  measurement on a real-doc skill with judgment-heavy gates found the prior Haiku default
  **prose-declined ~50% of them** (replying "I don't have information…" instead of picking an option →
  a fail-loud whiff); a Sonnet decider binds those gates and the run proceeds. ⚠️ This **raises per-gate
  token cost** for every `--decider-llm` run, and a gate a weaker model would have prose-declined (and
  failed fast) is now more likely to be answered and the run to continue (longer/costlier). Pin a
  cheaper model to restore the old cost/behavior: `--decider-model <haiku-id>` or
  `COWORK_HARNESS_DECIDER_MODEL`. (n is small — read this as "Haiku is too weak for judgment-heavy
  gates," not a precise rate.) The whiff error now also names the `--decider-model` lever.
  ⚠️ **False-green caveat (new guidance, no behavior change):** binding-and-proceeding is the upside,
  but a *decided* answer is the decider's best guess from the transcript tail — it never sees the
  mounted documents — so it can fabricate (oracle-less gate) or get a doc-answerable fact wrong, and a
  green run resting on it is a false pass. **Script any gate whose answer feeds a _semantic_ assertion
  (`--answer` / `--answer-policy`); reserve `--decider-llm` for structural-assertion runs.** See
  `references/fidelity-and-answers.md` in the skill.
- **Stall detector now also flags a stall AFTER an answered gate (H3).** The `stalled` verdict signal
  previously fired only when a run ended on a question having made *no tool calls at all*. It now fires
  when a run ends on a question and made **no productive tool call after its last `AskUserQuestion` gate** —
  catching the case where the agent answers a gate, then re-asks in plain text and stops with the
  deliverable never produced (previously a `result: "success"` false-green). The no-gate case is unchanged.
  Re-derives identically on replay. ⚠️ This can flip a previously-green scenario to red — set
  `allow_stall: true` to restore the prior verdict if ending on a question is the intended terminal state
  (e.g. a skill that writes its output and then ends on a confirmation/"anything else?" question). The signal
  is a *tool-position heuristic*, not deliverable detection, so it is imprecise in both directions: a post-gate
  tool *call* (successful or errored) clears the flag even if nothing useful was produced (false negative);
  and a deliverable produced *before* the final gate does NOT clear it, so a write-then-confirm-then-question
  run is flagged (false positive). Assertions are the real guard — assert the deliverable
  (`file_exists`/`artifact_json`), never `result` alone — and use `allow_stall` for a deliberate
  question-terminal skill.

### Fixed

- **`--decider-llm` now binds an echoed grant label on a `web_fetch` approval gate** instead of failing
  loud. The web_fetch permission-approval path matched the model's reply with an exact-label check only,
  so a reply that echoed the option plus a self-glossed tail past a `:` boundary (e.g.
  `Allow once: fetch this URL one time` against option `Allow once`) aborted the run — the same echo shape
  the `AskUserQuestion` path already tolerates. The permission path now applies the same `echoPrefixMatch`
  backstop, so the echoed label binds. Out-of-set replies still fail loud.
- **The three non-retried `--decider-llm` transport failures now name their mitigation in the error.** A
  timeout, a `maxBytes` overflow, and a spawn failure (e.g. `ENOENT`) forfeit the run by design — they are
  not transient — but the surfaced message previously named only the failure. It now points at the lever:
  `COWORK_HARNESS_LLM_TIMEOUT_MS`, `COWORK_HARNESS_LLM_MAX_BYTES`, and `PATH` / `COWORK_HARNESS_CLAUDE_BIN`
  respectively. No retry behavior changed.
- `doctor`'s "no token, but a Claude Code Keychain entry exists" remedy now also names the
  `--dotenv` workaround. The macOS Keychain branch previously printed only "copy the token into
  `./.env`", which led an operator whose token lived in a *different* file to conclude `doctor`
  ignores `--dotenv` — it does not (the global `--dotenv <path>` is honored by `doctor` exactly as
  by `skill`/`run`, since it loads into `process.env` before dispatch). The remedy now reads
  "… or, if the token is already in another file, point at it: `cowork-harness --dotenv <path> <cmd>`".

## [0.18.0] — 2026-06-27

### Fixed

- `sync` no longer flags an unknown delta when `coworkEgressAllowedHosts` is absent from
  `config.json` (the normal state for a fresh install with no user-configured custom egress
  hosts). Previously the absent key was treated the same as a wrong-typed value and blocked
  the baseline write entirely.
- `sync` now regenerates the baseline `$comment` with the current capture date instead of
  carrying the stale string forward from the prior baseline via the `...base` spread.
- A misplaced GLOBAL flag (the space form `--dotenv <path>` / `--run-dir <path>` placed *after* the
  subcommand, where the pre-0.17.0 docs put `--dotenv`) now fails with a position hint —
  `--dotenv is a GLOBAL flag and must come BEFORE the subcommand (e.g. \`cowork-harness --dotenv <path> doctor …\`)`
  — instead of a bare `unknown flag: --dotenv` (or, for some commands, an unrelated positional /
  "unexpected argument" error) that sent users hunting for a per-command flag that doesn't exist. The
  hint honors `--output-format json`, never pre-empts `--version`/`--help`, and only fires for a known
  subcommand (a junk command still gets the accurate "unknown command"). The `--dotenv=<path>` equals
  form is not matched — to avoid hijacking a legitimate value like `--answer "--dotenv=x=y"` — so a
  misplaced equals form still gets the plain unknown-flag rejection. (A bare `--dotenv`/`--run-dir`
  token used as another flag's omitted value, e.g. `decide --question --dotenv`, is pre-empted by the
  hint rather than the more specific "requires a value" error; both exit 2.)
- `doctor`'s no-token remedies now show `--dotenv` in its correct **leading** position
  (`cowork-harness --dotenv <path> <cmd>`). The git-worktree remedy previously printed the pre-0.17.0
  `<cmd> --dotenv` form — which the new position hint above now rejects — so `doctor` was suggesting a
  command the harness refuses. The generic no-token remedy also now advertises the
  `--dotenv <path> <cmd>` form, so pointing at a non-cwd `.env` is discoverable.
- `skill --help` / `run --help` now label `--run-dir` as a **GLOBAL** flag that must precede the
  subcommand. It was listed in each command's local "Output:" flag block, implying
  `skill … --run-dir <path>`, which the command rejects (`--run-dir` is honored only before the
  subcommand, like `--dotenv`).

### Changed

- Baseline bumped to `desktop-1.15962.0` (agent `2.1.187`). Content is unchanged from
  `1.15200.0` — host-loop generator, system prompt, identity, gates, and egress domains are
  all byte-identical per asar analysis. Version and fingerprint fields only. The live-contract
  suite was re-run green against the staged `2.1.187` agent on this baseline, so the
  "verified end-to-end" claims are earned. Cassettes recorded against the `1.15200.0` baseline will
  report a non-failing baseline-drift warning on `replay` (a hard fail under `--strict` /
  `verify-cassettes`); re-record to clear, or ignore it since the asar content is byte-identical.

### Documentation

- Audit-validated doc/DX fixes: corrected the `docs/cassette.md` cassette-version example
  (`6`→`7`); rewrote the `protocol-smoke` row to stop referencing a rejected
  `transcript_no_host_path: false` line; scoped the SKILL.md "agent binary" prerequisite to the
  sandboxed live tiers (protocol/replay need none); added `python3` to the README requirements
  (the `lint` linter shells out to it); moved the `/plugin` slash-command block off the `bash`
  fence; pinned `cowork-harness@>=0.17.0` in the CI recipe; noted that `chat` excludes
  `microvm`/`cowork`; and other small corrections from a full documentation audit.
- Refreshed all verification/version stamps that still pinned `1.15200.0` / `2.1.181`
  (README, DESIGN, SPEC, the spawn-contract reference, `docs/cassette.md` fingerprint example,
  and the `hostloop-prompt.ts` re-verified comment) to `1.15962.0` / `2.1.187`.

## [0.17.0] — 2026-06-26

### Upgrade notes

- **Re-record all cassettes after upgrading** (`cowork-harness record cassettes/ --rerecord-stale`).
  The skill-hash delimiter changed (v6 → v7); `verify-cassettes` reports which cassettes need it.
- **`transcript_no_host_path: false` is now rejected by the schema.** Remove the key or change it
  to `true`. (It was never meaningful as `false`.)
- **`is_null: false` on an absent path now fails loud** instead of silently passing. Add
  `exists: true` if you intend to assert presence before the null check.

### Fixed

- **The microVM egress proxy port is now allocated via bind-port-0 instead of freePort().** The
  previous approach (bind :0 → read port → close → re-bind real proxy) had a TOCTOU gap: another
  process could grab the port between the probe close and the proxy bind. The proxy now binds on `:0`
  directly; `actualPort` is read from the live socket and threaded into the guest firewall rule and
  `HTTP(S)_PROXY` env after the proxy is already bound. L1 (container/hostloop) was unaffected
  (uses a fixed port inside Docker's per-run network namespace); L0 (protocol) has no proxy.
- **Cassette fingerprint format is v7.** The skill-hash uses a NUL byte (`\0`) to delimit entries
  (`F:`, `D:`, `L:`) — unambiguous for all POSIX-valid filenames. `CONTENTSIG_ALGO` is 3.
  `verify-cassettes` reports `recorded under an older hash format (v6 → v7)` for stale cassettes;
  re-record with `--rerecord-stale` to clear.
- **`transcript_no_host_path` only accepts `true`.** Omit the key to skip the check; `false` is
  rejected by the schema (`const: true`).
- **`is_null: false` requires the path to be present.** An absent path fails loud. To assert "exists
  and is not null", write `exists: true` alongside `is_null: false`.
- **The egress proxy no longer crashes on a double-end or EPIPE.** When an upstream TLS error
  arrived after the response had already been ended (e.g. the client disconnected mid-stream),
  calling `res.writeHead(502)` on an already-sent response threw, taking down the proxy for the
  remainder of the run. The guard now skips the `writeHead` call when `res.headersSent` is true and
  swallows the resulting EPIPE.
- **L0 (protocol) containment check now uses `realpathSync` to guard against symlink escape.** The
  previous path comparison used the raw strings; a symlinked workspace folder could resolve outside
  the declared root and the check would miss it.
- **Session `enabledPlugins` now emits the correct `{ "name@mp": true }` object-map** that
  `claude --settings` requires, rather than an array of plugin-name strings that is silently ignored.
  Plugin loading via `--settings` was silently broken for any session with `enabled_plugins:` set.
- **`probeMicrovmOmitted` no longer issues a `limactl shell` probe when the Lima VM is not Running.**
  A cold (Absent) or stopped VM cannot be probed; the harness now skips the capability probe
  entirely and returns `null` rather than trying to shell into a non-running instance.
- **`is_null: true` on an absent path now directs to `absent: true`** with a clear error rather than
  silently treating absent-as-null (the two are semantically distinct: absent = the key doesn't
  exist; null = it exists with a JSON null value).
- **Boundary `/host` probe split into two independent checks.** The previous single-command probe
  could false-pass when the host filesystem was sealed but the `/host` directory existed and was
  empty. The probe now AND-combines a listing check and a no-denial text check.
- **`--decider-llm` transport now bounded-retries a transient `claude -p` exit and surfaces *why* it
  failed.** A single `claude -p` decider spawn can exit non-zero on a transient upstream hiccup
  (rate-limit/overload/network) during a long back-to-back batch — observed 1/8 live runs, not reproducible
  on demand. The non-zero-exit class is now retried (default 2 attempts, small linear backoff;
  `COWORK_HARNESS_LLM_RETRIES=0` to disable) so a transient exit doesn't kill a 10-minute paid run at the
  final gate. Retry never double-answers: the transport has no harness side effects, and a non-zero exit
  delivers no answer, so the gate is answered exactly once downstream of a successful call. The timeout /
  `maxBytes`-overflow / spawn-`ENOENT` classes are not transient and still fail loud on the first attempt.
  (A *deterministic* non-zero exit — bad `--decider-model`, auth — is also retried the full count before
  failing loud; the cost is bounded and the captured output names the cause.) The exit error now folds in the
  child's captured **stdout** (where `claude -p` writes its operational diagnosis — verified) and stderr, so
  `exited 1` is no longer undiagnosable.
- **`--decider-llm` now binds a markdown-/quote-wrapped `OTHER:` free-text directive.** A model often
  code-fences a verbatim directive (`` `OTHER: …` ``, `"OTHER: …"`); the leading backtick/quote previously
  defeated the `^\s*OTHER:` anchor and the gate whiffed → fail-loud stall (observed live). The sentinel now
  matches on the `trimNearMiss` form (wrapping quotes/backticks stripped, `:` preserved), so a real
  `OTHER:`-named option label still wins first via the exact-label tier.

## [0.16.0] — 2026-06-26

### Fixed

- **`--decider-llm` no longer whiffs when the answering model echoes the rendered option line (H10).** The
  model is now prompted to reply with the option **NUMBER** (the prompt renders options numbered, with
  descriptions on their own line) and the harness maps the number to the exact canonical label — so the
  reproduced `"Seed / AI/ML: Seed stage…"` (model parroting the `label: description` bullet) and similar
  whiffs can't occur on the common path. A backstop still binds a `label: description` echo (label is a
  boundary-prefix of the reply at a `:` boundary, longest-wins) and the `(Recommended)` suffix; conversational
  asides (`"No, I disagree…"`, `"Seed (probably) but Series A"`) and bare prose stay **loud, never a guess**.
  The LLM decider's unanswered error now also surfaces the `closest:` label.
- **`--decider-llm` now answers multi-select gates.** The LLM path had no `multiSelect` branch (a
  "select all that apply" gate could pick only one option); it now accepts a comma-list of option numbers
  (`1, 3`) and a mixed digit+label reply fails loud.

### Added

- **`--decider-model <id>`** (on `skill`, `decide`, and `record`) overrides the `--decider-llm` answering
  model — flag > env `COWORK_HARNESS_DECIDER_MODEL` > the Haiku default. Use a stronger model for genuinely
  ambiguous *judgment* gates; it does not make an under-specified gate deterministic. Requires `--decider-llm`.
- **Scripted `choose:` (and `--answer`) accepts a stable partial anchor** for skills whose option labels
  drift run-to-run: `choose: "Israeli company"` binds whichever single option starts with it (boundary-anchored,
  uniqueness-guarded). It **fails loud** if the anchor matches two options — drift-tolerance, not strict CI
  reproducibility (for that, pin a full exact label or use a free-text `answer:`).

### Docs

- **Added a debugging on-ramp (`docs/debugging.md`).** A router for "my skill misbehaved"
  (`inspect` → `trace` → `chat` → `verify-run`) vs. "I don't trust this green" (the false-green hunt:
  Gotchas, `lint`, `verify-cassettes`, `COWORK_HARNESS_DEBUG_SKILLHASH`), wired into every doc index
  (README, `docs/README.md`, `llms.txt`, the companion skill).
- **Documentation review sweep — doc-vs-code discrepancies corrected, DX/clarity/structure gaps closed
  (26 files).** Adversarially verified against `src/`. Highlights: startup `--folder` is a **staged fresh
  copy** (writes land in the run's `mnt/<folder>`, not the host original), not a live bind mount
  (`fidelity-gaps.md`, `chat.md`); `microvm` is **Lima + Apple-VZ**, not Docker (`python/README.md`);
  `llms.txt` command list corrected (`prune`/`inspect`, not the non-existent `runs gc`); the
  `verify-cassettes` JSON envelope documents its `coverage{}` field (`SPEC.md`); the discovery version-gate
  sits on **local** plugins while `.remote-plugins` is unconditional (`discovery.md`); `extra_allow` is
  **session-level** (`DESIGN.md`); same-repo release-branch PRs **do** run the live scenario suite
  (`RELEASING.md`); the `ci-recipe.md` live-lane gate uses a valid guard-step output (the prior
  `if: ${{ secrets.… }}` is not a valid Actions context); plus assertion-operator (`artifact_json`'s `in`),
  host-path-set, and exit-code corrections. DX: the `claude` CLI named as a prerequisite, the README
  reordered to a zero-infra-first ramp, and the three doc indexes reconciled by audience.

## [0.15.0] — 2026-06-25

### Fixed

- **Staleness no longer masks a scoped skill's own drift behind a co-occurring shared change.** For a
  `skills:`-scoped cassette, when BOTH the shared roots AND the scoped skill's own files changed, the
  diagnosis previously reported only `shared root changed` and never the skill — the two buckets were
  mutually exclusive (shared tested first). It now attributes drift per-bucket by the actual changed paths and
  emits BOTH a `shared-root` and a `skill` finding when both moved, each naming its own files. The same
  diagnosis (per-file `[N changed (…)]` detail and the `COWORK_HARNESS_DEBUG_SKILLHASH` hook) now also runs on
  the `replay` lane, which previously had a separate, less-detailed copy. With `COWORK_HARNESS_AGENT_SCOPE=skill`
  a changed `agents/<skill>.md` is attributed to that skill, matching the hash boundary.

### Changed

- **`replay --fail-on-skill-drift` no longer fails on a `COWORK_HARNESS_GITSET` / `COWORK_HARNESS_AGENT_SCOPE`
  flip.** A record-vs-verify mismatch in either setting is now classed `format` ("re-record under the same
  mode") rather than misattributed to skill/shared drift, so it is a non-failing warning under
  `--fail-on-skill-drift` (which targets skill-source drift only). It still fails under `--strict` and still
  reds `verify-cassettes`. Previously the `replay` lane mislabeled such a flip as `shared-root`/`skill` and
  failed the skill-drift gate.

## [0.14.0] — 2026-06-25

### Added

- **`replay` surfaces staleness + skipped assertions in JSON.** Each `--output-format json` result now carries
  `staleness[]` (class-tagged: `baseline` / `skill` / `shared-root` / `format` / `unverifiable-baseline` /
  `unverifiable-skill`) and `skippedAssertions` (`{full, partial}`), so a token-free CI gate can see a stale
  cassette or live-only assertions it didn't evaluate WITHOUT the verdict changing — a stale but otherwise
  passing replay stays `ok:true` by default. Previously these were stderr-only `::warning::` lines invisible
  to a JSON consumer.
- **`replay --fail-on-skill-drift`.** A narrower release gate than `--strict`: fails only on skill-source drift
  (`skill` / `shared-root` / `unverifiable-skill` — "can't verify the skill ⇒ not green"), while baseline /
  format / environment-level staleness stays a non-failing warning. `--strict` remains the superset (fails on
  every class).

### Fixed

- **Linter no longer false-flags `requires_capabilities`.** `cowork-harness lint` warned `unknown-top-key` on
  the valid scenario field `requires_capabilities` (its hand-maintained top-level-key list had drifted from the
  schema). The list is now generated from the Zod `ScenarioObject` schema (like the assertion-key list), so it
  can't drift; a parity test guards it.
- **SKILL.md capability pre-flight wording corrected.** It described `requires_capabilities` as skill-declared
  and said the harness "warns before the run"; it is a **scenario field** and the harness **aborts before the
  paid run (exit 3)** when the image omits a required capability (unless `allow_missing_capability: true`). The
  authoritative `docs/scenario.md` was already correct.

## [0.13.0] — 2026-06-25

### Added

- **`inspect <run-id | run-dir>` — see what a run produced.** Lists the run's artifacts and prints a shallow
  field preview of each JSON artifact (scalars inline, arrays as a count, nested objects collapsed), so
  "did it do the job?" is a first-class check instead of hand-parsing `…/mnt/outputs/...`. `--output-format
  json` emits a structured digest. When the work dir was torn down (a non-`--keep` container/microvm run),
  the artifact manifest still prints from `result.json` and the preview notes it's unavailable.
- **A whiffed gate no longer discards the paid run.** When a run exits on an unanswered gate
  (`on_unanswered: fail`), the harness now salvages a **PARTIAL** `result.json` (+ `run.jsonl`/`trace.json`)
  with the artifacts the agent wrote before the whiff, then still exits 2. The run dir is printed so you can
  `inspect` it. `partial` and `unansweredGate` are new `RunResult` fields; `verify-run` and `scaffold`
  refuse to treat a partial run's half-finished output as a passing result (scaffold still emits the gates,
  drops the artifact/result asserts, and warns loudly).
- **Capability pre-flight — fail fast.** A skill that declares `requires_capabilities` against an image that
  provably omits them now **aborts before the (paid) run** (`exit 3`) instead of running ~12 min to a verdict
  that's already known — unless the scenario asserts `allow_missing_capability: true`, which downgrades it to
  a notice and proceeds. `doctor` also surfaces the full-parity remedy on its agent-image line.

### Changed

- **LLM decider tolerates a near-miss label.** `--decider-llm` now binds a reply like `Confirmed.` or
  `"Confirmed"` to the label `Confirmed` (trailing sentence punctuation / surrounding quotes trimmed before
  matching) instead of failing loud — common on binary confirm gates. The `:` of the `OTHER:` free-text
  sentinel is never stripped, and fuzzy substring matching stays off, so the change can't mis-bind. The
  tolerance lives in `matchLabel` itself, so the web_fetch-approval path gets it too (a `Deny.` reply now
  binds `Deny`).
- **`runs gc` → top-level `prune`; the `runs` namespace is dropped.** Pruning accumulated run dirs is now
  `cowork-harness prune [--keep-last <n>] [--dry-run] [<runs-dir>]` (same flags). `runs` was a namespace with
  a single member and collided confusingly with `run` (execute); removing it leaves `run` = execute,
  inspection verbs (`trace`/`inspect`/`verify-run`/`scaffold`) top-level, and `prune` for cleanup.

### Fixed

- **Session-protocol over-cap test no longer flakes.** The over-cap control-out test read
  `control-out.jsonl` synchronously, but the stream opens it asynchronously (`createWriteStream`, flags
  `"a"`), so under load the file may not exist yet at the read — a flaky ENOENT. The over-cap frame is
  rejected before any write, so a missing file means nothing was written; the test now treats absence as
  empty.

### Docs

- **Documented the LLM-decider free-text path.** `--decider-llm` supplies free text via `OTHER: <value>`
  on an options-bearing gate; a bare out-of-set answer (no matching label, no `OTHER:`) fails loud
  (`UnansweredError` → exit 2), never stalling or guessing, and open-ended (no-option) gates need no
  prefix. Noted in the decider section of `fidelity-and-answers.md` and cross-referenced from the lone
  `OTHER:` mention in `SKILL.md` so the two don't drift.
- **Documented the live real-document validation workflow.** A new SKILL.md section covers driving a skill
  against real input documents (not recording a cassette): explore with `--decider-llm --intent`, script the
  load-bearing and binary-confirm gates, budget ~1 re-run per file (a whiffed gate now salvages a partial
  run), and `inspect` the outputs to judge correctness.

## [0.12.0] — 2026-06-24

### Added

- **`record` now shows the offered options when a scripted answer matches none.** A `choose:` that names no
  offered option previously failed with just "matched no offered option" — you had to dig through
  `events.jsonl` for the real labels. The error now lists the **valid labels** and suggests the **closest
  match**, so you can fix the anchor from the error alone. (The labels were already on the error object; the
  record path just wasn't printing them — `run`/`skill` already did.)
- **`doctor` detects the git-worktree `.env` trap.** Running from a git worktree where `./.env` is gitignored
  (so absent) yields "no token"; when the **main checkout** has a `.env`, `doctor` now points you at
  `--dotenv <main>/.env` instead of the generic remedy. (Keychain hint still takes precedence on macOS.)
- **`scaffold` stamps a provenance header on generated scenarios.** Output now carries a
  `# generated by cowork-harness v<ver> (scaffold)` comment (a comment, since the scenario schema is
  `additionalProperties: false`), mirroring the cassette's `generator`/`$schema`/`cassetteVersion` provenance.
  The shipped `example-pdf-skill` replay cassette — previously a hand-authored legacy fixture with no
  signature and a stale embedded scenario — was re-recorded live so it now carries a genuine v6 signature +
  fingerprint/artifacts/userVisibleRoots and matches the current scenario YAML (replays green;
  `verify-cassettes` clean).

### Changed

- **`verify-run` answer-coverage now refuses against a *stale* kept run.** Every run persists a skill
  fingerprint in `result.json`; on the answer-coverage path (`answers:` declared), `verify-run` recomputes it
  live and, if the skill source changed since the run was kept, **exits 2** ("the kept run predates the current
  skill") instead of vouching for answers against a stale gate snapshot. ⚠️ This closes a false-green: a
  reworded/moved gate after `--keep` would previously green against the old labels. The plain `assert:`-only
  re-eval (no `answers:`) is unaffected; a kept run recorded by an older harness (no fingerprint) → a warning,
  not a refusal. `RunResult.fingerprint` is the new persisted field.

### Parity

- **Synced the platform baseline to Claude Desktop 1.15200.0** (`baselines/desktop-1.15200.0.json`). The
  staged agent ELF is **unchanged (2.1.181)** — the bump is host-side: `sync` re-derived egress / gates /
  mount / web_fetch facts (no `unknown delta`; only the `asarFingerprint` moved). Re-verified end-to-end —
  the live scenario suite (`protocol` + `container` tiers) passes against the new baseline.
- **Re-paraphrased the reconstructed system-prompt + subagent appends for 1.15200.0**
  (`baselines/prompts/desktop-1.15200.0/`). Cowork's identity constant was rewritten **first→third person**
  (it no longer says "powering Cowork mode"; the load-bearing "is NOT Claude Code" correction is kept);
  `file_handling` became a scratchpad-vs-workspace split, and `working_with_user_files` / `product_information`
  blocks were added; the subagent-append VM clause changed to "not on the user's real computer." Host-only
  affordances (`request_cowork_directory`, `computer://` links) are described as behavior, **not** injected as
  instructions, so they don't induce dead tool calls on the container / microvm / protocol tiers. The host-loop
  `## Shell access` generator was re-verified **byte-identical** (one new conditional sentence stays omitted —
  our single-container topology never triggers it; comment + verification stamp refreshed).

### Fixed

- **Baseline-bump-stable staleness tests.** `staleness-roundtrip`, `manifest`, and `agent-scope` round-trip
  tests hardcoded the baseline version (`1.14271.0`), so adding a new latest baseline re-staled them; they now
  source it from `loadBaseline("latest")`, so a parity bump no longer breaks the green round-trips.
- **`example-pdf-skill` asserts the workspace deliverable correctly.** The scenario connects a folder, so
  `{{workspaceFolder}} = mnt/project` and the model writes the deliverable into the folder
  (`mnt/project/outputs/actions.md`), not `mnt/outputs` — but the assert was `file_exists: outputs/actions.md`
  (anchored at `mnt/`), so it failed. Switched to `user_visible_artifact: project/outputs/actions.md` (spans
  the user-visible roots). A pre-existing scenario bug (fails identically on the old prompt), not a parity
  regression; the `{{workspaceFolder}}` resolution is faithful to the Desktop builder `y8r`. Docs + skill now
  teach `user_visible_artifact` vs `file_exists` for folder-connected deliverables.

### Docs

- **Baseline-pin sweep to `desktop-1.15200.0`** across README / DESIGN / SPEC / spawn-contract / skill docs
  (agent ELF still 2.1.181). The `≥1.14271.0` mount/bare-name gate-boundary references are intentionally left
  as-is — that boundary did not move.
- Skill + scenario docs: the gate-centric answer-coverage currency rule; the cheap `--keep` → `trace
  --view questions`/`verify-run` authoring loop (no token-free gate probe exists — gates are model-decided);
  the mismatch-vs-unanswered hard-fail gotcha; "anchor only assert-relevant gates, prefer `on_unanswered:
  first` elsewhere"; the keep-going batch semantics (`record <dir>`/`--rerecord-stale` record all and report
  at the end — no one-at-a-time wrapper needed); and the git-worktree `.env` gotcha.

### Security

- **Hardened HTML-comment stripping in prompt assets (CodeQL `js/incomplete-multi-character-sanitization`).**
  A one-shot `.replace(/<!--[\s\S]*?-->/g, "")` is incomplete multi-character sanitization: removing an inner
  comment can recombine surrounding fragments into a fresh `<!--` the single pass leaves behind (e.g.
  `<!<!-- -->-- x -->` → `<!-- x -->`). `stripComments` now loops until the string stabilizes and is shared
  from `prompt.ts`; `hostloop.ts` reuses it instead of a duplicated inline regex. Resolves the finding at both
  call sites; a regression test covers the recombination case.

## [0.11.0] — 2026-06-24

### Added

- **`record --concurrency <N>` — parallel fleet re-records.** A directory batch (or `--rerecord-stale`) can
  now record N cassettes at a time (`record cassettes/ --rerecord-stale --concurrency 3`) instead of one ~7–8
  min run after another. Every run is already fully isolated (its own per-run Docker networks + egress proxy,
  its own session dir), so parallelism is safe; `--concurrency` is purely a **bound** against Docker's address
  pool and model API rate limits. Default `1` (unchanged behavior + ordered output), max `8`. A dir batch
  where two scenarios' `name:` slugify to the same cassette path is now rejected up front (they would clobber
  each other — a pre-existing footgun parallelism would have surfaced).
- **Opt-in per-skill agent scoping for cassette staleness (`COWORK_HARNESS_AGENT_SCOPE=skill`).** By default a
  plugin's `agents/` directory is a fleet-wide staleness root, so editing one skill's sub-agent contract
  (`agents/cap-table.md`) re-stales *every* cassette. With this env set, a **skill-named** `agents/<name>.md`
  is treated as skill `<name>`'s private input (refining a scenario's `skills:` scope), so it re-stales only
  that skill's cassettes; generic (non-skill-named) agents stay shared. The setting is stamped into the
  cassette fingerprint (`agentScope`), so flipping it is an honest one-time "re-record under the same setting"
  (like `COWORK_HARNESS_GITSET`); cassettes recorded without it are unaffected. Caveat: assumes an agent named
  after a skill belongs to that skill — keep it off if you share a skill-named agent across skills.

### Fixed

- **Clarified `verify-run` answer-coverage docs (gate-centric, not rule-centric).** `verify-run` checks that
  every gate the run *actually fired* is covered by a matching `answer`; it does **not** penalize answer rules
  that no fired gate matched (e.g. rules for conditional gates that didn't fire). The behavior was always
  correct; `docs/scenario.md` now states it precisely (a scenario with 5 rules whose run fired 2 gates passes
  at "2/2 matched").

## [0.10.0] — 2026-06-23

### Added

- **Stall-on-question verdict axis.** A run that ends on an unanswered plain-text question (final
  assistant turn ends with `?`, no tool calls, no structured `AskUserQuestion`) previously reported
  `result: "success"` — a false green. Runs now carry `stalledOnQuestion`, and a new **`stalled`**
  verdict signal (both the live and replay lanes) fails such runs by default. The detector re-derives on
  the replay re-drive, so cassettes stay consistent. Opt out per scenario with the **`allow_stall`**
  verdict modifier when a trailing question is the expected, acceptable ending. ⚠️ This can flip a
  scenario that was previously green to red — set `allow_stall: true` to restore the prior verdict. The
  published contract is updated accordingly: `schema/run-result.json`, `schema/scenario.schema.json`, the
  `assertion-keys.json` modifier list, `SPEC.md`, and the `docs/scenario.md` success formula now document
  the verdict-signal layer.
- **`lint` advisory for order-dependent positional `choose`.** `scenario.py` now parses `answers:` and
  flags a positional `choose` (`first` / index) as order-dependent — reconciled with `docs/scenario.md`'s
  guidance to prefer positional `choose` when option labels drift. Advisory only; it does not fail the lint.
- **Documentation completeness:** `record --dry-run`; the `COWORK_HARNESS_FIDELITY` / `_MODEL` /
  `_OUTPUT_FORMAT` environment variables; the `examples/scenarios/` lint path and its `python3`
  prerequisite; and links to `RELEASING.md` and the CI recipe.
- **`record` can answer gates live** instead of pre-scripting every answer: `--decider-dir <dir>`
  (a driving agent answers in-band; single scenario), `--decider-llm [--intent "…"]` (a model answers),
  and `--on-unanswered fail|first`. This removes the discovery-run → encode-answers → record dance for
  cassette authoring. When a gate is actually answered by a live decider (or an `--on-unanswered first`
  auto-pick), the cassette is stamped with an `authoring.nonDeterministic` provenance field and a warning
  notes that re-recording may drift — the cassette itself still **replays deterministically** (the answers
  are frozen). `--decider-*` flags are rejected with `--rerecord-stale`, and `--decider-dir` with a
  directory batch. The `record` help also clarifies that `--allow-failing` only relaxes the post-run
  verdict gate — it does **not** salvage an unanswered gate.
- **`verify-run` now also checks answer coverage.** When a scenario declares `answers:`, `verify-run`
  validates that each scripted answer still matches a gate the kept run actually fired (parsed from the
  run's `events.jsonl`, which retains the offered option labels). A drifted `when_question` or a `choose:`
  that names an option the run never offered now fails in ~1s instead of on a paid re-record. ⚠️ This
  **changes verify-run's exit-code contract**: a run green on `assert:` can now exit `1` on an answer
  mismatch. A scenario with no `answers:` is unaffected (assert-only, exactly as before); if a scenario
  declares answers but the kept run dir has no `events.jsonl`, `verify-run` refuses (exit `2`) rather than
  vacuously passing.
- **`doctor` detects the macOS Keychain first-run trap.** A Claude Code login writes the OAuth token to the
  login Keychain, but the in-Docker agent can only read env / `.env`. When the env has no token **but** a
  `Claude Code-credentials` Keychain entry exists, `doctor` now points you straight at copying it into
  `./.env` instead of a dead-end "set a token" remedy. Read-only probe (status only; the secret is never
  read or printed).

### Changed

- **`lint` no longer requires a separately-installed PyYAML.** A pure-Python copy of PyYAML is bundled with
  the linter (`scenario.py`), so `cowork-harness lint` works on a stock `python3` with no `pip install`
  (npm consumers / bare CI). A system PyYAML is still preferred when present.
- Upgraded to **zod 4** (runtime dependency). Scenario/session validation behaviour is unchanged.
- Regenerated `schema/scenario.schema.json` and `schema/session.schema.json` with zod 4's native JSON Schema
  generator. The published schemas are now flat draft-07: the `#/definitions/CoworkHarnessScenario` /
  `CoworkHarnessSession` wrapper is gone; nullable fields render as `anyOf: [{string}, {null}]` rather than
  `type: ["string", "null"]`; loose objects use `additionalProperties: {}`. `required` still lists only
  genuinely-required fields (defaulted fields excluded), and strict objects keep `additionalProperties: false`.
- Retired deprecated zod-3 APIs internally (`.passthrough()` → `z.looseObject`, `.strict()` → `z.strictObject`,
  `z.ZodIssueCode.custom` → `"custom"`). No behavioural change.

### Fixed

- **Cassette writes are now atomic** (temp file + rename) at the `record` and `rehash` sites, so an
  interrupted write can no longer leave a truncated or corrupt cassette on disk.
- **`runs gc` ranks real runs ahead of empty scaffold dirs.** A run with a `result.json` or `events.jsonl`
  is retained ahead of a newer empty scaffold directory, so a completed run no longer loses a keep slot to a
  newer empty one. `--keep-last` remains a hard cap.
- **Reworded the `manifest-needs-snapshot` lint message** to a conditional caveat — the linter is static and
  cannot read the cassette, so the message no longer asserts a snapshot is missing when it may not be.
- **Corrected the `lint` help text's exit-code note.** `127` means `python3` itself is missing; a
  PyYAML-missing failure exits `2`. The previous help conflated the two (and PyYAML is now bundled anyway).

### Security

- Cleared 5 Dependabot advisories in the dev toolchain by upgrading vitest (2 → 4); also bumped the build
  toolchain (typescript 5 → 6, @types/node 22 → 26, actions/checkout 6 → 7). All dev/CI-only — not shipped in
  the published package.

## [0.9.0] — 2026-06-22

### Breaking changes

- **Cassette staleness fingerprint bumped to format v6 (re-record once).** The skill-hash boundary changed,
  so committed cassettes recorded before this release report `recorded under an older hash format — re-record
  once`. Drivers: (1) **OS-junk** files (`.DS_Store` / `Thumbs.db` / `desktop.ini`) are excluded from
  `skillHash` — an out-of-band OS metadata touch can no longer re-stale a cassette (the "fresh cassette is
  immediately stale" bug); (2) **`contentSig` is unified onto the same walk as `skillHash`** (same file set,
  plugin.json `version` stripped, in-tree symlinks hashed by target) — `rehash` cannot bridge this algorithm
  change, so a pre-v6 cassette gets an honest *"algorithm changed — re-record"* (not "content changed"); (3)
  the **git-tracked file set is the default boundary** (see Added).
- **Git-tracked staleness/mount boundary is now the DEFAULT.** When a skill/plugin source dir is in a git
  work tree, both the staleness hash and the sandbox mount use only its **git-tracked** files (untracked
  scratch / build output / OS-junk are excluded from both, so they can't drift the hash or leak into the
  sandbox). A dir that isn't a git repo falls back to the raw walk automatically. Opt out with
  `COWORK_HARNESS_GITSET=0`.
- **Removed the legacy CLI aliases.** `assert` → use `assertions`; `replay --cassette <file>` → pass the
  path positionally (`replay <file | dir/>`); `verify-cassettes --privacy-only` / `--staleness-only` →
  `--skip-privacy` / `--skip-staleness`. (0.8.0 had documented the latter two groups as renamed/removed but
  the code still accepted the old forms; they are now gone. Each removed alias exits `2` if used.)
- **`assertions --list --output-format json` now reports `command: "assertions"`** (was the stale
  `"assert"`) — a JSON-envelope contract fix for anything keying on the `command` field.
- **`decide` exits `2` (not `1`) on a runtime error**, matching the documented "usage / runtime → `2`"
  contract. No-match / abstain still exits `1`.

### Added

- **`cowork-harness/secrets` package export** — `scrubField` and `collectSecrets` are now importable as a
  declared subpath (`import { scrubField, collectSecrets } from "cowork-harness/secrets"`) for custom
  redaction pipelines, with the documented usage corrected to `scrubField(value, collectSecrets())` (a bare
  `[token]` array misses secrets embedded in encoded fields). Adding the `exports` map also **bounds the
  package's public surface to this one subpath** — deep imports into `dist/` (`cowork-harness/dist/...`),
  previously resolvable by accident, are now private. The CLI (`bin`) is unaffected.
- **`lint` accepts a directory** — it expands to the directory's `*.yaml` / `*.yml` scenarios
  (non-recursive, sorted), the same file-or-dir ergonomics as `replay` / `verify-cassettes`. An empty
  directory is a loud error, never a vacuous "0 files = clean" pass.
- **Staleness now names the EXACT changed file.** A per-file manifest (`fileSigs`) in the cassette fingerprint
  lets `verify-cassettes` report e.g. `skill files changed since record — 1 changed (skills/x/SKILL.md)`
  instead of a coarse bucket message (appended to the existing shared-vs-scoped diagnosis). Manifest paths are
  root-relative and are scanned + redacted with the same privacy layer as `skillSources`. Omitted (with a
  loud `fileSigsOmitted`) above an internal size cap.
- **`COWORK_HARNESS_DEBUG_SKILLHASH=1`** — on a staleness mismatch, dumps the exact file set feeding the hash
  to stderr and flags OS-junk, so a drift source is one line instead of a black-box hunt (a one-line hint
  points to it when the flag is off).
- **`COWORK_HARNESS_GITSET=0`** — opt out of the new default git-tracked boundary (see Breaking) back to the
  legacy raw filesystem walk for every dir.
- **`requires_capabilities` scenario assertion** — fail a scenario unless the running tier provides *and can
  verify* the declared capability families (e.g. `office_convert`, `pdf_tables`). The unmet set is persisted
  in the run result (`requiresCapabilityUnmet`), so `verify-run` can't false-fail; opt out with the
  `allow_missing_capability` verdict modifier when the skill's fallback is genuinely equivalent.
- **LLM decider `OTHER:` free-text directive** — on an options-bearing gate, a decider answer of
  `OTHER: <text>` is matched to a label first, else passed through as free text; a bare out-of-set value
  still fails loud.

### Fixed

- **`doctor --tier microvm` now checks the right prerequisites.** It previously probed the Docker daemon +
  agent image + egress-proxy image for every live tier, but the `microvm` (L2) tier runs on **Lima / Apple
  Virtualization.framework**, not Docker — so it could report "not ready" on a Lima-only host, or "ready"
  with no Lima installed. `microvm` now checks `limactl` (honoring `COWORK_LIMACTL`) + the staged agent
  binary, and skips the Docker checks; `container`/`hostloop`/`cowork` are unchanged.
- **A freshly recorded cassette no longer reports `[stale]` immediately** because the OS rewrote a `.DS_Store`
  (or other OS-junk) in the skill tree — OS-junk is excluded from the skill hash. A chronic false-positive
  that pushed consumers to WARN-only (which then masked real drift).
- A standalone verdict-modifier assertion (e.g. `allow_l0_plugin_divergence: true`) no longer false-fails
  as "empty assertion", and verdict modifiers no longer trigger a misleading "filesystem/egress skipped"
  warning on the replay lane. The verdict modifiers are now single-sourced from one list (`assert.ts`,
  `cassette.ts`, and the Python linter all derive from / are checked against it), guarded by a convention
  test against drift.
- **A tail-end transport drop is no longer conflated with an agent failure.** A connection closed *after* a
  clean result is classified as `resultErrorKind: "transport"` (vs `"agent"`) and surfaced as a
  lane/assertion-aware `transport_error` verdict — still a failure (no false-green), but distinguishable from
  a genuine skill error; a non-matching envelope falls back to the agent classification.
- **Clearer guard / capability legibility.** The run footer lists only guards that actually ran this lane
  (`capabilityProbe: definitive | unverified | skipped`) — never a false check-mark for a guard that didn't
  run; capability notices state their own safety net + all-clear with verdict-impact tags; the unbuilt `max`
  tier is dropped from capability hints; and Docker pool-exhaustion is reframed as a concurrency limit, not a
  leak.
- **Ordered interrupt cleanup.** A `SIGINT` / `SIGTERM` during a live run reaps in-flight egress resources in
  order (container thunks before network thunks) and announces itself, instead of leaving them dangling.

## [0.8.0] — 2026-06-21

### Breaking changes

- **Work folders now mount at `mnt/<folder-name>`, not `mnt/.projects/<id>`; the folder `to:` field is
  removed.** Binary-verified (asar 1.14271.0): real Cowork mounts each connected work folder at a
  collision-resolved **basename** of its canonical path (e.g. `mnt/project`) with no author-chosen name —
  so the session-schema `folders[].to` override is GONE (it had no Cowork analog; names are always derived).
  Same-basename folders are disambiguated tier-accurately (host-loop keeps the first bare, the VM/container
  tier escalates both with a `--parent` prefix). Plugins likewise move from the synthetic
  `mnt/.local-plugins/cache/<…>` to the real `mnt/.local-plugins/marketplaces/<marketplace>/<plugin>` (no
  `cache/`, no version segment). **Version-gated:** this applies to Desktop **≥ 1.14271.0** (current
  baselines); older baselines keep the legacy `.projects/<id>` + `cache/` paths. `user_visible_artifact`
  and the artifact manifest now derive their visible roots from the actual mount set (persisted as
  `RunResult.userVisibleRoots`), and the cassette format bumps **v3 → v4** to store them.
  - *Upgrade note:* remove `to:` from `folders[]` in session files (the name derives from the folder
    basename). Reference connected-folder artifacts as `<folder-name>/…` (e.g. `project/summary.md`) instead
    of `.projects/<id>/…`. A folder-artifact cassette recorded before v4 must be **re-recorded** (`rehash`
    cannot migrate it — it only re-hashes skill fingerprints). A connected folder whose basename collides
    with a reserved Cowork mount name (`outputs`, `uploads`, `.projects`, …) on the VM/container tier is now
    rejected loudly instead of silently shadowing the fixed dir — rename the folder.

- **Run output now defaults to `~/.cowork-harness/runs`, not `<cwd>/runs`.** A `run` / `skill` / `chat` /
  `record` launched from a repo no longer drops run artifacts (often sensitive skill inputs/outputs) into the
  working tree — the root moved out of any working tree, matching the `~/.cowork-harness/` convention already
  used for VM work dirs. The root is **flat and machine-global** (shared across every project on the machine),
  not per-project. The readers (`trace` / `scaffold` / `verify-run`) resolve the same default, so a bare
  `trace <run-id>` now works from any directory; the previous cwd-relative / repo-root resolution tiers were
  removed. A one-time `runs → <dir>` line prints on stderr when the default is used (suppressed under
  `--quiet` / `--output-format json`, or when an override is set).
  - *Upgrade note (CI / scripts):* anything that reads `./runs` after a run — a CI `upload-artifact path: runs/`,
    a glob over `runs/**`, a `.gitignore` entry — must now set **`COWORK_HARNESS_RUNS_DIR`** (or pass
    `--run-dir`) to a workspace path so output lands where it's expected. Otherwise the step finds an empty
    `./runs` (and, if it doesn't fail on empty, passes silently). The bundled CI recipe sets
    `COWORK_HARNESS_RUNS_DIR: runs` on the live-scenario job for exactly this reason.

- **Agent image bumped `cowork-agent-base:1` → `:2` — REBUILD REQUIRED.** The image now mirrors the real
  Cowork rootfs's preinstalled toolchain (binary-verified by mounting the rootfs): **Node 22.22.3** (was
  ubuntu's node 12), the full **Python document/data stack** (openpyxl/pandas/numpy/pdfplumber/python-docx/
  python-pptx/matplotlib/…), node doc-gen globals (pdf-lib/pptxgenjs/sharp/tsx/…), `ruby`/`ffmpeg`/`qpdf`,
  `C.UTF-8` locale, and it now runs as **uid 1000 (`ubuntu`)** like the real VM. Rebuild with the command
  `cowork-harness doctor --tier container` prints, or set `COWORK_AGENT_IMAGE` to your own tag. *(Why: the
  real rootfs ships openpyxl etc. preinstalled — omitting them made skills that read `.xlsx`/PDFs falsely
  appear degraded under the harness. "pypi blocked at runtime" ≠ "not preinstalled.")*
- **A green run that uses a capability the agent image OMITS now FAILS** (verdict signal `missing_capability`),
  mirroring `permissive_auto_allow`/`l0_plugin_divergence`. The default "core" image omits the heavy lane
  (OCR/LibreOffice/markitdown/opencv/PDF-tables); a run that uses one is a likely false negative (real Cowork
  ships it). Suppress per-scenario with **`allow_missing_capability: true`** (when the fallback is equivalent),
  rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`), use the rootfs `max` tier, or skip the check with
  `COWORK_SKIP_CAPABILITY_PROBE=1`. Live tiers only (container/hostloop/microvm).
- **Stricter, fail-loud guardrails from the codebase bug-review sweep — a few previously-silent paths now
  error.** These close false-greens / false-accepts and can surface on an existing setup:
  - **Negative `verify-run` assertions fail on *missing* evidence instead of passing vacuously.**
    `tool_result_not_contains`, `tool_not_called`, `subagent_tool_absent`, `dispatch_count_max`,
    `subagent_declared_but_unused`, `no_delete_in_outputs`, `transcript_no_host_path`, and `self_heal_ran`
    now fail with an "evidence unavailable" reason when the underlying field is absent from a partial/older
    `result.json` (verify-run lane only — the live and replay lanes, where the evidence is always present,
    are unchanged). *Upgrade note:* re-run rather than re-assert against a fresh `result.json` if a verify-run
    flips to this failure.
  - **Non-strict cassette replay now fails on corrupt `controlOut`** — a malformed line, or a duplicate
    `request_id` with differing bodies — instead of warning and proceeding. Corruption is a protocol-fidelity
    failure, not advisory; `--strict` still additionally catches staleness/extra-data.
  - **`chat --raw` now rejects `--upload` / `--folder` / `--plugin` / `--fidelity`** (it can't honor them in
    native mode) instead of silently ignoring them, and an invalid `COWORK_HARNESS_FIDELITY` value is rejected
    loudly instead of silently falling back to `container`. An invalid `COWORK_HARNESS_MAX_ARTIFACT_BYTES` now
    errors (parity with the `--max-artifact-bytes` flag) instead of silently using the default.
  - **A `web_fetch` `approved_domains` / seed entry that isn't a bare host** (a URL, scheme, path, port, empty
    string, or `*` wildcard) is now rejected loudly instead of being added as an inert, never-matching entry.
  - **An over-cap (> 256 KiB) control-out frame now fails the live recording immediately** with a clear error,
    instead of writing an unreplayable truncation marker that only surfaced later as a replay failure.

### Added

- **Capability fidelity detection.** The harness probes the agent runtime (Docker image via `--network none`
  run, or the L2 microVM via `limactl shell`) for the document/OCR/Office capabilities the real Cowork rootfs
  ships, caches the result by `(tier, identity)`, and detects (from `events.jsonl`) when a skill used an
  omitted one — surfaced as the new `RunResult.missingCapabilityUse` field, a `::notice::`/`::warning::`, and
  the `missing_capability` verdict above. New assertion `allow_missing_capability`.
- **Opt-in full-parity image** (`docker build --build-arg COWORK_FULL_PARITY=1 -t cowork-agent-full:2`) adds
  tesseract / LibreOffice / opencv / onnxruntime+markitdown / camelot+tabula for OCR/Office/extraction skills.
- **Rootfs `max` tier (`npm run build:rootfs-image`)** — builds a Docker image from the user's OWN
  `rootfs.img` (local, byte-for-byte parity; cached by rootfs mtime+size); point `COWORK_AGENT_IMAGE` at it.
- **Provisioning drift gate (`npm run capture:rootfs`)** — captures the rootfs's toolchain to
  `baselines/provisioning/rootfs-provisioning.json`; `--check <image>` diffs a built image against it.
- **L2 (microVM) toolchain parity** — Lima provisioning now installs the same document/data stack
  (best-effort, with 24.04 version drift accepted).
- **`--run-dir <path>` global flag** to relocate the runs root (a thin shim over `COWORK_HARNESS_RUNS_DIR`).
  Precedence: `--run-dir` > `COWORK_HARNESS_RUNS_DIR` > `~/.cowork-harness/runs`. Keeps sensitive artifacts out
  of a working tree without the prior `cd`-into-a-scratch-dir workaround. Both spellings (`--run-dir <path>` and
  `--run-dir=<path>`) are accepted; unlike `--dotenv` it does not require the path to exist (it's an output dir).
- **Cross-project overwrite guard for pinned (`--session-id`) sessions.** On the flat shared root a pinned
  `sess-<id>` run dir is deterministic, so two projects can resolve to the same path. The writer now identifies
  a run by its **mounted-source content** (recorded in an `outDir/.origin` marker) and:
  - **errors instead of silently `rm -rf`-ing** a dir that belongs to a different project (the old behavior
    blind-deleted a colliding peer's persisted, resumable session);
  - **fails closed** on a missing/partial marker (a crashed prior run) — it throws with a "delete `<dir>` to
    reset" hint rather than deleting an unconfirmable dir;
  - treats a **sourceless inline scenario** (which has no content to identify it, only cwd) as unconfirmable —
    it throws rather than risk a cwd-collision delete (`skill <dir>` runs always mount the skill, so the common
    pinned workflow is unaffected);
  - blocks **`--resume`** onto a different project's session in place (override with
    `COWORK_HARNESS_ALLOW_FOREIGN_RESUME=1`).
- **`runs gc` never prunes pinned `sess-*` sessions** (and they don't consume a `--keep-last` slot — partitioned
  out before counting, so a retained pinned dir can't evict a newer ephemeral run). Only ephemeral `local_*`
  runs are pruned. Because the default root is now shared, a bare `runs gc` prunes ephemeral runs across **all**
  projects; pass an explicit `<runs-dir>` to scope it.
- **multiSelect `AskUserQuestion` gates are now answerable on every answer channel.** Scripted
  `choose: [list]` already worked; the in-band `--decider-dir` channel now accepts a repeated
  `--choose` (`answer <dir> --gate 1 --choose Auth --choose Audit`), and `--decider-cmd` helpers /
  hand-written `resp-N.json` accept a JSON-array reply (`{"answers":{"<q>":["Auth","Audit"]}}`). All
  channels deliver the binary-verified `", "`-joined wire shape; a member matching no option, an array
  on a single-select gate, or an empty array each fails loud. `cowork-harness answer`'s `--choose` is
  now repeatable for multiSelect gates (still single-only on single-select). Verified end-to-end
  against a live model (the real agent re-reads the joined answer as multiple selections).
- **`scaffold --from-run`** flags a delivered answer that looks like a multiSelect set (contains
  `", "`) with a loud comment telling the author to split `choose: "A, B"` into `choose: [A, B]`
  before replay (a scaffolded multiSelect answer would otherwise not match on replay).

### Fixed

- `doctor`'s staged-agent remedy now hints to put `COWORK_AGENT_BINARY` in `.env` so `--dotenv` covers it
  (like the auth token) — avoiding a misleading "red" when `doctor` is run without the same env/flags the real
  run uses.
- **`--decider-dir` / `--decider-cmd` no longer crash on a multiSelect array reply.** `coerceLabel`
  previously called `.trim()` on a non-string answer and threw a bare `TypeError`, aborting the run;
  it now throws a clear `UnansweredError` instead, and a multiSelect array is validated per-member and
  delivered as the joined wire shape.
- **Codebase bug-review sweep — 49 validated fixes across the harness** (beyond the behavior changes noted
  under Breaking):
  - **CLI parsing:** `vm status --output-format json` works and emits a JSON envelope, instead of misreading
    the flag as a baseline name; `skill` and common flags accept every documented `--flag=value` form;
    `boundary-check` reports a missing/malformed session as a clean (JSON-aware) usage error rather than an
    internal error; `chat` rejects extra positionals and empty/flag-looking value-flag arguments; `parseArgs`
    rejects empty `--flag ""` values.
  - **Path / boundary hardening:** named baselines can no longer escape `baselines/` via `../`; marketplace and
    staged-mount symlinks that resolve out of tree are rejected (realpath, not lexical); collected artifacts
    skip hardlinks (`nlink > 1`) that could inline out-of-root content into a cassette; a new
    `src/boundary-paths.ts` centralizes `safeNamedBaseline` / `containedRealPath` / `normalizeHost` /
    `validateBareDomain` so the egress allowlist and seed-domain paths share one policy.
  - **Protocol / replay integrity:** every control-request validates its `request_id` before replying; the
    AskUserQuestion body is validated at ingress (optionless / header-only gates still pass); a malformed
    cassette no longer aborts the whole replay batch; a `web_fetch` decision of the wrong kind is recorded as
    `mismatch→deny` with a warning; egress host matching is case- and trailing-dot-normalized.
  - **host-loop fidelity:** the `web_fetch` SSRF backstop pins the vetted address through connect (closing a
    DNS-rebind TOCTOU) and re-vets each redirect; a Docker infrastructure failure (daemon down, missing
    container, exit 125) is reported to the model as a generic harness error and logged raw, instead of
    leaking daemon text framed as a normal command exit.
  - **Fidelity drift checks:** the rootfs `--check` diffs the whole Layer-A pip set (generated from the
    Dockerfile) plus Node, the apt doc stack, and global npm; rootfs image tags are content-addressed; the
    capability cache keys on image content rather than a mutable tag; `sync` cleans its temp extraction dir and
    records a drift signal on a corrupt `config.json`.
  - **decider / schema / Python:** `allow_if` predicates accept non-identifier input keys (`input["file-path"]`);
    `choose`+`answer` and inert `grant` are rejected at schema time; optionless prompt/LLM gates are answerable;
    the Python wrapper returns a `BatchResult` for directory/replay runs so a later failure can't hide behind a
    passing first result.
- **Documentation audit sweep — stale references corrected, gaps filled.** Bumped the "current baseline" pins
  across README / DESIGN / SPEC / spawn-contract / skill docs to `desktop-1.14271.0` (agent ELF 2.1.181),
  re-verified end-to-end against the live staged agent at this baseline; added the missing
  `tool_result_contains` / `tool_result_not_contains` and `allow_missing_capability` assertion rows plus a
  verdict-signals (`prompt_asset_missing`) section to the docs; documented `doctor` / `rehash` / `runs gc` and
  exit code `3` in `llms.txt` and the README command table; corrected the SPEC §11 exit-code table
  (`boundary` → `3`), the `chat --folder` / `folders[].to` notes, the `trace --view tools` flag, and the
  skill-bootstrap version floor (`@>=0.7.1`). **CI fix:** the agent-base image build in
  `.github/workflows/ci.yml` was tagged `:1` while every code path defaults to `:2` — now `:2`.

## [0.7.1] — 2026-06-20

### Fixed

- **`file_exists` and `user_visible_artifact` now pass for truncated (large) cassette artifacts.**
  A truncated manifest entry (`truncated: true`) carries `path`, `bytes`, and `sha256` — positive
  proof the file existed at record time. 0.7.0 incorrectly failed these existence/promotion
  assertions with `"was truncated in the cassette — content was not committed; assertion cannot
  pass"`, producing false-REDs for any cassette whose artifacts exceeded the 64 KiB inline cap.
  Only **content** assertions (`artifact_json`) require the inlined body; existence assertions
  now correctly pass from the manifest. `artifact_json` on a truncated artifact continues to fail
  (the 0-byte placeholder is not valid JSON). Regression test added.

## [0.7.0] — 2026-06-19

### Added

- **`chat --plugin <dir>` (repeatable)** — load additional local plugins into a `chat` session alongside
  the primary skill folder. Each `--plugin <dir>` is appended to `plugins.local_plugins` so multi-plugin
  interactive debugging no longer requires a custom session YAML. In `--raw` mode (native Docker), `--plugin`
  flags are silently ignored with a warning: `chat --raw: --plugin flags are ignored in --raw mode`.
- **`/help` in the `chat` REPL** — typing `/help` in an interactive session now prints
  `Commands: /exit  /quit  /help` and continues rather than forwarding the text to the model. The startup
  prompt was updated from "type your message, /exit to quit" to "type your message (/help for commands)".
- **`scrubField(value, secrets)` exported from `src/secrets.ts`** — a new multi-pass field-level scrubber
  that covers token appearances beyond direct substring matches:
  - Pass 1: direct `scrub()` — catches literal, base64-encoded, and `encodeURIComponent`-encoded tokens.
  - Pass 2: whole-field base64 decode (≥20-char pure base64 strings) — if the decoded form contains a
    secret hit, returns `[REDACTED:base64]`.
  - Pass 3: whole-field URI decode (values containing `%`) — if the decoded form contains a secret hit,
    returns `[REDACTED:uri]`.
  Applied in `cassette.ts` artifact scrubbing: base64 artifacts (`encoding === "base64"`) are replaced
  wholesale with `[REDACTED:base64]`, the encoding marker is cleared (so replay decodes as UTF-8), and the
  sha256 is recomputed over the marker bytes (with a `::warning::` that artifact assertions will fail at
  replay). UTF-8 artifacts pass through `scrubField` safely.
- **`prompt_asset_missing` VerdictSignal** — `computeVerdict()` now pushes a `{ code: "prompt_asset_missing",
  severity: "warn" }` signal when `result.fidelityWarnings` contains a "referenced asset not found" entry,
  making a missing prompt asset visible in the verdict output rather than buried in the run log.
- **`onInfraError` callback in `makeWorkspaceHandler`** — an optional sixth parameter
  `onInfraError?: (message: string) => void` lets callers intercept infrastructure errors
  (ETIMEDOUT / killed / no code+stdout+stderr) separately from model-visible error text.
  `spawnHostLoop()` wires this to append `{ type: "infra_error", ts, message }` to `events.jsonl` so
  infrastructure failures are structured and queryable rather than only appearing in the model-visible
  response string.

### Fixed

- **`ExternalDecider` no longer coerces `"first"` to option 1.** `coerceLabel` gained an
  `enableFirstShorthand` parameter (default `true`). External deciders (`--decider-cmd`,
  `--decider-dir` helpers) now call `coerceLabel(raw, labels, false)`, so a helper script that
  accidentally returns the string `"first"` must match an actual label named `"first"` — it is no
  longer silently promoted to the first option. The shorthand remains active for internal (scripted)
  use.
- **`flagValue` and `chat --model` reject empty strings.** `flagValue()` in `src/cli.ts` now exits `2`
  with a clear message when the supplied value is blank or whitespace-only. `chat` additionally guards
  the `--model` value inline after parsing, so `--model ""` and `--model $UNSET_VAR` both fail loudly
  instead of passing an empty model ID to the runtime.
- **`redactCassette` skips `[REDACTED*]` marker bodies.** The per-line JSON redaction pass
  (`redactJsonLine`) is now bypassed for artifact bodies that already start with `[REDACTED` — preventing
  the sha256 from being corrupted by a second redaction pass over the marker string.
- **TLD list extended from 22 to 51 entries.** The domain scanner in `src/scan.ts` now recognises
  major European, Asian, and Latin American ccTLDs:
  `ch|nl|se|no|it|jp|br|nz|in|sg|kr|mx|es|pt|pl|be|at|dk|fi|ie|ru|cn|tw|hu|cz|ro|il|za|ar|cl|pe|tr`.
  Domain findings that were previously missed on these TLDs now fire correctly.

## [0.6.0] — 2026-06-19

### Breaking changes

- **Exit code 3 for boundary/integrity violations.** Commands that previously exited `2` for a
  boundary constraint (e.g. `skill` hitting the egress sandbox, `run` with a `boundary`-category
  failure) now exit `3`. Exit `2` is narrowed to usage errors, unknown flags, and runtime errors.
  Scripts that check `$? -eq 2` to detect boundary failures must be updated to `$? -eq 3`.
- **`verify-cassettes --staleness-only` / `--privacy-only` removed.** Replaced by
  `--skip-staleness` (run privacy scan only) and `--skip-privacy` (run staleness scan only). The
  old flags are not aliased — they now exit `2` as unknown flags.
- **`decide` with no configuration exits `2` instead of `1`.** Previously, calling `decide` with no
  `--decider-*`, `--answer`, or `--answer-policy` would fall through to a `ScriptedDecider([])` and
  exit `1` ("no rule matched"). It now fails early with exit `2` ("no decider configured") and a
  clear message.

### Added

- **`chat` — full flag parity for interactive debugging:**
  - `[prompt]` — optional seed prompt sent as the first turn before the REPL opens.
  - `--upload <file>` (repeatable) — attach a file at `mnt/uploads/<basename>`; live at session start.
  - `--folder <dir>` (repeatable) — connect a project folder at `mnt/.projects/<basename>` as a live bind mount.
  - `--verbose` / `-V` — show thinking blocks, tool inputs, and the sub-agent tree (previously hardcoded off).
  - `--fidelity protocol` — no-Docker fastest tier; accepted alongside `container` and `hostloop`.
  - `--model` in `--raw` mode — previously silently dropped; now passed as `--model <id>` to the docker argv.
  - Idle heartbeat wired in all three fidelity branches (protocol / hostloop / container).
  - Run ID printed at session start (before first turn) so a mid-session crash still tells you where the transcript is.
- **`assertions` command** — canonical rename of `assert`; `assert` is kept as a deprecated alias
  that prints a migration notice. `assertions --list` is the new canonical form.
- **`scaffold <run-id>` positional** — canonical form; `--from-run <id>` is kept as a deprecated
  alias that prints a migration notice.
- **`trace --view tools|questions|dispatches`** — replaces the three separate `--tools` / `--gates`
  / `--dispatches` flags with a single `--view` enum. Legacy flags are kept as backward-compat
  aliases (`--gates` maps to `--view questions`).
- **Env-var defaults for all live commands:**
  - `COWORK_HARNESS_FIDELITY` — default fidelity tier for `skill` and `chat` (validated; exits 2 on an invalid value).
  - `COWORK_HARNESS_MODEL` — default model override for `skill` and `chat`.
  - `COWORK_HARNESS_OUTPUT_FORMAT` — default `--output-format` for all commands (`text` or `json`).
- **`decide` no-decider guard** — calling `decide` with no configuration fails immediately with a
  clear message and exit `2` instead of falling through to a vacuous "no rule matched" exit `1`.
- **`vm` per-subcommand `--help`** — `vm <sub> --help` prints the subcommand usage and exits `0`.
- **`--quiet` / `-q` accepted in `decide`** — no-op flag for flag-surface consistency with `skill` / `run`.

### Fixed

- **`--rerecord-stale` now prefers on-disk scenario over embedded snapshot (G-1).** When a
  `scenarios/<name>.yaml` exists alongside the cassette dir, `--rerecord-stale` re-records from it
  instead of the embedded copy. Edits to the scenario (e.g. adding `skills:` for staleness scoping)
  now take effect. Falls back to the embedded snapshot when no on-disk file is found, with a clear
  warning.
- **Staleness message distinguishes format-version bump from real content change (G-2).** After a
  harness upgrade that changes the hash algorithm, `verify-cassettes` now reports
  `recorded under an older hash format (vN → vM)` instead of the misleading
  `local skill/plugin dir contents changed`.
- **`.cowork-hashignore` leading-slash patterns now correctly anchor to the mount root (G-3).**
  `/tests` previously compiled to a regex that never matched (no leading slash in relative paths);
  it now matches only the top-level `tests/` dir, as expected.
- **Scoped staleness findings now name the changed bucket (G-4).** When a cassette was recorded with
  `skills: [<name>]` scoping, `verify-cassettes` now reports `skills/<name> changed` or
  `shared root changed` rather than the generic `local skill/plugin dir contents changed`.
- **Unknown flags in `chat` now exit `2`.** Previously ignored silently; any unrecognised flag now
  exits `2` with a clear message.
- **`chat --model` bounds-checked.** If `--model` is the last argument (no value following), the
  command now exits `2` with a clear message instead of silently using `undefined`.
- **`cmdSync` platform guard fires before argument parsing.** On non-macOS platforms the guard now
  exits before `parseArgs`, so `sync --help` on Linux no longer crashes on a missing flag.
- **`record` conflict check.** Passing both a positional and `--cassette` now exits `2` immediately
  instead of silently preferring one.
- **L0 plugin divergence signal.** `spawnProtocol` now reports whether the skill resolved at L0
  (no container) vs. L1, so callers can surface the divergence accurately.
- **System-prompt threading.** `systemPromptAppend` is now passed through all runtime paths that
  previously dropped it.
- **Strict agent binary resolution.** When the exact staged binary path is missing, the harness now
  fails with a clear message pointing to `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1` instead of
  silently falling back to an arbitrary sibling version.
- **Path traversal guard on plugin sources.** Plugin source paths are now validated to be
  directories (not files or traversal strings) before mounting.
- **Cassette correctness (batch):** privacy/staleness coverage tracking, redaction verdict
  preservation across re-records, base64-encoded artifact body scanning, and exhaustiveness
  checks on the replay assertion set.

## [0.5.0] — 2026-06-18

### Added

- **`verify-run <run-dir> <scenario.yaml>`** — re-evaluate a scenario's `assert:` block against an
  already-kept run dir with **no live agent** (no tokens, no Docker). Fixing a wrong assertion was a full live
  re-record (~17 min); this turns it into ~1s. Reconstructs the assert context from the run's `result.json` +
  the `run.jsonl`/`trace.json` sidecars and routes the verdict through the same path as a real record. Refuses
  (rather than false-passing) when a filesystem assertion needs a work dir that's already torn down.
- **`record --max-artifact-bytes <n>` / `COWORK_HARNESS_MAX_ARTIFACT_BYTES`** — override the 64 KiB
  inline-body cap so a large structured deliverable can be inlined instead of stored hash-only. Paired with a
  **record-time guard**: if an `artifact_json` asserts an artifact that had to be truncated, record now fails
  (or warns under `--allow-failing`) at the cause, instead of producing a green record that goes red at replay
  (no committed body to parse).
- **`verify-cassettes --allow-domain` / `--allow-email` / `--allow-file`** — class-scoped privacy allows, plus
  a version-controlled allow file (one regex per line, `#` comments).
- **Scoped cassette-staleness fingerprint** — scenario **`skills: [<name>]`** narrows the staleness hash to the
  named skills' dirs plus the plugin's shared roots (fail-closed to whole-tree on an unknown name); session
  **`staleness.hash_ignore`** globs and a plugin-local **`.cowork-hashignore`** file (composed) drop
  non-runtime paths (`tests/`, `docs/`). Default behavior is unchanged (whole-tree, byte-identical). Cassette
  format bumped to **v2** (an older reader warns rather than mis-flagging a scoped cassette as stale).
- **Per-subcommand `--help`** — subcommands now print a usage line and exit 0 instead of answering `--help`
  with `unknown flag` (exit 2).
- **Cowork identity in the system-prompt append** — the emulated agent now self-identifies as "Claude, the
  Cowork assistant" and is told it is **not** Claude Code (verified against the installed Claude Desktop app;
  reconstructed, not bundled).

### Fixed

- **Privacy allows are whole-token + class-scoped.** A bare `--allow <regex>` previously substring-matched, so a
  domain allow (`example\.com`) silently cleared an email finding (`alice@example.com`) whose domain it matched.
  Allows are now anchored to the whole finding token, and `--allow-domain`/`--allow-email` can't bleed across
  classes — the email tripwire stays live.
- **Staleness hash no longer over-fires.** A pure `plugin.json` `version` bump (and, with the new scoping knobs,
  unrelated skills/tests/docs) no longer re-stales every cassette in a multi-skill plugin. *Upgrade note:*
  because the hash now ignores the `plugin.json` `version` field, cassettes recorded before this release
  recompute to a new digest and are flagged **stale once** after upgrading — re-record them
  (`record --rerecord-stale`). The cassette format is also bumped to **v2**.
- **`chat` is pipe/script-safe.** A piped/non-interactive stdin reaching EOF mid-turn crashed the REPL with
  `ERR_USE_AFTER_CLOSE`; it now exits cleanly.
- **Outputs-delete findings show the `rm` itself.** A long `VAR=…` assignment prefix used to push the operative
  delete past the truncation; the finding now isolates and variable-resolves the delete target.
- **Clearer record/run messaging.** The record freeze-refusal separates the run *result* from the *verdict* and
  names the failing signal; the run log states the unscripted-question *policy* instead of reading as a failure
  on clean runs.
- **`sync` warns when a synced baseline lacks its host-loop prompt asset** — previously host-loop records
  silently ran with an empty shell-access section.

### Internal

- Corrected the system-prompt fidelity note in `docs/boundary.md` (Cowork appends onto the `claude_code` preset
  by default rather than replacing it).
- Assertion docs steer content checks to `artifact_json` / stable lexical markers (not paraphrasable prose).
- `vitest` excludes `runs/` from test discovery (ephemeral live output could crash the walk with EACCES).

## [0.4.3] — 2026-06-18

### Fixed

- **`cowork-harness lint` no longer flags `artifact_json` / `allow_permissive_auto_allow` as unknown keys.**
  The linter's assertion-key list is now **generated from the Zod `Assertion` schema** (the same source
  `assert --list` uses) into a file shipped next to `scenario.py`, with a CI drift-guard — so it can't lag the
  schema again. Its replay-class warnings were also reconciled with the 0.3.0 artifact-manifest: `file_exists`,
  `user_visible_artifact`, and `artifact_json` are now treated as **manifest-backed** (replay-checkable when the
  cassette carries an `artifacts` manifest) rather than always-skipped, so a scenario asserting only those is no
  longer a false `replay-noop`. A self-check fails the linter if a future schema key isn't classified.

### Internal

- The npm tarball no longer ships internal planning notes that were accidentally being published.

### Added

- **Platform baseline `desktop-1.13576.1`** — synced from the updated Claude Desktop (the app moved
  `1.12603.1` → `1.13576.1`). `loadBaseline("latest")` now resolves to it. The embedded agent binary is
  unchanged at `2.1.177` (the update changed the app shell + gate states, not the agent ELF); this baseline
  also corrects the prior baselines' stale `2.1.170` agent pin to the actually-staged `2.1.177`. Egress
  allowlist unchanged.

## [0.4.1] — 2026-06-18

### Fixed

- **Agent-binary newest-staged fallback now applies on the real runtime paths** (container / hostloop, and
  thus `skill` / `run` / `chat`), not just `sync`/tests. `resolveAgentBinary` had two private duplicates
  (`container.ts`, `hostloop.ts`) **without** the 0.4.0 fallback, so a host with a newer staged
  `claude-code-vm/<ver>` than the baseline expects still hard-failed with "Staged agent binary not found".
  The duplicates were consolidated into the single exported resolver; a host that has staged a newer build
  now falls back to it (with a warning) instead of failing. A structural test + CI guard prevent the
  resolver from being re-duplicated.

## [0.4.0] — 2026-06-18

The parsing/validation hardening + safety release: a current-tree code-review sweep plus fidelity and
robustness findings from real skill-testing sessions — uniform fail-loud CLI parsing (enforced by a
structural test + CI guard), a centralized staging-source resolver, cassette replay/manifest safety
(base64 + containment + hash-verify), egress SSRF/DNS-rebind hardening, `replay <dir>`, and `cowork-harness lint`.

### Added

- **`cowork-harness lint <scenario.yaml>…`** — the bundled scenario linter/scaffolder (`scenario.py`) is now
  shipped in the npm package and reachable as a first-class subcommand, so a consumer who `npm i`s the harness
  (with no skill checkout) can run the no-silent-false-green checks in CI. Needs `python3` + PyYAML; a missing
  interpreter fails with a clear, actionable message.
- **`replay <dir>`** — `replay` now accepts a directory and replays every `*.cassette.json` in it (sorted,
  non-recursive), exiting on the worst per-cassette verdict, in addition to the existing `--cassette <file>`
  form. An unreadable cassette is reported per-file and forces the JSON envelope's `ok:false` (never a vacuous
  pass), and never aborts the batch.
- **A shipped `protocol`-tier example** (`examples/scenarios/protocol-smoke.yaml` + its session) — the first
  zero-Docker/zero-agent worked example for the L0 tier (a scripted answer reaches the model, a tool runs, a
  file is written), with the host-path leak owned via `transcript_no_host_path: false` to illustrate exactly
  what protocol fidelity does and does not seal.
- **Documentation for previously-undocumented surfaces:** `sync --allow-empty`, `boundary-check --session`,
  `decide`'s `--decider-dir` rejection, `verify-cassettes`'s non-recursive scan, `replay` (one file vs
  `record` batching), `gates` raw-output (no envelope), `gate_answers_delivered: false`, python
  `run_scenario()`, six public reproducibility env vars, and HELP text for `chat --fidelity/--model` and
  `sync --allow-empty`. Plus a zero-dependency "try it in 10s" `replay` lead in the README quick start.

### Changed

- **Uniform CLI argument validation.** A shared declarative argument parser backs the cassette commands
  (`record`/`replay`/`verify-cassettes`) + `boundary-check`, and **every** command now rejects unknown flags,
  extra positionals, and flag-looking values for path/id flags instead of silently ignoring them — closing a
  class of silent-accept parsing footguns. This is enforced going forward by a structural test (every command
  must reject an unknown flag) and a CI grep-ban on the legacy first-non-dash-token idiom. Error paths only;
  valid invocations are unchanged.
- **The npm package ships `scenario.py`** (the linter/scaffolder) and publishes with provenance attestation so
  CI consumers can lint without a skill checkout.
- **Agent-binary discovery falls back to the newest staged build.** When the baseline's exact
  `claude-code-vm/<ver>/claude` is absent (e.g. Cowork staged a newer build), the harness now uses the newest
  staged sibling with a warning instead of hard-failing; `COWORK_AGENT_BINARY` still takes precedence.
- **`chat --fidelity` now validates its argument** — a value other than `container`/`hostloop` is rejected
  (exit 2) instead of being silently coerced to `container` (a fidelity footgun).
- **`assert --list`** now describes `replay_protocol_fidelity` as replay-only and **not authorable** (it is
  synthesized by the replay lane and rejected if written in a scenario).

### Fixed

- **CLI parsing hygiene across commands.** `run` now treats an empty scenario directory as a loud non-zero
  (was a vacuous exit-0 pass); `record`/`verify-cassettes`/`gates` no longer mistake a `--output-format`/
  `--allow` value for the positional target; `trace` rejects mutually-exclusive view flags and extra targets;
  `scaffold`/`assert --list` validate `--output-format` and reject stray arguments; `decide` rejects unknown
  flags, stray positionals, `--intent` without `--decider-llm`, an `--decider-llm`+`--answer` conflict, and a
  flag-looking `--decider-cmd` value; `vm` validates its subcommand before loading a baseline; `boundary-check`
  rejects unknown flags; the global `--dotenv=<path>` equals form is accepted; and `--output-format=<x>`
  validates the value rather than silently degrading to text.
- **Cassette replay safety.** `replay` routes reads through the safe cassette reader (a malformed cassette is a
  clean error, not an internal crash); a lenient schema guards the dereferenced `scenario`/`events` fields and
  a missing optional `assert` is normalized so it can't crash a batch; manifest bodies are stored with an
  encoding marker (binary as base64) so non-text artifacts round-trip byte-exactly; materialized entries are
  path-contained (no `..`/absolute escape) and verified against their recorded sha256.
- **Skill-staleness hash no longer self-invalidates.** The `skillHash` fingerprint now excludes recorded
  cassettes (`*.cassette.json`, by extension) and VCS/cache dirs (`.git`/`node_modules`/`__pycache__`/…), so
  writing a cassette under the hashed skill tree no longer changes the fingerprint it just recorded (and a
  repo that co-locates committed cassettes with the skill stops falsely tripping the staleness gate). Real
  skill-source edits — including under a `tests/` dir — still change the hash (kept conservative: no
  false-negative).
- **Staging source validation.** Every declared session source now resolves through one central choke point
  (`resolveDeclaredSource`, guarded by a structural test): `mcp.config` must be a file; connected folders,
  local/remote plugin roots, and local skills must be directories; a nameless marketplace manifest now
  resolves and qualifier-matches by its derived name; and a corrupt `plugin.json` errors instead of silently
  defaulting to version `0.0.0`. The soft-missing reconciliation path is preserved (a missing source still
  reconciles; only a wrong-kind existing source fails loud).
- **Artifact collection no longer follows symlinks** (`lstat` + symlink-skip + a realpath cycle guard), and the
  egress sidecar/proxy are acquired inside the protected block so a prompt-render throw can't leak them.
- **Egress/web-fetch guards.** The private-address guard recognizes IPv4-mapped IPv6 and numeric/hex/octal IPv4
  loopback forms; a host-side `web_fetch` to a hostname that **resolves** to a private/loopback address is now
  denied (DNS-rebind/SSRF, fail-closed — a name that won't resolve is also denied), checked on every redirect
  hop; the proxy parses bracketed IPv6 `Host` headers; and an `allow` egress decision is recorded only once the
  upstream actually connects (so `egress_allowed` can't pass when nothing reached the host).
- **Verdict/assertion correctness.** A nonzero child exit after a success result is now fatal (with the stderr
  tail); `artifact_json` `equals`/`in` compare JSON with key-order-insensitive deep equality (arrays stay
  order-significant); the external decider rejects an invalid permission `behavior` loudly instead of silently
  denying; `no_delete_in_outputs` accepts only `true` (authoring `false` was a silent no-op footgun); and the
  outputs-delete detector parses `mv` direction (a move *into* `outputs/` is no longer a false delete) with an
  opt-in safe-staging-prefix suppression for scratch cleanups (`COWORK_HARNESS_SAFE_STAGING_PREFIX`).
- **Python wrapper drift.** `run_scenario()` no longer passes `--fidelity`/`--answer` flags the `run` command
  rejects; fidelity and answers are scenario-authored (the YAML's `fidelity:`/`answers:` fields).
- **Docs reconciled with the 0.3.0 artifact-manifest replay behavior.** README, SPEC, `docs/scenario.md`,
  the companion `SKILL.md`, and the skill references previously claimed `file_exists`/`user_visible_artifact`/
  `artifact_json` were "always skipped" on replay; they now correctly state these are evaluated **when the
  cassette carries an `artifacts` manifest** (only the live-only egress keys are always skipped), with
  `docs/cassette.md` flagged as canonical and `allow_permissive_auto_allow` added to its table.
- **Corrected the claim that the `protocol` tier needs no token** — L0 spawns the host `claude` and calls a
  real model, so it needs the auth token (Docker-free/agent-free, not token-free).
- **Aligned stale references:** npx floor `>=0.2.0` → `>=0.3.0`; skill reference headers `0.1.0` → `0.3.0`;
  stale `cassette.ts` line-cites → the `contentKeys` symbol; and the broken `DESIGN.md §1` anchor.
- **Doc accuracy:** all five fidelity values (vs "L0/L1/L2"), `max_thinking_tokens` over "extended thinking",
  the `config_dir` write-guard caveat, the `boundary-check` (exit 1) vs `BoundaryError` (exit 3) exit-code
  distinction, and the `npm run ci` vs CI-Stage-1 gate framing.

## [0.3.0] — 2026-06-17

The CI-operate + privacy layer for committed cassettes: record-time redaction, an always-on
`verify-cassettes` scan/staleness gate, batch recording, and a set-membership assert operator.

### Added

- **`verify-cassettes <file|dir>`** — a token/agent-free CI gate over committed cassettes. A privacy
  **scan** flags `email`/`currency`/bare-`domain` matches across the whole cassette, excluding only the
  agent's **capability-manifest** messages (`system/init` + the `init-1` registry) from the noisy classes —
  that catalog/MCP-server boilerplate is the sole concentrated false-positive source (email still scans it,
  since the registry `account` field can carry the dev's email). `--allow <regex>` suppresses synthetic/
  public reference names; multi-word proper names are opt-in, not a default class. Plus a **staleness** check
  (`--staleness-only`) fails when a cassette's fingerprint drifted (you edited the skill but didn't
  re-record). Exit 1 on any finding/drift/unreadable cassette; a malformed cassette is tallied, never
  crashes the batch. Dedicated JSON envelope (`{command, ok, results}`), not the `RunResult` shape.
- **Record-time content redaction** (opt-in; distinct from secret-scrub). A `.cowork-redact.json` (or
  `COWORK_HARNESS_REDACT_PATTERNS`/`_KEYS`) rewrites configured PII across the **whole** cassette surface
  (transcript, artifact bodies + filenames, prompt/answers/assert, skillSources) **structurally** — JSON
  stays valid and the AskUserQuestion question/answer strings stay in sync (the O7 guard still passes), with
  collision-safe deterministic tokens. Redaction is **verdict-preserving**: `record` refuses to write if it
  would flip an assertion (a manufactured green). `--no-redact` / `--allow-failing` escape hatches.
- **Batch recording** — `record <dir>` records every scenario in a directory (classified by a positive
  `prompt:` signal: a non-scenario YAML is an announced skip, a broken scenario is a failure, never a silent
  skip); `record <cassette-dir> --rerecord-stale` re-records only the cassettes whose fingerprint drifted.
- **`artifact_json` `in:` operator** — assert the resolved value deep-equals one of a fixed set; stable for
  stochastic (LLM-extracted) values where `equals` churns across re-records.

### Fixed

- **`skillHash` cassette fingerprint was silently dead** — `skillSourceDirs` passed a path string to
  `loadSession` (which wants parsed YAML), threw, and the throw was swallowed, so the staleness gate's
  skill-edit signal never computed for a file-based session. Now parses + resolves the session correctly;
  `hashDir` folds in each file's relative path + type marker (a *move* now registers); `skillSources` are
  stored relative, never as absolute host paths.

## [0.2.0] — 2026-06-17

Binary-verified the AskUserQuestion answer wire shape (agent ELF 2.1.170), implemented the
harness-improvements plan, and resolved a 39-finding code-review pass behind two centralizing seams.

### Added

- **AskUserQuestion answer shapes.** `multiSelect` gates (answer with a list of labels → the verified
  comma-joined wire shape); free-text **"Other"** via `answer:` (distinct from the label-validated
  `choose:`); `choose` tolerates the `(Recommended)` suffix + `recommended`/`first` keywords. A partial
  match on a batched gate now **names the unmatched sub-questions**.
- **`artifact_json` assertion** — assert a JSON artifact's contents via a dotted path
  (`equals`/`gt`/`exists`/`absent`/`is_null`); `absent`, `is_null`, and an unresolved intermediate are
  distinct (the last fails loud, never a vacuous pass).
- **Artifact manifest in cassettes** — `record` snapshots `outputs/`/`.projects/` (paths + hashes + small
  JSON bodies) so `file_exists`/`user_visible_artifact`/`artifact_json` run on token-free `replay`. A
  cassette→skill/baseline **staleness fingerprint** warns on drift; `replay --strict` fails on it. Cassettes
  now carry a `cassetteVersion` (forward-compat guard).
- **`RunResult.artifacts`** (ENV-MANIFEST) — observed user-visible files (path + bytes); also surfaced as
  `Result.artifacts` in the Python helper.
- **`allow_permissive_auto_allow` assertion + `RunResult.scan`** — a security-scan surface for the
  Cowork-parity verdict (below); the assertion opts a scenario into a permissive auto-allow on purpose.
- **CLI:** `trace --dispatches` (sub-agent dispatch tree + real total), `assert --list` (schema-generated),
  `scaffold --from-run <id>` (kept run → starter scenario YAML).
- **Python:** `run_scenario()` — run an authored scenario YAML and get the typed `Result`.

### Changed

- **Single verdict source (`computeVerdict()`)** wired into all five pass/fail sites (run/skill exit, footer,
  replay exit, JSON-envelope `ok`) plus the Python `assert_success`. A Cowork-parity violation — a permissive
  auto-allow, a recorded `outputs/` delete, or a host-path leak — now **default-fails** the run unless the
  scenario explicitly asserts about it.
- **Single fail-loud staging policy (`src/staging/resolve.ts`)** for every declared input (marketplace
  manifest, enabled-plugin resolution, local skills, `mcp.config`, uploads, folders), with a Docker-safe
  marketplace charset.
- The run root honors `COWORK_HARNESS_RUNS_DIR`.

### Fixed

- **Egress / runtime hardening:** per-hop redirect egress logging, allowlist validation, a per-run proxy
  port, proxy/sidecar readiness handshakes, fail-loud Lima provisioning, and boundary teardown in
  `try/finally`.
- **Protocol / decider hardening:** oversized control-frame hard-fail, a nonzero child-exit error event,
  provenance untruncation, TTY-elicit cancel, and a JSON-safe `reply_with` key.
- **Detection / packaging:** `%2F`/backslash decode in the outputs-delete detector; the npm package now
  ships `schema/`, `docs/`, `python/`, and `scripts/`; assertion path containment; resume empty-tree warning.

### Notes

- Held/deferred per the plan's gating: composed partial-gate answering, `decider_intent:` in scenario YAML,
  a whole-gate `response:` freeform, and `artifacts_share_field`. All additive/opt-in when built.

## [0.1.1] — 2026-06-16

Docs, distribution, and packaging. No CLI behavior change.

### Added

- **Companion Claude Code skill, installable.** A `.claude-plugin/marketplace.json` + skills-directory
  plugin make the bundled skill installable via `/plugin marketplace add yaniv-golan/cowork-harness`;
  the skill self-bootstraps the CLI (`npx cowork-harness@latest`) and fails loud on missing tier deps.
- **`AGENTS.md`** — canonical, cross-tool agent instructions — and **`llms.txt`** doc index.
- **JSON Schema for scenario & session YAML** (`schema/*.schema.json`, generated via `npm run schema`,
  pinned by a token-free drift-guard); `# yaml-language-server: $schema=` hints in the example scenarios.
- README banner, badges, an "For AI agents" section, and `npm install` instructions.

### Changed

- Release pipeline publishes via npm **Trusted Publishing (OIDC)** with provenance (no stored token).
- GitHub Actions bumped off the deprecated Node 20 runtime; CI live-scenario job skips cleanly without a key.

## [0.1.0] — 2026-06-16

Initial public release. A faithful, headless, scriptable harness for Claude Cowork's runtime — for
testing Claude Code **skills** outside the Desktop app with the same staged agent, spawn/control-protocol
contract, egress allowlist, permission protocol, and sandbox limitations. Binary-grounded against
`app.asar` 1.12603.1 / agent ELF 2.1.170.

### Added

- Commands: `skill`, `run`, `chat`, `record`, `replay`, `trace`, and `decide`, plus `sync`,
  `boundary-check`, and `vm` management. Stable `--output-format json` envelope and CI-ready exit codes.
- Five fidelity tiers (`fidelity:`): `protocol`, `container`, `microvm`, `hostloop`, and `cowork`
  (auto-picks host-loop vs container the way Cowork does).
- Scenario YAML — prompt + scripted answers + `assert:` (transcript, files, artifacts, tool / sub-agent
  usage, egress, and more) for authored, asserted regression runs.
- Input policy with no silent false-greens: scripted, LLM, and in-band (`--decider-dir`) answering for
  AskUserQuestion / tool-permission gates; an unanswered gate fails loud.
- Default-deny egress sandbox enforced against the synced Cowork domain allowlist.
- Token-free, Docker-free cassette `record` / `replay` for the PR gate.
- Platform baselines synced from a local Claude Desktop install — nothing Anthropic-owned is bundled
  or distributed.
