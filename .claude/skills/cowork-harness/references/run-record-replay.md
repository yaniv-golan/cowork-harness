# Run, record and lock

Tracks `cowork-harness 4.4.1` (baseline `desktop-2.19675.0`). Read it when running a scenario, recording or placing a cassette, reading verdict signals, checking a background run, or choosing CI lanes.

## Part II — RUN, RECORD & LOCK

You have an authored scenario. This Part runs it, reads the verdict, locks it into a
byte-deterministic cassette, checks a background run's liveness, and places the assertions in the
right CI lane.

### Run, then lock determinism

Read the verdict and the inline failing transcript. To pin a flaky-because-stochastic gate, paste
the echoed `--answer "<q>=<choice>"` footer lines back into the scenario's `answers:` for a
deterministic re-run. Use `cowork-harness trace <id>` to digest a run. If only an *assertion* is wrong (the
run itself was fine), `cowork-harness verify-run <run-dir> <scenario.yaml>` re-checks the `assert:` block against
a **kept** run dir (`--keep`, or a `--session-id` run) with no live re-record — tokens-free, ~1s per iteration.
When the scenario declares `answers:`, verify-run **also** checks they still match the run's actual gates (a
reworded gate or a `choose:` the run never offered fails here in ~1s instead of on a paid re-record). `verify-run`
never calls the semantic judge, so a `semantic_matches` or `semantic_pairwise` assert is not re-graded by it; after a rubric change,
`cowork-harness regrade <run-dir> --scenario <scenario.yaml>` re-grades those against the kept run (the judge call
is the only spend) and reports whether the judge read the same document the live judge did (widening the evidence
scope needs `--allow-unchecked`: content the live judge never read is refused otherwise). A part of the judge's
input that cannot be proven scrubbed with the run's scrub set is refused too (exit 2, `refusals[]`, naming the parts,
never their text). A run records a keyed fingerprint of its scrub set (`result.json` `scrubSet`); when this
process's set provably covers it, everything is sent. Otherwise only parts equal to the run's own scrubbed record
are: the pairwise task line, each rubric line, each evidence-health and scratch note, and each reference still
byte-identical to the one a live comparison of the run was sent. So a new or edited rubric line
(`rubric_unverifiable`), a changed prompt (`task_unverifiable`), a changed evidence note (`evidence_unverifiable`),
or a reference re-frozen since the run (`reference_unverifiable`) is refused on a run recorded before the
scrub-set fingerprint (no `scrubSet`), on one whose key was unusable (`scrubSetUnavailable`, see
`debugging.md`), from another machine, or after a token it scrubbed rotated. Re-run the case (a new run records a
fresh fingerprint), regrade with the run's scrub settings, or pass `--allow-scrub-change` after checking them (the
grade records `scrubAcceptedBy`); `--allow-doc-drift` and `--allow-unchecked` never imply it.
`ref freeze` applies the same proof: a document with no live fingerprint (`--allow-unchecked`) is composed with this
process's scrub set, so it is frozen only when that set provably covers the run's, or with `--allow-scrub-change`;
`ref verify` refuses both flags. A run dir moved or
downloaded from where it ran is read from where it is; a COPY beside its still-present original is refused (its
`result.json` names the original's files), so grade the original, or re-run the scenario. Or skip
the discovery/encode/record dance entirely and answer gates **live during the recording** with
`record --decider-dir`/`--decider-llm` (the cassette is flagged non-deterministic but replays deterministically).
`run` takes no `--dry-run`: to check that a scenario **loads** without spending, `cowork-harness lint
<file.yaml>` runs the real loader (and resolves a named `baseline:`); `cowork-harness record <file.yaml>
--dry-run` runs the real loader too AND the same scenario-level
refusals the real `record` applies (`on_unanswered: prompt`, and an unsatisfiable assert pairing) **plus the
cassette-portability pre-flight below**, so it cannot green something a paid run would reject. **That binding
guarantee is the SINGLE-FILE form only** — it takes the real `--out` and the real flags, so its verdict is the
one a paid run would give. Two inputs it reports rather than refuses, at exit 0 under `inputErrors[]` with a
`⚠ input error:` line: a `session:` file that cannot be read (missing, a directory, not valid YAML — 4.1.1
and later) and a `tool_not_called` the tier can never violate — `run` and the real `record` refuse both. On a **directory** the path-dependent verdicts (host-inventory, cassette
portability) are reported as `⚠ would-refuse (advisory)` / `⚠ would-warn (advisory)` notes — the label follows
the verdict kind, and portability can only ever warn — that do NOT affect the exit code — a dir target
takes no `--out`, so the destination is a guess — and only the path-independent ones (prompt policy, assert
contradiction, duplicate cassette target) gate the batch. An input the real record would refuse — a
`session:` file that cannot be read (4.1.1 and later), a missing path, an unknown baseline name, a `tool_not_called` the tier can never violate — is listed under
`inputErrors[]` with a `⚠ input error:` line, also at exit 0. So a directory dry-run CAN exit 0 on a scenario the
real `record` would refuse; re-run that one file with its real flags for a binding answer, or gate on
`.ok and (.inputErrors == [])` in the JSON payload (4.1.0 and later). A directory also
reports every offender and the batch cost estimate. `lint` checks the assertion invariants AND that each file loads (the same loader, plus a named `baseline:`), but not the pre-spend refusals.

**Which arm to reach for.** They answer different questions, and picking the wrong one is why a consumer
concluded the free pre-flight was unavailable:
- **"Does my whole corpus still load?"** → `cowork-harness lint scenarios/` answers it (every file the
  loader rejects is an ERROR, and so is a `baseline:` naming no shipped baseline), or the **directory** arm
  (`record scenarios/ --dry-run --quiet`, the CI shape in `references/ci-recipe.md`) when you also want the
  pre-spend refusals. The directory arm reports every offender in one pass, and the
  destination-policy verdict cannot red it: that arm knows no `--out`, so host-inventory and portability
  are advisory `notes[]` at exit 0 while a file that cannot load is `✗ broken:` at exit 1. Limits worth
  knowing: it is **non-recursive** (`readdirSync` — scenarios in subdirectories are never opened), a file
  with no `prompt:` key reports as `· skipped:` rather than broken (so a renamed or mis-indented
  `prompt:` reads as "not a scenario" and the batch still exits 0), exit 1 covers **refused**
  (path-independent only — prompt policy, assert contradiction, duplicate target) as well as broken, and
  `--quiet` suppresses the advisory notes entirely — it keeps `✗ broken:` / `✗ refused:` / `· skipped:`,
  which is what you want in CI but means the notes are not a thing you will see there.
- **"Would THIS record be refused?"** → the **single-file** arm **with the flags and `--out` the real
  record will get**. The destination it evaluates is `--out` if given, else `cassettes/<slug>.cassette.json`
  *relative to your cwd* — so previewing from the repo root a record that really runs from a subdirectory
  asks about a path that may not even exist, and a scenario whose cassette IS committed can come back
  refused. Point it at the real destination and the answer is binding.

Neither question is answered by passing `--allow-host-inventory-fixture` to get past the refusal: that
flag is consent for a recording you intend to make, and reaching for it as a load-check habit is how it
stops meaning anything.

**`record <file>` exit codes.** `2` means the scenario did not load. `1` means it loaded and this record
was refused: before the spend (`on_unanswered: prompt`, an unsatisfiable assert pairing, the host-inventory
destination refusal, a slug collision, a scenario that resolves no model, and the `--max-budget-usd`
refusal — `1` on `record` since 4.0.0, still `2` on `run`/`skill`), or after it, once the agent has
finished: a failing verdict without `--allow-failing`, an assert on an artifact too large to commit (also waived by `--allow-failing`), a
quarantined inventory finding, or any other error before the cassette is written. Only the after-the-run
refusals report the run: under `--output-format json` they carry it in `results[0]` (verdict and
cost) with `error.category: "runtime"`; every pre-spend refusal, and a run that throws before returning a
result (an unanswered gate), has `results: []`. The envelope's `ok` is the exit code (`ok` ⇔ exit 0, a
cassette was written), not the verdict: an `--allow-failing` recording of a red run is `ok: true` with
`results[0].verdict.pass: false`. `record <dir/>` reports per scenario under `items[]` (each with `status`,
and `verdict`/`result` once its run finished), not `results[]`.

