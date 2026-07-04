# Task recipes — end-to-end paths for the four jobs consumers actually reverse-engineer

Each recipe composes facts that live scattered across SKILL.md and the other references into one
decision path. They were derived from a real consumer's adoption report — every one answers a
question a fleet owner had to work out the hard way. Facts track the harness version in SKILL.md's
front-matter; the `resolved-tier`/`unverifiable-tier` staleness classes (Recipe 2) and
`init-redact` (Recipe 3) are new in the release AFTER 0.23.0.

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

Top-level fields of a `*.cassette.json` (schema `schema/cassette.v7.json`):

| Field | What it is |
|---|---|
| `$schema`, `generator`, `cassetteVersion` | Provenance: schema URL, producing tool, format version (current: 7) |
| `scenario` | The embedded scenario snapshot at record time |
| `events` | The recorded agent event stream (the replay source) |
| `controlOut` | Driver→agent control responses — presence unlocks gate asserts on replay |
| `effectiveFidelity` | The tier the live record actually resolved to (the drift-audit key above) |
| `artifacts` | Output-file manifest (paths + hashes + small inlined bodies) — unlocks `file_exists`/`artifact_json` on replay |
| `fingerprint` | Skill/baseline staleness tripwire |
| `userVisibleRoots` | The user-visible mount roots captured at record time |
| `scenarioSource` | Relative path to the authored YAML this was recorded from |
| `authoring` | Present iff a live decider answered ≥1 gate during recording (`nonDeterministic: true`) |

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
   `--allow-path '/opt/ci-runner/.*'` — over bare `--allow` (which applies to every class and can
   let a domain allow swallow an email leak). For a version-controlled allowlist use
   `--allow-file <path>`: bare all-class patterns, one regex per line, `#` comments and blank
   lines ignored.

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
