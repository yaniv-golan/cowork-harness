import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fisherDropP,
  bucketDiff,
  aggregateScenario,
  modelMismatch,
  parseFraction,
  readProfileFile,
  singleModel,
  positiveIntFlag,
  calibrateScenario,
  boundedSpawnJson,
  type Profile,
  type ProfileMeta,
  type ScenarioProfile,
} from "../scripts/eval-gate";

describe("fisherDropP — one-sided drop significance", () => {
  it("fires on a single-claim collapse, stays quiet on a wobble (the documented boundary)", () => {
    // A discriminating claim's realistic collapse is significant at α=0.05...
    expect(fisherDropP(6, 6, 2, 6)).toBeLessThan(0.05); // 6/6→2/6 ≈ 0.030
    expect(fisherDropP(5, 6, 1, 6)).toBeLessThan(0.05); // 5/6→1/6 ≈ 0.040
    expect(fisherDropP(6, 6, 0, 6)).toBeLessThan(0.05); // total collapse ≈ 0.001
    // ...but a 5/6→2/6 wobble and a 5/6→4/6 dip are NOT (they land in Inconclusive).
    expect(fisherDropP(5, 6, 2, 6)).toBeGreaterThan(0.05); // ≈ 0.121
    expect(fisherDropP(5, 6, 4, 6)).toBeGreaterThan(0.05);
  });
  it("never exceeds 1 and is 1-ish for no drop", () => {
    expect(fisherDropP(3, 6, 3, 6)).toBeGreaterThan(0.5);
    expect(fisherDropP(3, 6, 6, 6)).toBe(1);
  });
});

const claim = (index: number, pass: string, over: Partial<{ discriminating: boolean }> = {}) => ({
  index,
  claim: `claim ${index}`,
  pass,
  ...over,
});
const scen = (skillInvoked: string, claims: ReturnType<typeof claim>[]) => ({ reps: 6, skillInvoked, validReps: 6, errored: 0, claims });

describe("bucketDiff — regression / inconclusive / improvement / trigger / non-discriminating", () => {
  const baseline: Profile = {
    "eval-a": scen("6/6", [
      claim(0, "6/6", { discriminating: true }),
      claim(1, "6/6", { discriminating: false }),
      claim(2, "5/6", { discriminating: true }),
    ]),
    "eval-b": scen("6/6", [claim(0, "6/6", { discriminating: true })]),
  };
  const candidate: Profile = {
    "eval-a": scen("6/6", [claim(0, "2/6"), claim(1, "0/6"), claim(2, "4/6")]), // [0] collapse (reg); [1] non-discriminating (skip); [2] wobble (inconclusive)
    "eval-b": scen("2/6", [claim(0, "6/6")]), // trigger-rate regression (invoked 6/6→2/6)
  };
  const r = bucketDiff(baseline, candidate);

  it("flags a discriminating single-claim collapse as a regression", () => {
    expect(r.regressions.map((x) => `${x.scenario}[${x.index}]`)).toContain("eval-a[0]");
  });
  it("excludes a non-discriminating claim even when it drops hard", () => {
    expect(r.skippedNonDiscriminating).toBe(1);
    expect(r.regressions.map((x) => `${x.scenario}[${x.index}]`)).not.toContain("eval-a[1]");
  });
  it("routes a non-significant drop to inconclusive, not regression", () => {
    expect(r.inconclusive.map((x) => `${x.scenario}[${x.index}]`)).toContain("eval-a[2]");
  });
  it("flags a trigger-rate collapse separately", () => {
    expect(r.triggerRegressions.map((x) => x.scenario)).toContain("eval-b");
  });
});

