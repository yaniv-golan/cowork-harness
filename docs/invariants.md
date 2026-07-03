# Invariants index

Every row here cost a real bug when it was violated. This is a flat index — enforcement code first, then
the test that pins it. Prose explaining *why* each one matters lives at the "enforced by" link (don't
duplicate it here; this table is for finding things fast, not for the full rationale).

| Invariant | Enforced by | Tested by |
|---|---|---|
| `serializeDecision` must emit `updatedInput: { questions, answers }`, never `{ answers }` alone (O7 bug: dropping `questions` throws `q.map` in the in-VM binary, the answer never reaches the model) | `src/agent/session.ts` (`serializeDecision`) | `test/seams.test.ts` (regression guard, ~L135-142: `updatedInput.questions` must survive `serializeDecision`; tamper test, ~L867-926: dropping `questions` trips the `replay_protocol_fidelity` guard) |
| `replay` must re-serialize `controlOut` via `serializeDecision` on the token-free lane — a new decision *kind* must extend both `serializeDecision` and `deserializeDecision` (declared inverses) | `src/agent/session.ts` | `test/seams.test.ts` (round-trip tests, ~L972-1047, assert `serializeDecision`/`deserializeDecision` are inverses for every decision kind; the tamper test at ~L867-926 exercises replay's re-serialization path directly) |
| A new `assert:` key must be classified into exactly one replay bucket (content vs. filesystem/egress) in `replayCassette` — an unclassified key throws at first replay instead of silently no-op'ing on CI | `src/run/cassette.ts:2471-2496` (exhaustiveness check over `AssertionSchema.shape`) | no dedicated test of the throw itself — it fires unconditionally on every `replayCassette` call (exercised across `test/seams.test.ts`, `test/cassette-protocol.test.ts`, and others); a newly-added unclassified key would surface as a thrown error the next time those suites run |
| `evaluate()` (`src/assert.ts`) is synchronous — no model-call/LLM-judge assertion without an explicit async-refactor decision (would break determinism + the replay lane) | `src/assert.ts` | `test/assert.test.ts` (459 lines directly exercising `evaluate()` across every assertion kind — no test asserts non-`Promise` return explicitly, but any accidental `async` conversion would surface as a broken call site across this file) |
| `profile:` is a retired alias for `baseline:` — do not reintroduce the term as a first-class concept | `src/types.ts` (the `Scenario` preprocess wrapper, immediately after the `ScenarioObject` definition — don't trust a line number here; grep `z.preprocess` to find it) | `test/cli-json.test.ts` (~L179-187: "deprecated scenario field `profile:` still parses ... + warns on stderr") |
| Answer paths (`--answer`/`--answer-policy`, `--decider-llm`, `--decider-cmd`, `--decider-dir`) are orthogonal; the bare `--on-unanswered llm` CLI flag is rejected and redirects to `--decider-llm` | `src/cli.ts` (decider flag validation) | `test/cli-json.test.ts` (~L133-141: bare `--on-unanswered llm` → usage error redirecting to `--decider-llm`; see also ~L64-141 and ~L253-262 for the broader decider-flag orthogonality guards) |
| CLI commands must resolve positional arguments via `positionals()`/`parseArgs` — never a first-non-dash-token scan (silently grabs a flag's value as a positional) | CI grep guard, `.github/workflows/ci.yml:34-43` | `test/cli-structural-guard.test.ts` (every command rejects an unknown flag) |
| `resolveAgentBinary` (with the newest-staged-binary fallback) must be defined only once, in `src/baseline.ts` — it was once duplicated inline in `container.ts`/`hostloop.ts` without the fallback | CI grep guard, `.github/workflows/ci.yml:44-53` | `test/agent-binary-single-source.test.ts` |
| Usage/runtime CLI errors must route through `fail(...)` (never a bare `log()` + `process.exit`) so `--output-format json` always gets the shared envelope; an intentional exception needs the `cli-error-envelope-exempt` marker | CI grep guard, `.github/workflows/ci.yml` (added by this plan's Task 1) | `test/cli-json-error-envelope.test.ts` (added by this plan's Task 1) |
| npm package version, package-lock version, companion-skill version (marketplace.json/plugin.json/SKILL.md), the skill's bootstrap floor, and README's floor references must all agree (6 sub-checks) | `scripts/check-versions.ts` | `npm run check:versions` (CI step `ci.yml:30-31`; no dedicated vitest file — it's a standalone script, not a unit-testable module boundary) |

## Adding a new invariant

When you introduce a new "this must never happen again" guard (a CI grep, an exhaustiveness throw, a
structural test), add a row here in the same commit. If it doesn't have a row here, the next contributor
won't know it exists until they break it.
