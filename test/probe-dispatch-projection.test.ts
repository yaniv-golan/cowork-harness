import { describe, it, expect } from "vitest";
import { projectDispatchProbe, formatDispatchProbe } from "../src/run/probe-dispatch.js";
import type { RunResult } from "../src/types.js";

// Minimal RunResult builder — same idiom as test/verdict.test.ts's `rr()`, extended with the fields
// projectDispatchProbe actually reads (subagents/fileToolAttempts/pathDenials/toolResults). Nothing here
// drives a live run: the whole point of this suite is exercising the pure projection function against a
// SYNTHETIC RunResult, per the design's "unit-test the projection, don't require a live run" instruction.
function rr(over: Partial<RunResult>): RunResult {
  return {
    scenario: "t",
    fidelity: "hostloop",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [
      { assertion: { subagent_dispatched: ".*" }, pass: true },
      { assertion: { dispatch_count_max: 1 }, pass: true },
    ],
    outDir: "/tmp/x",
    ...over,
  };
}

const DISPATCH_ID = "toolu_dispatch_1";
const WRITE_ID = "toolu_write_1";

describe("projectDispatchProbe", () => {
  it("projects a healthy single dispatch: resolvedAgentType, delivered:true, pathDenials scoped per-dispatch", () => {
    const result = rr({
      subagents: [
        {
          toolUseId: DISPATCH_ID,
          dispatchAgentType: "founder-skills:deck-review",
          resolvedAgentType: "founder-skills:deck-review",
          declaredTools: [],
          toolsUsed: [],
        },
      ],
      fileToolAttempts: [
        {
          tool: "Write",
          paths: { file_path: "mnt/outputs/report.md" },
          gatePath: "mnt/outputs/report.md",
          origin: "subagent",
          parentToolUseId: DISPATCH_ID,
          toolUseId: WRITE_ID,
        },
      ],
      toolResults: [{ toolUseId: WRITE_ID, isError: false, text: "ok" }],
      pathDenials: [],
    });
    const p = projectDispatchProbe(result);
    expect(p.subagentsUnavailable).toBe(false);
    expect(p.dispatches).toHaveLength(1);
    const d = p.dispatches[0];
    expect(d.resolvedAgentType).toBe("founder-skills:deck-review");
    expect(d.dispatchTypeOmitted).toBeUndefined();
    expect(d.delivered).toBe(true);
    expect(d.pathDenials).toEqual([]);
    expect(d.pathDenialsScope).toBe("per-dispatch");
    expect(p.verdict.pass).toBe(true);
  });

  it("flags dispatchTypeOmitted — the wildcard-fallback trap", () => {
    const result = rr({
      subagents: [
        {
          toolUseId: DISPATCH_ID,
          dispatchAgentType: "unknown",
          resolvedAgentType: "general-purpose",
          dispatchTypeOmitted: true,
          declaredTools: [],
          toolsUsed: [],
        },
      ],
    });
    const p = projectDispatchProbe(result);
    expect(p.dispatches[0].dispatchTypeOmitted).toBe(true);
    expect(p.dispatches[0].resolvedAgentType).toBe("general-purpose");
  });

  it("delivered:false when the sub-agent's write has no paired non-error tool_result", () => {
    const result = rr({
      subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }],
      fileToolAttempts: [{ tool: "Write", paths: {}, origin: "subagent", parentToolUseId: DISPATCH_ID, toolUseId: WRITE_ID }],
      toolResults: [{ toolUseId: WRITE_ID, isError: true, text: "boom" }], // errored — not a delivery
    });
    const p = projectDispatchProbe(result);
    expect(p.dispatches[0].delivered).toBe(false);
  });

  it("delivered:false when the write belongs to a SIBLING dispatch (parentToolUseId mismatch)", () => {
    const OTHER = "toolu_dispatch_2";
    const result = rr({
      subagents: [
        { toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] },
        { toolUseId: OTHER, dispatchAgentType: "y", declaredTools: [], toolsUsed: [] },
      ],
      fileToolAttempts: [{ tool: "Write", paths: {}, origin: "subagent", parentToolUseId: OTHER, toolUseId: WRITE_ID }],
      toolResults: [{ toolUseId: WRITE_ID, isError: false, text: "ok" }],
    });
    const p = projectDispatchProbe(result);
    const first = p.dispatches.find((d) => d.toolUseId === DISPATCH_ID)!;
    const second = p.dispatches.find((d) => d.toolUseId === OTHER)!;
    expect(first.delivered).toBe(false); // the write is NOT its own
    expect(second.delivered).toBe(true); // the write IS its own
  });

  it('--expect-write suffix narrows "delivered" to a matching target path', () => {
    const result = rr({
      subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }],
      fileToolAttempts: [
        {
          tool: "Write",
          paths: { file_path: "mnt/outputs/other.json" },
          gatePath: "mnt/outputs/other.json",
          origin: "subagent",
          parentToolUseId: DISPATCH_ID,
          toolUseId: WRITE_ID,
        },
      ],
      toolResults: [{ toolUseId: WRITE_ID, isError: false, text: "ok" }],
    });
    expect(projectDispatchProbe(result, { expectWriteSuffix: "artifacts/probe.json" }).dispatches[0].delivered).toBe(false);
    expect(projectDispatchProbe(result, { expectWriteSuffix: "outputs/other.json" }).dispatches[0].delivered).toBe(true);
  });

  it('delivered:"unavailable" (never a false "no") when fileToolAttempts/toolResults are undefined', () => {
    const result = rr({ subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }] });
    expect(projectDispatchProbe(result).dispatches[0].delivered).toBe("unavailable");
  });

  it('pathDenials:"unavailable" when RunResult.pathDenials is undefined — never conflated with a proven-empty []', () => {
    const result = rr({ subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }] });
    const d = projectDispatchProbe(result).dispatches[0];
    expect(d.pathDenials).toBe("unavailable");
    expect(d.pathDenialsScope).toBe("unavailable");
  });

  it("pathDenials falls back to the run-level list when fileToolAttempts can't join the denial to a dispatch", () => {
    const result = rr({
      subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }],
      pathDenials: [{ source: "pretooluse", tool: "Write", path: "/sessions/x", decision: "deny", toolUseId: WRITE_ID }],
      // fileToolAttempts deliberately absent — the join is impossible.
    });
    const d = projectDispatchProbe(result).dispatches[0];
    expect(d.pathDenialsScope).toBe("run-level");
    expect(d.pathDenials).toHaveLength(1);
  });

  it("pathDenials scoped per-dispatch excludes a denial that belongs to a SIBLING dispatch", () => {
    const OTHER = "toolu_dispatch_2";
    const OTHER_DENIED_CALL = "toolu_denied_2";
    const result = rr({
      subagents: [
        { toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] },
        { toolUseId: OTHER, dispatchAgentType: "y", declaredTools: [], toolsUsed: [] },
      ],
      fileToolAttempts: [{ tool: "Write", paths: {}, origin: "subagent", parentToolUseId: OTHER, toolUseId: OTHER_DENIED_CALL }],
      pathDenials: [{ source: "pretooluse", tool: "Write", path: "/sessions/x", decision: "deny", toolUseId: OTHER_DENIED_CALL }],
    });
    const first = projectDispatchProbe(result).dispatches.find((d) => d.toolUseId === DISPATCH_ID)!;
    const second = projectDispatchProbe(result).dispatches.find((d) => d.toolUseId === OTHER)!;
    expect(first.pathDenials).toEqual([]); // not this dispatch's denial
    expect(first.pathDenialsScope).toBe("per-dispatch");
    expect(second.pathDenials).toHaveLength(1); // this one IS
  });

  it("subagentsUnavailable:true (never a bogus zero-dispatches) when RunResult.subagents is undefined", () => {
    const p = projectDispatchProbe(rr({}));
    expect(p.subagentsUnavailable).toBe(true);
    expect(p.dispatches).toEqual([]);
  });

  it("referencesRead passes through per-dispatch", () => {
    const result = rr({
      subagents: [
        {
          toolUseId: DISPATCH_ID,
          dispatchAgentType: "x",
          declaredTools: [],
          toolsUsed: [],
          referencesRead: ["references/checklist.md"],
        },
      ],
    });
    expect(projectDispatchProbe(result).dispatches[0].referencesRead).toEqual(["references/checklist.md"]);
  });

  it("verdict mirrors computeVerdict — a failed assertion fails the probe's verdict", () => {
    const result = rr({
      subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }],
      assertions: [{ assertion: { dispatch_count_max: 1 }, pass: false, message: "too many dispatches" }],
    });
    expect(projectDispatchProbe(result).verdict.pass).toBe(false);
  });
});