describe("bucketDiff — trigger-rate uses the Fisher test, not a crude threshold", () => {
  const trig = (base: string, cand: string) =>
    bucketDiff({ s: scen(base, [claim(0, "6/6", { discriminating: true })]) }, { s: scen(cand, [claim(0, "6/6")]) }).triggerRegressions
      .length;

  it("does NOT fire on a statistically-insignificant invocation dip (the real eval-8 case: 5/6→3/6, p≈0.3)", () => {
    // Model-invocation nondeterminism on a SAME-CODE run must not manufacture a trigger regression.
    expect(fisherDropP(5, 6, 3, 6)).toBeGreaterThan(0.05);
    expect(trig("5/6", "3/6")).toBe(0);
    expect(trig("6/6", "4/6")).toBe(0); // 6/6→4/6 p≈0.11, noise
  });
  it("DOES fire on a real invocation collapse from a reliable baseline", () => {
    expect(trig("6/6", "1/6")).toBe(1); // 6/6→1/6 p≈0.008
    expect(trig("6/6", "0/6")).toBe(1); // total collapse
    expect(trig("6/6", "2/6")).toBe(1); // 6/6→2/6 p≈0.03
  });
  it("does not fire when the baseline itself was not reliably invoking (<0.8)", () => {
    expect(trig("3/6", "0/6")).toBe(0); // baseline never reliably fired → nothing to regress from
  });
});

describe("modelMismatch — the gate's same-model precondition", () => {
  const meta = (over: Partial<ProfileMeta> = {}): ProfileMeta => ({
    judgeModel: "claude-opus-4-8",
    answererModel: "claude-sonnet-5",
    judgePromptHash: "abc123",
    harnessVersion: "0.27.0",
    date: "2026-07-09",
    ...over,
  });

  it("passes (null) when both models match the baseline provenance", () => {
    expect(modelMismatch(meta(), "claude-opus-4-8", "claude-sonnet-5")).toBeNull();
  });
  it("blocks when the judge OR the answerer differs", () => {
    expect(modelMismatch(meta(), "claude-opus-4-7", "claude-sonnet-5")).toMatch(/judge:/);
    expect(modelMismatch(meta(), "claude-opus-4-8", "claude-sonnet-4")).toMatch(/answerer:/);
  });
  it("does NOT block on an unknown (legacy header-less) baseline", () => {
    expect(modelMismatch(meta({ judgeModel: null, answererModel: null }), "x", "y")).toBeNull();
  });
  it("F21: blocks when the baseline is concrete but the candidate model is unobserved (unverifiable, not tolerated)", () => {
    const r = modelMismatch(meta(), null, null);
    expect(r).toMatch(/judge:.*unobserved/);
    expect(r).toMatch(/answerer:.*unobserved/);
  });
  it("F21: null tolerance is reserved for an explicitly-legacy (null) BASELINE model, not a null candidate", () => {
    // Baseline judge is null (legacy/unknown) → candidate judge being null is fine (still unknown↔unknown).
    // Baseline answerer is concrete → candidate answerer being null is NOT fine (unverifiable).
    const r = modelMismatch(meta({ judgeModel: null }), null, null);
    expect(r).not.toMatch(/judge:/);
    expect(r).toMatch(/answerer:.*unobserved/);
  });
});

