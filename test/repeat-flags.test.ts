import { describe, it, expect } from "vitest";
import { parseRepeatFlags } from "../src/run/repeat-flags.js";

/** `--repeat` and its companions were parsed inline in `cmdRun`, which is why they were `run`-only:
 *  the exploratory `skill` lane — where loop users actually live — rejected them outright. Extracting
 *  the parse gives both lanes ONE implementation, so the flags cannot drift between them. */
describe("parseRepeatFlags", () => {
  it("extracts --repeat and leaves other args untouched", () => {
    const r = parseRepeatFlags(["./skill", "a prompt", "--repeat", "5", "--keep"], "skill");
    expect(r.repeatN).toBe(5);
    expect(r.rest).toEqual(["./skill", "a prompt", "--keep"]);
  });

  it("accepts the --repeat=N form", () => {
    expect(parseRepeatFlags(["--repeat=3"], "skill").repeatN).toBe(3);
  });

  it("rejects a repeat count outside 2..100", () => {
    for (const bad of ["1", "0", "101", "abc", "2.5"]) {
      expect(() => parseRepeatFlags(["--repeat", bad], "skill")).toThrow(/between 2 and 100/);
    }
  });

  it("rejects --repeat with no value", () => {
    expect(() => parseRepeatFlags(["--repeat"], "skill")).toThrow(/between 2 and 100/);
  });

  it("parses the companion flags", () => {
    const r = parseRepeatFlags(["--repeat", "4", "--min-pass-rate", "0.5", "--stop-on-diverge", "--max-budget-usd", "2.5"], "skill");
    expect(r).toMatchObject({ repeatN: 4, minPassRate: 0.5, stopOnDiverge: true, maxBudgetUsd: 2.5 });
  });

  it("requires --repeat for every companion flag — they are meaningless alone", () => {
    expect(() => parseRepeatFlags(["--min-pass-rate", "0.5"], "skill")).toThrow(/requires --repeat/);
    expect(() => parseRepeatFlags(["--stop-on-diverge"], "skill")).toThrow(/requires --repeat/);
    expect(() => parseRepeatFlags(["--max-budget-usd", "1"], "skill")).toThrow(/requires --repeat/);
    expect(() => parseRepeatFlags(["--allow-budget-stop"], "skill")).toThrow(/requires --repeat/);
  });

  it("defaults to no repeat, leaving argv unchanged", () => {
    const r = parseRepeatFlags(["./skill", "prompt"], "skill");
    expect(r.repeatN).toBeUndefined();
    expect(r.minPassRate).toBe(1.0);
    expect(r.rest).toEqual(["./skill", "prompt"]);
  });
});
