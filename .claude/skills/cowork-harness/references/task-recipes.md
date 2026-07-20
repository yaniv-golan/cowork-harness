# Task recipes — end-to-end paths for the jobs consumers actually do

Each recipe composes facts that live scattered across SKILL.md and the other references into one
decision path. Every one answers a question a real fleet owner had to work out the hard way. Facts track the harness version in SKILL.md's
front-matter (currently 1.5.0). Recipe 2's `resolved-tier`/`unverifiable-tier` staleness classes and
Recipe 3's `init-redact` shipped in 0.24.0 and are part of the current feature set — no version gate
needed if your CLI meets SKILL.md's version floor.

## Recipe 1 — Evolve the `assert:` block of an existing cassette (usually NO re-record)

You added or changed assertion keys in a scenario whose cassette is already committed. Do you need
a paid live re-record? Walk this tree — the answer is usually no:

1. **Content / always-replay keys** (`transcript_*`, `tool_called`/`tool_not_called`,
   `tool_result_*`, `subagent_*`, `dispatch_count_max`, `skill_triggered`/`no_skill_triggered`,
   `result`, `max_turns`, `tool_calls_max`, `max_cost_usd`, `max_tokens`) →
   `cowork-harness replay <cassette> --assert-from <scenario.yaml>`. Token-free, no re-record.
   If the recording genuinely lacks the telemetry a key needs (very old cassettes), the key fails
   **loud** as `evidence-unavailable` — that is correct behavior, not a bug; only then re-record.
2. **Gate keys** (`question_asked`, `questions_count_max`, `gate_answers_delivered`) on a cassette
   **with `controlOut`** (any modern recording) → same token-free `--assert-from` path.
3. **Gate keys** on a **pre-`controlOut`** cassette → one re-record unlocks gate asserts for that
   cassette permanently.
4. **Filesystem / egress keys** (`file_exists` without an artifact manifest, `egress_allowed`,
   `egress_denied`, `no_delete_in_outputs`) → live lane **by design**; replay skips them with a
   loud `::warning::`. Keep them in the scenario, run them on the nightly live gate.

**The one hard caveat:** `--assert-from` **hard-fails on recording-shaping drift** — if the
scenario's `prompt:`, `answers:`, baseline, or skill content differ from what shaped the
recording, re-asserting under them is meaningless and the harness refuses. The trap you'll
actually hit is `answers:`: sequence your edits — land assert-only changes (token-free), and land
answer changes separately (those DO force a re-record).

## Recipe 2 — Audit a fleet for tier drift

A `fidelity: cowork` scenario records at whatever tier the baseline's host-loop gate resolves to
at record time. When Cowork flips that gate, your committed cassettes silently stop representing
what production would do. Two layers of defense:

