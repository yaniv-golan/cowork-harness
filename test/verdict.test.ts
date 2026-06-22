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

  it("Fix 5 — splits result:error into transport_error vs result_error (both fail; distinct message)", () => {
    // a generic agent error → result_error
    const agent = computeVerdict(rr({ result: "error", resultErrorKind: "agent" }), "live");
    expect(agent.pass).toBe(false);
    expect(agent.signals.some((s) => s.code === "result_error")).toBe(true);

    // a transport drop with passing assertions → transport_error (still fail, no false-green), distinct msg
    const transport = computeVerdict(
      rr({ result: "error", resultErrorKind: "transport", assertions: [assn({ tool_called: "X" }, true)] }),
      "live",
    );
    expect(transport.pass).toBe(false);
    const ts = transport.signals.find((s) => s.code === "transport_error");
    expect(ts?.message).toMatch(/artifacts were written/);
    expect(ts?.message).toMatch(/retry/);

    // assertion-less transport drop → no false comfort
    const noAssert = computeVerdict(rr({ result: "error", resultErrorKind: "transport" }), "live");
    expect(noAssert.signals.find((s) => s.code === "transport_error")?.message).toMatch(/NO assertions were defined/);

    // replay lane → lane-aware message (no "artifacts written" claim — replay writes none)
    const onReplay = computeVerdict(
      rr({ result: "error", resultErrorKind: "transport", assertions: [assn({ tool_called: "X" }, true)] }),
      "replay",
    );
    const rs = onReplay.signals.find((s) => s.code === "transport_error");
    expect(rs?.message).toMatch(/re-checked on replay/);
    expect(rs?.message).not.toMatch(/artifacts were written/);

    // transport classification but a failing assertion → treated as a real failure
    const alsoFailed = computeVerdict(
      rr({ result: "error", resultErrorKind: "transport", assertions: [assn({ tool_called: "X" }, false)] }),
      "live",
    );
    expect(alsoFailed.signals.find((s) => s.code === "transport_error")?.message).toMatch(/real failure/);
  });

  it("Fix 6h — guard roster reflects lane + probe outcome; never ✓ for a guard that didn't run", () => {
    const g = (v: ReturnType<typeof computeVerdict>, name: string) => v.guards.find((x) => x.name === name)?.status;

    // live + a definitive clean probe → capability-use ran clean (ok); scan guards ok
    const clean = computeVerdict(rr({ capabilityProbe: "definitive" }), "live");
    expect(g(clean, "capability-use")).toBe("ok");
    expect(g(clean, "permissive-auto-allow")).toBe("ok");

    // live but the probe was SKIPPED (e.g. protocol/skip-env) → capability-use is N/A, NOT ok (no false ✓)
    expect(g(computeVerdict(rr({ capabilityProbe: "skipped" }), "live"), "capability-use")).toBe("na");
    // probe ran but couldn't conclude → unverified, NOT ok
    expect(g(computeVerdict(rr({ capabilityProbe: "unverified" }), "live"), "capability-use")).toBe("unverified");
    // a capability guard that fired → fired
    expect(g(computeVerdict(rr({ capabilityProbe: "definitive", missingCapabilityUse: ["ocr"] }), "live"), "capability-use")).toBe("fired");

    // replay lane → live-only guards render N/A (a cassette can't reproduce them)
    const onReplay = computeVerdict(rr({ capabilityProbe: "definitive" }), "replay");
    expect(g(onReplay, "capability-use")).toBe("na");
    expect(g(onReplay, "permissive-auto-allow")).toBe("na");
    expect(g(onReplay, "host-path")).toBe("na");
  });

  it("Fix 4b — requires_capabilities the tier couldn't satisfy hard-fails (both lanes); opt-out + clean run pass", () => {
    // declared family omitted by the running image → fail
    const omitted = computeVerdict(rr({ requiresCapabilityUnmet: { caps: ["office_convert"], reason: "omitted" } }), "live");
    expect(omitted.pass).toBe(false);
    expect(omitted.signals.find((s) => s.code === "missing_capability")?.message).toMatch(/omits declared required/);

    // declared but the tier (e.g. protocol) couldn't verify → fail, distinct message
    const unverifiable = computeVerdict(rr({ requiresCapabilityUnmet: { caps: ["ocr"], reason: "unverifiable" } }), "live");
    expect(unverifiable.pass).toBe(false);
    expect(unverifiable.signals.find((s) => s.code === "missing_capability")?.message).toMatch(/could not verify/);

    // fires on the REPLAY lane too (persisted run-time truth, honored by verify-run/replay)
    expect(computeVerdict(rr({ requiresCapabilityUnmet: { caps: ["ocr"], reason: "unverifiable" } }), "replay").pass).toBe(false);

    // allow_missing_capability opts out
    const optIn = computeVerdict(
      rr({ requiresCapabilityUnmet: { caps: ["ocr"], reason: "omitted" }, assertions: [assn({ allow_missing_capability: true })] }),
      "live",
    );
    expect(optIn.pass).toBe(true);

    // a clean run on full parity records nothing here → verify-run never false-fails
    expect(computeVerdict(rr({ capabilityProbe: "definitive" }), "live").pass).toBe(true);
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
