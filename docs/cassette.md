# Cassette guide

A **cassette** is the recorded control-protocol stream from a live run, saved as a single JSON file.
`replay` plays it back deterministically — no token, no model, no Docker — and re-evaluates the content
assertions. Record once in CI (or locally); replay on every PR for free.

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

## File shape

```jsonc
{
  "cassetteVersion": 6,                  // format version; ABSENT = legacy (0); a FUTURE version warns
  "scenario": { /* Scenario object — same schema as the .yaml */ },
  "events": [ /* JSON lines from events.jsonl (child→driver stdout) */ ],
  "controlOut": [ /* JSON lines from control-out.jsonl (driver→child control_responses) */ ],
  "userVisibleRoots": ["outputs", "myproject"], // visible roots = outputs + each connected folder's mount name (its basename; `.projects` is the pre-1.14271.0 legacy fallback)
  "artifacts": [                         // snapshot of outputs/ + connected folders (optional)
    { "path": "outputs/x.json", "bytes": 24, "sha256": "…", "body": "{…}" }, // body inlined ≤ 64 KiB
    { "path": "outputs/big.bin", "bytes": 9e6, "sha256": "…", "truncated": true } // oversized → hash-only
  ],
  "fingerprint": { "baseline": "1.15200.0", "skillHash": "…", "mode": "git", "contentSig": "…", "fileSigs": [["skills/x/SKILL.md", "…"]], "skillSources": ["…"] }, // staleness tripwire (v5 manifest: fileSigs; v6: mode + git default)
  "authoring": { "nonDeterministic": true, "channel": "decider-dir" } // present ONLY when a live decider answered ≥1 gate (see §Answering gates during recording); re-record may drift, replay is still deterministic
}
```

`controlOut` is optional (old cassettes pre-dating full-fidelity replay lack it). When present it
enables full-fidelity replay (see §Full-fidelity replay below). When absent, replay falls back to
events-only mode with a loud warning.

`artifacts` and `fingerprint` are also optional — both engage only when present, so old
cassettes replay unchanged. `cassetteVersion` is the format-schema version (a monotonic integer, not
semver): a value newer than the harness understands triggers a loud forward-compat warning.

## Recording prerequisites

`record` runs a live scenario first, then saves the two output files as a cassette:

```bash
cowork-harness record examples/scenarios/example-pdf-skill.yaml \
  --out cassettes/example-pdf-skill.cassette.json
```

