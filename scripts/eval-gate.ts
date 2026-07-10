// The answer-quality regression gate for the companion skill. ONE tool produces the baseline AND the
// candidate profile with the SAME code (so a format mismatch is impossible), and gates a per-claim
// fraction profile with an explicit statistical rule.
//
//   tsx scripts/eval-gate.ts --rebaseline [--reps N] [--concurrency N] [--dotenv <path>]  → write test/evals/baseline/profile.json
//   tsx scripts/eval-gate.ts --calibrate  [--reps N] [--concurrency N] [--dotenv <path>]  → tag discriminating claims (ablation)
//   tsx scripts/eval-gate.ts [--allow-unmatched] [--reps N] [--concurrency N] [--dotenv <path>]  → gate candidate vs the committed profile
//     --allow-unmatched: don't hard-fail on unmatched scenario/claim coverage (F19) — print-only escape hatch
//     --reps / --concurrency must be positive integers (F24)
//
// Regression rule (documented, adjudicated — see docs/internal/2026-07-09-eval-gate-rebuild-plan.md §R2 C1):
// a DISCRIMINATING claim whose one-sided Fisher-exact drop (baseline pass-rate → candidate pass-rate) is
// significant at α=0.05 UNADJUSTED. The gate is adjudicated (a red is reviewed by a human, not an auto-merge
// block), so it must be able to fire on a single-claim collapse — which strict FDR at ~99 claims cannot.
// Discrete Fisher runs sub-nominal, so ~1–3 false reds/run over 99 claims, absorbed by adjudication.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { buildJudgePrompt } from "../src/decide/semantic-judge.js";

const SKILL = "cowork-harness";
const ALPHA = 0.05;
const MIN_VALID = 4; // a scenario with fewer valid+invoked reps than this errors the capture loud
const BASELINE = resolve("test/evals/baseline/profile.json");
const SCENARIO_DIR = resolve("test/evals/scenarios");
const HARNESS_VERSION = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version?: string }).version ?? "unknown";
const today = (): string => new Date().toISOString().slice(0, 10);
// Fingerprint of the JUDGE PROMPT TEMPLATE (rendered on a fixed sentinel rubric/answer, so it changes iff
// the template changes). Recorded in the baseline and checked by the gate: a prompt edit silently shifts
// every pass rate, and the model-provenance guard can't see it — so a baseline captured under a different
// prompt is not comparable and the gate must refuse to diff across it (M1).
const JUDGE_PROMPT_HASH = createHash("sha256")
  .update(buildJudgePrompt(["<c0>", "<c1>", "<c2>"], "<ANSWER>"))
  .digest("hex")
  .slice(0, 16);

// ─────────────────────────────── pure statistics (exported for tests) ───────────────────────────────

/** ln(n!) via lgamma (Lanczos) — for the hypergeometric tail without factorial overflow. */
function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const lnChoose = (n: number, k: number): number => (k < 0 || k > n ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1));

/** One-sided Fisher-exact p that the CANDIDATE dropped: P(candidate passes ≤ c | fixed margins), the lower
 *  tail on the candidate cell of the 2×2 table [[bPass, bN-bPass],[cPass, cN-cPass]]. Small values ⇒ the
 *  candidate is significantly worse than the baseline. */
export function fisherDropP(bPass: number, bN: number, cPass: number, cN: number): number {
  const total = bN + cN;
  const totalPass = bPass + cPass;
  const lnDenom = lnChoose(total, totalPass);
  let p = 0;
  // candidate cell k ranges over feasible values ≤ cPass; hypergeometric P(cand cell = k)
  const kMin = Math.max(0, totalPass - bN);
  for (let k = kMin; k <= cPass; k++) {
    p += Math.exp(lnChoose(cN, k) + lnChoose(bN, totalPass - k) - lnDenom);
  }
  return Math.min(1, p);
}

export interface ClaimProfile {
  index: number;
  claim: string;
  pass: string; // "k/n" over valid+invoked reps
  discriminating?: boolean; // set by --calibrate; undefined = not yet calibrated (treated as discriminating)
  priors?: string | null; // "k/n" over skill-not-invoked reps (informational)
}
export interface ScenarioProfile {
  reps: number;
  skillInvoked: string; // "inv/total"
  validReps: number;
  errored: number;
  claims: ClaimProfile[];
}
export type Profile = Record<string, ScenarioProfile>;

/** Provenance of a baseline: WHICH models produced these rates. The gate compares answer QUALITY, so a
 *  baseline recorded under a different judge or answerer is not comparable — diffing across it would report
 *  model drift as a skill regression. Recorded here so the guard (below) can enforce it. */
export interface ProfileMeta {
  judgeModel: string | null;
  answererModel: string | null;
  judgePromptHash: string | null; // fingerprint of the judge-prompt template at capture time (M1)
  harnessVersion: string;
  date: string;
}
/** The on-disk baseline: provenance header + the per-scenario profiles. */
export interface ProfileFile {
  __meta__: ProfileMeta;
  scenarios: Profile;
}

