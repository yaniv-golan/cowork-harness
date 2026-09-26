import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeVerdict } from "../src/run/verdict.js";
import { evaluate, type AssertContext } from "../src/assert.js";
import type { RunResult, Assertion } from "../src/types.js";

/**
 * The outputs-delete guard's fail-authority, tiered by corroboration. Two detectors feed it: a text scan
 * of the agent's bash commands (a heuristic that over-flags by design — it cannot tell a Python variable
 * named `rm` from the `rm` command) and a filesystem diff of `outputs/` taken before and after the turn
 * (ground truth, but blind to a file the turn both created and deleted). A text hit is fail-authority only
 * when the filesystem confirms it, when a delete in command/call position has an outputs path as its own operand, or when
 * the diff could not run; otherwise it is the `outputs_delete_unconfirmed` warn.
 *
 * Everything here drives `computeVerdict` / `evaluate` over PERSISTED shapes — the same data `verify-run`
 * reads — so no agent, container or token is involved.
 */

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
const codes = (v: ReturnType<typeof computeVerdict>) => v.signals.map((s) => `${s.code}:${s.severity}`);

// The false positive this tiering exists for: an inline Python body whose variable is named `rm`, plus an outputs path
// elsewhere in the same command. Nothing was deleted.
const PY_RM_VAR = `rm = data.get("body","")`;
const clean = { status: "clean" as const, findings: [] as string[] };
const textOnly = (entry: string, basis: "named" | "inferred") => ({
  outputsDeletes: [entry],
  outputsDeleteBasis: [basis],
  hostPathLeaked: false,
  selfHealRan: false,
});

describe("outputs-delete: an uncorroborated, inferred text hit warns instead of failing", () => {
  it("a Python variable named rm (inferred, filesystem diff clean) passes with one outputs_delete_unconfirmed warn", () => {
    const v = computeVerdict(rr({ scan: textOnly(PY_RM_VAR, "inferred"), fsDiff: clean } as Partial<RunResult>), "live");
    expect(codes(v)).not.toContain("outputs_delete:fail");
    expect(codes(v)).toContain("outputs_delete_unconfirmed:warn");
    expect(v.pass).toBe(true);
  });

  it("an authored no_delete_in_outputs passes on the same evidence, and says why", () => {
    const ctx = {
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: "/nonexistent",
      userVisiblePrefixes: ["outputs"],
      outputsDeletes: [PY_RM_VAR],
      outputsDeleteBasis: ["inferred"],
      fsDiff: clean,
      mountDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
    } as unknown as AssertContext;
    const [r] = evaluate([{ no_delete_in_outputs: true }], ctx);
    expect(r.pass).toBe(true);
    expect(String(r.evidence ?? "")).toMatch(/advisory/i);
  });
});

describe("outputs-delete: what still fails", () => {
  it("a delete statement that names an outputs path fails even when the diff is clean (a run-created file)", () => {
    const v = computeVerdict(
      rr({ scan: textOnly(`rm -f "/sessions/s/mnt/outputs/deck.pdf"`, "named"), fsDiff: clean } as Partial<RunResult>),
      "live",
    );
    expect(codes(v)).toContain("outputs_delete:fail");
    expect(v.pass).toBe(false);
  });

  it("a filesystem-proven delete fails — including when the text scan itself is unavailable", () => {
    const fs = { status: "findings" as const, findings: ["[fs-diff] output file removed post-run: outputs/a.md"] };
    expect(computeVerdict(rr({ scan: undefined, fsDiff: fs } as Partial<RunResult>), "live").pass).toBe(false);
    expect(codes(computeVerdict(rr({ scan: undefined, fsDiff: fs } as Partial<RunResult>), "live"))).toContain("outputs_delete:fail");
  });

  it("fails closed: an inferred hit fails when the diff did not run, is unavailable, or the basis is missing/misaligned", () => {
    // legacy result.json: no fsDiff, no basis
    expect(computeVerdict(rr({ scan: { outputsDeletes: [PY_RM_VAR], hostPathLeaked: false, selfHealRan: false } }), "live").pass).toBe(
      false,
    );
    // basis present but no fsDiff
    expect(computeVerdict(rr({ scan: textOnly(PY_RM_VAR, "inferred") } as Partial<RunResult>), "live").pass).toBe(false);
    for (const reason of ["baseline-incomplete", "post-walk-incomplete"] as const) {
      const fsDiff = { status: "unavailable" as const, reason, findings: [] as string[] };
      expect(computeVerdict(rr({ scan: textOnly(PY_RM_VAR, "inferred"), fsDiff } as Partial<RunResult>), "live").pass).toBe(false);
    }
    // positional basis whose length does not match the entries — ambiguous, so it proves nothing
    const misaligned = {
      outputsDeletes: [PY_RM_VAR, PY_RM_VAR],
      outputsDeleteBasis: ["inferred"],
      hostPathLeaked: false,
      selfHealRan: false,
    };
    expect(computeVerdict(rr({ scan: misaligned, fsDiff: clean } as Partial<RunResult>), "live").pass).toBe(false);
  });
});