**Decide WHERE the cassette lives before you record it — a cassette cannot be moved afterwards.**
Without `--out`, `record` writes `cassettes/<scenario-name-slug>.cassette.json` (gitignored by
default); pass `--out <path>` to put it somewhere tracked, e.g. `examples/replays/<name>.cassette.json`.
That choice is permanent: the cassette rewrites `scenario.session` and `scenarioSource` **relative to
its own directory** at record time, so moving the file later — a different `--out`, a `git mv`, a copy
into another repo — leaves those unresolvable and
`verify-cassettes` reports `unverifiable-skill` ("can't verify ⇒ not green", exit 3) until you
re-record at the new location — or point `replay`/`verify-cassettes` at the session with `--session <file>`, which resolves it without a re-record. Since 2.0.0 a bare `replay` FAILS on this class rather than warning. **`record` now says so BEFORE it spends:** a pre-flight — at the same
pre-spend point as the host-inventory refusal, and in `record --dry-run`, so the rehearsal is free —
warns when the cassette would be written outside the scenario's tree, or when `session:` itself lives
outside it (an absolute or `~` path: the mirror case, invisible to a check that only looks at where the
cassette lands). A warning, not a refusal — an out-of-tree throwaway cassette is legitimate; what was
missing was anything saying so while you could still act. Related: recording at a **host-inheriting** tier
(`protocol`/`hostloop`/`cowork`→hostloop) into a repo-visible path is refused outright (gotcha 25 in `gotchas.md`).
The clean answer there is `fidelity: container` (sealed, `HOME=/tmp`, nothing to leak) — **not**
redirecting `--out` outside the repo and moving the file in afterwards, which trades a loud refusal
for a cassette that cannot verify staleness from its own location — recoverable only by passing
`--session <file>` on every invocation thereafter.