/** Strict "integer/integer" fraction parser (F27) — requires two integers, a POSITIVE denominator, and
 *  0 <= numerator <= denominator (a pass-rate can never exceed its sample size or be negative). Returns
 *  null on anything else (malformed text, "0/0", a negative, a decimal, NaN). Every caller MUST treat null
 *  as "invalidate the profile, loud" — never silently skip the comparison or default the rate to 0. */
export function parseFraction(s: string): { n: number; d: number } | null {
  const m = /^(\d+)\/(\d+)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!Number.isInteger(n) || !Number.isInteger(d) || d <= 0 || n < 0 || n > d) return null;
  return { n, d };
}
/** "k/n" shape, structurally AND semantically (0<=k<=n, n>0 via `parseFraction`). Used by the profile-file
 *  schema (F22) so a malformed fraction fails loud at load time, not deep inside a diff. */
const fractionShape = z
  .string()
  .regex(/^\d+\/\d+$/, 'must be an "integer/integer" fraction')
  .refine((s) => parseFraction(s) !== null, { message: "fraction must satisfy 0 <= numerator <= denominator with a positive denominator" });

// ─────────────────────────────── profile-file schema (F22) ───────────────────────────────
// readProfileFile used to presence-check keys and blind-cast (`as ProfileFile`) with no value validation, so
// a hand-edited or truncated profile.json would silently flow malformed strings/numbers into the statistics.
// Every field is validated here; a bad profile is a loud parse error, not a downstream NaN/crash.
const claimProfileSchema = z.object({
  index: z.number().int().nonnegative(),
  claim: z.string(),
  pass: fractionShape,
  discriminating: z.boolean().optional(),
  priors: fractionShape.nullable().optional(),
});
const scenarioProfileSchema = z.object({
  reps: z.number().int().nonnegative(),
  skillInvoked: fractionShape,
  validReps: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  claims: z.array(claimProfileSchema),
});
const profileSchema = z.record(z.string(), scenarioProfileSchema);
const profileMetaSchema = z.object({
  judgeModel: z.string().nullable(),
  answererModel: z.string().nullable(),
  judgePromptHash: z.string().nullable(),
  harnessVersion: z.string(),
  date: z.string(),
});
const profileFileSchema = z.object({
  __meta__: profileMetaSchema,
  scenarios: profileSchema,
});

/** Null iff the candidate's observed models match the baseline's recorded provenance; otherwise a loud,
 *  human-readable reason the gate must refuse to diff. A null recorded BASELINE model (older baseline) is
 *  treated as "unknown" and does NOT block. A concrete baseline model paired with an UNOBSERVED candidate
 *  model (F21: null candidate) is NOT tolerated — that pairing is unverifiable, not "compatible"; only an
 *  explicitly-legacy (null) BASELINE gets the null-tolerant pass. Exported for unit tests. */
export function modelMismatch(base: ProfileMeta, candJudge: string | null, candAnswerer: string | null): string | null {
  const bad: string[] = [];
  if (base.judgeModel) {
    if (!candJudge) bad.push(`judge: baseline "${base.judgeModel}" vs candidate unobserved (no live judge model captured) — unverifiable`);
    else if (base.judgeModel !== candJudge) bad.push(`judge: baseline "${base.judgeModel}" vs candidate "${candJudge}"`);
  }
  if (base.answererModel) {
    if (!candAnswerer)
      bad.push(`answerer: baseline "${base.answererModel}" vs candidate unobserved (no live answerer model captured) — unverifiable`);
    else if (base.answererModel !== candAnswerer) bad.push(`answerer: baseline "${base.answererModel}" vs candidate "${candAnswerer}"`);
  }
  return bad.length ? bad.join("; ") : null;
}

/** Identity of a rubric claim for baseline↔candidate matching — the claim text, whitespace-normalized so a
 *  reflow doesn't unmatch, but otherwise exact (any wording change unmatches → forces a rebaseline).
 *  Null-safe: a malformed claim (missing text) collapses to "" and simply won't match, never crashes. */
const claimKey = (claim: string | undefined): string => (claim ?? "").trim().replace(/\s+/g, " ");

export interface Bucketed {
  regressions: { scenario: string; index: number; claim: string; base: string; cand: string; p: number }[];
  inconclusive: { scenario: string; index: number; claim: string; base: string; cand: string; p: number }[];
  improvements: { scenario: string; index: number; claim: string; base: string; cand: string }[];
  triggerRegressions: { scenario: string; base: string; cand: string }[];
  skippedNonDiscriminating: number;
  unmatched: string[];
  // F19: true iff `unmatched` contains an entry that MUST fail the gate — a scenario missing from either
  // side, a discriminating (or not-yet-calibrated) claim with no text match, or a malformed fraction. A
  // non-discriminating claim's text-mismatch is still recorded in `unmatched` for visibility but does NOT
  // set this (it was already excluded from grading, same as `skippedNonDiscriminating`).
  hardFail: boolean;
}

