import { describe, it, expect } from "vitest";
import { computeVerdict, persistedVerdict } from "../src/run/verdict.js";
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

describe("computeVerdict (the single verdict source)", () => {
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

  it("skips the host_path_leak default-fail at hostloop AND protocol (real host paths expected — neither seals the FS), still fails at container/microvm", () => {
    const leak = { outputsDeletes: [], hostPathLeaked: true, selfHealRan: false };
    const atHostloop = computeVerdict(rr({ scan: leak, effectiveFidelity: "hostloop" }), "live");
    expect(atHostloop.pass).toBe(true);
    expect(atHostloop.signals.some((s) => s.code === "host_path_leak")).toBe(false);
    // protocol (L0) runs the agent on the real host cwd with no sealed FS, exactly like hostloop —
    // so a host path in a tool_result is expected there, not a leak.
    const atProtocol = computeVerdict(rr({ scan: leak, effectiveFidelity: "protocol" }), "live");
    expect(atProtocol.pass).toBe(true);
    expect(atProtocol.signals.some((s) => s.code === "host_path_leak")).toBe(false);
    const atContainer = computeVerdict(rr({ scan: leak, effectiveFidelity: "container" }), "live");
    expect(atContainer.pass).toBe(false);
    expect(atContainer.signals.some((s) => s.code === "host_path_leak")).toBe(true);
  });

  it("splits result:error into transport_error vs result_error (both fail; distinct message)", () => {
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

    // usage_limit → its own signal (still fail, but "not a skill failure; retry after reset")
    const usage = computeVerdict(rr({ result: "error", resultErrorKind: "usage_limit" }), "live");
    expect(usage.pass).toBe(false);
    const us = usage.signals.find((s) => s.code === "usage_limit");
    expect(us).toBeDefined();
    expect(us?.message).toMatch(/not a skill failure/i);
    expect(us?.message).toMatch(/reset/i);
    // and it must NOT also emit the generic result_error/transport_error
    expect(usage.signals.some((s) => s.code === "result_error" || s.code === "transport_error")).toBe(false);
  });

  it("guard roster reflects lane + probe outcome; never ✓ for a guard that didn't run", () => {
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

  it("requires_capabilities the tier couldn't satisfy hard-fails (both lanes); opt-out + clean run pass", () => {
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

  it("a stalled run fails on BOTH lanes (re-derived on replay), unless allow_stall opts out", () => {
    const stalled = rr({ stalledOnQuestion: true });
    expect(computeVerdict(stalled, "live").pass).toBe(false);
    expect(computeVerdict(stalled, "live").signals.some((s) => s.code === "stalled")).toBe(true);
    expect(computeVerdict(stalled, "replay").pass).toBe(false); // the detector re-runs on the replay re-drive → fails there too
    const optIn = rr({ stalledOnQuestion: true, assertions: [assn({ allow_stall: true })] });
    expect(computeVerdict(optIn, "live").pass).toBe(true); // allow_stall suppresses the stall (standalone modifier)
    expect(computeVerdict(rr({}), "live").signals.some((s) => s.code === "stalled")).toBe(false); // not stalled → no signal
  });

  it("reports host-path/outputs-delete as unverified (not ok) when scan evidence is absent", () => {
    const v = computeVerdict(rr({ scan: undefined }), "live");
    const byName = Object.fromEntries(v.guards.map((g) => [g.name, g.status]));
    expect(byName["host-path"]).toBe("unverified");
    expect(byName["outputs-delete"]).toBe("unverified");
  });

  it("emits a warn signal when scan evidence is absent on the live lane", () => {
    const v = computeVerdict(rr({ scan: undefined }), "live");
    expect(v.signals).toContainEqual(expect.objectContaining({ code: "scan_unavailable", severity: "warn" }));
    expect(v.pass).toBe(true); // warn, not fail
  });
});

describe("persistedVerdict (the RunResult.verdict projection)", () => {
  it("a failing assertion → pass:false, failures[] names the assertion key + message, exitCode is the fail code", () => {
    const r = rr({ assertions: [{ assertion: { tool_called: "Bash" }, pass: false, message: "expected Bash to be called" }] });
    const v = persistedVerdict(r, "live");
    expect(v.pass).toBe(false);
    expect(v.exitCode).toBe(1);
    expect(v.failures).toEqual([{ assertion: "tool_called", message: "expected Bash to be called" }]);
  });

  it("a passing run → pass:true, failures:[], exitCode 0", () => {
    const v = persistedVerdict(rr({ assertions: [assn({ tool_called: "Bash" }, true)] }), "live");
    expect(v).toEqual({ pass: true, exitCode: 0, failures: [] });
  });

  it("a hard-verdict guard failure independent of any assert (infra error) is named without an `assertion` key", () => {
    const v = persistedVerdict(rr({ infraErrors: [{ source: "egress-sidecar", message: "sidecar exited 1" }] }), "live");
    expect(v.pass).toBe(false);
    expect(v.failures).toEqual([{ message: expect.stringContaining("sidecar exited 1") }]);
    expect(v.failures[0]).not.toHaveProperty("assertion");
  });

  it("names BOTH a failing assertion (keyed) and a guard reason (unkeyed) when both fire on the same run", () => {
    const r = rr({
      assertions: [assn({ tool_called: "Bash" }, false)],
      infraErrors: [{ source: "egress-sidecar", message: "sidecar crashed" }],
    });
    const v = persistedVerdict(r, "live");
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(2);
    expect(v.failures.some((f) => f.assertion === "tool_called")).toBe(true);
    expect(v.failures.some((f) => f.message.includes("sidecar crashed") && f.assertion === undefined)).toBe(true);
  });

  it("a salvaged (unanswered-gate) run: pass:false, failures[] names the gate reason, not the generic 'run result was error'", () => {
    const gateMsg = 'unscripted AskUserQuestion (on_unanswered=fail):\n  • "Confirm?"';
    const r = rr({ result: "error", unansweredGate: { message: gateMsg, hint: "add --answer" } });
    const v = persistedVerdict(r, "live");
    expect(v.pass).toBe(false);
    expect(v.exitCode).toBe(1);
    expect(v.failures).toEqual([{ message: gateMsg }]);
    // the generic result_error placeholder is suppressed in favor of the real gate reason
    expect(v.failures.some((f) => f.message === "run result was error")).toBe(false);
  });

  it("jq-shape sanity: plain JSON — round-trips through JSON.stringify/parse with no functions, and an unnamed failure drops its `assertion` key rather than serializing `assertion: undefined`", () => {
    const r = rr({ assertions: [assn({ tool_called: "Bash" }, false)], infraErrors: [{ source: "x", message: "boom" }] });
    const v = persistedVerdict(r, "live");
    const roundTripped = JSON.parse(JSON.stringify(v));
    expect(roundTripped).toEqual(v);
    for (const f of roundTripped.failures) {
      if (f.assertion === undefined) expect(Object.prototype.hasOwnProperty.call(f, "assertion")).toBe(false);
    }
  });

  it("reuses computeVerdict's own pass/exitCode rather than recomputing independently", () => {
    const r = rr({ nonDeterministic: true }); // a WARN-only signal — pass stays true
    const cv = computeVerdict(r, "live");
    const pv = persistedVerdict(r, "live");
    expect(pv.pass).toBe(cv.pass);
    expect(pv.exitCode).toBe(cv.exitCode);
  });
});
