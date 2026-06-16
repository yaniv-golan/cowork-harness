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
  "scenario": { /* Scenario object — same schema as the .yaml */ },
  "events": [ /* JSON lines from events.jsonl (child→driver stdout) */ ],
  "controlOut": [ /* JSON lines from control-out.jsonl (driver→child control_responses) */ ]
}
```

`controlOut` is optional (old cassettes pre-dating full-fidelity replay lack it). When present it
enables full-fidelity replay (see §Full-fidelity replay below). When absent, replay falls back to
events-only mode with a loud warning.

## Recording prerequisites

`record` runs a live scenario first, then saves the two output files as a cassette:

```bash
cowork-harness record examples/scenarios/example-pdf-skill.yaml \
  --out cassettes/example-pdf-skill.cassette.json
```

This requires the same setup as `run` at container fidelity:
- A staged agent binary (Claude Desktop opened once).
- Docker (arm64) + the agent image (`cowork-agent-base:1`).
- A valid auth token (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`).

The generated cassette bundles the scenario, the event stream, and the decision responses. Secrets
(the injected OAuth token / API key) are scrubbed from the recorded `controlOut` by value at record
time — safe to commit for synthetic fixtures (see §Committed fixture below).

Without `--out`, the cassette is named after the scenario's `name:` (or the YAML filename).

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
| `subagent_tool_used` | a sub-agent used the tool |
| `subagent_tool_absent` | no sub-agent used the tool |
| `subagent_dispatched` | a sub-agent matching the regex was dispatched |
| `subagent_declared_but_unused` | sub-agent declared the tool but never used **that** tool (even if it used others) |
| `dispatch_count_max` | at most N sub-agents dispatched |
| `question_asked` | agent asked an AskUserQuestion matching the regex |
| `questions_count_max` | at most N questions asked |
| `gate_answers_delivered` | answered gates' answers reached the model |
| `result` | run ended with `success` or `error` |

**`question_asked`, `questions_count_max`, `gate_answers_delivered` require `controlOut`** (full-fidelity
replay). On an old cassette without `controlOut` these three keys are excluded from evaluation — not
vacuously passed — and a loud warning fires (see §Backward compatibility).

### Skipped on replay (filesystem / egress — run on live `run` only)

`file_exists`, `user_visible_artifact`, `no_delete_in_outputs`, `self_heal_ran`,
`transcript_no_host_path`, `egress_denied`, `egress_allowed`, `expect_denied`.

Skipped assertions are **absent** from `assertions[]` in the replay result (filtered before evaluation),
not present-and-passing. A CI script must not assume a fixed assertion count across replay and live lanes.

### Mixed assertions and the partial-skip warning

A single assertion object may mix a content key with a filesystem/egress key, e.g.
`{ result: "success", file_exists: "out.pdf" }`. On replay the object is **stripped to its content
keys** before evaluation — only `result` is checked; `file_exists` is silently dropped (it's live-only).
To keep "skipped ≠ false-green," replay fires a second loud warning whenever this happens:

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
      --cassette examples/replays/example-pdf-skill.cassette.json \
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