/** Diff a candidate profile against the baseline, per claim, with the documented Fisher rule. */
export function bucketDiff(baseline: Profile, candidate: Profile): Bucketed {
  const out: Bucketed = {
    regressions: [],
    inconclusive: [],
    improvements: [],
    triggerRegressions: [],
    skippedNonDiscriminating: 0,
    unmatched: [],
    hardFail: false,
  };
  const baseScenarios = new Set(Object.keys(baseline));
  for (const [scenario, bs] of Object.entries(baseline)) {
    const cs = candidate[scenario];
    if (!cs) {
      out.unmatched.push(`${scenario} (missing from candidate)`);
      out.hardFail = true; // F19: unmatched scenario coverage is a hard failure, not print-only
      continue;
    }
    // trigger-rate regression: the skill reliably fired at baseline (≥0.8) and its invocation dropped
    // SIGNIFICANTLY in the candidate — judged by the SAME one-sided Fisher test used per-claim, not a crude
    // fixed threshold. A fixed "candidate ≤ 0.5" fires on a statistically-insignificant dip (e.g. 5/6→3/6,
    // p≈0.3) driven by model-invocation nondeterminism, manufacturing a false red on a same-code run;
    // Fisher fires only on a real collapse (6/6→≤1/6) and routes noise to inconclusive.
    // F27: strict fraction parse instead of `split("/").map(Number)` + a falsey-denominator skip — a
    // malformed/zero-denominator `skillInvoked` string is invalidated loud, not silently ignored.
    const bInvFrac = parseFraction(bs.skillInvoked);
    const cInvFrac = parseFraction(cs.skillInvoked);
    if (!bInvFrac || !cInvFrac) {
      out.unmatched.push(`${scenario} malformed skillInvoked fraction (base="${bs.skillInvoked}" cand="${cs.skillInvoked}")`);
      out.hardFail = true;
    } else {
      const { n: bInv, d: bTot } = bInvFrac;
      const { n: cInv, d: cTot } = cInvFrac;
      if (bInv / bTot >= 0.8 && cInv / cTot < bInv / bTot && fisherDropP(bInv, bTot, cInv, cTot) <= ALPHA)
        out.triggerRegressions.push({ scenario, base: bs.skillInvoked, cand: cs.skillInvoked });
    }
    const baseClaimKeys = new Set(bs.claims.map((c) => claimKey(c.claim)));
    for (const bc of bs.claims) {
      // Match claims by TEXT, not index (C1: rubric is `string[]`, so the claim text IS its identity).
      // Index matching would silently diff mismatched claims after any rubric edit/insert; text matching
      // makes an edited/removed claim UNMATCHED (never scored) — the documented "a rubric edit requires a
      // fresh --rebaseline" workflow, now actually enforced rather than a false green/red.
      const cc = cs.claims.find((x) => claimKey(x.claim) === claimKey(bc.claim));
      if (!cc) {
        out.unmatched.push(
          `${scenario}[${bc.index}] "${bc.claim.slice(0, 60)}" (no text match in candidate — claim edited/removed; rebaseline)`,
        );
        // F19: an unmatched DISCRIMINATING (or not-yet-calibrated) claim is a hard failure — coverage was
        // silently dropped. A known non-discriminating claim's drift is recorded but not fatal (it was
        // already excluded from grading).
        if (bc.discriminating !== false) out.hardFail = true;
        continue;
      }
      if (bc.discriminating === false) {
        out.skippedNonDiscriminating++;
        continue; // prior-answerable → excluded from the exit code
      }
      // F27: strict fraction parse — a malformed/zero-denominator `pass` string invalidates the claim loud
      // instead of the old `if (!bN || !cN) continue` silent skip.
      const bFrac = parseFraction(bc.pass);
      const cFrac = parseFraction(cc.pass);
      if (!bFrac || !cFrac) {
        out.unmatched.push(`${scenario}[${bc.index}] malformed pass fraction (base="${bc.pass}" cand="${cc.pass}")`);
        out.hardFail = true;
        continue;
      }
      const { n: bPass, d: bN } = bFrac;
      const { n: cPass, d: cN } = cFrac;
      const bRate = bPass / bN;
      const cRate = cPass / cN;
      if (cRate > bRate) {
        out.improvements.push({ scenario, index: bc.index, claim: bc.claim, base: bc.pass, cand: cc.pass });
        continue;
      }
      if (cRate === bRate) continue; // unchanged
      const p = fisherDropP(bPass, bN, cPass, cN);
      const row = { scenario, index: bc.index, claim: bc.claim, base: bc.pass, cand: cc.pass, p };
      if (p <= ALPHA) out.regressions.push(row);
      else out.inconclusive.push(row);
    }
    // F19: also iterate CANDIDATE-only claims — a claim text present in the candidate's rubric but absent
    // from the baseline's (e.g. a rubric addition) is unverifiable against the baseline and must not be
    // silently ignored; the claim/scenario SET must match on both sides, not just baseline→candidate.
    for (const cc of cs.claims) {
      if (!baseClaimKeys.has(claimKey(cc.claim))) {
        out.unmatched.push(`${scenario} candidate-only claim "${cc.claim.slice(0, 60)}" (no text match in baseline — rebaseline)`);
        out.hardFail = true;
      }
    }
  }
  // F19: candidate-only SCENARIOS (a new scenario file with no baseline coverage yet) were never iterated
  // at all — silently invisible to the gate. Report and hard-fail them too.
  for (const scenario of Object.keys(candidate)) {
    if (!baseScenarios.has(scenario)) {
      out.unmatched.push(`${scenario} (candidate-only scenario, no baseline coverage — rebaseline)`);
      out.hardFail = true;
    }
  }
  out.regressions.sort((a, b) => a.p - b.p);
  return out;
}

