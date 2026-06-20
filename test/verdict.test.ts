import { describe, it, expect } from "vitest";
import { computeVerdict } from "../src/run/verdict.js";
import type { RunResult, Assertion } from "../src/types.js";

function rr(over: Partial<RunResult>): RunResult {
  return {
    scenario: "t",
    fidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    ...over,
  };
}
const assn = (assertion: Assertion, pass = true): RunResult["assertions"][number] => ({ assertion, pass });

describe("computeVerdict (SEAM B — the single verdict source)", () => {
  it("passes a clean success; fails a failed assertion or result:error", () => {
    expect(computeVerdict(rr({}), "live").pass).toBe(true);
    expect(computeVerdict(rr({ assertions: [assn({ tool_called: "X" }, false)] }), "live").pass).toBe(false);
    expect(computeVerdict(rr({ result: "error" }), "live").pass).toBe(false);
  });

  it("default-fails on a permissive auto-allow, unless the scenario opts in", () => {
    expect(computeVerdict(rr({ permissiveAutoAllow: ["Bash"] }), "live").pass).toBe(false);
    const optIn = rr({ permissiveAutoAllow: ["Bash"], assertions: [assn({ allow_permissive_auto_allow: true })] });
    expect(computeVerdict(optIn, "live").pass).toBe(true);
  });

  it("default-fails on a recorded delete / host-path leak when unasserted; an authored assertion owns it (no double-count)", () => {
    const del = { outputsDeletes: ["rm outputs/x"], hostPathLeaked: false, selfHealRan: false };
    expect(computeVerdict(rr({ scan: del }), "live").pass).toBe(false);
    // authoring no_delete_in_outputs suppresses the default-fire (the assertion itself owns the verdict)
    const authored = computeVerdict(rr({ scan: del, assertions: [assn({ no_delete_in_outputs: true }, true)] }), "live");
    expect(authored.signals.some((s) => s.code === "outputs_delete")).toBe(false);
    expect(authored.pass).toBe(true);
    expect(computeVerdict(rr({ scan: { outputsDeletes: [], hostPathLeaked: true, selfHealRan: false } }), "live").pass).toBe(false);
  });

  it("treats non-determinism as a WARN, never a fail", () => {
    const v = computeVerdict(rr({ nonDeterministic: true }), "live");
    expect(v.pass).toBe(true);
    expect(v.signals.some((s) => s.code === "non_deterministic" && s.severity === "warn")).toBe(true);
  });

  it("replay lane skips scan/permissive (a cassette can't reproduce them) but still honors assertions + result:error", () => {
    const r = rr({ permissiveAutoAllow: ["Bash"], scan: { outputsDeletes: ["rm outputs/x"], hostPathLeaked: true, selfHealRan: false } });
    expect(computeVerdict(r, "replay").pass).toBe(true); // skipped on replay
    expect(computeVerdict(r, "live").pass).toBe(false); // enforced live
    expect(computeVerdict(rr({ result: "error" }), "replay").pass).toBe(false);
  });

  it("exitCode tracks pass", () => {
    expect(computeVerdict(rr({}), "live").exitCode).toBe(0);
    expect(computeVerdict(rr({ result: "error" }), "live").exitCode).toBe(1);
  });

  it("default-fails when the skill used an omitted capability (likely false negative), unless opted in", () => {
    // otherwise-green run that used a capability the image omits → FAIL (the silent-green false negative)
    expect(computeVerdict(rr({ missingCapabilityUse: ["ocr"] }), "live").pass).toBe(false);
    expect(
      computeVerdict(rr({ missingCapabilityUse: ["ocr"] }), "live").signals.some(
        (s) => s.code === "missing_capability" && s.severity === "fail",
      ),
    ).toBe(true);
    // opt-in (the fallback is equivalent) suppresses it
    const optIn = rr({ missingCapabilityUse: ["ocr"], assertions: [assn({ allow_missing_capability: true })] });
    expect(computeVerdict(optIn, "live").pass).toBe(true);
  });

  it("missing-capability is live-only (a cassette can't probe the image → zeroed on replay)", () => {
    const r = rr({ missingCapabilityUse: ["ml_extract"] });
    expect(computeVerdict(r, "live").pass).toBe(false);
    expect(computeVerdict(r, "replay").pass).toBe(true);
  });
});
