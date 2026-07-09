import { describe, it, expect } from "vitest";
import { fisherDropP, bucketDiff, aggregateScenario, type Profile } from "../scripts/eval-gate";

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

describe("aggregateScenario — invalid reps counted-not-dropped, invoked-only rates", () => {
  const env = (invoked: boolean, invalid: boolean, passes: boolean[]) => ({
    results: [
      {
        skillsInvoked: invoked ? ["cowork-harness"] : [],
        assertions: [
          {
            assertion: { semantic_matches: { rubric: ["a", "b"] } },
            judgeInvalid: invalid,
            semanticClaims: passes.map((p, i) => ({ index: i, pass: p })),
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

  it("counts an INVALID rep (does not drop it) and errors below the valid-rep floor", () => {
    // 5 invoked reps but 2 are judge-invalid → only 3 valid < MIN_VALID(4) → loud error
    expect(() =>
      aggregateScenario("eval-y", [
        env(true, false, [true, true]),
        env(true, false, [true, true]),
        env(true, false, [true, true]),
        env(true, true, [true, true]),
        env(true, true, [true, true]),
      ]),
    ).toThrow(/valid skill-invoked reps/);
  });
});