/** Aggregate a set of run envelopes (one scenario, N reps) into a ScenarioProfile. Reps that never invoked
 *  the skill measure priors, not the skill; reps whose judge grade was INVALID are counted (never dropped)
 *  but excluded from the pass denominator. Errors loud if too few valid+invoked reps remain. */
export function aggregateScenario(name: string, envelopes: unknown[], ablated = false): ScenarioProfile {
  const reps = envelopes
    .map((raw) => {
      const r = (raw as { results?: unknown[] }).results?.[0] as
        | {
            result?: "success" | "error";
            assertions?: {
              assertion?: { semantic_matches?: unknown };
              semanticClaims?: { index: number; claim: string; pass: boolean }[];
              judgeInvalid?: boolean;
            }[];
            skillsInvoked?: string[];
          }
        | undefined;
      if (!r || !Array.isArray(r.assertions)) return null;
      // A run that ERRORED (result:"error" — e.g. a session/rate limit, transport failure, or a genuine
      // task failure) produced no clean answer-quality measurement. Drop it here so it counts as `errored`,
      // NOT as a "ran but skill didn't fire" data point — otherwise a rate-limited candidate manufactures
      // false trigger-rate regressions (skillsInvoked is empty on an errored run) and false claim drops.
      // Too many errored ⇒ ran < MIN_VALID ⇒ the loud "untrustworthy" throw fires, which is correct.
      if (r.result === "error") return null;
      const sem = r.assertions.find((a) => a.assertion && (a.assertion as { semantic_matches?: unknown }).semantic_matches);
      if (!sem) return null;
      return { invoked: (r.skillsInvoked ?? []).includes(SKILL), invalid: sem.judgeInvalid === true, claims: sem.semanticClaims ?? [] };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // The measured set: skill-invoked & valid reps for a normal run; ALL valid reps for an ablated (skill
  // removed by design, so it never "invokes") calibration run.
  const invokedReps = ablated ? reps : reps.filter((r) => r.invoked);
  const measured = invokedReps.filter((r) => !r.invalid);
  const notInvoked = reps.filter((r) => !r.invoked);
  // F25: identify a claim by its normalized TEXT — the SAME identity `claimKey`/`bucketDiff` use — not by
  // its numeric `index`. The old code picked the rubric from the first non-empty rep and then counted every
  // OTHER rep purely by index, so a rep whose judge emitted the claims in a different order (or a different
  // set) silently voted into the wrong bucket instead of being caught. Every rep that carries a rubric must
  // agree on the exact ORDER/TEXT of claim keys with the first one; a mismatch invalidates the whole capture
  // loud (never a silent per-rep majority-rules guess).
  const repsWithClaims = reps.filter((r) => r.claims.length);
  const rubricKeys = repsWithClaims[0]?.claims.map((c) => claimKey(c.claim)) ?? [];
  for (const r of repsWithClaims) {
    const keys = r.claims.map((c) => claimKey(c.claim));
    if (keys.length !== rubricKeys.length || keys.some((k, i) => k !== rubricKeys[i]))
      throw new Error(
        `eval-gate: scenario ${name} has an inconsistent rubric across reps — expected [${rubricKeys.join(" | ")}] but a rep reported ` +
          `[${keys.join(" | ")}]; capture is untrustworthy (a nondeterministic/edited rubric mid-capture; rebaseline or fix the scenario)`,
      );
  }
  const rubricText = repsWithClaims[0]?.claims.map((c) => c.claim) ?? []; // original (display) text, order-aligned with rubricKeys
  const rate = (set: typeof reps, key: string) => set.filter((r) => r.claims.find((c) => claimKey(c.claim) === key)?.pass).length;

  // Two distinct UNTRUSTWORTHY conditions must throw loud (never silently write an empty/degenerate
  // profile — that is the vacuous-green trap the gate exists to prevent):
  //   1. Too few reps RAN at all (`ran < MIN_VALID`): most runs errored/crashed (rate-limit, transport,
  //      Docker) — we cannot trust anything, regardless of invocation.
  //   2. Enough ran AND enough invoked, but too few had a VALID judge grade: the judge kept failing.
  // What must NOT throw is the genuine trigger signal — enough reps RAN but few INVOKED the skill ("skill
  // stopped firing") — which flows through to bucketDiff (low skillInvoked ratio; "k/0" claim rates it
  // skips per-claim) so the trigger regression is REPORTED, not crashed on. The ABLATED path never throws
  // (skill-removed runs are expected to fail; that failure is the discrimination signal calibrate reads).
  const ran = reps.length; // envelopes that parsed WITH a semantic_matches assertion present
  if (!ablated && ran < MIN_VALID)
    throw new Error(
      `eval-gate: scenario ${name} produced only ${ran}/${envelopes.length} gradeable runs (rest errored) — capture is untrustworthy (rate-limit / transport / resource); lower --concurrency or retry`,
    );
  if (!ablated && invokedReps.length >= MIN_VALID && measured.length < MIN_VALID)
    throw new Error(
      `eval-gate: scenario ${name} had only ${measured.length}/${invokedReps.length} skill-invoked reps with a VALID judge grade (need ≥${MIN_VALID}) — judge failures make this capture untrustworthy`,
    );

  return {
    reps: reps.length,
    skillInvoked: `${reps.filter((r) => r.invoked).length}/${reps.length}`,
    validReps: measured.length,
    errored: envelopes.length - reps.length,
    claims: rubricKeys.map((key, index) => ({
      index,
      claim: rubricText[index] ?? key,
      pass: `${rate(measured, key)}/${measured.length}`,
      priors: notInvoked.length ? `${rate(notInvoked, key)}/${notInvoked.length}` : null,
    })),
  };
}

// ─────────────────────────────── orchestration ───────────────────────────────

function scenarioFiles(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => /^eval-\d.*\.yaml$/.test(f) && !f.endsWith("-session.yaml"))
    .map((f) => join(SCENARIO_DIR, f));
}

const RUN_TIMEOUT_MS = 10 * 60_000; // F23: a hung-but-alive child (stuck container, network stall) must not block the whole capture pool forever
const RUN_MAX_STDOUT_BYTES = 16 * 1024 * 1024; // F23: bound a spewing/looping child rather than growing the buffer unbounded

// F23 residual: `detached: true` (below) makes each spawned child its OWN process-group leader — which is
// exactly why `killGroup` can `process.kill(-pid, ...)` to take `npx`→`tsx`→`node` down together on a
// timeout/byte-cap. The SAME detachment means a SIGINT/SIGTERM delivered to THIS process (an operator's
// Ctrl-C mid-capture) does NOT propagate to an already-running child's group — an interrupted capture leaks
// running container runs for up to RUN_TIMEOUT_MS × the concurrency pool. Track every outstanding child's
// pid (its own group id) so an entry-path signal handler can kill them all before this process actually
// exits. Exported for a unit test of the tracking set itself — reliably simulating a real SIGINT/SIGTERM
// against a live child in a test harness is environment-dependent, so the set's add/remove lifecycle is
// what's verified directly.
export const outstandingChildPids = new Set<number>();

function killAllOutstandingChildGroups(): void {
  for (const pid of outstandingChildPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  outstandingChildPids.clear();
}

let orphanCleanupHandlersInstalled = false;
/** Idempotent (F23 residual): installs the Ctrl-C/SIGTERM cleanup at most once no matter how many times it's
 *  called (a test calling it repeatedly, or a future second entry path) — repeat calls are a no-op. Exported
 *  for the unit test to verify idempotency directly; the real entry path below always calls it. */
export function installOrphanCleanupHandlers(): void {
  if (orphanCleanupHandlersInstalled) return;
  orphanCleanupHandlersInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAllOutstandingChildGroups();
      process.exit(1);
    });
  }
}

