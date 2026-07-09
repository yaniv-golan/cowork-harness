import { describe, it, expect } from "vitest";
import { fisherDropP, bucketDiff, aggregateScenario, modelMismatch, type Profile, type ProfileMeta } from "../scripts/eval-gate";

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
  it("does NOT block on an unknown (legacy header-less) baseline or an unobserved candidate model", () => {
    expect(modelMismatch(meta({ judgeModel: null, answererModel: null }), "x", "y")).toBeNull();
    expect(modelMismatch(meta(), null, null)).toBeNull(); // candidate models unobservable → don't false-block
  });
});

describe("aggregateScenario — invalid reps counted-not-dropped, invoked-only rates", () => {
  const env = (invoked: boolean, invalid: boolean, passes: boolean[]) => ({
    results: [
      {
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
