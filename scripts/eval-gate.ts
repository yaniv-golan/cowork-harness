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
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

/** Null iff the candidate's observed models match the baseline's recorded provenance; otherwise a loud,
 *  human-readable reason the gate must refuse to diff. A null recorded model (older baseline) is treated as
 *  "unknown" and does NOT block — only a concrete mismatch does. Exported for unit tests. */
export function modelMismatch(base: ProfileMeta, candJudge: string | null, candAnswerer: string | null): string | null {
  const bad: string[] = [];
  if (base.judgeModel && candJudge && base.judgeModel !== candJudge)
    bad.push(`judge: baseline "${base.judgeModel}" vs candidate "${candJudge}"`);
  if (base.answererModel && candAnswerer && base.answererModel !== candAnswerer)
    bad.push(`answerer: baseline "${base.answererModel}" vs candidate "${candAnswerer}"`);
  return bad.length ? bad.join("; ") : null;
}

const frac = (s: string): number | null => {
  const [n, d] = s.split("/").map(Number);
  return d ? n / d : null;
};

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
      // Match claims by TEXT, not index (C1: rubric is `string[]`, so the claim text IS its identity).
      // Index matching would silently diff mismatched claims after any rubric edit/insert; text matching
      // makes an edited/removed claim UNMATCHED (never scored) — the documented "a rubric edit requires a
      // fresh --rebaseline" workflow, now actually enforced rather than a false green/red.
      const cc = cs.claims.find((x) => claimKey(x.claim) === claimKey(bc.claim));
      if (!cc) {
        out.unmatched.push(
          `${scenario}[${bc.index}] "${bc.claim.slice(0, 60)}" (no text match in candidate — claim edited/removed; rebaseline)`,
        );
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
  const rubric = reps.find((r) => r.claims.length)?.claims.map((c) => c.claim) ?? [];
  const rate = (set: typeof reps, idx: number) => set.filter((r) => r.claims.find((c) => c.index === idx)?.pass).length;

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
    claims: rubric.map((claim, index) => ({
      index,
      claim,
      pass: `${rate(measured, index)}/${measured.length}`,
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

/** One `run --output-format json` invocation, parsed. Async so a pool can run several at once. */
function runOnce(file: string, dotenv: string | undefined, ablate: boolean): Promise<unknown> {
  return new Promise((resolveJob) => {
    const args = ["tsx", "src/cli.ts", ...(dotenv ? ["--dotenv", dotenv] : []), "run", file, "--output-format", "json"];
    if (ablate) args.push("--ablate-skill");
    const child = spawn("npx", args, { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("close", () => {
      try {
        resolveJob(JSON.parse(buf || "{}"));
      } catch {
        resolveJob({});
      }
    });
    child.on("error", () => resolveJob({}));
  });
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
  const single = (s: Set<string>, label: string): string | null => {
    if (s.size === 0) return null;
    if (s.size > 1)
      process.stderr.write(
        `[eval-gate] WARNING: ${s.size} distinct ${label} models observed (${[...s].join(", ")}) — run was not model-homogeneous\n`,
      );
    return [...s].sort()[0]!;
  };
  return { scenarios: profile, judgeModel: single(judge, "judge"), answererModel: single(answerer, "answerer") };
}

/** Read the on-disk baseline, tolerating a legacy flat (header-less) profile as "provenance unknown". */
function readProfileFile(path: string): ProfileFile {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw && typeof raw === "object" && "scenarios" in raw && "__meta__" in raw) return raw as unknown as ProfileFile;
  return {
    __meta__: { judgeModel: null, answererModel: null, judgePromptHash: null, harnessVersion: "unknown", date: "unknown" },
    scenarios: raw as unknown as Profile,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const val = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const reps = Number(val("--reps") ?? (flag("--calibrate") ? 4 : 6));
  const dotenv = val("--dotenv");
  const concurrency = Number(val("--concurrency") ?? 4);

  if (flag("--calibrate")) {
    // Ablation: a claim that still passes WITHOUT the skill is not discriminating → excluded from the gate.
    const ablated = await capture(reps, dotenv, true, concurrency);
    const file = readProfileFile(BASELINE);
    const base = file.scenarios;
    const forced: string[] = [];
    for (const [scen, sp] of Object.entries(ablated.scenarios)) {
      const b = base[scen];
      if (!b) continue;
      // Too few gradeable skill-removed reps ⇒ removing the skill reliably broke the run: the strongest
      // discrimination signal there is. Mark every claim in the scenario discriminating rather than
      // trusting a <MIN_VALID-sample rate. Iterate the BASELINE's claims so each is tagged even when
      // ablation produced zero gradeable reps for it (a claim absent from the ablated set defaults
      // discriminating — the safe direction, since an untagged claim is gated on anyway).
      const insufficient = sp.validReps < MIN_VALID;
      if (insufficient) forced.push(`${scen} (${sp.validReps}/${reps} gradeable ablated reps)`);
      for (const bc of b.claims) {
        const ac = sp.claims.find((c) => c.index === bc.index);
        bc.discriminating = insufficient || !ac ? true : (frac(ac.pass) ?? 0) < 0.75; // passes <3/4 without the skill ⇒ discriminating
      }
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
  process.stdout.write(lines.join("\n") + "\n");
  if (b.regressions.length || b.triggerRegressions.length) process.exitCode = 1;
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