- **Automated (preferred):** `cowork-harness verify-cassettes <dir>` raises a
  **`resolved-tier`** staleness finding when a `fidelity: cowork` cassette's recorded
  `effectiveFidelity` no longer matches what the current baseline resolves to, and
  **`unverifiable-tier`** when a `fidelity: cowork` cassette predates `effectiveFidelity`
  entirely (can't verify → re-record). Explicit-tier cassettes (`hostloop`, `container`, …) are
  statically knowable and only produce a non-failing informational note.
- **Manual (one-liner):** `grep -h '"effectiveFidelity"' cassettes/*.cassette.json | sort | uniq -c`
  shows the tier distribution of the fleet at a glance.

### Cassette anatomy (what you're looking at when you open one)

Top-level fields of a `*.cassette.json` (schema `schema/cassette.v10.json`):

| Field | What it is |
|---|---|
| `$schema`, `generator`, `cassetteVersion` | Provenance: schema URL, producing tool, format version (current: 10) |
| `scenario` | The embedded scenario snapshot at record time |
| `events` | The recorded agent event stream (the replay source) |
| `controlOut` | Driver→agent control responses — presence unlocks gate asserts on replay |
| `effectiveFidelity` | The tier the live record actually resolved to (the drift-audit key above) |
| `artifacts` | Output-file manifest (paths + hashes + small inlined bodies) — unlocks `file_exists`/`artifact_json` on replay. Each entry carries `truncationReason` (`"size"`\|`"readonly"`\|`"unreadable"`, v8+) naming WHY a body is absent, and — v10+ — `linkKind` (`"symlink"`\|`"hardlink"`) for a body-less link entry, never dereferenced. |
| `fingerprint` | Skill/baseline staleness tripwire |
| `userVisibleRoots` | The user-visible mount roots captured at record time |
| `preRunPaths` | Pre-run file-path baseline for `no_unexpected_files` (workRoot-relative; co-present with `userVisibleRoots`) |
| `preRunHashes` | Pre-run per-path sha256 baseline for `input_unmodified` (added 0.27.0, no cassetteVersion bump); a `null` value marks a path whose recorded artifact body was secret-scrubbed (evidence-unavailable, never a false "modified") |
| `scenarioSource` | Relative path to the authored YAML this was recorded from |
| `authoring` | Present iff a live decider answered ≥1 gate during recording (`nonDeterministic: true`) |
| `sessionFingerprint` | Optional even on v9+ (the minimum readable version): hash of the session's content-relevant SHAPE (folders/plugins/skills/mcp/egress). Checked ONLY by `verify-cassettes`, never the default replay verdict; absent → not checked |
| `folderPrefixMap` | Optional even on v9+: the record-time connected-folder host-path → mount-name map. Replay's `computer_links_resolve` uses THIS (never the current session file); absent → the link is treated as evidence-unavailable, never reconstructed from the current session |
| `timeline`, `timelineHeader` | The recorded per-event timeline (harness-observation timestamps for tool_use/tool_result/subagent_dispatch/thinking/decision/result, in total order) plus its header (`startedAtWall`/`startedAtMono` anchors); informational only — never affects the replay verdict. Absent on a cassette recorded before this field existed |
| `environment` | Recording provenance: `location` (`"local"` on every cassette this harness produces), plus the resolved `tier` and `agentBinaryFormat` |

## Recipe 3 — Set up redaction BEFORE your first hostloop/protocol record

`hostloop` and `protocol` runs execute on the host, so real host paths (`/Users/you/…`) land in
the transcript and would be committed inside the cassette. Set the policy up **before** the first
record — retrofitting means re-recording:

1. `cowork-harness init-redact` — copies the reference `.cowork-redact.json` (host-path +
   email patterns) into the current directory. Version-control it.
2. **Search set:** record looks for `.cowork-redact.json` in the **cwd, the scenario's directory,
   and the cassette's output directory** — every distinct file found is MERGED (plus
   `COWORK_HARNESS_REDACT_PATTERNS`/`_KEYS` from the env). Repo root (= cwd in CI) is the
   conventional home.
3. **Preflight backstop:** `record` on a host-path-bearing tier with NO effective policy emits a
   loud pre-spawn `::warning::` (once per batch). If you see it, stop and do step 1.
4. **Scanner relationship:** redaction (record-time, rewrites content) and the
   `verify-cassettes` privacy scanner (CI-time, read-only tripwire over 4 classes: `domain`,
   `email`, `path`, `machine-inventory`) are independent layers. The scanner catches what
   redaction missed.
5. **Scoping idioms for scanner findings you've reviewed and accepted:** prefer the class-scoped
   flags — `--allow-domain 'api\.example\.com'`, `--allow-email '.*@yourco\.com'`,
   `--allow-path '/opt/ci-runner/.*'` — over bare `--allow <regex>` (a single pattern, which
   applies to every class and can let a domain allow swallow an email leak). For a
   version-controlled allowlist use `--allow-patterns-file <path>`: a FILE of bare all-class
   patterns, one regex per line, `#` comments and blank lines ignored — note the flag name is the
   FILE of patterns, not a path to allow.
