# `test/evals/` — the companion skill's answer-quality gate

These are the project's **own** evals over the companion skill in
`.claude/skills/cowork-harness/` — a maintainer instrument, **not** shipped as part of the skill and
**not** part of `npm run ci`. They answer one question a deterministic test can't: *after someone edits
`SKILL.md`/`references/*`, does the skill still lead an agent to **correct** answers?*

They are **live** (real model runs + LLM-judge calls) and cost real money — see the cost note below. They
never gate a PR; a human adjudicates a red.

## Layout

| Path | What it is |
|---|---|
| `scenarios/eval-*.yaml` | 18 Q&A scenarios — each installs the skill and asserts the answer with a `semantic_matches` rubric of discrete, checkable claims. |
| `scenarios/_session.yaml` | shared session: installs the skill and **pins the answerer to a mid-tier model** (`claude-sonnet-5`) — too strong an answerer masks skill-content regressions. `eval-7-session.yaml` is a per-scenario override. |
| `baseline/profile.json` | the committed baseline: per-claim pass rates + which claims are `discriminating` (skill-driven), under a `__meta__` header recording the judge + answerer models it was captured with. |
| `files/` | cassette fixtures for the replay-based scenarios (e.g. the false-green debug case). |
| `evals.json` | the source eval spec the scenarios were derived from — **not read by the gate** (the gate runs the `scenarios/*.yaml`). |

## The gate — `scripts/eval-gate.ts` (`npm run eval-gate`)

One tool produces the baseline and the candidate with the **same code**, so a format mismatch is
impossible. All three modes take `--dotenv .env` (host-side credentials) and `--concurrency <N>` (default
4); `--reps <N>` overrides the rep count.

```bash
# 1. Record the baseline pass-rate profile (default N=6 reps/scenario).
npm run eval-gate -- --rebaseline --dotenv .env

# 2. Tag which claims the skill actually drives (skill-ablation, default N=4). A claim that still
#    passes WITHOUT the skill is not "discriminating" and is excluded from the gate's exit code.
npm run eval-gate -- --calibrate --dotenv .env

# 3. Gate a candidate skill edit against the committed baseline.
npm run eval-gate -- --dotenv .env
```

**How a red is decided.** A claim is a **regression** only if it is `discriminating` *and* its drop
(baseline pass-rate → candidate pass-rate) is significant by a one-sided **Fisher-exact** test at
**α = 0.05, unadjusted**. A near-total collapse fires (e.g. 6/6 → ≤1/6, p ≈ 0.03); a 5/6 → 2/6 wobble
(p ≈ 0.12) lands in **Inconclusive** by design — escalate it with `--reps 12`. A separate
**trigger-rate** check catches the skill no longer firing at all. The gate **refuses to diff** if the
candidate's judge or answerer model differs from the baseline's recorded provenance (that would measure
model drift, not skill quality) — re-record with `--rebaseline` after any intended model change.

**Detection power is honest, not oversold.** At N=6 the gate reliably catches *strong* degradation;
*subtle* degradation relies on the `--reps 12` escalation and the human `-`-line review of the skill diff.

## Workflow for a skill edit

1. `--rebaseline` + `--calibrate` on the current skill, commit `baseline/profile.json`.
2. Make the SKILL.md/reference edit.
3. `npm run eval-gate -- --dotenv .env`; read the per-claim buckets. Adjudicate any red (fix, escalate N,
   or re-baseline with justification). **Editing a rubric claim unmatches it** (claims are keyed by text),
   so a rubric change requires a fresh `--rebaseline`.

## Cost

A `--rebaseline` or a gate run is **18 × N live container runs + ~18 × N Opus judge calls** (N=6 ⇒ 108
each) — roughly 30–90 min at concurrency 3–4, real money per run. This is why it is off the blocking
per-PR path.

## Related

- **`npm run skill-critique`** (`scripts/skill-critique.ts`) — a companion *discovery* instrument that
  surfaces triaged, evidence-grounded improvement *ideas* for a skill (it never edits anything, always
  exits 0). Its live acceptance test is `scripts/skill-critique-acceptance.ts`
  (`npm run skill-critique-acceptance`).
- Author-facing `semantic_matches` guidance for skill users lives in the skill itself
  (`.claude/skills/cowork-harness/references/task-recipes.md`, Recipe 5).