describe("aggregateScenario — invalid reps counted-not-dropped, invoked-only rates", () => {
  const env = (invoked: boolean, invalid: boolean, passes: boolean[], result: "success" | "error" = "success") => ({
    results: [
      {
        result,
        skillsInvoked: invoked ? ["cowork-harness"] : [],
        assertions: [
          {
            assertion: { semantic_matches: { rubric: ["a", "b"] } },
            judgeInvalid: invalid,
            semanticClaims: passes.map((p, i) => ({ index: i, claim: `claim ${i}`, pass: p })),
          },
        ],
      },
    ],
  });

  it("computes per-claim rates over VALID skill-invoked reps and surfaces priors", () => {
    const p = aggregateScenario("eval-x", [
      env(true, false, [true, true]),
      env(true, false, [true, false]),
      env(true, false, [true, true]),
      env(true, false, [true, false]),
      env(false, false, [true, true]), // not invoked → priors, not the rate
    ]);
    expect(p.claims[0].pass).toBe("4/4"); // claim 0 passes in all 4 valid+invoked reps
    expect(p.claims[1].pass).toBe("2/4");
    expect(p.claims[0].priors).toBe("1/1");
    expect(p.validReps).toBe(4);
  });

  it("does NOT throw on an ABLATED scenario below the valid-rep floor (skill-removal broke it — that IS the signal)", () => {
    // Only 2 gradeable skill-removed reps (< MIN_VALID) must not crash the calibration pass; the calibrate
    // loop reads the low validReps to force the scenario's claims discriminating.
    const p = aggregateScenario("eval-z", [env(true, false, [true, false]), env(true, false, [false, true])], true);
    expect(p.validReps).toBe(2);
    expect(p.claims).toHaveLength(2);
  });

  it("F1: throws ONLY when the skill fired enough but the JUDGE failed (untrustworthy), not on low invocation", () => {
    // 5 invoked reps but 2 are judge-invalid → 3 valid < MIN_VALID(4) → loud error (broken measurement)
    expect(() =>
      aggregateScenario("eval-y", [
        env(true, false, [true, true]),
        env(true, false, [true, true]),
        env(true, false, [true, true]),
        env(true, true, [true, true]),
        env(true, true, [true, true]),
      ]),
    ).toThrow(/untrustworthy/);
  });

  it("F1: throws LOUD when most reps ERRORED (empty envelopes) — never silently writes a vacuous profile", () => {
    // 6 errored envelopes ({} = crashed/rate-limited, no parseable assertion) → ran=0 < MIN_VALID → throw.
    // This is the mass-error case that must fail loud instead of producing claims:[] (a vacuous baseline).
    expect(() => aggregateScenario("eval-err", [{}, {}, {}, {}, {}, {}])).toThrow(/gradeable runs.*errored/);
    // Mixed: 2 ran, 4 errored → still < MIN_VALID ran → throw.
    expect(() => aggregateScenario("eval-err2", [env(true, false, [true, true]), env(true, false, [true, true]), {}, {}, {}, {}])).toThrow(
      /gradeable runs/,
    );
  });

  it("F1: an ERRORED rep (rate-limit) counts as errored, NOT as 'skill didn't fire' — no false trigger regression", () => {
    // 6 reps that ran+invoked+passed, plus 4 that ERRORED (result:error, skillsInvoked empty). The errored
    // reps must NOT inflate the not-invoked count (which would fake a trigger regression); they count as
    // errored. 6 gradeable ≥ MIN_VALID so no throw; skillInvoked reflects only the gradeable reps.
    const p = aggregateScenario("eval-rl", [
      env(true, false, [true, true]),
      env(true, false, [true, true]),
      env(true, false, [true, true]),
      env(true, false, [true, true]),
      env(true, false, [true, true]),
      env(true, false, [true, true]),
      env(false, false, [false, false], "error"),
      env(false, false, [false, false], "error"),
      env(false, false, [false, false], "error"),
      env(false, false, [false, false], "error"),
    ]);
    expect(p.errored).toBe(4);
    expect(p.skillInvoked).toBe("6/6"); // errored reps excluded from the denominator, not counted as not-invoked
  });

  it("F1: too many ERRORED reps → loud throw (untrustworthy), never a false trigger regression", () => {
    // 2 gradeable + 4 errored → ran=2 < MIN_VALID → throw (matches a rate-limited candidate run).
    expect(() =>
      aggregateScenario("eval-rl2", [
        env(true, false, [true, true]),
        env(true, false, [true, true]),
        env(false, false, [false, false], "error"),
        env(false, false, [false, false], "error"),
        env(false, false, [false, false], "error"),
        env(false, false, [false, false], "error"),
      ]),
    ).toThrow(/gradeable runs.*errored/);
  });

  it("F1: a scenario that STOPPED INVOKING does not throw — it emits a low-invocation profile for the trigger check", () => {
    // Skill fired in only 1/6 reps (it stopped triggering). This must NOT crash the capture (the old bug):
    // it is the trigger-rate signal itself and must reach bucketDiff.
    const p = aggregateScenario("eval-trig", [
      env(true, false, [true, true]),
      env(false, false, [true, true]),
      env(false, false, [true, true]),
      env(false, false, [true, true]),
      env(false, false, [true, true]),
      env(false, false, [true, true]),
    ]);
    expect(p.skillInvoked).toBe("1/6");
    expect(p.validReps).toBe(1);
    // And it composes: a baseline that fired fully vs this candidate → a trigger-rate regression is REPORTED
    // (previously unreachable because aggregateScenario threw first).
    const baseline: Profile = { "eval-trig": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    const cand: Profile = { "eval-trig": { reps: 6, skillInvoked: "1/6", validReps: 1, errored: 0, claims: p.claims } };
    expect(bucketDiff(baseline, cand).triggerRegressions.map((x) => x.scenario)).toContain("eval-trig");
  });

  it("F2: an edited claim's wording UNMATCHES (never scored), instead of diffing against the wrong baseline claim", () => {
    const baseline: Profile = { "eval-e": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    // candidate reworded claim 0 → same index, different text → must be unmatched, NOT diffed as 6/6→0/6.
    const cand: Profile = {
      "eval-e": {
        reps: 6,
        skillInvoked: "6/6",
        validReps: 6,
        errored: 0,
        claims: [{ index: 0, claim: "a REWORDED claim 0", pass: "0/6" }],
      },
    };
    const d = bucketDiff(baseline, cand);
    expect(d.regressions).toHaveLength(0); // no false red from a text mismatch
    expect(d.unmatched.some((u) => u.includes("eval-e"))).toBe(true);
  });
});

describe("bucketDiff — F19: unmatched scenario/claim coverage is a hard failure, not print-only", () => {
  it("sets hardFail when a baseline scenario is missing from the candidate", () => {
    const baseline: Profile = { "eval-a": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    const d = bucketDiff(baseline, {});
    expect(d.hardFail).toBe(true);
    expect(d.unmatched.some((u) => u.includes("eval-a") && u.includes("missing from candidate"))).toBe(true);
  });

  it("sets hardFail on a CANDIDATE-only scenario (new scenario file with no baseline coverage) — previously never iterated", () => {
    const baseline: Profile = { "eval-a": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    const candidate: Profile = {
      "eval-a": scen("6/6", [claim(0, "6/6")]),
      "eval-new": scen("6/6", [claim(0, "6/6")]),
    };
    const d = bucketDiff(baseline, candidate);
    expect(d.hardFail).toBe(true);
    expect(d.unmatched.some((u) => u.includes("eval-new") && u.includes("candidate-only scenario"))).toBe(true);
  });

  it("sets hardFail on a CANDIDATE-only claim within a matched scenario (rubric addition never diffed against the baseline)", () => {
    const baseline: Profile = { "eval-a": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    const candidate: Profile = {
      "eval-a": scen("6/6", [claim(0, "6/6"), { index: 1, claim: "a brand-new claim", pass: "6/6" }]),
    };
    const d = bucketDiff(baseline, candidate);
    expect(d.hardFail).toBe(true);
    expect(d.unmatched.some((u) => u.includes("candidate-only claim"))).toBe(true);
  });

  it("sets hardFail when an UNMATCHED baseline claim is discriminating (or not-yet-calibrated)", () => {
    const baseline: Profile = { "eval-e": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    const candidate: Profile = { "eval-e": scen("6/6", [{ index: 0, claim: "reworded", pass: "6/6" }]) };
    expect(bucketDiff(baseline, candidate).hardFail).toBe(true);

    // discriminating undefined (not yet calibrated) is treated the same as discriminating:true (documented
    // "undefined = not yet calibrated (treated as discriminating)").
    const baselineUncalibrated: Profile = { "eval-u": scen("6/6", [claim(0, "6/6")]) };
    const candidateUncalibrated: Profile = { "eval-u": scen("6/6", [{ index: 0, claim: "reworded", pass: "6/6" }]) };
    expect(bucketDiff(baselineUncalibrated, candidateUncalibrated).hardFail).toBe(true);
  });

  it("does NOT set hardFail for an unmatched claim already known non-discriminating (still excluded from grading)", () => {
    const baseline: Profile = { "eval-nd": scen("6/6", [claim(0, "6/6", { discriminating: false })]) };
    // Candidate has NO claims for this scenario at all (isolates the "baseline claim unmatched" path from
    // the separate "candidate-only claim" path below, which is unconditionally fatal for a different reason).
    const candidate: Profile = { "eval-nd": scen("6/6", []) };
    const d = bucketDiff(baseline, candidate);
    expect(d.hardFail).toBe(false);
    expect(d.unmatched.length).toBeGreaterThan(0); // still recorded for visibility
  });

  it("a fully matched baseline/candidate (identical scenario+claim sets) does not hardFail", () => {
    const baseline: Profile = { "eval-a": scen("6/6", [claim(0, "6/6", { discriminating: true })]) };
    const candidate: Profile = { "eval-a": scen("6/6", [claim(0, "6/6")]) };
    expect(bucketDiff(baseline, candidate).hardFail).toBe(false);
  });
});

describe("parseFraction — F27: strict integer/integer fraction parsing", () => {
  it("parses a well-formed fraction", () => {
    expect(parseFraction("3/6")).toEqual({ n: 3, d: 6 });
    expect(parseFraction("0/6")).toEqual({ n: 0, d: 6 });
    expect(parseFraction("6/6")).toEqual({ n: 6, d: 6 });
  });
  it("rejects a zero denominator ('0/0' is not 'no data', it's malformed)", () => {
    expect(parseFraction("0/0")).toBeNull();
  });
  it("rejects numerator > denominator, negatives, decimals, and garbage", () => {
    expect(parseFraction("7/6")).toBeNull();
    expect(parseFraction("-1/6")).toBeNull();
    expect(parseFraction("1.5/6")).toBeNull();
    expect(parseFraction("abc")).toBeNull();
    expect(parseFraction("6")).toBeNull();
    expect(parseFraction("")).toBeNull();
  });
});

describe("bucketDiff — F27: malformed pass/skillInvoked fractions invalidate loud instead of silently skipping", () => {
  it("hard-fails and reports a malformed per-claim pass fraction instead of silently skipping the comparison", () => {
    const baseline: Profile = { "eval-m": scen("6/6", [claim(0, "0/0", { discriminating: true })]) };
    const candidate: Profile = { "eval-m": scen("6/6", [claim(0, "0/0")]) };
    const d = bucketDiff(baseline, candidate);
    expect(d.regressions).toHaveLength(0); // never silently diffed as a real rate
    expect(d.hardFail).toBe(true);
    expect(d.unmatched.some((u) => u.includes("malformed pass fraction"))).toBe(true);
  });
  it("hard-fails on a malformed skillInvoked fraction instead of silently skipping the trigger check", () => {
    const baseline: Profile = { "eval-m": scen("0/0", [claim(0, "6/6", { discriminating: true })]) };
    const candidate: Profile = { "eval-m": scen("0/0", [claim(0, "6/6")]) };
    const d = bucketDiff(baseline, candidate);
    expect(d.triggerRegressions).toHaveLength(0);
    expect(d.hardFail).toBe(true);
    expect(d.unmatched.some((u) => u.includes("malformed skillInvoked fraction"))).toBe(true);
  });
});

describe("singleModel — F20: model heterogeneity in one capture is invalid, not collapsed to one arbitrary id", () => {
  it("returns null when nothing was observed", () => {
    expect(singleModel(new Set(), "judge")).toBeNull();
  });
  it("returns the sole observed model", () => {
    expect(singleModel(new Set(["claude-opus-4-8"]), "judge")).toBe("claude-opus-4-8");
  });
  it("throws loud on >1 distinct model instead of silently picking the lexicographically-first one", () => {
    expect(() => singleModel(new Set(["claude-opus-4-8", "claude-sonnet-5"]), "answerer")).toThrow(/not model-homogeneous/);
  });
});

describe("positiveIntFlag — F24: --reps/--concurrency must be a positive finite integer", () => {
  it("falls back to the default when the flag is absent", () => {
    expect(positiveIntFlag(undefined, 6, "--reps")).toBe(6);
  });
  it("accepts a valid positive integer string", () => {
    expect(positiveIntFlag("12", 6, "--reps")).toBe(12);
  });
  it.each(["0", "-1", "abc", "1.5", "Infinity", "-Infinity", "NaN", ""])("rejects %s as a usage error", (raw) => {
    expect(() => positiveIntFlag(raw, 6, "--concurrency")).toThrow(/--concurrency must be a positive integer/);
  });
});

describe("aggregateScenario — F25: cross-rep aggregation is by claim TEXT identity, with a rubric-consistency check", () => {
  const envIdx = (invoked: boolean, claims: { index: number; claim: string; pass: boolean }[]) => ({
    results: [
      {
        result: "success",
        skillsInvoked: invoked ? ["cowork-harness"] : [],
        assertions: [
          { assertion: { semantic_matches: { rubric: claims.map((c) => c.claim) } }, judgeInvalid: false, semanticClaims: claims },
        ],
      },
    ],
  });

  it("aggregates correctly when every rep's claim array agrees on text/order", () => {
    const p = aggregateScenario("eval-ok", [
      envIdx(true, [
        { index: 0, claim: "A", pass: true },
        { index: 1, claim: "B", pass: false },
      ]),
      envIdx(true, [
        { index: 0, claim: "A", pass: true },
        { index: 1, claim: "B", pass: true },
      ]),
      envIdx(true, [
        { index: 0, claim: "A", pass: false },
        { index: 1, claim: "B", pass: false },
      ]),
      envIdx(true, [
        { index: 0, claim: "A", pass: true },
        { index: 1, claim: "B", pass: false },
      ]),
    ]);
    expect(p.claims[0].claim).toBe("A");
    expect(p.claims[0].pass).toBe("3/4");
    expect(p.claims[1].claim).toBe("B");
    expect(p.claims[1].pass).toBe("1/4");
  });

  it("aggregates by claim TEXT, not a (possibly mislabeled) numeric index field", () => {
    // A judge that emitted the claims in the SAME array order every rep, but happened to assign the wrong
    // `.index` field to one of them, must still tally correctly by text — this is exactly the class of bug
    // the old index-keyed `rate()` could not detect (it trusted `.index`, not the text). 4 reps to clear
    // MIN_VALID.
    const p = aggregateScenario("eval-textkey", [
      envIdx(true, [
        { index: 5, claim: "A", pass: true }, // .index is garbage/mislabeled; array position + text is truth
        { index: 9, claim: "B", pass: false },
      ]),
      envIdx(true, [
        { index: 5, claim: "A", pass: false },
        { index: 9, claim: "B", pass: true },
      ]),
      envIdx(true, [
        { index: 5, claim: "A", pass: true },
        { index: 9, claim: "B", pass: false },
      ]),
      envIdx(true, [
        { index: 5, claim: "A", pass: false },
        { index: 9, claim: "B", pass: false },
      ]),
    ]);
    expect(p.claims[0].claim).toBe("A");
    expect(p.claims[0].pass).toBe("2/4");
    expect(p.claims[1].claim).toBe("B");
    expect(p.claims[1].pass).toBe("1/4");
  });

  it("throws loud when a rep's rubric TEXT/ORDER is inconsistent with the first rep's, instead of silently voting positionally", () => {
    expect(() =>
      aggregateScenario("eval-inconsistent", [
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "B", pass: false },
        ]),
        // Same texts, but REORDERED — array position now disagrees with rep 1's, so a positional/short-cut
        // aggregation would silently swap A's and B's votes. Must throw instead.
        envIdx(true, [
          { index: 0, claim: "B", pass: true },
          { index: 1, claim: "A", pass: false },
        ]),
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "B", pass: false },
        ]),
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "B", pass: false },
        ]),
      ]),
    ).toThrow(/inconsistent rubric/);
  });

  it("throws loud when a rep reports a different claim SET (not just a reorder)", () => {
    expect(() =>
      aggregateScenario("eval-diffset", [
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "B", pass: false },
        ]),
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "C", pass: false }, // "C" instead of "B"
        ]),
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "B", pass: false },
        ]),
        envIdx(true, [
          { index: 0, claim: "A", pass: true },
          { index: 1, claim: "B", pass: false },
        ]),
      ]),
    ).toThrow(/inconsistent rubric/);
  });
});

