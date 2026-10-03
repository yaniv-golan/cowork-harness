import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { outputsCheckArmed } from "../src/run/outputs-delete-tier.js";

/**
 * ONE rule for "does the harness check outputs deletes on this run": the verdict's default signals, the guard roster
 * and execute.ts's stderr warning all read it, so they cannot disagree.
 *
 * Armed when the baseline does not record outputs as exactly "rwd" (Desktop before 2.16120.0, an absent field, the
 * remote lane), OR `no_delete_in_outputs` is authored, OR `no_delete_in_mounts` is authored without
 * `allow_delete_in` waiving outputs (that key covers outputs on every baseline).
 */
describe("outputsCheckArmed", () => {
  it("is armed on anything but an exact rwd", () => {
    expect(outputsCheckArmed("rw", [])).toBe(true);
    expect(outputsCheckArmed(undefined, [])).toBe(true);
    expect(outputsCheckArmed("RWD" as never, [])).toBe(true);
    expect(outputsCheckArmed("rwd", [])).toBe(false);
  });

  it("an authored no_delete_in_outputs arms it on rwd", () => {
    expect(outputsCheckArmed("rwd", [{ no_delete_in_outputs: true }])).toBe(true);
  });

  it("an authored no_delete_in_mounts arms it on rwd unless outputs is waived", () => {
    expect(outputsCheckArmed("rwd", [{ no_delete_in_mounts: true }])).toBe(true);
    expect(outputsCheckArmed("rwd", [{ no_delete_in_mounts: true }, { allow_delete_in: ["outputs"] }])).toBe(false);
    expect(outputsCheckArmed("rwd", [{ no_delete_in_mounts: true }, { allow_delete_in: ["reports"] }])).toBe(true);
  });

  it("other keys do not arm it", () => {
    expect(outputsCheckArmed("rwd", [{ allow_outputs_delete: true }, { allow_delete_in: ["outputs"] }])).toBe(false);
  });
});

// SOURCE PIN: the three readers use the helper rather than re-deriving the rule.
describe("wiring (source pin)", () => {
  it("execute.ts gates its stderr warning on outputsCheckArmed", () => {
    expect(readFileSync(resolve("src/run/execute.ts"), "utf8")).toMatch(
      /fsDiff\.status === "unavailable" && outputsCheckArmed\(outputsMountMode, scenario\.assert\)/,
    );
  });
  it("verdict.ts reads it for both the signals and the roster", () => {
    const src = readFileSync(resolve("src/run/verdict.ts"), "utf8");
    expect(src.match(/outputsCheckArmed\(result\.outputsMountMode, /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