describe("formatDispatchProbe (text rendering)", () => {
  it("renders resolvedAgentType/delivered/pathDenials/verdict for a healthy dispatch", () => {
    const result = rr({
      subagents: [
        {
          toolUseId: DISPATCH_ID,
          dispatchAgentType: "x",
          resolvedAgentType: "founder-skills:deck-review",
          declaredTools: [],
          toolsUsed: [],
        },
      ],
      fileToolAttempts: [{ tool: "Write", paths: {}, origin: "subagent", parentToolUseId: DISPATCH_ID, toolUseId: WRITE_ID }],
      toolResults: [{ toolUseId: WRITE_ID, isError: false, text: "ok" }],
      pathDenials: [],
    });
    const text = formatDispatchProbe(projectDispatchProbe(result));
    expect(text).toContain("founder-skills:deck-review");
    expect(text).toContain("delivered: yes");
    expect(text).toContain("pathDenials: 0");
    expect(text).toContain("verdict: PASS");
  });

  it("renders evidence-unavailable states distinctly from a proven negative", () => {
    const result = rr({ subagents: [{ toolUseId: DISPATCH_ID, dispatchAgentType: "x", declaredTools: [], toolsUsed: [] }] });
    const text = formatDispatchProbe(projectDispatchProbe(result));
    expect(text).toContain("delivered: unavailable");
    expect(text).toContain("pathDenials: unavailable");
  });

  it("renders the no-dispatch-tree case distinctly from zero dispatches", () => {
    const text = formatDispatchProbe(projectDispatchProbe(rr({})));
    expect(text).toContain("unavailable");
    expect(text).not.toContain("dispatches: none");
  });
});