describe("calibrateScenario — F26: joins ablated↔baseline claims by TEXT, fails loud on an unmatched claim", () => {
  const baselineScenario = (claims: ReturnType<typeof claim>[]): ScenarioProfile => ({
    reps: 6,
    skillInvoked: "6/6",
    validReps: 6,
    errored: 0,
    claims,
  });
  const ablatedScenario = (validReps: number, claims: { index: number; claim: string; pass: string }[]): ScenarioProfile => ({
    reps: validReps,
    skillInvoked: `0/${validReps}`,
    validReps,
    errored: 0,
    claims,
  });

  it("tags discriminating from the TEXT-matched ablated claim's pass rate (<0.75 ⇒ discriminating)", () => {
    const b = baselineScenario([claim(0, "6/6"), claim(1, "6/6")]);
    const ablated = ablatedScenario(4, [
      { index: 0, claim: "claim 0", pass: "1/4" }, // 0.25 < 0.75 ⇒ discriminating
      { index: 1, claim: "claim 1", pass: "4/4" }, // 1.0 ⇒ NOT discriminating (still passes without the skill)
    ]);
    calibrateScenario("s", b, ablated);
    expect(b.claims[0]!.discriminating).toBe(true);
    expect(b.claims[1]!.discriminating).toBe(false);
  });

  it("matches by TEXT even when the ablated capture's numeric index disagrees with the baseline's", () => {
    const b = baselineScenario([claim(0, "6/6")]); // baseline claim 0's text is "claim 0"
    const ablated = ablatedScenario(4, [{ index: 7, claim: "claim 0", pass: "0/4" }]); // same text, different index
    calibrateScenario("s", b, ablated);
    expect(b.claims[0]!.discriminating).toBe(true);
  });

  it("forces every claim discriminating when the ablated scenario had too few gradeable reps (safe direction, regardless of text match)", () => {
    const b = baselineScenario([claim(0, "6/6"), claim(1, "6/6")]);
    const ablated = ablatedScenario(1, [{ index: 0, claim: "totally different text", pass: "1/1" }]);
    calibrateScenario("s", b, ablated);
    expect(b.claims[0]!.discriminating).toBe(true);
    expect(b.claims[1]!.discriminating).toBe(true); // even the claim with NO ablated match at all
  });

  it("throws loud on a text-unmatched claim (rubric drifted since the baseline) instead of defaulting silently", () => {
    const b = baselineScenario([claim(0, "6/6")]);
    const ablated = ablatedScenario(4, [{ index: 0, claim: "a completely reworded claim", pass: "1/4" }]);
    expect(() => calibrateScenario("s", b, ablated)).toThrow(/claim mismatch/);
  });

  it("throws loud on a malformed ablated pass fraction (F27) instead of defaulting to 0", () => {
    const b = baselineScenario([claim(0, "6/6")]);
    const ablated = ablatedScenario(4, [{ index: 0, claim: "claim 0", pass: "0/0" }]);
    expect(() => calibrateScenario("s", b, ablated)).toThrow(/malformed ablated pass fraction/);
  });
});

