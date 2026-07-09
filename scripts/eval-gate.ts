// The answer-quality regression gate for the companion skill. ONE tool produces the baseline AND the
// candidate profile with the SAME code (so a format mismatch is impossible), and gates a per-claim
// fraction profile with an explicit statistical rule.
//
//   tsx scripts/eval-gate.ts --rebaseline [--reps N] [--dotenv <path>]   → write test/evals/baseline/profile.json
//   tsx scripts/eval-gate.ts --calibrate  [--reps N] [--dotenv <path>]   → tag discriminating claims (ablation)
//   tsx scripts/eval-gate.ts              [--reps N] [--dotenv <path>]    → gate candidate vs the committed profile
//
// Regression rule (documented, adjudicated — see docs/internal/2026-07-09-eval-gate-rebuild-plan.md §R2 C1):
// a DISCRIMINATING claim whose one-sided Fisher-exact drop (baseline pass-rate → candidate pass-rate) is
// significant at α=0.05 UNADJUSTED. The gate is adjudicated (a red is reviewed by a human, not an auto-merge
// block), so it must be able to fire on a single-claim collapse — which strict FDR at ~99 claims cannot.
// Discrete Fisher runs sub-nominal, so ~1–3 false reds/run over 99 claims, absorbed by adjudication.
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SKILL = "cowork-harness";
const ALPHA = 0.05;
const MIN_VALID = 4; // a scenario with fewer valid+invoked reps than this errors the capture loud
const BASELINE = resolve("test/evals/baseline/profile.json");
const SCENARIO_DIR = resolve("test/evals/scenarios");

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

const frac = (s: string): number | null => {
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : null;
};

export interface Bucketed {
  regressions: { scenario: string; index: number; claim: string; base: string; cand: string; p: number }[];
  inconclusive: { scenario: string; index: number; claim: string; base: string; cand: string; p: number }[];
  improvements: { scenario: string; index: number; claim: string; base: string; cand: string }[];
  triggerRegressions: { scenario: string; base: string; cand: string }[];
  skippedNonDiscriminating: number;
  unmatched: string[];
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
  };
  for (const [scenario, bs] of Object.entries(baseline)) {
    const cs = candidate[scenario];
    if (!cs) {
      out.unmatched.push(`${scenario} (missing from candidate)`);
      continue;
    }
    // trigger-rate: baseline invoked ~fully → candidate ≤ half
    const [bInv, bTot] = bs.skillInvoked.split("/").map(Number);
    const [cInv, cTot] = cs.skillInvoked.split("/").map(Number);
    if (bTot && bInv / bTot >= 0.8 && cTot && cInv / cTot <= 0.5)
      out.triggerRegressions.push({ scenario, base: bs.skillInvoked, cand: cs.skillInvoked });
    for (const bc of bs.claims) {
      const cc = cs.claims.find((x) => x.index === bc.index);
      if (!cc) {
        out.unmatched.push(`${scenario}[${bc.index}] (claim missing in candidate)`);
        continue;
      }
      if (bc.discriminating === false) {
        out.skippedNonDiscriminating++;
        continue; // prior-answerable → excluded from the exit code
      }
      const [bPass, bN] = bc.pass.split("/").map(Number);
      const [cPass, cN] = cc.pass.split("/").map(Number);
      if (!bN || !cN) continue;
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
  }
  out.regressions.sort((a, b) => a.p - b.p);
  return out;
}

/** Aggregate a set of run envelopes (one scenario, N reps) into a ScenarioProfile. Reps that never invoked
 *  the skill measure priors, not the skill; reps whose judge grade was INVALID are counted (never dropped)
 *  but excluded from the pass denominator. Errors loud if too few valid+invoked reps remain. */