describe("outputs-delete: a filesystem diff that could not run is never silent", () => {
  it("warns outputs_diff_unavailable with no text hit at all", () => {
    const fsDiff = { status: "unavailable" as const, reason: "post-walk-incomplete" as const, findings: [] as string[] };
    const v = computeVerdict(
      rr({ scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false }, fsDiff } as Partial<RunResult>),
      "live",
    );
    expect(codes(v)).toContain("outputs_diff_unavailable:warn");
    expect(v.pass).toBe(true);
  });
});

describe("outputs-delete: waiver and roster", () => {
  it("allow_outputs_delete silences the fail and the unconfirmed warn; the roster still reports what was seen", () => {
    const status = (v: ReturnType<typeof computeVerdict>) => v.guards.find((g) => g.name === "outputs-delete")?.status;
    const warnRun = rr({ scan: textOnly(PY_RM_VAR, "inferred"), fsDiff: clean } as Partial<RunResult>);
    expect(status(computeVerdict(warnRun, "live"))).toBe("fired");
    const waived = computeVerdict({ ...warnRun, assertions: [assn({ allow_outputs_delete: true })] }, "live");
    expect(codes(waived).filter((c) => c.startsWith("outputs_delete"))).toEqual([]);
    const failRun = rr({
      scan: textOnly(`rm -rf mnt/outputs/x`, "named"),
      fsDiff: clean,
      assertions: [assn({ allow_outputs_delete: true })],
    } as Partial<RunResult>);
    expect(codes(computeVerdict(failRun, "live")).filter((c) => c.startsWith("outputs_delete"))).toEqual([]);
  });
});

describe("outputs-delete: the unconfirmed warn stays visible when the key is authored", () => {
  // The authored key owns the VERDICT (it passes on this tier), but a passing assertion's evidence is
  // printed only in the JSON envelope — in text mode the advisory would vanish. The warn never flips
  // `pass`, so emitting it alongside the authored key costs nothing and keeps the hit on stderr.
  it("authored no_delete_in_outputs + inferred hit + clean diff ⇒ pass, and the warn is still raised", () => {
    const v = computeVerdict(
      rr({
        scan: textOnly(PY_RM_VAR, "inferred"),
        fsDiff: clean,
        assertions: [assn({ no_delete_in_outputs: true }, true)],
      } as Partial<RunResult>),
      "live",
    );
    expect(v.pass).toBe(true);
    expect(codes(v)).toContain("outputs_delete_unconfirmed:warn");
    expect(codes(v)).not.toContain("outputs_delete:fail"); // the fail stays owned by the assertion
  });
});

describe("outputs-delete: a malformed persisted fsDiff fails closed instead of throwing", () => {
  it("fsDiff without a findings array (hand-edited or truncated result.json)", () => {
    const malformed = { status: "clean" } as unknown as RunResult["fsDiff"];
    const run = () => computeVerdict(rr({ scan: textOnly(PY_RM_VAR, "inferred"), fsDiff: malformed } as Partial<RunResult>), "live");
    expect(run).not.toThrow();
    expect(run().pass).toBe(false);
    expect(codes(run())).toContain("outputs_delete:fail");
  });
});