**Author answers WITHOUT re-paying — the cheap loop.** You don't need a fresh paid record to discover a
scenario's gates or their labels: `--keep` ONE run, then `cowork-harness trace <run-dir> --view questions`
(and `verify-run`) read the gates + every offered option's **label and `description`** out of that run's
`events.jsonl` for free — a skill routinely puts the sentence the user is actually deciding on in a
`description`, and `question_context:` is the key that gates on it (`question_options:` compares labels
only). When a view renders no field you need, read `events.jsonl` directly rather than concluding the text
was never delivered — the views are a digest, and the record is wider (`jq` recipes in
[`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md)). Iterate
your `answers:` against that kept run, then record once. **But the kept run is a snapshot:** if you change the
skill's gate phrasing afterward, re-`--keep` — verify-run's answer-coverage *refuses* (exit 2, "predates the
current skill") rather than vouch against stale labels, but the trace/inspect path can't warn you, so re-keep
deliberately. (Same fail-closed family: corrupt gate evidence — unparseable `events.jsonl` lines, or fewer
gates than `trace.json` recorded questions — a structurally invalid `result.json`, a `command:"replay"`
result (a replay is a re-check of a recorded cassette, not run evidence — verify the original live run dir),
and a `mode:"chat"` result (chat carries no assertions or verdict by contract) also refuse rather than
certify.) (A token-free probe of "which gates fire" isn't possible — gates are model-decided per run.)

Run artifacts are written to `~/.cowork-harness/runs/…` by default — **outside any working tree**, so a run
launched from a repo root never drops sensitive skill inputs/outputs into it. Pass `--run-dir <path>` (or set
`COWORK_HARNESS_RUNS_DIR`) to relocate; in CI point it at a workspace path so an artifact-upload step can
collect the runs. The runs dir is also where `--max-budget-usd` reads its cost history: pointed at a fresh or
per-job directory it finds no priced run for the scenario, warns `no priced run history … proceeding
UNCAPPED`, and runs with no cap (a batch's estimate becomes a lower bound; only the `--concurrency 1`
running total still stops it). To keep the cap, leave `--run-dir` at the default, or reuse the same
directory across invocations (a CI cache, say) so it holds at least one priced run of that scenario.
Under `--output-format json` this is machine-readable: the envelope's top-level `budget` object reports
`enforced: false` (single run: at least one scenario ran with no cap) or `"lower_bound"` (a `record`
batch), with `unpriced[]`, `runsDir` and `runsDirRedirected`; and when the runs dir was redirected the
warning names `--run-dir` / `COWORK_HARNESS_RUNS_DIR` as the cause. A budget REFUSAL carries
`error.code: "budget_exceeded"` plus `error.budget` (cap, refused estimate, basis, unpriced) — branch on
that code, never on the message; a scenario that did not load has no `error.code`. On a
`record <dir/> --dry-run` refusal, `broken[]` / `inputErrors[]` stay on the error envelope.

#### Validate a skill against real documents (not a cassette)

The loops above build **deterministic regressions**. A different job — drive a skill against *real* input
documents to judge whether it actually does the work (extraction, analysis), with no intent to record a
cassette — has its own recipe:

1. **Explore with the LLM decider.** `cowork-harness skill <dir> --decider-llm --intent "<one line of what
   this run is testing>"` lets a model (Sonnet default) answer each gate steered by your intent. The model replies with
   the option **number** and the harness maps it to the exact label (so it can't whiff by mis-typing the
   label text); an out-of-set answer fails loud. This is exploration, **not** a deterministic regression —
   the run is flagged non-deterministic and a green here is not a scripted pass. The answering model
   defaults to a Sonnet id (a weaker model tends to prose-decline an ambiguous judgment gate → fail-loud);
   override it with `--decider-model <id>` — a cheaper model (e.g. Haiku) for simple gates to cut cost,
   or Opus for the hardest judgment gates; it won't make an under-specified gate deterministic. A live
   decider can false-green a semantic assertion on an oracle-less gate — see `references/fidelity-and-answers.md`.
2. **Script the load-bearing gates — especially binary confirm gates.** Once you know which gates fire
   (`trace <run-dir> --view questions`), pin the ones whose choice drives the outcome with
   `--answer "<q>=<label>"` / `--answer-policy <yaml>`. When a skill **re-words its option labels run-to-run**
   (LLM-authored gates), pin a **stable leading substring** instead of the full label — `--answer
   "<q>=Israeli company"` binds whichever option starts with `Israeli company`. It is uniqueness-guarded and
   **fails loud** if the anchor ever matches two options (the documented trade: drift-tolerance, not strict
   CI reproducibility — for that, pin a full exact label or a free-text `answer:`).
3. **Budget ~1 re-run per file.** If a gate whiffs, the run does not vanish — it exits non-zero but
   **salvages a PARTIAL run** (the extraction the agent already did is written to disk). So the cost of a
   missed gate is one re-run with a better `--intent` or a scripted answer, not a lost paid run.
4. **Inspect the outputs to judge correctness.** `cowork-harness inspect <run-dir>` shows what the run
   produced — the artifacts plus a shallow field preview of each JSON artifact (e.g. the extracted figures).
   It works on a salvaged partial run too. (A partial run is marked `PARTIAL`; `verify-run` and `scaffold`
   refuse to treat its half-finished output as a passing result.)
5. **For image-only / scanned PDFs, use the full-parity image.** The default agent image omits OCR and
   PDF-table tooling; if a **scenario** sets `requires_capabilities` (a scenario field — not skill
   frontmatter) and the image provably omits one, the harness **aborts before the paid run (exit 3)** —
   unless the scenario asserts `allow_missing_capability: true`, which downgrades it to a notice and
   proceeds. Rebuild with `--build-arg COWORK_FULL_PARITY=1` and point `COWORK_AGENT_IMAGE` at it for those
   skills.
6. **Iterate across fixes — verify before you trust, and don't cross-pair generations.** A green run is
   not a correct run, and a skill's self-reported finding is not real until its cited evidence is found in
   the run's own output. Ground each finding against `result.json` (`finalMessage` = the skill's own
   answer/critique; `toolResults` = tool outputs) and the tool-call stream via
   `cowork-harness trace <run-dir> --output-format json` — add `--full-results` so a successful call's full
   input + result are captured, not just errored ones. When iterating, tag generations with `--label` and
   pair a critique only with a `result.json` whose `fingerprint.skillHash` **matches** the skill that
   produced it (`inspect`/the run-index row surface a short `skillHash` prefix; `verify-run` warns when a
   kept run predates the current skill). **The hazard is general, not critique-specific:** repeated
   `run`/`skill` invocations of one scenario accumulate in the SAME scenario directory regardless of skill
   version, so a plain `stats <scenario>` silently averages pre-fix and post-fix runs together. Compare
   generations with **`stats <scenario> --group-by skill-hash`** (or narrow with `--skill-hash <prefix>` /
   `--label <tag>`); an un-split window spanning more than one generation now warns.
   **Multi-skill plugin caveat (post-1.7.0 CLIs with `--skill`):**
   skillHash keys the whole MOUNTED plugin, so on a multi-skill plugin the hash alone cross-pairs
   critiques of DIFFERENT skills — pair by the report's `(gradedSkillHash, gradedSkill)` pair. **On a pre-1.5.0 CLI the `skill` lane emits no `fingerprint.skillHash` at all**, so a
   pairing step there silently groups on an absent key instead of erroring — check the field is present, or
   require ≥ 1.5.0. See [`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md)
   (repo-only) for the full loop.

#### Interpreting verdict signals

The run verdict may include `WARN`-severity signals in addition to pass/fail. One to watch for:

- **`prompt_asset_missing`** — the run proceeded but a prompt asset referenced by the scenario was
  not found. The model ran against an incomplete prompt. This is a `WARN`, not a hard failure, so
  the run can still green. If you see it, fix the asset path — a green with a missing asset is
  not a valid pass.

**False negatives — signals that are tier/image artifacts, not skill defects.** Some fail-severity
signals read like a skill gap but are really a property of the reduced test image or the fidelity tier.
Recognize these before "fixing" a non-bug:

- **`missing_capability`** — the lean `core` agent image is a deliberate partial mirror of real Cowork's
  rootfs, so a skill that used `soffice`/LibreOffice (`office_convert`), `tesseract` (`ocr`),
  `markitdown`/`magika` (`ml_extract`), `cv2` (`cv`), `camelot`/`tabula` (`pdf_tables`), or `wand`
  (`magick`) can trip this even though real Cowork **ships** those (per the rootfs manifest captured at
  Desktop `2.9939.2` — `baselines/provisioning/rootfs-provisioning.json`, which is the dated evidence
  behind that sentence; 3 baselines have shipped since without a re-capture). The message says so ("likely a FALSE
  NEGATIVE (real Cowork ships them)"). Fix: rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`, point
  `COWORK_AGENT_IMAGE` at it), or — if the skill's fallback is genuinely equivalent — assert
  `allow_missing_capability: true`. (Two sources: a skill *observed using* an omitted family, live lane;
  or a declared `requires_capabilities` the tier can't provide, both lanes — an unknown family name
  hard-fails rather than silently passing.) **On an open-ended `skill` run** (no `assert:` block to carry
  the modifier), pass **`--allow-missing-capability`** — the CLI equivalent of the assertion.
- **`ended_with_question`** (`WARN`, live lane) — a heuristic: the agent's final answer contains a
  question (or closes on a request for input — the same test `stalled` uses, see [gotchas.md](gotchas.md) item 13) and the run
  wrote **no deliverable to `outputs/`** — it may have ended on a request for input instead of
  finishing. Warn-only; the fix is scripting/steering the answer (`answer:` / `--answer` / a decider, or
  `--decider-llm --intent`), not editing the skill's prose. The strict, fail-severity sibling `stalled`
  already catches a final turn that ends on a question or a closing request for input ("Please share X
  so I can…", "Once you upload it, I'll…" — counted only once a gate has fired) and did no tool work
  after the last gate; this covers the residual (a mid-message `?`, or tool work after the last gate
  that still ended asking). Read the final message before acting — a legitimate question-posing answer
  that wrote a file never fires. Assert `allow_stall: true` if ending on a question is the intended
  terminal state (on an open-ended `skill` / `probe-dispatch` run, pass **`--allow-stall`** — the CLI
  equivalent).
- **`undelivered_deliverables`** (`WARN`) — the skill produced file(s) **outside every user-visible root**
  and never delivered them. On a **remote** Cowork session the workspace is reclaimed at session end, so
  they are destroyed; on a **local** one they persist but stay invisible to the user. Either way the user
  does not get them. It fires with no assertion written — `present_files_called` covers the positive case
  only when you thought to ask for it, and the runs that most need this are the ones where nobody did.
  **Silent when the evidence cannot answer the question** (no workspace walk, or a tier that runs no
  scratchpad walk, absent delivery telemetry, or a resumed turn) — "cannot tell" never reads as "clean".
  **The fix is lane-dependent — and so is the PATH.** On `lane: local`, write deliverables where the user
  can see them, and give the file tools an **absolute** path under the outputs directory the agent's prompt
  names. On the desktop-local host-loop lane (what production runs), against Desktop **2.7032.0 and later**,
  the agent process runs outside the session (`/var/empty`), so a relative `Read`/`Write`/`Edit` — a bare
  filename or `outputs/x.md` alike — is **refused** ("File is in a directory that is denied by your
  permission settings."); only a pathless or relative `Grep`/`Glob` is redirected to outputs. (Before
  2.7032.0 the file tools were rooted at `outputs/`, so a bare filename landed there and `outputs/x.md`
  doubled to `outputs/outputs/x.md`.) At `fidelity: container`/`microvm` (VM-loop) the
  base is the session root, so a bare name lands in the scratchpad and you want `{{workspaceFolder}}` or an
  explicit delivery. Addressing
  a connected folder by name (`<folder>/x.md`) never reaches it on either lane — it builds a same-named
  decoy inside `outputs`, reports success, and gives no signal. Measured 2026-08-27; see
  [docs/scenario.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md), "Where a relative path actually lands". **On `lane: remote`, moving a file under `outputs/` does NOT help** —
  nothing is delivered by location there, so only an explicit delivery counts. Assert
  **`allow_undelivered_deliverables: true`** when the leftovers are intentional (intermediates, caches,
  downloaded inputs) rather than a delivery gap.
- **`delivery_unobservable`** (`WARN`, `lane: remote` only) — the run produced file(s) but the harness
  serves **no delivery tool on that lane**, so whether they reached the user is unanswerable. This is the
  honest cannot-verify companion to `undelivered_deliverables`: reporting every remote file as undelivered
  would claim more than the evidence supports, and staying silent would read as clean. Mutually exclusive
  with `undelivered_deliverables`, and quiet on a run that produced nothing to deliver. Not a skill defect —
  a harness coverage gap (see the *File delivery* section of fidelity-gaps).
- **`model_fallback`** (`WARN`) — the agent switched off the requested model mid-run. Read the `trigger`:
  `model_not_found` / `model_blocked` / `permission_denied` are properties of the **pin**, so every run of
  this scenario falls back the same way until you change the pinned id; `overloaded` / `server_error` are
  transient and a re-run may hold. The run's assertions still mean what they say — but they were produced
  by a different model than the scenario names, so treat a green as evidence about the fallback model.

- **`mount_delete`** (`WARN`) — a delete touched a **delete-denied mount other than `outputs`**: a `rw`
  connected folder. Production denies `unlink`/`rmdir` on *every* Cowork FUSE mount until per-mount
  approval, not just outputs — a connected folder shows the identical default — so this run diverged from
  what production would have allowed. `WARN` rather than `FAIL` because the harness **detects** post-hoc
  what production **enforces**: by the time the scan sees it, the agent already proceeded where it would
  have hit `EPERM`, so failing the run would overstate what a post-hoc scan knows. Author
  `no_delete_in_mounts: true` to hard-fail on it, or `allow_delete_in: ["<mount>"]` to waive that mount
  (detection still runs and the hit is still recorded — the waiver is a verdict decision).
- **`host_path_leak`** — skipped at **`hostloop` and `protocol`** fidelity (the agent runs on real host
  paths there, so a host path in model-visible text is expected, not a leak); it is *armed* at
  `container`/`microvm`, but only *fires* on an actual scanned leak with no authored
  `transcript_no_host_path`. At `fidelity: cowork` the skip follows the **resolved** tier, so a `cowork`
  run that lands on `container` is armed. Author `transcript_no_host_path` to enforce cleanliness where
  it's valid. A host path that came verbatim from the scenario's own uploads, connected folders, prompt or
  declared plugins' or local skills' files is not a leak (whole-token match; a token cut short where the path
  goes on, or one naming a location the harness created for the run, is never exempt, and a plugin's or
  skill's own files never exempt a path under its host source); `scan.inputHostPathTokens` counts the
  host-path tokens the inputs carried, `scan.hostPathsFromInputs` the ones exempted, and a non-zero exemption
  prints a `::notice::` so a clean scan that relied on it is never silent.
- **`exec_infra_error`** (`WARN`, host-loop) — one or more container `exec` calls failed for
  infrastructure reasons (daemon/container-level), so those tool calls returned an error to the agent
  rather than the command's own output. Warn-severity because the run's other evidence is intact — unlike
  the fail-severity `infra_error`, where a **supervising process** died and contaminated everything. Note
  a model-requested `timeout_ms` expiry is *not* this: it returns the command's partial output with
  `Command timed out after <duration>` in stderr, matching production. Known gap: if **every** exec
  failed, the agent ran nothing yet the run still only warns — read `result.infraErrors` when a run looks
  suspiciously empty.
- **`outputs_delete_unconfirmed`** (`WARN`) — a delete-shaped command near `mnt/outputs` that nothing
  confirms: the per-turn filesystem diff shows no output present at turn start was deleted, and no flagged
  delete has an `outputs/` path as its own operand. The classic case is a Python variable named `rm` in a
  `python3 -c` body that also reads a report from outputs: `rm = json.load(open(".../outputs/r.json"))`.
  A file the turn created and then deleted is invisible to the diff, so real deletes land here too:
  - a loop body whose operand is the loop variable (`for f in …; do rm "$f"; done`);
  - a `cd` then a relative path;
  - chained variables (`A=…; B=$A/x; rm "$B"`);
  - a Python path held in a variable set on another line (`p = …` then `os.remove(p)`);
  - wrapper flag combinations the classifier does not model (`sudo -Hu user rm`, `git -C dir rm`);
  - calls outside the modelled set, such as Node's `fs.promises.rm(…)`.

  Read the command before dismissing it. A literal-path delete (`rm -f mnt/outputs/x`,
  `os.remove(".../outputs/x")`) still fails `outputs_delete`. So do two non-deletes: quoted text where a
  delete command with an outputs operand follows a separator, subshell or keyword
  (`echo 'note; rm mnt/outputs/x'` — the classifier does not track quotes), and a heredoc that *writes* a
  script instead of running it. A statement over 4 KiB or a command over 16 KiB is judged by the stricter
  original rule, so a huge one-line body with a variable named `rm` fails again, and a command whose variable
  expansion would exceed the scanner's work budget (about a hundred distinct variables in one 10 KB line) is
  not expanded — every mount it names literally counts as deleted in. Waive any of these with
  `allow_outputs_delete`. The warn is raised even when `no_delete_in_outputs` is authored (the assertion
  passes; this warn is how the hit stays visible in text output). On a baseline recording outputs as `rwd`
  (Desktop 2.16120.0+, including `latest`) none of `outputs_delete`, `outputs_delete_unconfirmed` and
  `outputs_diff_unavailable` fires unless `no_delete_in_outputs` or `no_delete_in_mounts` (outputs not waived) is authored, and the roster shows
  `outputs-delete —` (not applicable; the evidence stays in `scan` / `fsDiff`).
- **`outputs_diff_unavailable`** (`WARN`) — the outputs filesystem diff could not verify this turn and the
  text scan saw nothing, so a delete by a script file or a non-bash tool would have gone unseen.
- **`scan_unavailable`** (`WARN`) — emitted only on the live lane: `events.jsonl` was missing/corrupt, so
  `RunResult.scan` is undefined and the host-path guard and the outputs-delete **text scan did not run this
  run** (the outputs filesystem diff still did, and a delete it proves still fails wherever the outputs check is
  armed: a `rw` baseline, or `no_delete_in_outputs` / `no_delete_in_mounts` authored). Not a
  pass or a defect — assert `no_delete_in_outputs` / `transcript_no_host_path` to hard-fail on it instead.
- **`partly_scripted_gate`** (`WARN`) — one `AskUserQuestion` batched several sub-questions and your
  `answers:` matched only some. Answers are delivered as one unit, so the whole batch went to
  `on_unanswered` and the matched answers were not delivered. The message names the matched and unmatched
  sub-questions and who answered; `result.partlyScriptedGates` has the lists. `replay` and `verify-run`
  re-derive it: `verify-run` clears once you script every sub-question of the batch, a replay only after you
  re-record with them scripted (it reads the answers frozen in the cassette).

The full 23-code signal table (severity + per-signal opt-out) is in
[`references/assertion-catalog.md`](./assertion-catalog.md); [`docs/scenario.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md) (repo-only) carries
the fuller narrative.

### Checking whether a background run is alive

Never use `ps aux` to check on a `cowork-harness` run you launched in the background — it only sees
processes in your OWN PID namespace, which is frequently NOT the harness process's namespace (e.g. when
you're a sandboxed subagent). An empty `ps aux` match tells you nothing about whether the run is still
going.

Use **`cowork-harness status <dir> [--follow]`** instead — reads `<outDir>/status.json`, a file the
harness writes/updates throughout the run's lifecycle (including a crash-safety net for a thrown
error/`SIGTERM`, AND staleness detection for a hard `SIGKILL`/OOM-kill that no exit handler can catch —
either way you get `"error"`/`stale` instead of a permanently-trusted `"running"`), so liveness is
checkable regardless of PID namespace. The harness prints `[status] <outDir>` to stderr as soon as the
run starts, so capture stderr to get the exact directory — **unless you passed `--compact` (or `--demo`,
which implies it), which suppress that line** (it is a raw, un-tildeified host path, exactly what those shareable-output
modes exist to withhold; `status.json` is still written either way, so `status` still works) — but
`<dir>` also accepts the run-dir root
passed to `--run-dir` (a directory without its own `status.json`): it scans up to two levels down for the
newest session's `status.json` and reads that. `--follow` fails loud on a timeout/staleness
rather than hanging forever. (Fuller recipe in [`docs/run-status.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/run-status.md) — repo-only, not in the installed
payload; `cowork-harness status --help` has the flags.) To find a scenario's newest run dir, use
`cowork-harness status --latest-for <scenario>`, which orders by run time rather than directory mtime.

**Poll with `--follow`, not with a shell loop over `status`'s stdout.** The one-shot text form prints to
**stderr** and writes nothing to stdout; `--output-format json` (one envelope) and `--follow` (one JSON
line per status change) are the **stdout** forms. A poll that greps `status`'s stdout therefore matches
nothing, exits 1, and returns instantly against a run with minutes left to go — a silent false "done":

```bash
# WRONG — stdout is empty, so grep exits 1, `!` inverts it, and the loop never sleeps.
until ! cowork-harness status "$D" | grep -q '● running'; do sleep 30; done

# RIGHT — the harness owns the poll loop and exits when the run reaches a terminal state.
cowork-harness status "$D" --follow
```

**A multi-minute `record`/`run` outlives a short-lived wrapper.** Don't launch a long record from a
subagent that returns before it finishes — the returning agent tears down its process tree and kills the
in-flight run mid-artifact-write. Run it foreground, or detached from any process that will exit first.
(The `status.json` liveness above is exactly what surfaces such a teardown as `"error"`/`stale` rather
than a stuck `"running"`.)

### Other flags worth knowing

- `skill` / `critique`: `--prompt-file <path>` reads the prompt verbatim (no shell parsing); `--marketplace <dir>
  --enable name@mkt` loads skills through a marketplace; `--timeout <ms>` is the wall-clock budget;
  `--allow-host-writes` consents to a writable `hostloop` connected folder; `--verbose` adds thinking, tool inputs
  and the sub-agent tree to the output.
- `run --matrix`: `--max-cells <n>` caps the cross-product (default 16), and a truncated matrix fails unless
  `--allow-truncated-matrix` judges only the cells that ran.
- `record`: `--max-artifact-bytes <n>` caps an inlined artifact body (default 65536); `--rerecord-stale
  --from-embedded` re-records from the cassette's embedded scenario when no source file resolves.
- `replay --mutate`: `--mutate-include` / `--mutate-exclude <glob>` scope which artifact paths are perturbed, and
  `--mutate-max-per-file` / `--mutate-max-total` raise the sample caps (default 10 / 50).
- `probe-dispatch --expect-write <suffix>` counts only a sub-agent write whose path ends with the suffix as delivered.
- `ref freeze --case-id <id>` overrides the store entry's name (default: the scenario's name).
- `fixture export <run-dir> --out <dir>` refuses a file holding a secret, and a text file or file name holding a host
  path unless `--allow-host-paths` (a path into a run dir or a guest session is refused regardless).
- `prune [--keep-last <n>] [--pinned-older-than <N>d]` removes old run dirs (default `--keep-last 5`);
  `--dry-run` previews it.

### Place assertions in the right CI lane

CI placement: a **token-free `replay` PR gate** (content/structure only) + a **nightly live `run`**
(filesystem/egress). Fastest setup: `uses: yaniv-golan/cowork-harness@v4` (a packaged GitHub Action with a
PR job-summary reporter). See `references/ci-recipe.md` for the Action, the manual step-by-step form, and
the four-stage pipeline.