/** Spawn `cmd args...`, capturing stdout, bounded by a wall-clock TIMEOUT and a stdout BYTE CAP (F23) — both
 *  kill the whole process GROUP (the child is `detached`, so `npx` → `tsx` → `node` all die together; killing
 *  only the `npx` pid can leave the real runner alive and hung) and resolve `{}`. An empty-object resolution
 *  is exactly what a JSON-parse failure already produced here, so a timed-out/oversized rep flows through the
 *  SAME path `aggregateScenario` already uses for a crashed/rate-limited rep: it has no `results` array, so
 *  it's dropped and counted toward `errored`, and too many of them trips the existing MIN_VALID loud throw.
 *  A pure spawn wrapper (not baked into `runOnce`) so a unit test can exercise both failure paths against a
 *  trivial `node -e ...` child instead of a real 10-minute hang. Exported for unit tests. */
export function boundedSpawnJson(cmd: string, args: string[], timeoutMs = RUN_TIMEOUT_MS, maxBytes = RUN_MAX_STDOUT_BYTES): Promise<unknown> {
  return new Promise((resolveJob) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], detached: true });
    if (child.pid) outstandingChildPids.add(child.pid); // F23 residual: tracked until settled, below
    let buf = "";
    let bytes = 0;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL"); // fallback: not our own group leader (e.g. already reaped, or non-POSIX)
        } catch {
          /* already gone */
        }
      }
    };
    const finish = (value: unknown) => {
      if (settled) return; // a killed child can still emit a trailing close/error; only the first result counts
      settled = true;
      clearTimeout(timer);
      if (child.pid) outstandingChildPids.delete(child.pid);
      resolveJob(value);
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({});
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        killGroup();
        finish({});
        return;
      }
      buf += d.toString();
    });
    child.on("close", () => {
      try {
        finish(JSON.parse(buf || "{}"));
      } catch {
        finish({});
      }
    });
    child.on("error", () => finish({}));
  });
}

