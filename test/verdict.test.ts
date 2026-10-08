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

  it("allow_outputs_delete accepts a detected delete instead of failing the run", () => {
    const del = { outputsDeletes: ["rm outputs/x"], hostPathLeaked: false, selfHealRan: false };
    expect(computeVerdict(rr({ scan: del }), "live").pass).toBe(false); // unwaived: still fails
    const waived = computeVerdict(rr({ scan: del, assertions: [assn({ allow_outputs_delete: true })] }), "live");
    expect(waived.signals.some((s) => s.code === "outputs_delete")).toBe(false);
    expect(waived.pass).toBe(true);
  });

  // The roster reports what the GUARD observed, not whether the signal fired. The signal is suppressed
  // whenever the scenario authored `no_delete_in_outputs` (it fails there instead) or waived via
  // `allow_outputs_delete` — reporting `ok` in either case is a false ✓ for a guard that did catch its
  // failure mode. The authored case was already wrong before `allow_outputs_delete` existed.
  it("the outputs-delete guard reports `fired` whenever a delete was detected, even when the signal is suppressed", () => {
    const del = { outputsDeletes: ["rm outputs/x"], hostPathLeaked: false, selfHealRan: false };
    const status = (v: ReturnType<typeof computeVerdict>) => v.guards.find((g) => g.name === "outputs-delete")?.status;
    expect(status(computeVerdict(rr({ scan: del }), "live"))).toBe("fired");
    expect(status(computeVerdict(rr({ scan: del, assertions: [assn({ allow_outputs_delete: true })] }), "live"))).toBe("fired");
    expect(status(computeVerdict(rr({ scan: del, assertions: [assn({ no_delete_in_outputs: true }, true)] }), "live"))).toBe("fired");
    // and still `ok` when the scan ran clean, `unverified` when it did not run at all
    expect(status(computeVerdict(rr({ scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false } }), "live"))).toBe("ok");
    expect(status(computeVerdict(rr({ scan: undefined }), "live"))).toBe("unverified");
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

  it("`skill --allow-missing-capability` shape: the modifier MERGED onto {result:success} suppresses both sources", () => {
    // Feature A merges allow_missing_capability onto the synthesized success assertion (one object, two keys).
    const useOptOut = rr({ missingCapabilityUse: ["ocr"], assertions: [assn({ result: "success", allow_missing_capability: true })] });
    expect(computeVerdict(useOptOut, "live").pass).toBe(true);
    expect(computeVerdict(useOptOut, "live").signals.some((s) => s.code === "missing_capability")).toBe(false);
    const declOptOut = rr({
      requiresCapabilityUnmet: { caps: ["office_convert"], reason: "omitted" },
      assertions: [assn({ result: "success", allow_missing_capability: true })],
    });
    expect(computeVerdict(declOptOut, "live").pass).toBe(true);
    // negative: the same combined assertion WITHOUT the modifier still fails (no accidental blanket suppress)
    const noMod = rr({ missingCapabilityUse: ["ocr"], assertions: [assn({ result: "success" })] });
    expect(computeVerdict(noMod, "live").pass).toBe(false);
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

  it("under answer_channel: none a stall is a parked note (warn), never the stalled fail", () => {
    const parked = rr({ stalledOnQuestion: true, answerChannel: "none" });
    for (const lane of ["live", "replay"] as const) {
      const v = computeVerdict(parked, lane);
      expect(v.pass).toBe(true);
      expect(v.signals.map((s) => [s.code, s.severity])).toContainEqual(["parked_at_question", "warn"]);
      expect(v.signals.some((s) => s.code === "stalled")).toBe(false);
    }
    // The note never rescues a failing file assertion: completion is still judged from the files.
    const unfinished = rr({ stalledOnQuestion: true, answerChannel: "none", assertions: [assn({ file_exists: "outputs/x" }, false)] });
    expect(computeVerdict(unfinished, "live").pass).toBe(false);
    // No stall → no note.
    expect(computeVerdict(rr({ answerChannel: "none" }), "live").signals.some((s) => s.code === "parked_at_question")).toBe(false);
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

  it("ended_with_question: warns (never fails) when the final answer contains a question and no deliverable was written to outputs/", () => {
    const fires = rr({
      result: "success",
      finalMessage: "I reviewed the deck. Which round is this? Let me know.",
      workspaceFiles: [{ path: "x", bytes: 1, class: "mount" }],
      assertions: [assn({ result: "success" })],
    });
    const v = computeVerdict(fires, "live");
    expect(v.signals.some((s) => s.code === "ended_with_question")).toBe(true);
    expect(v.pass).toBe(true); // warn never fails

    // the motivating shape: ONLY mount/input-class files present (e.g. a connected-folder input), no
    // output-class file — the warn must still fire.
    const mountOnly = rr({
      result: "success",
      finalMessage: "I reviewed the deck. Which round is this? Let me know.",
      workspaceFiles: [{ path: "input.pdf", bytes: 1, class: "input" }],
      assertions: [assn({ result: "success" })],
    });
    expect(computeVerdict(mountOnly, "live").signals.some((s) => s.code === "ended_with_question")).toBe(true);

    // suppressed by an output deliverable
    const withOutput = rr({
      ...fires,
      workspaceFiles: [{ path: "outputs/report.md", bytes: 9, class: "output" }],
    });
    expect(computeVerdict(withOutput, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // suppressed when workspaceFiles is undefined (no evidence observed)
    const noEvidence = rr({
      result: "success",
      finalMessage: "I reviewed the deck. Which round is this? Let me know.",
      assertions: [assn({ result: "success" })],
    });
    expect(computeVerdict(noEvidence, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // suppressed by stalledOnQuestion (the strict sibling owns it instead)
    const stalled = rr({
      ...fires,
      stalledOnQuestion: true,
    });
    const stalledVerdict = computeVerdict(stalled, "live");
    expect(stalledVerdict.signals.some((s) => s.code === "ended_with_question")).toBe(false);
    expect(stalledVerdict.signals.some((s) => s.code === "stalled")).toBe(true);

    // suppressed by allow_stall
    const allowStall = rr({
      ...fires,
      assertions: [assn({ result: "success" }), assn({ allow_stall: true })],
    });
    expect(computeVerdict(allowStall, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // suppressed by an authored content assertion (not open-ended)
    const authoredContent = rr({
      ...fires,
      assertions: [assn({ file_exists: "outputs/x.md" }, true)],
    });
    expect(computeVerdict(authoredContent, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // suppressed on the replay lane (live-only heuristic)
    expect(computeVerdict(fires, "replay").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // a '?' that's URL-shaped (query string) does not count as an open question
    const urlShaped = rr({
      ...fires,
      finalMessage: "see https://example.test/a?b=1",
    });
    expect(computeVerdict(urlShaped, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // trailing question wrapped in quotes/bold still counts
    const quoted = rr({ ...fires, finalMessage: 'Ready to proceed?"' });
    expect(computeVerdict(quoted, "live").signals.some((s) => s.code === "ended_with_question")).toBe(true);
    const bolded = rr({ ...fires, finalMessage: "Which sector?**" });
    expect(computeVerdict(bolded, "live").signals.some((s) => s.code === "ended_with_question")).toBe(true);

    // finalMessage undefined (omitted) → absent
    const noMessage = rr({
      result: "success",
      workspaceFiles: [{ path: "x", bytes: 1, class: "mount" }],
      assertions: [assn({ result: "success" })],
    });
    expect(computeVerdict(noMessage, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);

    // a `?`-free closing request for input counts too — the same helper `stalled` uses. This is the shape
    // `stalled` cannot own when tool work ran after the last gate, so it must land here, not in neither.
    // Same condition as `stalled`: only once an AskUserQuestion gate fired.
    const gated = { ...fires, toolCounts: { AskUserQuestion: 1, Bash: 2 } };
    const imperative = rr({ ...gated, finalMessage: "Here is what I found. Please share the raise amount so I can model it." });
    expect(computeVerdict(imperative, "live").signals.some((s) => s.code === "ended_with_question")).toBe(true);
    // …not without a gate
    const ungated = rr({
      ...fires,
      toolCounts: { Bash: 2 },
      finalMessage: "Here is what I found. Please share the raise amount so I can model it.",
    });
    expect(computeVerdict(ungated, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);
    // …and never for a polite closer with no `?`
    const closer = rr({ ...gated, finalMessage: "That covers the deck. Let me know if you'd like any changes." });
    expect(computeVerdict(closer, "live").signals.some((s) => s.code === "ended_with_question")).toBe(false);
  });

  it("ended_with_question stays open-ended through a `skill --allow-missing-capability` assert (A↔B seam)", () => {
    // A `skill --allow-missing-capability` run synthesizes `{result:"success", allow_missing_capability:true}`.
    // The modifier key must NOT count as an authored CONTENT assertion (which would flip `openEnded` off and
    // silently stop `ended_with_question` from ever firing on those runs). Pins that exemption.
    const r = rr({
      result: "success",
      finalMessage: "I reviewed it. Which sector should I assume? Let me know.",
      workspaceFiles: [{ path: "deck.pdf", bytes: 1, class: "mount" }], // connected-folder input only, no output
      assertions: [assn({ result: "success", allow_missing_capability: true })],
    });
    expect(computeVerdict(r, "live").signals.some((s) => s.code === "ended_with_question")).toBe(true);
  });
});

describe("computeVerdict's failures[] (the unified RunResult.verdict projection — no separate persistedVerdict)", () => {
  it("a failing assertion → pass:false, failures[] names the assertion key + message, exitCode is the fail code", () => {
    const r = rr({ assertions: [{ assertion: { tool_called: "Bash" }, pass: false, message: "expected Bash to be called" }] });
    const v = computeVerdict(r, "live");
    expect(v.pass).toBe(false);
    expect(v.exitCode).toBe(1);
    expect(v.failures).toEqual([{ assertion: "tool_called", message: "expected Bash to be called", kind: "assertion" }]);
  });

  it("a passing run → pass:true, failures:[], exitCode 0", () => {
    const v = computeVerdict(rr({ assertions: [assn({ tool_called: "Bash" }, true)] }), "live");
    expect(v.pass).toBe(true);
    expect(v.exitCode).toBe(0);
    expect(v.failures).toEqual([]);
  });

  it("a hard-verdict guard failure independent of any assert (infra error) is named without an `assertion` key", () => {
    const v = computeVerdict(rr({ infraErrors: [{ source: "egress-sidecar", message: "sidecar exited 1" }] }), "live");
    expect(v.pass).toBe(false);
    expect(v.failures).toEqual([{ message: expect.stringContaining("sidecar exited 1"), kind: "guard" }]);
    expect(v.failures[0]).not.toHaveProperty("assertion");
    // `kind` is the discriminator — key-absence never was one (a coverage miss carries a key too).
    expect(v.failures[0].kind).toBe("guard");
  });

  it("names BOTH a failing assertion (keyed) and a guard reason (unkeyed) when both fire on the same run", () => {
    const r = rr({
      assertions: [assn({ tool_called: "Bash" }, false)],
      infraErrors: [{ source: "egress-sidecar", message: "sidecar crashed" }],
    });
    const v = computeVerdict(r, "live");
    expect(v.pass).toBe(false);
    expect(v.failures).toHaveLength(2);
    expect(v.failures.some((f) => f.assertion === "tool_called")).toBe(true);
    expect(v.failures.some((f) => f.message.includes("sidecar crashed") && f.assertion === undefined)).toBe(true);
  });

  it("a salvaged (unanswered-gate) run: pass:false, failures[] names the gate reason, not the generic 'run result was error'", () => {
    const gateMsg = 'unscripted AskUserQuestion (on_unanswered=fail):\n  • "Confirm?"';
    const r = rr({ result: "error", unansweredGate: { message: gateMsg, hint: "add --answer" } });
    const v = computeVerdict(r, "live");
    expect(v.pass).toBe(false);
    expect(v.exitCode).toBe(1);
    expect(v.failures).toEqual([{ message: gateMsg, kind: "guard" }]);
    // the generic result_error placeholder is suppressed in favor of the real gate reason
    expect(v.failures.some((f) => f.message === "run result was error")).toBe(false);
  });

  it("hard-fails a dead supervisor but only warns a failed container exec", () => {
    const fatal = computeVerdict(rr({ infraErrors: [{ source: "hostloop-sidecar", message: "died" }] }), "live");
    expect(fatal.pass).toBe(false);
    expect(fatal.signals.find((s) => s.code === "infra_error")?.severity).toBe("fail");

    const soft = computeVerdict(rr({ infraErrors: [{ source: "hostloop-exec", message: "exec failed" }] }), "live");
    expect(soft.pass).toBe(true);
    expect(soft.signals.find((s) => s.code === "exec_infra_error")?.severity).toBe("warn");
    // and it must NOT also raise the fatal signal
    expect(soft.signals.find((s) => s.code === "infra_error")).toBeUndefined();
  });

  it("still hard-fails when a sidecar death accompanies a failed exec", () => {
    const v = computeVerdict(
      rr({
        infraErrors: [
          { source: "hostloop-exec", message: "exec failed" },
          { source: "hostloop-sidecar", message: "died" },
        ],
      }),
      "live",
    );
    expect(v.pass).toBe(false);
    expect(v.signals.find((s) => s.code === "infra_error")?.message).toContain("died");
    expect(v.signals.find((s) => s.code === "infra_error")?.message).not.toContain("exec failed");
  });

  it("jq-shape sanity: plain JSON — round-trips through JSON.stringify/parse with no functions, and an unnamed failure drops its `assertion` key rather than serializing `assertion: undefined`", () => {
    const r = rr({ assertions: [assn({ tool_called: "Bash" }, false)], infraErrors: [{ source: "hostloop-sidecar", message: "boom" }] });
    const v = computeVerdict(r, "live");
    const roundTripped = JSON.parse(JSON.stringify(v));
    expect(roundTripped).toEqual(v);
    for (const f of roundTripped.failures) {
      if (f.assertion === undefined) expect(Object.prototype.hasOwnProperty.call(f, "assertion")).toBe(false);
    }
  });
});

describe("the persisted channel (result.json) and the streamed channel (--output-format json envelope) can never diverge", () => {
  // Regression test for the shape-inconsistency this unifies: before, execute.ts persisted
  // `result.verdict` via a separate `persistedVerdict()` wrapper shaped `{pass, exitCode, failures}`,
  // while envelope.ts's stdout envelope overwrote the SAME field name with `computeVerdict(r, lane)`
  // shaped `{pass, exitCode, signals, guards}` — so `run --output-format json | jq
  // '.results[0].verdict.failures'` returned undefined even on a failing run. Both persist points
  // (execute.ts's success path and its buildPartialResult salvage path) and envelope.ts's stdout
  // attachment now call the exact same `computeVerdict`, so they are provably the same shape — this
  // test simulates both call sites against one RunResult and asserts they agree, INCLUDING `failures`.
  it("execute.ts's persist-point verdict and envelope.ts's stream-point verdict are identical for a failing run", () => {
    const r = rr({ assertions: [{ assertion: { tool_called: "Bash" }, pass: false, message: "expected Bash to be called" }] });

    // Mirrors execute.ts:1253 (`result.verdict = computeVerdict(result, "live");`) — the result.json persist point.
    const persisted = computeVerdict(r, "live");

    // Mirrors envelope.ts:84 (`{ ...r, verdict: computeVerdict(r, lane) }`) — the stdout envelope's per-result attachment.
    const streamed = { ...r, verdict: computeVerdict(r, "live") }.verdict;

    expect(persisted).toEqual(streamed);
    // the exact bug this fix closes: failures[] must survive on BOTH channels, not just one.
    expect(persisted.failures).toEqual([{ assertion: "tool_called", message: "expected Bash to be called", kind: "assertion" }]);
    expect(streamed.failures).toEqual([{ assertion: "tool_called", message: "expected Bash to be called", kind: "assertion" }]);
  });
});

/** `undelivered_deliverables` — the negative-case signal. No assertion covers "the skill produced a
 *  deliverable and never delivered it" unless an author thought to write one, and the scenarios that most
 *  need it are the ones whose author never considered delivery. Observed live: a run created 23 files,
 *  delivered 3, and reported success. */
describe("verdict — undelivered_deliverables", () => {
  const scratch = (path: string) => ({ path, bytes: 10, class: "scratchpad" as const });
  // The signal now requires POSITIVE evidence that a complete scratchpad walk observed the run.
  const observed = (over: Partial<RunResult> = {}): RunResult => rr({ scratchpadEvidenceComplete: true, presentedFiles: [], ...over });
  const out = (path: string) => ({ path, bytes: 10, class: "output" as const });
  const codes = (r: RunResult) => computeVerdict(r, "live").signals.map((s) => s.code);

  it("fires when a scratchpad file was never presented", () => {
    const v = computeVerdict(observed({ workspaceFiles: [scratch("scratchpad/report.html")] }), "live");
    expect(v.signals.map((s) => s.code)).toContain("undelivered_deliverables");
    expect(v.signals.find((s) => s.code === "undelivered_deliverables")!.message).toContain("report.html");
  });

  it("is WARN — it never fails a run on its own", () => {
    const v = computeVerdict(observed({ workspaceFiles: [scratch("scratchpad/report.html")] }), "live");
    expect(v.signals.find((s) => s.code === "undelivered_deliverables")!.severity).toBe("warn");
    expect(v.pass).toBe(true);
  });

  it("stays silent when the file WAS presented", () => {
    const r = observed({
      workspaceFiles: [scratch("scratchpad/report.html")],
      presentedFiles: [{ from: "/sessions/s/report.html", to: "/sessions/s/mnt/outputs/report.html", promoted: true, leaked: false }],
    });
    expect(codes(r)).not.toContain("undelivered_deliverables");
  });

  // present_files' own copy-failure branch leaves the file in the scratchpad. Counting that as delivery
  // would green the exact case `no_scratchpad_leak` exists to catch.
  it("does NOT treat a LEAKED presentation as delivered", () => {
    const r = observed({
      workspaceFiles: [scratch("scratchpad/report.html")],
      presentedFiles: [{ from: "/sessions/s/report.html", to: "", promoted: false, leaked: true }],
    });
    expect(codes(r)).toContain("undelivered_deliverables");
  });

  it("ignores files already in the delivery channel (outputs/ is not scratchpad)", () => {
    expect(codes(observed({ workspaceFiles: [out("outputs/report.html")] }))).not.toContain("undelivered_deliverables");
  });

  // The three ways the answer is UNKNOWN rather than "nothing". Silence here would let "cannot tell" read
  // as "clean" — the precise failure mode this signal exists to remove.
  it("stays silent when workspace evidence is UNAVAILABLE (workspaceFiles undefined)", () => {
    expect(codes(observed({ workspaceFiles: undefined }))).not.toContain("undelivered_deliverables");
  });

  it("stays silent when no scratchpad walk ran on this tier (no scratchpad-class entries at all)", () => {
    // protocol has no session-root layout, so the walk never runs — the ABSENCE of scratchpad entries
    // proves nothing, and must not be read as a clean delivery record.
    expect(codes(observed({ workspaceFiles: [out("outputs/a")] }))).not.toContain("undelivered_deliverables");
  });

  it("names at most 5 files and counts the rest, so a messy run doesn't produce an unreadable warning", () => {
    const many = Array.from({ length: 8 }, (_, i) => scratch(`scratchpad/f${i}.txt`));
    const msg = computeVerdict(observed({ workspaceFiles: many }), "live").signals.find(
      (s) => s.code === "undelivered_deliverables",
    )!.message;
    expect(msg).toContain("8 file(s)");
    expect(msg).toContain("+3 more");
  });

  // The message must be true on BOTH lanes: remote reclaims the container (destroyed), local keeps the
  // file but never shows it (invisible). Claiming destruction on local would be a false statement shipped
  // inside a warning whose whole value is being trustworthy.
  it("does not claim the file was destroyed — that is remote-only", () => {
    const msg = computeVerdict(observed({ workspaceFiles: [scratch("scratchpad/a.txt")] }), "live").signals.find(
      (s) => s.code === "undelivered_deliverables",
    )!.message;
    expect(msg).toContain("never reached the user");
    expect(msg).not.toMatch(/\bdestroyed\b(?!.*remote)/);
  });
});

/** Regressions from the adversarial review of the lane axis and the undelivered signal. Each of these
 *  shipped wrong once; the tests exist so they cannot ship wrong twice. */
describe("verdict — undelivered_deliverables: review regressions", () => {
  const scratch = (path: string) => ({ path, bytes: 10, class: "scratchpad" as const });
  const out = (path: string) => ({ path, bytes: 10, class: "output" as const });
  const observed = (over: Partial<RunResult> = {}): RunResult => rr({ scratchpadEvidenceComplete: true, presentedFiles: [], ...over });
  const codes = (r: RunResult) => computeVerdict(r, "live").signals.map((s) => s.code);

  // F2: "the walk never ran" and "the walk found nothing" were byte-identical silence, so protocol/chat/
  // replay read as clean. The signal now demands POSITIVE evidence that a complete walk observed the run.
  it("stays silent when no scratchpad walk observed the run — cannot tell is not clean", () => {
    expect(codes(rr({ workspaceFiles: [scratch("scratchpad/a.txt")], presentedFiles: [] }))).not.toContain("undelivered_deliverables");
    expect(codes(observed({ workspaceFiles: [scratch("scratchpad/a.txt")] }))).toContain("undelivered_deliverables");
  });

  // The commit message claimed absent delivery telemetry produced no signal. It fired, inventing an
  // undelivered verdict from absence of evidence.
  it("stays silent when delivery telemetry is absent, rather than inferring non-delivery", () => {
    expect(codes(observed({ workspaceFiles: [scratch("scratchpad/a.txt")], presentedFiles: undefined }))).not.toContain(
      "undelivered_deliverables",
    );
  });

  // F7: present_files COPIES — the source stays in the scratchpad — and presentedFiles is per-turn. So a
  // file delivered on turn 1 re-warned "never reached the user" on every later turn: a false statement.
  it("stays silent on a resumed turn, where the scratchpad still holds earlier turns' delivered files", () => {
    const r = observed({ workspaceFiles: [scratch("scratchpad/report.html")], turn: 2 });
    expect(codes(r)).not.toContain("undelivered_deliverables");
  });

  // SUPERSEDED INTENT (consumer report, 2026-08-01). This previously asserted that a remote
  // outputs-located file "counts as undelivered". It does not — and the old behaviour made the signal
  // fire on EVERY live first-turn remote run that wrote any file, because `isDelivered`'s location arm is
  // off on remote (correct) while its `presentedFiles` arm can never match there (no remote delivery tool
  // is modeled, so the array is structurally always empty). A signal that always fires carries no
  // information, and it forced `allow_undelivered_deliverables: true` into every remote scenario.
  //
  // The harness cannot distinguish "the skill failed to deliver" from "delivery is unobservable here", so
  // it must not assert the former. It now reports the gap itself via `delivery_unobservable`.
  it("on lane: remote, an outputs-located file is UNOBSERVABLE, not undelivered", () => {
    const r = observed({ lane: "remote", workspaceFiles: [out("outputs/report.html")] });
    expect(codes(r)).not.toContain("undelivered_deliverables");
    expect(codes(r)).toContain("delivery_unobservable");
  });

  // The two signals answer the same question and must never both fire — one claims a delivery failure,
  // the other says the question is unanswerable.
  it("never emits both delivery signals for the same run", () => {
    for (const lane of ["local", "remote"] as const) {
      const c = codes(observed({ lane, workspaceFiles: [scratch("scratchpad/a.html"), out("outputs/b.html")] }));
      expect(c.filter((x) => x === "undelivered_deliverables" || x === "delivery_unobservable")).toHaveLength(1);
    }
  });

  // Guards the always-fires property the replaced behaviour had: a remote run that produced nothing to
  // deliver has nothing unverifiable about it, so the cannot-verify notice must stay quiet too.
  it("stays quiet on a remote run that produced no deliverable at all", () => {
    expect(codes(observed({ lane: "remote", workspaceFiles: [] }))).not.toContain("delivery_unobservable");
    const inputOnly = observed({ lane: "remote", workspaceFiles: [{ path: "uploads/in.csv", bytes: 1, class: "input" as const }] });
    expect(codes(inputOnly)).not.toContain("delivery_unobservable");
  });

  it("delivery_unobservable names the lane, the cause, and both remedies", () => {
    const m = computeVerdict(observed({ lane: "remote", workspaceFiles: [out("outputs/r.html")] }), "live").signals.find(
      (s) => s.code === "delivery_unobservable",
    )!.message;
    expect(m).toContain("lane: remote");
    expect(m).toContain("CANNOT BE VERIFIED");
    expect(m).toContain("lane: local"); // the measure-it-properly remedy
    expect(m).toContain("allow_undelivered_deliverables"); // the acknowledge-the-gap remedy
  });

  it("honours allow_undelivered_deliverables for the unobservable notice too", () => {
    const r = observed({
      lane: "remote",
      workspaceFiles: [out("outputs/report.html")],
      assertions: [{ assertion: { allow_undelivered_deliverables: true }, pass: true }],
    });
    expect(codes(r)).not.toContain("delivery_unobservable");
  });

  it("on lane: local, that same file is delivered by location and stays silent", () => {
    const r = observed({ lane: "local", workspaceFiles: [out("outputs/report.html")] });
    expect(codes(r)).not.toContain("undelivered_deliverables");
  });

  // The candidate set is lane-dependent, so the EXPLANATION must branch on the same predicate. Caught
  // live: on remote the message inherited the local wording and contradicted itself — it named
  // `outputs/report.md`, called it "written outside every user-visible root", and prescribed "write
  // deliverables under outputs/" as the remedy for a file already there. The pre-existing tests asserted
  // only the signal CODE, so nothing failed. These assert the prose, which is the whole payload of a
  // signal whose severity means nobody has to have authored an assertion to see it.
  const msg = (r: RunResult) => computeVerdict(r, "live").signals.find((s) => s.code === "undelivered_deliverables")!.message;

  // The two remote-message tests that lived here are retired with the behaviour they described:
  // `undelivered_deliverables` no longer fires on remote at all, so there is no remote message of that
  // code left to assert. Its lane-branched `else` arm is retained in verdict.ts (unreachable today,
  // live again the moment a remote delivery tool ships) and the replacement coverage is
  // "delivery_unobservable names the lane, the cause, and both remedies" above.

  it("on lane: local, the scratchpad wording and the outputs/ remedy are kept", () => {
    const m = msg(observed({ lane: "local", workspaceFiles: [scratch("scratchpad/report.html")] }));
    expect(m).toContain("outside every user-visible root");
    expect(m).toContain("Write deliverables under outputs/");
  });

  it("names the opt-out key — the reader is told how to silence it", () => {
    expect(msg(observed({ lane: "local", workspaceFiles: [scratch("scratchpad/a.html")] }))).toContain("allow_undelivered_deliverables");
    // The remote half of this moved to the delivery_unobservable message test above, which asserts the
    // same opt-out is named there — the reader must never hit an unsilenceable warn on either lane.
  });

  // A read-only input the agent never authored is not a deliverable it failed to deliver.
  it("never counts input-class files as undelivered, even on remote", () => {
    const r = observed({ lane: "remote", workspaceFiles: [{ path: "uploads/in.csv", bytes: 1, class: "input" as const }] });
    expect(codes(r)).not.toContain("undelivered_deliverables");
  });

  // F7 noise half: working in the scratchpad is Cowork's designed pattern, so a scenario whose scratch
  // activity is intentional can say so — the convention `allow_stall` already sets for a warn signal.
  it("honours the allow_undelivered_deliverables opt-out", () => {
    const r = observed({
      workspaceFiles: [scratch("scratchpad/__pycache__/x.pyc")],
      assertions: [{ assertion: { allow_undelivered_deliverables: true }, pass: true }],
    });
    expect(codes(r)).not.toContain("undelivered_deliverables");
  });
});