This requires the same setup as `run` at container fidelity:
- A staged agent binary (Claude Desktop opened once).
- Docker (arm64) + the agent image (`cowork-agent-base:2`).
- A valid auth token (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`).

The generated cassette bundles the scenario, the event stream, and the decision responses. Secrets
(the injected OAuth token / API key) are scrubbed from the recorded `controlOut` by value at record
time — safe to commit for synthetic fixtures (see §Committed fixture below).

Without `--out`, the cassette is named after the scenario's `name:` (or the YAML filename).

## Answering gates during recording

By default `record` answers gates from the scenario's scripted `answers:` and falls to `on_unanswered`
(default `fail`) for anything unmatched — so an unanticipated gate aborts the record. Instead of a
separate discovery run to learn the gates, then encoding answers, then recording, you can answer them
**live during the recording**:

- `--decider-dir <dir>` — a driving agent answers in-band (pair with `gates`/`answer`). Single scenario
  only (not a `dir/` batch).
- `--decider-llm [--intent "<one line>"]` — a model answers the gates.
- `--on-unanswered first` — auto-pick option 1 for any unmatched gate.

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
   ::warning:: artifact <path>: body contained a secret and was replaced with [REDACTED:base64]; artifact_json/user_visible_artifact assertions on this artifact will fail at replay
   ```

The warning is intentional: any `artifact_json` or `user_visible_artifact` assertion targeting this
artifact **will fail at replay** because the body no longer matches its record-time content. This is
the correct outcome — a compromised artifact should not green a replay.

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

This table mirrors `src/run/cassette.ts` `contentKeys`, which is **the single source of truth**.
Content keys are evaluated on replay; everything else is skipped.

### Evaluated on replay (contentKeys)

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
| `subagent_tool_used` | a sub-agent used the tool |
| `subagent_tool_absent` | no sub-agent used the tool |
| `subagent_dispatched` | a sub-agent matching the regex was dispatched |
| `subagent_declared_but_unused` | sub-agent declared the tool but never used **that** tool (even if it used others) |
| `dispatch_count_max` | at most N sub-agents dispatched |
| `question_asked` | agent asked an AskUserQuestion matching the regex |
| `questions_count_max` | at most N questions asked |
| `gate_answers_delivered` | answered gates' answers reached the model |
| `result` | run ended with `success` or `error` |
| `allow_permissive_auto_allow` | verdict modifier — kept on replay → no-op pass (the live signal it suppresses is zeroed) |
| `allow_missing_capability` | verdict modifier — kept on replay → no-op pass (the live signal it suppresses is zeroed) |
| `allow_l0_plugin_divergence` | verdict modifier — kept on replay → no-op pass (the live signal it suppresses is zeroed) |
| `allow_stall` | verdict modifier — kept on replay → no-op pass (suppresses the `stalled` default-fail; the stall is re-derived on the replay re-drive) |

**`question_asked`, `questions_count_max`, `gate_answers_delivered` require `controlOut`** (full-fidelity
replay). On an old cassette without `controlOut` these three keys are excluded from evaluation — not
vacuously passed — and a loud warning fires (see §Backward compatibility).

### Filesystem assertions — replay-checkable WITH an artifact manifest

`file_exists`, `user_visible_artifact`, and `artifact_json` run on replay **when the cassette carries an
`artifacts` manifest** — `record` snapshots `outputs/` + connected folders and `replay` materializes that snapshot
to evaluate them token-free. `artifact_json` needs the JSON `body` inlined (small files); a hash-only
(`truncated`) entry still satisfies `file_exists` but not `artifact_json`. The inline cap is 64 KiB; raise it
with `record --max-artifact-bytes <n>` (or `COWORK_HARNESS_MAX_ARTIFACT_BYTES`) so a large structured deliverable
stays replay-checkable, and `record` fails fast if an `artifact_json` targets an artifact it had to truncate (that
would pass at record but fail at replay). Without a manifest (older
cassettes), these are skipped. A green replay re-confirms *record-time* artifacts, **not** that the current
skill still produces them — `replay --strict` fails the run when the `fingerprint` shows the skill/baseline
drifted.

### Still skipped on replay (no filesystem/network in a cassette)

`no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`, `egress_denied`, `egress_allowed`,
`expect_denied`.

Skipped assertions are **absent** from `assertions[]` in the replay result (filtered before evaluation),
not present-and-passing. A CI script must not assume a fixed assertion count across replay and live lanes.

### Mixed assertions and the partial-skip warning

A single assertion object may mix a content key with a still-skipped egress/filesystem key, e.g.
`{ result: "success", egress_denied: "evil.com" }`. On replay the object is **stripped to its
replay-checkable keys** before evaluation — only `result` is checked; `egress_denied` is dropped. (With an
artifact manifest, `file_exists`/`user_visible_artifact`/`artifact_json` are no longer dropped — they're
checkable; only the genuinely live-only keys above are.) To keep "skipped ≠ false-green," replay fires a
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

On replay, a `ReplayDecider` indexes `controlOut` by `request_id` and serves the recorded response to
the decision pipeline instead of consulting a live decider or asking the user. This makes the full
`Run.handleDecision` path execute on replay, which populates `rec.questions`, `rec.gateAnswers`, and
`rec.gateDeliveries` — exactly as in a live run. Consequence: `question_asked`, `questions_count_max`,
and `gate_answers_delivered` are now genuinely evaluated, not silently skipped or vacuously passed.

`gate_answers_delivered` accepts a boolean: `: true` asserts the answered gates' answers reached the
model; `: false` is the **inverse** — it asserts a *confirmed delivery failure* (at least one gate whose
`delivered === false`), for scenarios that deliberately exercise a non-delivery path. Unobserved delivery
(`delivered: null`) satisfies neither — absence of evidence is a failure, not a pass.

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

## Backward compatibility (old cassettes without controlOut)

Cassettes recorded before full-fidelity replay lack `controlOut`. Replay handles them without silently
regressing to the prior false-green behavior:

1. **A loud warning fires** on stderr:
   ```
   ::warning:: [replay] cassette has no controlOut (pre-full-fidelity) — question/gate assertions
   are NOT checked; re-record to enable them
   ```
2. **`question_asked`, `questions_count_max`, `gate_answers_delivered` are excluded** from the evaluated
   assertion set for that run — not vacuously passed, absent.
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

On every **harness major** (x.0.0) version bump, re-record AND re-verify all cassettes:

```bash
cowork-harness record scenarios/ --dry-run          # preview the scenarios + token/binary checks, write nothing
cowork-harness record scenarios/                    # or: record cassettes/ --rerecord-stale
cowork-harness verify-cassettes cassettes/
```

Why: a major may change the emulated system-prompt, the egress policy, or the hash algorithm — any of
which can shift recorded behavior. Structural assertions (`artifact_json`, `file_exists`, `result`) are
stable across these shifts; prose-level `transcript_matches` is not. Prefer structural asserts where
possible.

`verify-cassettes` reports these staleness causes:
- **`recorded under an older hash format (vN → vM)`** — format upgrade; re-record once and the message
  goes away. (Cassettes recorded before format **v6** all need one re-record — see the boundary note below.)
- **`skill files changed since record — N changed (path, …)`** — the **exact** changed/added/removed file(s),
  from the per-file manifest (`fileSigs`). For a scoped cassette it is prefixed with the bucket diagnosis
  (`shared root changed (scope: skills/x) [N changed (…)]`) so you still see whether the change was in your
  scoped skill or a shared dependency.
- **`recorded in '<mode>' file-set mode, verifying in '<mode>'`** — the staleness boundary differs between
  record and verify (e.g. recorded in a git work tree but verified from a non-repo copy); the hashes are not
  comparable, so re-record under the same mode.

**The skill-hash boundary (v6+):** by default the hash covers the **git-tracked** files of each skill/plugin
source dir (a dir not in a git repo falls back to a raw filesystem walk). **OS-junk** (`.DS_Store` /
`Thumbs.db` / `desktop.ini`) is always excluded, so a Finder touch never re-stales a cassette. Opt out of git
mode with `COWORK_HARNESS_GITSET=0`. Set `COWORK_HARNESS_DEBUG_SKILLHASH=1` to dump the exact file set on a
mismatch. Declare per-plugin non-runtime paths in `.cowork-hashignore` / the session `staleness.hash_ignore`.
Note `rehash` cannot migrate a pre-v6 cassette (the hash *input set* changed, not just the digest format) —
re-record those.

## Batch recording

`record` takes a single scenario OR a directory:

```bash
cowork-harness record scenarios/                 # record every scenario in the dir (one cassette each)
cowork-harness record cassettes/ --rerecord-stale # re-record ONLY the cassettes whose fingerprint drifted
```

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

A cassette snapshots the transcript **and** the `outputs/` JSON bodies (names, dollar figures, share
counts) — committed PII surface. Two layers, distinct from secret-scrub (which only strips auth tokens):

- **Opt-in redaction** (the mutation). Drop a `.cowork-redact.json` next to your scenarios, or set
  `COWORK_HARNESS_REDACT_PATTERNS` / `COWORK_HARNESS_REDACT_KEYS`. At record time it rewrites matching PII
  across the whole cassette surface (transcript, artifact bodies + filenames, prompt/answers/assert,
  skillSources) **structurally** — JSON stays valid and the AskUserQuestion question/answer strings stay in
  sync, so the O7 guard still passes. Redaction is **verdict-preserving**: `record` replays before/after and
  **refuses to write** if redaction would flip an assertion (a manufactured green is the cardinal sin).
  `--no-redact` skips it for known-synthetic inputs.
- **Always-on scan gate** — `verify-cassettes <file|dir>` scans the committed cassettes and **exits
  non-zero** on a finding, so "no leak" is a gate, not discipline. The full net (`email` + `currency` +
  bare-`domain`) runs over the **whole cassette** — the deliverable (`outputs/` bodies + filenames), the
  author-written `prompt`/`answers`/`assert`, AND the agent's reasoning + tool I/O — with **one structural
  exception**: the agent's **capability-manifest** messages (the `system/init` event and the `initialize`
  registry `control_response`, `request_id:"init-1"`) are excluded from the noisy classes. Those two carry
  the tool/skill catalog (slash-command descriptions naming `docsend.com`, `Pitch.com`, …) and the MCP-server
  names (`claude.ai Gmail`, …) — environment boilerplate a regex can't tell apart from customer data, and the
  sole concentrated source of false positives. They are excluded **as a unit**, not by domain — but `email`
  still scans them (the registry's `account` field can carry the developer's own email). `--allow <regex>`
  suppresses synthetic / public reference names (e.g. `NVCA`, `Cooley GO`, `Acme`); each allow must match the
  **whole** finding token (so a bare-domain allow no longer silently clears an email whose domain it matches), and
  `--allow-domain` / `--allow-email` scope an allow to a single finding class, while `--allow-file <path>` loads
  allows from a version-controlled file (one regex per line, `#` comments). Multi-word proper names are **not** a
  default class (too noisy). `verify-cassettes` also runs the **staleness** check (both checks run by
  default; scope to one with `--skip-privacy` or `--skip-staleness`): a drifted `skillHash` (you edited
  the skill but didn't re-record) fails the gate.
  The `skillHash` hard-excludes only what is UNIVERSALLY non-runtime — recorded cassettes (`*.cassette.json`,
  by extension, so writing a cassette under the hashed tree doesn't self-invalidate the fingerprint it just
  recorded), VCS/cache dirs (`.git`, `node_modules`, `__pycache__`, …), and the `version` field of a
  `.claude-plugin/plugin.json` manifest (a pure version bump is metadata; mcpServers/hooks/deps still count).

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

```bash
cowork-harness verify-cassettes cassettes/ --allow 'NVCA|Cooley GO|Acme'
```

The cardinal rule still holds: record against **synthetic** inputs (e.g. "Cadence / Acme", made-up
numbers) — redaction and the scan are belt-and-suspenders, not a license to record real customer data.

## Committed fixture

`examples/replays/example-pdf-skill.cassette.json` is a **synthetic** cassette committed to the repo
(not generated from a live run). It covers: assistant text, one permission gate, one AskUserQuestion
gate with a matching `tool_result`, and a `result: success`. Its `assert:` block exercises
`transcript_contains`, `tool_called`, `question_asked`, `gate_answers_delivered`, and `result` — the
full-fidelity path end to end.

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
```

This dogfoods the documented pattern and pins the fixture against future `parseMessage` / assertion /
`Run` regressions on every PR without spending a token.

For the complete CI pipeline (unit, boundary, scenarios, replay), see `.github/workflows/ci.yml` and
the [README Testing section](../README.md#testing--cicd).

## Cross-references

- [docs/scenario.md](./scenario.md) — `scenarios/*.yaml` schema, the full assertion reference, and
  which assertions survive replay.
- [SPEC.md](../SPEC.md) — the replay-fidelity contract clause (§11 / RunResult shape).
- `src/run/cassette.ts` — the implementation: `contentKeys`, `replayCassette`, `CassetteAgentSession`.
- `src/agent/session.ts` — `serializeDecision` (and its declared inverse `deserializeDecision`).
- `src/secrets.ts` — `scrubField` + `collectSecrets`, published as the `cowork-harness/secrets` subpath
  export for custom scrubbing pipelines.
