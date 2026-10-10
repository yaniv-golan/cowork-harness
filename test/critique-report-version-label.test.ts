// The critique report records which harness version wrote it and the `--label` it was given, so reports from
// different releases and generations can be told apart without the graded turn's own result.
import { describe, it, expect } from "vitest";
import { parseArgs, buildJsonReport, buildTaskTurnArgs } from "../src/critique/command.js";
import { pkgVersion } from "../src/run/envelope.js";

const minimalState = (over: Record<string, unknown> = {}) =>
  ({
    skillFolder: "skills/foo",
    prompt: "p",
    sessionId: "sess-crit-1",
    outDir: "/tmp/x",
    fidelity: "container",
    taskResult: "success",
    selfReportStatus: "captured",
    items: [],
    requestedModel: "claude-opus-4-8",
    ...over,
  }) as unknown as Parameters<typeof buildJsonReport>[0];

describe("critique report: harnessVersion and label", () => {
  it("parseArgs captures --label (both forms) and still forwards it to the task turn", () => {
    for (const argv of [
      ["./s", "--prompt", "p", "--label", "v1.2.3-rc1"],
      ["./s", "--prompt", "p", "--label=v1.2.3-rc1"],
    ]) {
      const opts = parseArgs(argv);
      expect(opts.label).toBe("v1.2.3-rc1");
      expect(buildTaskTurnArgs(opts, "sess-crit-1").join(" ")).toContain("v1.2.3-rc1");
    }
    expect(parseArgs(["./s", "--prompt", "p"]).label).toBeUndefined();
  });

  it("the report carries harnessVersion and label on every branch", () => {
    const base = { harnessVersion: pkgVersion(), label: "gen2" };
    for (const over of [{}, { infraFailure: "x", infraFailurePhase: "task turn" }, { evaluatorError: "boom" }]) {
      const r = buildJsonReport(minimalState({ ...base, ...over }));
      expect(r.harnessVersion).toBe(pkgVersion());
      expect(r.label).toBe("gen2");
    }
    expect(JSON.parse(JSON.stringify(buildJsonReport(minimalState())))).not.toHaveProperty("label");
  });
});