/** One `run --output-format json` invocation, parsed. Async so a pool can run several at once. */
function runOnce(file: string, dotenv: string | undefined, ablate: boolean): Promise<unknown> {
  const args = ["tsx", "src/cli.ts", ...(dotenv ? ["--dotenv", dotenv] : []), "run", file, "--output-format", "json"];
  if (ablate) args.push("--ablate-skill");
  return boundedSpawnJson("npx", args);
}

/** Run every (scenario × rep) job through a bounded concurrency pool, aggregate by scenario. Container
 *  runs are heavy, so the default cap is small; each scenario is fully isolated per the harness. */
interface Capture {
  scenarios: Profile;
  judgeModel: string | null;
  answererModel: string | null;
}

async function capture(reps: number, dotenv: string | undefined, ablate: boolean, concurrency: number): Promise<Capture> {
  const files = scenarioFiles();
  const jobs: { name: string; file: string }[] = [];
  for (const file of files) for (let i = 0; i < reps; i++) jobs.push({ name: basename(file, ".yaml"), file });
  const byScenario = new Map<string, unknown[]>();
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const env = await runOnce(job.file, dotenv, ablate);
      (byScenario.get(job.name) ?? byScenario.set(job.name, []).get(job.name)!).push(env);
      done++;
      if (done % 5 === 0 || done === jobs.length)
        process.stderr.write(`[eval-gate] ${ablate ? "ablate " : ""}${done}/${jobs.length} runs\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  const profile: Profile = {};
  for (const file of files) {
    const name = basename(file, ".yaml");
    profile[name] = aggregateScenario(name, byScenario.get(name) ?? [], ablate);
  }
  // Observe which models actually produced these runs — recorded as baseline provenance and checked by the
  // gate's same-model guard (a run must be model-homogeneous for the guard to mean anything).
  // Only REAL live model ids count. Placeholder markers wrapped in angle brackets (e.g. `<synthetic>`, the
  // model field of a cassette/replay rep that used NO live model) are not answerers — including them would
  // pollute the set and, via single()'s sort, spuriously flip the provenance and refuse a valid gate.
  const isLiveModel = (m: unknown): m is string => typeof m === "string" && !m.startsWith("<");
  const judge = new Set<string>();
  const answerer = new Set<string>();
  for (const envs of byScenario.values())
    for (const env of envs) {
      const r = (env as { results?: unknown[] }).results?.[0] as { assertions?: { judgeModel?: string }[]; models?: string[] } | undefined;
      if (!r) continue;
      for (const a of r.assertions ?? []) if (isLiveModel(a.judgeModel)) judge.add(a.judgeModel);
      for (const m of r.models ?? []) if (isLiveModel(m)) answerer.add(m);
    }
  return { scenarios: profile, judgeModel: singleModel(judge, "judge"), answererModel: singleModel(answerer, "answerer") };
}

/** Collapse a capture's observed model set to the single homogeneous model, or null if none were observed.
 *  F20: heterogeneity (>1 distinct model in one capture) used to be a WARNING, silently collapsed to the
 *  lexicographically-first id — an arbitrary choice that let a mixed-model run (e.g. a flaky model swap
 *  mid-capture) masquerade as a clean single-model provenance. Now it throws loud: the capture is INVALID
 *  and the gate must refuse to rebaseline/calibrate/gate on it, not silently pick one of the observed ids.
 *  Exported for unit tests. */
export function singleModel(s: Set<string>, label: string): string | null {
  if (s.size === 0) return null;
  if (s.size > 1)
    throw new Error(
      `eval-gate: ${s.size} distinct ${label} models observed in one capture (${[...s].join(", ")}) — capture is not model-homogeneous; ` +
        `refusing to gate/rebaseline/calibrate on it. Pin the model, or reduce --concurrency/--reps to isolate the drift, then retry.`,
    );
  return [...s][0]!;
}

/** Read the on-disk baseline, tolerating a legacy flat (header-less) profile as "provenance unknown" — but
 *  (F22) strictly SCHEMA-VALIDATING every field either way. `readProfileFile` used to presence-check keys
 *  and blind-cast (`as ProfileFile`/`as Profile`) with no value validation, so a hand-edited or truncated
 *  profile.json flowed malformed strings/numbers straight into the statistics; now a malformed profile is a
 *  loud, specific parse error at load time. Exported for unit tests. */
export function readProfileFile(path: string): ProfileFile {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (raw && typeof raw === "object" && "scenarios" in raw && "__meta__" in raw) {
    const parsed = profileFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`eval-gate: malformed profile file at ${path}: ${parsed.error.message}`);
    return parsed.data;
  }
  const legacy = profileSchema.safeParse(raw);
  if (!legacy.success) throw new Error(`eval-gate: malformed (legacy, header-less) profile file at ${path}: ${legacy.error.message}`);
  return {
    __meta__: { judgeModel: null, answererModel: null, judgePromptHash: null, harnessVersion: "unknown", date: "unknown" },
    scenarios: legacy.data,
  };
}

/** Parse a CLI numeric flag as a strictly positive finite integer (F24) — `Number(...)` on its own silently
 *  accepts 0, negatives, NaN (`Number(undefined)` if a default weren't supplied), fractions, and Infinity,
 *  all of which would then drive a spawn pool (`--concurrency`) or a rep count (`--reps`) into nonsense
 *  (zero workers, a negative loop bound, an infinite job list). `Number.isInteger` alone rejects NaN and
 *  ±Infinity too, so one check covers every bad case. Throws (caught by main's top-level handler) rather
 *  than silently clamping — a bad flag is a usage error, not something to guess through. Exported for tests. */
export function positiveIntFlag(raw: string | undefined, def: number, flagName: string): number {
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`eval-gate: ${flagName} must be a positive integer (got ${JSON.stringify(raw)})`);
  return n;
}

/** Tag every claim in a baseline scenario `discriminating` from the matching ablated-capture scenario, by
 *  normalized claim TEXT (F26) — the SAME identity `bucketDiff` uses, not the numeric `index` field (which
 *  can legitimately differ, or be flat-out mislabeled, between the baseline capture and this calibration
 *  run). Too few gradeable skill-removed reps (`validReps < MIN_VALID`) means removing the skill reliably
 *  broke the scenario — the strongest discrimination signal there is — so every claim is forced
 *  discriminating (the safe direction) rather than trusting a sub-floor sample rate. Otherwise, an unmatched
 *  claim (rubric drifted since the baseline was recorded) or a malformed ablated pass fraction (F27) is a
 *  loud calibration failure, never a silent default. Mutates `baseline.claims` in place. Exported for tests. */
export function calibrateScenario(scenario: string, baseline: ScenarioProfile, ablated: ScenarioProfile): void {
  const insufficient = ablated.validReps < MIN_VALID;
  for (const bc of baseline.claims) {
    if (insufficient) {
      bc.discriminating = true;
      continue;
    }
    const ac = ablated.claims.find((c) => claimKey(c.claim) === claimKey(bc.claim));
    if (!ac)
      throw new Error(
        `eval-gate: --calibrate claim mismatch — ${scenario}[${bc.index}] "${bc.claim.slice(0, 60)}" has no text match in the ` +
          `ablated capture (rubric drifted since the baseline was recorded); rebaseline, then recalibrate`,
      );
    const acFrac = parseFraction(ac.pass); // F27: strict parse, never a silent-0 default
    if (!acFrac) throw new Error(`eval-gate: --calibrate ${scenario}[${bc.index}] has a malformed ablated pass fraction "${ac.pass}"`);
    bc.discriminating = acFrac.n / acFrac.d < 0.75; // passes <3/4 without the skill ⇒ discriminating
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const val = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const reps = positiveIntFlag(val("--reps"), flag("--calibrate") ? 4 : 6, "--reps");
  const dotenv = val("--dotenv");
  const concurrency = positiveIntFlag(val("--concurrency"), 4, "--concurrency");
  const allowUnmatched = flag("--allow-unmatched");

  if (flag("--calibrate")) {
    // Ablation: a claim that still passes WITHOUT the skill is not discriminating → excluded from the gate.
    const ablated = await capture(reps, dotenv, true, concurrency);
    const file = readProfileFile(BASELINE);
    const base = file.scenarios;
    const forced: string[] = [];
    for (const [scen, sp] of Object.entries(ablated.scenarios)) {
      const b = base[scen];
      if (!b) continue;
      if (sp.validReps < MIN_VALID) forced.push(`${scen} (${sp.validReps}/${reps} gradeable ablated reps)`);
      calibrateScenario(scen, b, sp);
    }
    if (forced.length)
      process.stderr.write(
        `[eval-gate] skill-removal broke these scenarios (all their claims marked discriminating):\n  ${forced.join("\n  ")}\n`,
      );
    writeFileSync(BASELINE, JSON.stringify(file, null, 2) + "\n"); // preserves the rebaseline's provenance header
    process.stderr.write(`[eval-gate] calibration written to ${BASELINE}\n`);
    return;
  }

  if (flag("--rebaseline")) {
    const cap = await capture(reps, dotenv, false, concurrency);
    const file: ProfileFile = {
      __meta__: {
        judgeModel: cap.judgeModel,
        answererModel: cap.answererModel,
        judgePromptHash: JUDGE_PROMPT_HASH,
        harnessVersion: HARNESS_VERSION,
        date: today(),
      },
      scenarios: cap.scenarios,
    };
    writeFileSync(BASELINE, JSON.stringify(file, null, 2) + "\n");
    process.stderr.write(
      `[eval-gate] baseline written to ${BASELINE} (judge=${cap.judgeModel}, answerer=${cap.answererModel}; run --calibrate next to tag discriminating claims)\n`,
    );
    return;
  }

  // Gate.
  const baseFile = readProfileFile(BASELINE);
  const cap = await capture(reps, dotenv, false, concurrency);
  // Refuse to diff across a model change — otherwise the gate reports model drift as a skill regression.
  const mism = modelMismatch(baseFile.__meta__, cap.judgeModel, cap.answererModel);
  if (mism) {
    process.stderr.write(
      `[eval-gate] REFUSING to gate — candidate models differ from the baseline's provenance, so a diff would measure model behavior, not skill quality:\n  ${mism}\n` +
        `  Re-record the baseline (--rebaseline) under the current models, or restore the pinned models, then retry.\n`,
    );
    process.exitCode = 1;
    return;
  }
  // Refuse across a judge-prompt change too (M1) — a prompt edit silently shifts every pass rate, invisible
  // to the model guard. A null recorded hash (legacy baseline) is treated as unknown and does not block.
  if (baseFile.__meta__.judgePromptHash && baseFile.__meta__.judgePromptHash !== JUDGE_PROMPT_HASH) {
    process.stderr.write(
      `[eval-gate] REFUSING to gate — the judge prompt changed since this baseline was recorded ` +
        `(baseline ${baseFile.__meta__.judgePromptHash} vs current ${JUDGE_PROMPT_HASH}); every pass rate may have shifted. Re-record with --rebaseline.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const b = bucketDiff(baseFile.scenarios, cap.scenarios);
  const lines: string[] = [];
  if (b.regressions.length) {
    lines.push(`✗ ${b.regressions.length} regression(s) (discriminating claim, Fisher p ≤ ${ALPHA}):`);
    for (const r of b.regressions)
      lines.push(`  - ${r.scenario}[${r.index}] ${r.base}→${r.cand} (p=${r.p.toFixed(3)}) ${r.claim.slice(0, 80)}`);
  } else lines.push(`✓ no regressions`);
  if (b.triggerRegressions.length) {
    lines.push(`✗ ${b.triggerRegressions.length} trigger-rate regression(s) (skill stopped firing):`);
    for (const t of b.triggerRegressions) lines.push(`  - ${t.scenario} invoked ${t.base}→${t.cand}`);
  }
  if (b.inconclusive.length) {
    lines.push(`? ${b.inconclusive.length} inconclusive drop(s) — escalate with --reps 12 to resolve:`);
    for (const r of b.inconclusive) lines.push(`  - ${r.scenario}[${r.index}] ${r.base}→${r.cand} (p=${r.p.toFixed(3)})`);
  }
  if (b.improvements.length) lines.push(`${b.improvements.length} improvement(s)`);
  lines.push(`${b.skippedNonDiscriminating} non-discriminating claim(s) excluded; ${b.unmatched.length} unmatched`);
  // F19: unmatched scenario/claim coverage (missing baseline coverage, a rubric-drifted claim still
  // discriminating, or a candidate-only scenario/claim never diffed) used to be print-only — the gate could
  // go green while silently NOT measuring part of the rubric. Now it's a hard failure unless the caller
  // explicitly opts out with --allow-unmatched (e.g. a deliberate, reviewed rubric-in-flux state).
  if (b.hardFail) {
    if (allowUnmatched) lines.push(`(--allow-unmatched: the ${b.unmatched.length} unmatched entrie(s) above did NOT fail the gate)`);
    else {
      lines.push(`✗ ${b.unmatched.length} unmatched scenario/claim entrie(s) — unverifiable coverage (pass --allow-unmatched to override):`);
      for (const u of b.unmatched) lines.push(`  - ${u}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  if (b.regressions.length || b.triggerRegressions.length || (b.hardFail && !allowUnmatched)) process.exitCode = 1;
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  installOrphanCleanupHandlers(); // F23 residual: a Ctrl-C must kill any outstanding bounded-spawn child group
  // Top-level loud-error catch: F20 (model heterogeneity), F22 (malformed profile), F24 (bad --reps/
  // --concurrency), F25 (inconsistent rubric across reps), F26 (calibration claim-text mismatch), and F27
  // (malformed fraction) all throw an `Error` rather than silently degrading; this is the single place that
  // turns any of them into a clean stderr message + a non-zero exit instead of an uncaught-rejection stack.
  main().catch((err: unknown) => {
    process.stderr.write(`[eval-gate] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
