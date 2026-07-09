import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { captureAuthoredFiles } from "../src/run/artifacts";
import { runSemanticJudges, evaluate, type AssertContext, type SemanticJudge } from "../src/assert";
import type { Assertion } from "../src/types";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

describe("captureAuthoredFiles — the judge's authored-artifact evidence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cwh-authored-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    mkdirSync(join(root, "proj"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("captures new + modified files under user-visible roots, skips unchanged mounts", () => {
    writeFileSync(join(root, "outputs", "report.yaml"), "on_unanswered: fail\nfidelity: container\n"); // new
    writeFileSync(join(root, "proj", "notes.md"), "edited body"); // modified vs pre-run
    writeFileSync(join(root, "proj", "unchanged.md"), "same"); // unchanged → skip
    const preRun = { "proj/notes.md": sha("old body"), "proj/unchanged.md": sha("same") };
    const got = captureAuthoredFiles(root, ["outputs", "proj"], [], preRun);
    const paths = got.map((f) => f.path).sort();
    expect(paths).toEqual(["outputs/report.yaml", "proj/notes.md"]);
    expect(got.find((f) => f.path === "outputs/report.yaml")!.content).toContain("on_unanswered: fail");
    expect(paths).not.toContain("proj/unchanged.md");
  });

  it("excludes read-only inputs and returns [] with no pre-run manifest (microvm)", () => {
    writeFileSync(join(root, "proj", "input.txt"), "readonly");
    // proj is a readonly folder root → class 'input' → excluded even though it looks 'new'
    expect(captureAuthoredFiles(root, ["proj"], ["proj"], {})).toEqual([]);
    // no manifest at all → no diff possible → no capture
    expect(captureAuthoredFiles(root, ["outputs", "proj"], [], undefined)).toEqual([]);
  });

  it("truncates over-cap content and flags it", () => {
    writeFileSync(join(root, "outputs", "big.txt"), "x".repeat(1000));
    const got = captureAuthoredFiles(root, ["outputs"], [], {}, { perFileBytes: 100, totalBytes: 500 });
    expect(got[0].truncated).toBe(true);
    expect(got[0].content.length).toBe(100);
  });

  it("F12: captures cwd-relative scratchpad deliverables outside mnt, skips dotfiles + the mnt subtree", () => {
    // Simulate a container session tree: session root (scratchpad) with an `mnt` workspace inside it.
    const sessionRoot = mkdtempSync(join(tmpdir(), "cwh-sess-"));
    const mnt = join(sessionRoot, "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    // captured via mnt/userVisibleRoots (the existing path):
    writeFileSync(join(mnt, "outputs", "in-mnt.yaml"), "fidelity: container");
    // a cwd-relative write that landed in the scratchpad (the F12 coin-flip) — MUST be captured:
    mkdirSync(join(sessionRoot, "outputs"), { recursive: true });
    writeFileSync(join(sessionRoot, "outputs", "scenario.yaml"), "on_unanswered: fail");
    writeFileSync(join(sessionRoot, "loose.md"), "a bare relative write");
    // $HOME runtime noise → excluded:
    mkdirSync(join(sessionRoot, ".claude"), { recursive: true });
    writeFileSync(join(sessionRoot, ".claude", "state.json"), "{}");
    const got = captureAuthoredFiles(mnt, ["outputs"], [], {}, { scratchpadRoot: sessionRoot });
    const paths = got.map((f) => f.path).sort();
    expect(paths).toContain("outputs/in-mnt.yaml"); // mnt path (unprefixed)
    expect(paths).toContain("scratchpad/outputs/scenario.yaml"); // the recovered coin-flip deliverable
    expect(paths).toContain("scratchpad/loose.md");
    expect(paths.some((p) => p.includes(".claude"))).toBe(false); // dotfile runtime state excluded
    expect(paths.some((p) => p.startsWith("scratchpad/mnt"))).toBe(false); // mnt not double-walked
    rmSync(sessionRoot, { recursive: true, force: true });
  });
});

const sem = (rubric: string[]): Assertion => ({ semantic_matches: { rubric } });
function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/x",
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

describe("runSemanticJudges — never-drop + authored-file grading", () => {
  it("grades the authored file content, not only the inline prose (presentation-stable)", async () => {
    const judge: SemanticJudge = async (rubric, answer) => rubric.map((claim, index) => ({ index, claim, pass: answer.includes(claim) }));
    const a = sem(["on_unanswered: fail"]);
    // The claim text appears ONLY in the authored file, not the (empty) transcript/finalMessage.
    const c = ctx({ authoredFiles: [{ path: "outputs/x.yaml", content: "on_unanswered: fail" }] });
    await runSemanticJudges([a], c, judge);
    expect(evaluate([a], c)[0].pass).toBe(true);
  });

  it("marks a rep INVALID (not a silent drop) when the judge throws after a retry", async () => {
    const judge: SemanticJudge = async () => {
      throw new Error("malformed");
    };
    const a = sem(["x"]);
    const c = ctx({ transcript: "x" });
    await runSemanticJudges([a], c, judge);
    expect(c.judgeInvalid?.has(a)).toBe(true);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(false);
    expect((r as { judgeInvalid?: boolean }).judgeInvalid).toBe(true);
    expect(r.message).toMatch(/INVALID/);
  });

  it("retries once and succeeds on a transient judge error", async () => {
    let calls = 0;
    const judge: SemanticJudge = async (rubric) => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return rubric.map((claim, index) => ({ index, claim, pass: true }));
    };
    const a = sem(["x"]);
    const c = ctx({ transcript: "x" });
    await runSemanticJudges([a], c, judge);
    expect(calls).toBe(2);
    expect(c.judgeInvalid?.has(a)).toBe(false);
    expect(evaluate([a], c)[0].pass).toBe(true);
  });
});