6. **Matching semantics (any allow — flag or file):** each pattern is anchored to the **whole finding
   token** (`^(?:…)$`), so `example\.com` clears an `example.com` finding but NOT `sub.example.com` —
   a narrow allow can't silently swallow a wider leak. Matching is **case-SENSITIVE** unless your regex
   carries an `i` flag (e.g. `(?i)api\.example\.com`). It is NOT whole-token *and* case-insensitive by
   default — write the `i` in yourself if you need it.

## Recipe 4 — Budget assertions without a two-pass record

`max_turns` / `tool_calls_max` / `questions_count_max` / `dispatch_count_max` need observed
values, but you don't need a second paid run to get them — derive them from evidence you already
have:

1. **From the run you already did:** `run` always keeps its run dir. Read observed turns from
   `result.json` (`usage.turns`), tool-call and question counts from
   `cowork-harness trace <run-id> --view tools` / `--view questions`, and the dispatch count from
   `--view dispatches`.
2. **From history:** `cowork-harness stats <scenario> --metric turns` gives p50/p95 turns across
   indexed runs — better than a single observation.
3. **Set the budget with headroom:** observed × 1.5, rounded up (agentic run lengths vary run to
   run; a budget at the observed value flakes).
4. **Replay-class note:** `max_turns` / `tool_calls_max` / `dispatch_count_max` re-evaluate
   token-free on replay; `questions_count_max` needs `controlOut` (Recipe 1's tree applies).
   `max_cost_usd` / `max_tokens` on replay assert the FROZEN recording's spend — near-zero signal
   as a regression gate; if you need a cost gate, put it on the live lane via `stats`.

## Recipe 5 — Evaluate your skill's ANSWER QUALITY (semantic regression gate)

Behavioral asserts (`file_exists`, `egress_*`, `tool_called`) test what a skill *does*.
`semantic_matches` tests what it *says* — whether the skill's guidance leads the agent to a correct
answer. Use this to gate a skill edit (e.g. a SKILL.md refactor) so a restructure can't silently
degrade the advice. It is real work to calibrate; these steps are the traps that make or break it.

1. **Author a suite of Q&A scenarios — one per representative question.** Each installs your skill and
   asserts the answer with a rubric. The judge grades the **union of the agent's final answer, the
   transcript, and any files it wrote**, so a claim about content your skill leads the agent to *write to a
   file* grades as reliably as one about inlined prose — you don't have to force an inline answer:
   ```yaml
   session: ./_session.yaml      # plugins.local_plugins + enabled: [<your-skill>@local]
   fidelity: container
   prompt: <a real question a user of your skill would ask>
   assert:
     - semantic_matches:
         rubric:
           - <one discrete, checkable claim a correct answer MUST make>
           - <another>
   ```
2. **Write DISCRIMINATING claims, and verify each against ground truth — not memory.** A claim that
   contradicts how the tool actually behaves can *never* pass (the correct skill will contradict it), and
   it silently poisons the gate. Check each claim against the code/docs. Decompose into single,
   independently-checkable statements; prefer facts only your skill supplies.
3. **Verify the skill was actually invoked.** A rep whose `RunResult.skillsInvoked` does NOT include your
   skill answered from the model's priors, not your skill — it is not a valid measurement. Check it
   (`trace <run-id>` / `result.json`) and discard or re-run invalid reps.
4. **Run N≥3 reps; read the per-claim PROFILE, not a single verdict.** Agent answers vary run to run, so a
   correct claim can pass one rep and miss the next. A claim's baseline is its pass *rate* (3/3, 2/3), read
   from `RunResult.assertions[].semanticClaims`. Do **not** chase single-run all-pass — set `min_pass` to
   the reliably-hit core for a green verdict, and treat the per-claim rates as the real signal. (N=1
   routinely mislabels a stable 0/3 as "intermittent" and vice-versa.)
5. **Check discrimination — does the skill actually help?** Run one rep with the skill NOT installed (or
   inspect a not-invoked rep). If the answer still scores high, that claim is answerable from priors and
   tests the model, not your skill — strengthen it (a skill-specific fact) or drop it.
6. **Gate a change on the profile diff.** Capture the per-claim profile before your edit (the baseline),
   make the edit, re-capture, and compare per claim: a claim that DROPPED (e.g. 3/3 → 0/3) is a regression
   your edit caused; a claim already at 0/3 (a known gap) cannot regress. That turns "did my SKILL.md
   refactor quietly make the advice worse?" into a checkable gate.

**Lane note:** `semantic_matches` is **live-only** (the judge is a live model call), so these scenarios
run on the `run` lane, never token-free `replay` — the linter's "all assertions live-only" warning is
expected and correct here.

## Recipe 6 — Iterate a skill across fixes (ground findings, don't cross-pair generations)

Hardening a skill is a loop: run → read what it did → fix → run again. Two disciplines keep it honest.

1. **Verify before you trust.** A green run is not a correct run, and a skill's self-reported finding (a
   self-critique appendix, "I extracted X") is not real until its cited evidence is found in the run's own
   output. **Reproduce before acting on a finding:** `cowork-harness skill <folder> "<prompt>" --repeat 5 --label gen-1`
   runs the same skill+prompt N times (2-100) and prints a variance rollup instead of a single pass/fail —
   `--repeat` works on the `skill` lane, not just `run`. A single green run proves it passed *once*.
   Companions: `--min-pass-rate`, `--stop-on-diverge`, `--max-budget-usd`, `--allow-budget-stop`. It rejects `--session-id`/
   `--resume` (both pin one run dir) and `--decider-cmd`/`--decider-dir` (a driving agent x N is not a
   measurement).
   The full loop (harvest -> reproduce -> fix -> prove freshness -> compare) is written out end-to-end in
   docs/debugging.md under "The whole loop, end to end". The harness now SHIPS a grader — `cowork-harness critique <skill-folder> --prompt "<probe>"` runs the
   skill, asks the agent what confused it, and grades that self-report against a frozen record of the run
   (blinded evaluator + mechanical citation checking). **Critiquing a document-analysis skill?** The probe
   attaches nothing on its own — pass `--upload <path>` (repeatable) or `--folder <dir>` exactly as you
   would to `skill`, or the graded run has no file and "there was no file attached" is the correct finding,
   not a skill defect. Source flags reach both spawned turns automatically. UNRELEASED — see SKILL.md's
   floor list. See docs/critique.md for the full flag table, cost and limits. If you
   prefer to build your own grader, the substrate is still here:
   - `result.json` → `finalMessage` (the skill's own answer/critique) + `toolResults[]` (tool outputs).
   - `cowork-harness trace <run-dir> --output-format json` → the tool-call stream. Add `--full-results` so
     a **successful** call's full input + result are captured (the default view slices them to ~100/120
     chars) — this is what lets your grader confirm "the skill claims it read X and derived Y" against the
     actual call.
   - `cowork-harness inspect <run-dir>` → what the run produced, plus the run's `label` and `skillHash`.
   - In-run alternative: dispatch a checker **sub-agent** (maker/checker) whose result folds into the
     verdict.
2. **Don't cross-pair generations.** When you run the same skill across fixes, never pair a *pre-fix*
   `result.json` with a *post-fix* critique. The authoritative version key is `fingerprint.skillHash` —
   content-exact, on every live `run`/`skill` run that mounts a skill or plugin — **but only on ≥ 1.5.0; earlier CLIs emit
   no `skillHash` on the `skill` lane at all, so verify the field is present before pairing on it** (a run that mounts nothing
   records none; the `chat` lane records no fingerprint), changes on any tracked edit. **Group/pair on it**
   (`inspect` and the
   run-index row surface a short prefix). Add `--label <tag>` for a human-readable generation name
   (skillHash is the correctness key; the label is ergonomics). `cowork-harness verify-run <run-dir>
   <scenario.yaml>` is the native staleness guard: it **warns** when a kept run predates the current
   skill, and with scripted `answers` **hard-fails** rather than vouch for a stale gate snapshot.

**Lane note:** the exploratory driver is `skill <dir> --decider-llm --intent "<what this run tests>"`,
which is flagged non-deterministic (a green here is exploration, not a scripted pass) — pin the
load-bearing gates with `--answer` once you know which fire.
