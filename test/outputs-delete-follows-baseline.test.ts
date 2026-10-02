import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeVerdict } from "../src/run/verdict.js";
import { evaluate, type AssertContext } from "../src/assert.js";
import { scanEvents, isOutputsDelete, outputsFsDiff } from "../src/run/execute.js";
import { baselineOutputsMountMode, stampedOutputsMountMode } from "../src/baseline.js";
import type { RunResult, Assertion, PlatformBaseline } from "../src/types.js";

/**
 * The outputs-delete default verdict follows the run's baseline.
 *
 * From Desktop 2.16120.0 every mount builder sets the outputs mount from one exported function that returns
 * "rwd" (deletes allowed) for a normal session and "rw" only for a Dispatch bridge session. The baselines record
 * that per release in `mountLayout.mounts[name=outputs].mode`, and each live run persists it as
 * `RunResult.outputsMountMode`. On "rwd" an outputs delete (unlink, or a move out of outputs) no longer fails the
 * default verdict; on "rw", and whenever the field is absent (every result written before it existed, a replay,
 * the remote lane), the verdict is exactly what it was.
 *
 * The verdict is pure over RunResult, so a hand-built RunResult is its real input here, not a stub.
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
const roster = (v: ReturnType<typeof computeVerdict>) => v.guards.find((g) => g.name === "outputs-delete")?.status;
const outputsCodes = (v: ReturnType<typeof computeVerdict>) => codes(v).filter((c) => c.startsWith("outputs_"));

const clean = { status: "clean" as const, findings: [] as string[] };
const FINDING = "[fs-diff] output file removed post-run: outputs/draft.md";
const proven = {
  scan: { outputsDeletes: [FINDING], outputsDeleteBasis: ["fs-diff" as const], hostPathLeaked: false, selfHealRan: false },
  fsDiff: { status: "findings" as const, findings: [FINDING] },
};
const named = (cmd: string) => ({
  scan: { outputsDeletes: [cmd], outputsDeleteBasis: ["named" as const], hostPathLeaked: false, selfHealRan: false },
  fsDiff: clean,
});
const inferred = {
  scan: {
    outputsDeletes: [`rm = data.get("body","")`],
    outputsDeleteBasis: ["inferred" as const],
    hostPathLeaked: false,
    selfHealRan: false,
  },
  fsDiff: clean,
};
const diffUnavailable = {
  scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  fsDiff: { status: "unavailable" as const, reason: "post-walk-incomplete" as const, findings: [] as string[] },
};

describe("rwd baseline, nothing authored: an outputs delete is allowed", () => {
  it("a filesystem-proven delete passes with no outputs signal and the roster reads na", () => {
    const v = computeVerdict(rr({ ...proven, outputsMountMode: "rwd" } as Partial<RunResult>), "live");
    expect(v.pass).toBe(true);
    expect(outputsCodes(v)).toEqual([]);
    expect(roster(v)).toBe("na");
  });

  it("a named rm of an outputs path passes", () => {
    const v = computeVerdict(rr({ ...named(`rm -f mnt/outputs/draft.md`), outputsMountMode: "rwd" } as Partial<RunResult>), "live");
    expect(v.pass).toBe(true);
    expect(outputsCodes(v)).toEqual([]);
  });

  it("a move OUT of outputs passes: rwd allows rename as well as unlink", () => {
    const v = computeVerdict(
      rr({ ...named(`mv mnt/outputs/draft.md /tmp/draft.md`), outputsMountMode: "rwd" } as Partial<RunResult>),
      "live",
    );
    expect(v.pass).toBe(true);
    expect(outputsCodes(v)).toEqual([]);
  });

  it("an inferred hit raises no outputs_delete_unconfirmed warn", () => {
    expect(outputsCodes(computeVerdict(rr({ ...inferred, outputsMountMode: "rwd" } as Partial<RunResult>), "live"))).toEqual([]);
  });

  it("a diff that could not verify raises no outputs_diff_unavailable warn", () => {
    expect(outputsCodes(computeVerdict(rr({ ...diffUnavailable, outputsMountMode: "rwd" } as Partial<RunResult>), "live"))).toEqual([]);
  });

  it("allow_outputs_delete is an accepted no-op, with no signal about the key", () => {
    const v = computeVerdict(
      rr({ ...proven, outputsMountMode: "rwd", assertions: [assn({ allow_outputs_delete: true })] } as Partial<RunResult>),
      "live",
    );
    expect(v.pass).toBe(true);
    expect(v.signals).toEqual([]);
  });
});

describe("rw baseline, or no recorded mode: unchanged", () => {
  // Green on the code before this change by design: they pin behaviour that must NOT move. Their teeth are the
  // mutation checks (treat absent as rwd; gate on `!== "rw"`).
  it("rw + a filesystem-proven delete fails outputs_delete", () => {
    const v = computeVerdict(rr({ ...proven, outputsMountMode: "rw" } as Partial<RunResult>), "live");
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("outputs_delete:fail");
    expect(roster(v)).toBe("fired");
  });

  it("rw + a move out of outputs fails outputs_delete", () => {
    const v = computeVerdict(
      rr({ ...named(`mv mnt/outputs/draft.md /tmp/draft.md`), outputsMountMode: "rw" } as Partial<RunResult>),
      "live",
    );
    expect(codes(v)).toContain("outputs_delete:fail");
  });

  it("an ABSENT mode (a result written before the field, a replay, the remote lane) fails exactly as rw", () => {
    const v = computeVerdict(rr({ ...proven }), "live");
    expect(v.pass).toBe(false);
    expect(codes(v)).toContain("outputs_delete:fail");
    expect(roster(v)).toBe("fired");
    expect(codes(computeVerdict(rr({ ...inferred }), "live"))).toContain("outputs_delete_unconfirmed:warn");
    expect(codes(computeVerdict(rr({ ...diffUnavailable }), "live"))).toContain("outputs_diff_unavailable:warn");
  });

  it("an unknown persisted mode value is not read as rwd", () => {
    const v = computeVerdict(rr({ ...proven, outputsMountMode: "RWD" } as unknown as Partial<RunResult>), "live");
    expect(codes(v)).toContain("outputs_delete:fail");
  });
});

describe("rwd baseline, no_delete_in_outputs authored: the check works exactly as before", () => {
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
      slashInvokedSkills: [],
      ...over,
    }) as unknown as AssertContext;

  it("the assertion fails on a proven delete and on a move out of outputs", () => {
    const r1 = evaluate(
      [{ no_delete_in_outputs: true }],
      baseCtx({ outputsDeletes: [FINDING], outputsDeleteBasis: ["fs-diff"], fsDiff: proven.fsDiff }),
    )[0];
    expect(r1.pass).toBe(false);
    const mv = `mv mnt/outputs/draft.md /tmp/draft.md`;
    const r2 = evaluate(
      [{ no_delete_in_outputs: true }],
      baseCtx({ outputsDeletes: [mv], outputsDeleteBasis: ["named"], fsDiff: clean }),
    )[0];
    expect(r2.pass).toBe(false);
    // Its message no longer claims the delete is forbidden in Cowork: on rwd it is not.
    expect(String(r1.message)).not.toMatch(/forbidden in Cowork/);
  });

  it("the verdict fails through the assertion, and the roster reports what the guard saw", () => {
    const v = computeVerdict(
      rr({ ...proven, outputsMountMode: "rwd", assertions: [assn({ no_delete_in_outputs: true }, false)] } as Partial<RunResult>),
      "live",
    );
    expect(v.pass).toBe(false);
    expect(codes(v)).not.toContain("outputs_delete:fail"); // the assertion owns the fail, as on rw
    expect(roster(v)).toBe("fired");
  });

  it("an inferred hit still raises the unconfirmed warn, and an unverifiable diff still warns", () => {
    const authored = [assn({ no_delete_in_outputs: true }, true)];
    expect(
      codes(computeVerdict(rr({ ...inferred, outputsMountMode: "rwd", assertions: authored } as Partial<RunResult>), "live")),
    ).toContain("outputs_delete_unconfirmed:warn");
    expect(
      codes(computeVerdict(rr({ ...diffUnavailable, outputsMountMode: "rwd", assertions: authored } as Partial<RunResult>), "live")),
    ).toContain("outputs_diff_unavailable:warn");
  });
});

describe("no_delete_in_mounts keeps covering outputs on every baseline", () => {
  const ctx = (mountDeletes: { mount: string; command: string }[], waived?: string[]) =>
    ({
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: "/nonexistent",
      userVisiblePrefixes: ["outputs"],
      outputsDeletes: [],
      mountDeletes,
      ...(waived ? { deleteWaivedMounts: waived } : {}),
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
      slashInvokedSkills: [],
    }) as unknown as AssertContext;
  const outputsHit = { mount: "outputs", command: "rm mnt/outputs/draft.md" };

  it("an outputs-only delete fails the authored key, and the message does not claim production denies it", () => {
    const r = evaluate([{ no_delete_in_mounts: true }], ctx([outputsHit]))[0];
    expect(r.pass).toBe(false);
    expect(String(r.message)).toContain("outputs");
    expect(String(r.message)).not.toMatch(/production denies/);
  });

  it("allow_delete_in: [outputs] waives it; a rw connected-folder delete still fails", () => {
    expect(evaluate([{ no_delete_in_mounts: true }, { allow_delete_in: ["outputs"] }], ctx([outputsHit]))[0].pass).toBe(true);
    expect(evaluate([{ no_delete_in_mounts: true }], ctx([{ mount: "reports", command: "rm mnt/reports/a" }]))[0].pass).toBe(false);
  });
});

describe("the scan keeps outputs evidence when outputs is not delete-denied", () => {
  const events = (cmd: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-odfb-"));
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } }) + "\n",
    );
    return f;
  };

  it("an outputs rm lands in outputsDeletes AND mountDeletes even when the denied roots omit outputs", () => {
    const s = scanEvents(events("rm -f mnt/outputs/draft.md"), []);
    expect(s.outputsDeletes).toHaveLength(1);
    expect(s.mountDeletes.map((d) => d.mount)).toEqual(["outputs"]);
  });

  it("with outputs in the denied roots the result is the same (rw baselines are byte-identical)", () => {
    const a = scanEvents(events("rm -f mnt/outputs/draft.md"), ["outputs"]);
    const b = scanEvents(events("rm -f mnt/outputs/draft.md"), []);
    expect(b).toEqual(a);
  });
});

describe("rename and overwrite inside outputs are not deletes (the live rwd probe: both returned 0, no card)", () => {
  it("the command classifier does not flag a rename within outputs or a move onto an existing destination", () => {
    expect(isOutputsDelete("mv mnt/outputs/a.md mnt/outputs/final.md")).toBe(false);
    expect(isOutputsDelete("mv mnt/outputs/tmp.md mnt/outputs/report.md")).toBe(false);
  });

  it("the filesystem diff does not report a rename within outputs, or an overwrite by rename", () => {
    const hashOf = (m: Record<string, string>) => (p: string) => m[p] ?? null;
    const walk = (paths: string[]) => ({ entries: paths.map((path) => ({ path })), complete: true, containmentSkips: [] as string[] });
    // rename: a.md -> final.md (a NEW path carrying the same content)
    const renamed = outputsFsDiff(
      { complete: true, paths: ["outputs", "outputs/a.md"], hashes: { outputs: null, "outputs/a.md": "h1" } },
      walk(["outputs", "outputs/final.md"]),
      hashOf({ "outputs/final.md": "h1" }),
    );
    expect(renamed.findings).toEqual([]);
    // overwrite by rename: a turn-created tmp.md moved onto the pre-existing report.md, which still exists
    const overwritten = outputsFsDiff(
      { complete: true, paths: ["outputs", "outputs/report.md"], hashes: { outputs: null, "outputs/report.md": "h0" } },
      walk(["outputs", "outputs/report.md"]),
      hashOf({ "outputs/report.md": "h2" }),
    );
    expect(overwritten.findings).toEqual([]);
  });
});

describe("the baseline's recorded outputs mode", () => {
  const raw = (name: string) => JSON.parse(readFileSync(resolve("baselines", `desktop-${name}.json`), "utf8")) as PlatformBaseline;

  it("reads the committed baselines: rwd from 2.16120.0, rw before", () => {
    expect(baselineOutputsMountMode(raw("2.19675.0"))).toBe("rwd");
    expect(baselineOutputsMountMode(raw("2.16120.0"))).toBe("rwd");
    expect(baselineOutputsMountMode(raw("2.9939.4"))).toBe("rw");
    expect(baselineOutputsMountMode(raw("1.11847.5"))).toBe("rw");
  });

  it("fails closed: no outputs mount, or any mode other than exactly rwd, reads as rw", () => {
    const b = raw("2.19675.0");
    const without = { ...b, mountLayout: { ...b.mountLayout, mounts: b.mountLayout.mounts.filter((m) => m.name !== "outputs") } };
    expect(baselineOutputsMountMode(without)).toBe("rw");
    const ro = { ...b, mountLayout: { ...b.mountLayout, mounts: [{ name: "outputs", mountPath: "outputs", mode: "r" as const }] } };
    expect(baselineOutputsMountMode(ro)).toBe("rw");
  });

  it("the remote lane stamps nothing: the Desktop mount builders are not evidence for the cloud lane", () => {
    const b = raw("2.19675.0");
    expect(stampedOutputsMountMode(b, "remote")).toBeUndefined();
    expect(stampedOutputsMountMode(b, "local")).toBe("rwd");
    expect(stampedOutputsMountMode(b, undefined)).toBe("rwd");
    expect(stampedOutputsMountMode(raw("2.9939.4"), undefined)).toBe("rw");
  });
});

// SOURCE PIN, not a producer test: `executeScenario` is reachable only with a spawned agent. This binds both live
// assembly paths (the normal result and the unanswered-gate salvage) to the stamped value; the live suite
// (test/live-outputs-delete.test.ts) asserts the persisted field end to end. A broken stamp fails RED (absent
// means rw), never green.
describe("wiring (source pin)", () => {
  const src = readFileSync(resolve("src/run/execute.ts"), "utf8");
  it("execute.ts computes the mode once from the baseline object and the scenario lane", () => {
    expect(src).toMatch(/const outputsMountMode = stampedOutputsMountMode\(baseline, scenario\.lane\);/);
  });
  it("both live result paths carry it", () => {
    expect(src).toMatch(/buildPartialResult\(\{[\s\S]{0,400}outputsMountMode,/);
    expect(src.match(/^\s+outputsMountMode,\s*(\/\/.*)?$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/outputsMountMode: args\.outputsMountMode,/);
  });
});