export function aggregateScenario(name: string, envelopes: unknown[]): ScenarioProfile {
  const reps = envelopes
    .map((raw) => {
      const r = (raw as { results?: unknown[] }).results?.[0] as
        | {
            assertions?: {
              assertion?: { semantic_matches?: unknown };
              semanticClaims?: { index: number; pass: boolean }[];
              judgeInvalid?: boolean;
            }[];
            skillsInvoked?: string[];
          }
        | undefined;
      if (!r || !Array.isArray(r.assertions)) return null;
      const sem = r.assertions.find((a) => a.assertion && (a.assertion as { semantic_matches?: unknown }).semantic_matches);
      if (!sem) return null;
      return { invoked: (r.skillsInvoked ?? []).includes(SKILL), invalid: sem.judgeInvalid === true, claims: sem.semanticClaims ?? [] };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const invokedValid = reps.filter((r) => r.invoked && !r.invalid);
  const notInvoked = reps.filter((r) => !r.invoked);
  const rubric = reps.find((r) => r.claims.length)?.claims.map((c) => c.claim) ?? [];
  const rate = (set: typeof reps, idx: number) => set.filter((r) => r.claims.find((c) => c.index === idx)?.pass).length;

  if (invokedValid.length < MIN_VALID)
    throw new Error(
      `eval-gate: scenario ${name} has only ${invokedValid.length}/${reps.length} valid skill-invoked reps (need ≥${MIN_VALID}) — capture is not trustworthy`,
    );

  return {
    reps: reps.length,
    skillInvoked: `${reps.filter((r) => r.invoked).length}/${reps.length}`,
    validReps: invokedValid.length,
    errored: envelopes.length - reps.length,
    claims: rubric.map((claim, index) => ({
      index,
      claim,
      pass: `${rate(invokedValid, index)}/${invokedValid.length}`,
      priors: notInvoked.length ? `${rate(notInvoked, index)}/${notInvoked.length}` : null,
    })),
  };
}

// ─────────────────────────────── orchestration ───────────────────────────────

function scenarioFiles(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => /^eval-\d.*\.yaml$/.test(f) && !f.endsWith("-session.yaml"))
    .map((f) => join(SCENARIO_DIR, f));
}

/** Run one scenario N times, return the parsed --output-format json envelopes. */
function runScenario(file: string, reps: number, dotenv: string | undefined, ablate: boolean): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < reps; i++) {
    const args = ["tsx", "src/cli.ts", ...(dotenv ? ["--dotenv", dotenv] : []), "run", file, "--output-format", "json"];
    if (ablate) args.push("--ablate-skill");
    const r = spawnSync("npx", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    try {
      out.push(JSON.parse(r.stdout || "{}"));
    } catch {
      out.push({});
    }
  }
  return out;
}

function capture(reps: number, dotenv: string | undefined, ablate: boolean): Profile {
  const profile: Profile = {};
  for (const file of scenarioFiles()) {
    const name = basename(file, ".yaml");
    process.stderr.write(`[eval-gate] ${ablate ? "ablate " : ""}${name} ×${reps}…\n`);
    profile[name] = aggregateScenario(name, runScenario(file, reps, dotenv, ablate));
  }
  return profile;
}

function readProfile(path: string): Profile {
  return JSON.parse(readFileSync(path, "utf8")) as Profile;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const val = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const reps = Number(val("--reps") ?? (flag("--calibrate") ? 4 : 6));
  const dotenv = val("--dotenv");

  if (flag("--calibrate")) {
    // Ablation: a claim that still passes WITHOUT the skill is not discriminating → excluded from the gate.
    const ablated = capture(reps, dotenv, true);
    const base = readProfile(BASELINE);
    for (const [scen, sp] of Object.entries(ablated)) {
      const b = base[scen];
      if (!b) continue;
      for (const claim of sp.claims) {
        const bc = b.claims.find((c) => c.index === claim.index);
        if (bc) bc.discriminating = (frac(claim.pass) ?? 0) < 0.75; // passes <3/4 without the skill ⇒ discriminating
      }
    }
    writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n");
    process.stderr.write(`[eval-gate] calibration written to ${BASELINE}\n`);
    return;
  }

  if (flag("--rebaseline")) {
    const profile = capture(reps, dotenv, false);
    writeFileSync(BASELINE, JSON.stringify(profile, null, 2) + "\n");
    process.stderr.write(`[eval-gate] baseline written to ${BASELINE} (run --calibrate next to tag discriminating claims)\n`);
    return;
  }

  // Gate.
  const baseline = readProfile(BASELINE);
  const candidate = capture(reps, dotenv, false);
  const b = bucketDiff(baseline, candidate);
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
  process.stdout.write(lines.join("\n") + "\n");
  if (b.regressions.length || b.triggerRegressions.length) process.exitCode = 1;
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