describe("readProfileFile — F22: strict schema validation, not a presence-check-and-cast", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-gate-test-"));
  const write = (name: string, content: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  it("reads a well-formed header'd profile file", () => {
    const p = write("good.json", {
      __meta__: { judgeModel: "m", answererModel: "a", judgePromptHash: "h", harnessVersion: "1.0.0", date: "2026-07-10" },
      scenarios: { "eval-a": { reps: 6, skillInvoked: "6/6", validReps: 6, errored: 0, claims: [{ index: 0, claim: "x", pass: "6/6" }] } },
    });
    const f = readProfileFile(p);
    expect(f.__meta__.judgeModel).toBe("m");
    expect(f.scenarios["eval-a"]!.claims[0]!.claim).toBe("x");
  });

  it("reads a legacy header-less flat profile as provenance-unknown", () => {
    const p = write("legacy.json", {
      "eval-a": { reps: 6, skillInvoked: "6/6", validReps: 6, errored: 0, claims: [{ index: 0, claim: "x", pass: "6/6" }] },
    });
    const f = readProfileFile(p);
    expect(f.__meta__.judgeModel).toBeNull();
    expect(f.__meta__.harnessVersion).toBe("unknown");
    expect(f.scenarios["eval-a"]!.claims[0]!.pass).toBe("6/6");
  });

  it("throws loud on a malformed pass fraction instead of silently casting", () => {
    const p = write("bad-fraction.json", {
      "eval-a": { reps: 6, skillInvoked: "6/6", validReps: 6, errored: 0, claims: [{ index: 0, claim: "x", pass: "not-a-fraction" }] },
    });
    expect(() => readProfileFile(p)).toThrow(/malformed/);
  });

  it("throws loud on a missing required field instead of a downstream undefined crash", () => {
    const p = write("missing-field.json", {
      __meta__: { judgeModel: null, answererModel: null, judgePromptHash: null, harnessVersion: "1.0.0", date: "2026-07-10" },
      scenarios: { "eval-a": { reps: 6, skillInvoked: "6/6", errored: 0, claims: [] } }, // validReps missing
    });
    expect(() => readProfileFile(p)).toThrow(/malformed/);
  });

  it("throws loud on a wrong-typed field (e.g. a numeric claim index sent as a string)", () => {
    const p = write("wrong-type.json", {
      "eval-a": { reps: 6, skillInvoked: "6/6", validReps: 6, errored: 0, claims: [{ index: "0", claim: "x", pass: "6/6" }] },
    });
    expect(() => readProfileFile(p)).toThrow(/malformed/);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("boundedSpawnJson — F23: a per-child timeout and stdout byte cap, resolving to an errored envelope", () => {
  it("resolves the parsed JSON envelope on a normal, fast, well-behaved child", async () => {
    const out = await boundedSpawnJson(
      "node",
      ["-e", "process.stdout.write(JSON.stringify({results:[{result:'success'}]}))"],
      5000,
      1_000_000,
    );
    expect(out).toEqual({ results: [{ result: "success" }] });
  });

  it("times out a hung-but-alive child and resolves {} (flows into aggregateScenario's `errored` count)", async () => {
    const out = await boundedSpawnJson("node", ["-e", "setTimeout(() => {}, 5000)"], 150, 1_000_000);
    expect(out).toEqual({});
  }, 10_000);

  it("kills and resolves {} when a child's stdout exceeds the byte cap, instead of growing the buffer unbounded", async () => {
    const out = await boundedSpawnJson("node", ["-e", "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 5000)"], 10_000, 100);
    expect(out).toEqual({});
  }, 10_000);
});