describe("scan_unavailable no longer claims the whole outputs-delete guard did not run", () => {
  // With events.jsonl missing only the TEXT half is gone: the filesystem diff still runs and its findings
  // survive (and can fail the run as outputs_delete). A warn saying "the outputs-delete guard did not run"
  // beside that failure would contradict it.
  it("the verdict message scopes the gap to the text scan", () => {
    const v = computeVerdict(rr({ scan: undefined, fsDiff: clean } as Partial<RunResult>), "live");
    const msg = v.signals.find((s) => s.code === "scan_unavailable")?.message ?? "";
    expect(msg).toMatch(/text scan/);
    expect(msg).not.toMatch(/outputs-delete guards did not run/);
  });

  it.each(["docs/scenario.md", ".claude/skills/cowork-harness/SKILL.md", ".claude/skills/cowork-harness/references/scenario-schema.md"])(
    "%s does not say the outputs-delete guard did not run",
    (rel) => {
      const text = readFileSync(resolve(rel), "utf8").replace(/\*\*/g, "").replace(/\s+/g, " ");
      expect(text).not.toMatch(/outputs-delete guards did not run/);
    },
  );
});

describe("outputs-delete: the authored key on the diff's own evidence states", () => {
  const baseCtx = (over: Partial<AssertContext>): AssertContext =>
    ({
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: "/nonexistent",
      userVisiblePrefixes: ["outputs"],
      outputsDeletes: [],
      mountDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
      ...over,
    }) as unknown as AssertContext;
  const run = (over: Partial<AssertContext>) => evaluate([{ no_delete_in_outputs: true }], baseCtx(over))[0];

  it("an incomplete post-run walk with no text hit fails as evidence-unavailable", () => {
    const r = run({ fsDiff: { status: "unavailable", reason: "post-walk-incomplete", findings: [] } });
    expect(r.pass).toBe(false);
    expect(String(r.message)).toMatch(/evidence unavailable.*post-run outputs walk/);
  });

  it("an incomplete baseline with no text hit passes (the verdict warns instead)", () => {
    expect(run({ fsDiff: { status: "unavailable", reason: "baseline-incomplete", findings: [] } }).pass).toBe(true);
  });

  it("a missing text scan plus a filesystem-proven delete fails, naming the finding", () => {
    const finding = "[fs-diff] output file removed post-run: outputs/a.md";
    const r = run({ scanMissing: true, fsDiff: { status: "findings", findings: [finding] } });
    expect(r.pass).toBe(false);
    expect(String(r.message)).toContain(finding);
  });
});

describe("outputs-delete: roster and mixed evidence", () => {
  const status = (v: ReturnType<typeof computeVerdict>) => v.guards.find((g) => g.name === "outputs-delete")?.status;

  it("the roster reads `unverified` when the diff could not verify and nothing was flagged", () => {
    const fsDiff = { status: "unavailable" as const, reason: "post-walk-incomplete" as const, findings: [] as string[] };
    const v = computeVerdict(
      rr({ scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false }, fsDiff } as Partial<RunResult>),
      "live",
    );
    expect(status(v)).toBe("unverified");
  });

  it("a filesystem-proven delete beside an inferred text hit fails — the fs-diff basis wins", () => {
    const finding = "[fs-diff] output file removed post-run: outputs/a.md";
    const scan = {
      outputsDeletes: [PY_RM_VAR, finding],
      outputsDeleteBasis: ["inferred", "fs-diff"] as ("inferred" | "fs-diff")[],
      hostPathLeaked: false,
      selfHealRan: false,
    };
    const v = computeVerdict(rr({ scan, fsDiff: { status: "findings", findings: [finding] } } as Partial<RunResult>), "live");
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("outputs_delete:fail");
    expect(codes(v)).not.toContain("outputs_delete_unconfirmed:warn");
  });

  it("allow_outputs_delete also silences outputs_diff_unavailable", () => {
    const fsDiff = { status: "unavailable" as const, reason: "baseline-incomplete" as const, findings: [] as string[] };
    const scan = { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false };
    expect(codes(computeVerdict(rr({ scan, fsDiff } as Partial<RunResult>), "live"))).toContain("outputs_diff_unavailable:warn");
    const waived = computeVerdict(rr({ scan, fsDiff, assertions: [assn({ allow_outputs_delete: true })] } as Partial<RunResult>), "live");
    expect(codes(waived)).not.toContain("outputs_diff_unavailable:warn");
  });
});
