import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { captureAuthoredFilesWithHealth, authoredTotalBytes, parseAuthoredTotalBytes } from "../src/run/artifacts";
import {
  runSemanticJudges,
  evaluate,
  buildJudgedDocument,
  composeJudgedDocument,
  type AssertContext,
  type SemanticJudge,
} from "../src/assert";
import { Scenario, type Assertion } from "../src/types";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

/** A judge that records the document it was handed and passes every claim. The recorded document is the
 *  oracle for "what evidence actually reached the model" — asserting only on the verdict would let a
 *  16 KiB slice of an 87 KB report read as success. */
function recordingJudge(): SemanticJudge & { seen: string[] } {
  const seen: string[] = [];
  const j = (async (rubric: string[], answer: string) => {
    seen.push(answer);
    return rubric.map((claim, index) => ({ index, claim, pass: true }));
  }) as SemanticJudge & { seen: string[] };
  j.seen = seen;
  j.model = "test-judge";
  return j;
}

async function judgeAndEvaluate(assertions: Assertion[], ctx: AssertContext, judge: SemanticJudge) {
  await runSemanticJudges(assertions, ctx, judge);
  return evaluate(assertions, ctx);
}

describe("semantic_matches.evidence_files — scoping the judge's authored-file evidence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cwh-evscope-"));
    mkdirSync(join(root, "outputs", "_work"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
  });

  /** The originating consumer shape: a pipeline whose intermediates dwarf its deliverable. `_work/` sorts
   *  before `report.md` (`_` 0x5F < `r` 0x72) and the walk recurses in place, so the budget is spent
   *  before the deliverable is ever reached. */
  const REPORT_HEAD = "ACTOR: Acme Holdings\n";
  const REPORT_TAIL = "\n*Risk — the counterparty is unrated.\n";
  function stageOriginatingRun(): void {
    writeFileSync(join(root, "outputs", "_work", "relations.json"), "r".repeat(197_910));
    writeFileSync(join(root, "outputs", "_work", "joinable.json"), "j".repeat(90_512));
    writeFileSync(join(root, "outputs", "report.md"), REPORT_HEAD + "b".repeat(80_000) + REPORT_TAIL);
    for (let i = 0; i < 60; i++) writeFileSync(join(root, "outputs", `f${String(i).padStart(2, "0")}.json`), "s".repeat(9_500));
  }
  const capture = (opts: Parameters<typeof captureAuthoredFilesWithHealth>[4] = {}) =>
    captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, opts);

  function ctxFrom(cap: ReturnType<typeof captureAuthoredFilesWithHealth>): AssertContext {
    return {
      transcript: "",
      finalMessage: "done",
      workRoot: root,
      userVisiblePrefixes: ["outputs"],
      authoredFiles: cap.files,
      authoredFilesHealth: cap.health.omittedPaths.length || cap.health.readErrors.length ? cap.health : undefined,
    } as unknown as AssertContext;
  }

  it("BEFORE: the unscoped default refuses — budget spent on files no rubric mentions", async () => {
    stageOriginatingRun();
    const cap = capture();
    expect(cap.health.omittedPaths.length).toBeGreaterThan(0);
    expect(cap.files.find((f) => f.path === "outputs/report.md")).toBeUndefined(); // never reached
    const a: Assertion[] = [{ semantic_matches: { rubric: ["names the actor"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), recordingJudge());
    expect(res[0].pass).toBe(false);
    expect(res[0].message).toMatch(/evidence unavailable/);
    // UNSCOPED gets its own reason: the fix here is "add a scope", not "fix your glob".
    expect(res[0].semanticEvidence?.reason).toBe("evidence_incomplete");
  });

  it("AFTER: a scope + a raised budget puts the WHOLE deliverable in front of the judge", async () => {
    stageOriginatingRun();
    const cap = capture({ priorityGlobs: ["outputs/report.md"], totalBytes: 262_144 });
    const report = cap.files.find((f) => f.path === "outputs/report.md");
    expect(report).toBeDefined();
    expect(report!.truncated).toBeUndefined();
    // The oracle is the TAIL, not the path: a per-file-capped capture would still satisfy "report.md is
    // in files" while handing the judge 16 KiB of an 87 KB report.
    expect(report!.content).toContain(REPORT_TAIL.trim());

    const judge = recordingJudge();
    const a: Assertion[] = [
      { semantic_matches: { rubric: ["names the actor", "carries a risk line"], evidence_files: ["outputs/report.md"] } },
    ] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), judge);
    expect(res[0].pass).toBe(true);
    expect(judge.seen[0]).toContain(REPORT_TAIL.trim()); // the tail really reached the model
    expect(judge.seen[0]).not.toContain("relations.json"); // out-of-scope evidence is not graded
    expect(res[0].semanticEvidence).toEqual({ reason: "graded", paths: ["outputs/report.md"] });
    expect(res[0].evidence).toContain("outputs/report.md"); // a scoped green says WHAT it graded
  });

  it("in-scope files are exempt from the per-file cap; out-of-scope files are not", () => {
    writeFileSync(join(root, "outputs", "report.md"), "d".repeat(50_000));
    writeFileSync(join(root, "outputs", "other.md"), "o".repeat(50_000));
    const cap = capture({ priorityGlobs: ["outputs/report.md"], perFileBytes: 16 * 1024, totalBytes: 100_000 });
    expect(cap.files.find((f) => f.path === "outputs/report.md")!.content.length).toBe(50_000);
    expect(cap.files.find((f) => f.path === "outputs/other.md")!.content.length).toBe(16 * 1024);
  });

  it("an in-scope file too big for the TOTAL budget is truncated and REFUSES (never a partial grade)", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "d".repeat(200_000));
    const cap = capture({ priorityGlobs: ["outputs/report.md"], totalBytes: 64 * 1024 });
    expect(cap.files[0].truncated).toBe(true);
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), recordingJudge());
    expect(res[0].pass).toBe(false);
    expect(res[0].semanticEvidence?.reason).toBe("in_scope_truncated");
    expect(res[0].message).toMatch(/TRUNCATED/);
  });

  it("a scope matching NOTHING refuses, and the message lists the paths the run authored", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "body");
    const cap = capture();
    // The exact mistake the docs cannot prevent: a bare filename, when keys are `<root>/<rel>`.
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), recordingJudge());
    expect(res[0].pass).toBe(false);
    expect(res[0].semanticEvidence?.reason).toBe("scope_matched_nothing");
    // Printing the LIST is the whole point — a bare "matched nothing" is the failure mode, not the fix.
    expect(res[0].message).toContain("outputs/report.md");
    expect(res[0].semanticEvidence?.paths).toEqual(["outputs/report.md"]);
  });

  it("a scope naming an OMITTED file refuses as omitted, not as a typo", async () => {
    // Explicit small caps, so the arithmetic is legible: `aaa.json` takes min(perFile, total) = the whole
    // budget, and `report.md` (sorting after it) is then dropped at the `used >= total` gate.
    writeFileSync(join(root, "outputs", "aaa.json"), "a".repeat(5_000));
    writeFileSync(join(root, "outputs", "report.md"), "body");
    const cap = capture({ perFileBytes: 1_000, totalBytes: 1_000 }); // no priority: report.md is dropped
    expect(cap.health.omittedPaths).toContain("outputs/report.md");
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), recordingJudge());
    expect(res[0].pass).toBe(false);
    // NOT scope_matched_nothing — the glob matched a real path the run tried to author.
    expect(res[0].semanticEvidence?.reason).toBe("in_scope_omitted");
    expect(res[0].semanticEvidence?.paths).toEqual(["outputs/report.md"]);
  });

  it("an OUT-of-scope omission no longer refuses, but the judge is still told about it", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "the body");
    // Budget 600 with a 500 per-file cap: the prioritised report takes 8 (exempt), z1 takes 500, z2 takes
    // the remaining 92, and z3 is dropped outright — an omission that has nothing to do with the rubric.
    for (const n of ["z1", "z2", "z3"]) writeFileSync(join(root, "outputs", `${n}.json`), "z".repeat(5_000));
    const cap = capture({ priorityGlobs: ["outputs/report.md"], perFileBytes: 500, totalBytes: 600 });
    expect(cap.health.omittedPaths).toContain("outputs/z3.json");
    const judge = recordingJudge();
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), judge);
    expect(res[0].pass).toBe(true);
    // Narrowing what is GRADED must not narrow what the judge is TOLD about the capture.
    expect(judge.seen[0]).toContain("Evidence health (INCOMPLETE)");
    expect(judge.seen[0]).toContain("outputs/z3.json");
  });

  it("two asserts with different scopes get DIFFERENT documents (the doc cache is keyed on the scope)", async () => {
    writeFileSync(join(root, "outputs", "alpha.md"), "ALPHA-ONLY-MARKER");
    writeFileSync(join(root, "outputs", "beta.md"), "BETA-ONLY-MARKER");
    const cap = capture();
    const judge = recordingJudge();
    const a: Assertion[] = [
      { semantic_matches: { rubric: ["x"], evidence_files: ["outputs/alpha.md"] } },
      { semantic_matches: { rubric: ["x"], evidence_files: ["outputs/beta.md"] } },
    ] as Assertion[];
    await judgeAndEvaluate(a, ctxFrom(cap), judge);
    expect(judge.seen).toHaveLength(2);
    expect(judge.seen[0]).toContain("ALPHA-ONLY-MARKER");
    expect(judge.seen[0]).not.toContain("BETA-ONLY-MARKER");
    expect(judge.seen[1]).toContain("BETA-ONLY-MARKER");
    expect(judge.seen[1]).not.toContain("ALPHA-ONLY-MARKER");
  });

  it("refuses when the aggregate judge-document cap cut into the authored evidence", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "d".repeat(300_000));
    const cap = capture({ priorityGlobs: ["outputs/report.md"], totalBytes: 400_000 });
    expect(cap.files[0].truncated).toBeUndefined(); // capture is complete…
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), recordingJudge());
    // …but the composed document overflows JUDGE_DOC_CAP, so the evidence was silently cut at compose time.
    expect(res[0].pass).toBe(false);
    expect(res[0].semanticEvidence?.reason).toBe("authored_evidence_truncated");
  });

  it("a scoped rubric that genuinely fails still fails (the narrowed refusal is not a blanket pass)", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "body");
    const cap = capture();
    const failing: SemanticJudge = async (rubric) => rubric.map((claim, index) => ({ index, claim, pass: false }));
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), failing);
    expect(res[0].pass).toBe(false);
    expect(res[0].message).toMatch(/rubric claims passed/);
  });

  it("scratchpad deliverables are prioritisable (they are in the same ordered candidate list)", () => {
    const session = mkdtempSync(join(tmpdir(), "cwh-sess-"));
    mkdirSync(join(session, "mnt", "outputs"), { recursive: true });
    // perFile 400 / total 800: the two workspace files consume the whole budget in candidate order, so the
    // scratchpad file — walked LAST — is omitted unless it is prioritised. Without the small explicit caps
    // this test cannot fail: at the 16 KiB per-file default no pair of files can exhaust 64 KiB.
    writeFileSync(join(session, "mnt", "outputs", "a.json"), "a".repeat(5_000));
    writeFileSync(join(session, "mnt", "outputs", "b.json"), "b".repeat(5_000));
    writeFileSync(join(session, "deliverable.md"), "SCRATCH-DELIVERABLE");
    const caps = { scratchpadRoot: session, perFileBytes: 400, totalBytes: 800 };
    const without = captureAuthoredFilesWithHealth(join(session, "mnt"), ["outputs"], [], {}, caps);
    expect(without.health.omittedPaths).toContain("scratchpad/deliverable.md"); // starved by walk order
    const withPrio = captureAuthoredFilesWithHealth(
      join(session, "mnt"),
      ["outputs"],
      [],
      {},
      {
        ...caps,
        priorityGlobs: ["scratchpad/deliverable.md"],
      },
    );
    expect(withPrio.files.find((f) => f.path === "scratchpad/deliverable.md")?.content).toBe("SCRATCH-DELIVERABLE");
    rmSync(session, { recursive: true, force: true });
  });

  it("priority ordering does not change WHICH files are authored, only the order budget is spent", () => {
    stageOriginatingRun();
    const plain = capture({ totalBytes: 64 * 1024 });
    const prio = capture({ priorityGlobs: ["outputs/report.md"], totalBytes: 64 * 1024 });
    const union = (c: ReturnType<typeof captureAuthoredFilesWithHealth>) =>
      [...new Set([...c.files.map((f) => f.path), ...c.health.omittedPaths, ...c.health.readErrors.map((e) => e.path)])].sort();
    expect(union(prio)).toEqual(union(plain)); // same candidate set — no_lost_write_back's selector is safe
    expect(prio.files.map((f) => f.path)).not.toEqual(plain.files.map((f) => f.path)); // but a different slice fits
    // omittedPaths must be sorted regardless of WHICH PASS dropped a file. The fixture has to make pass 1
    // drop a late-alphabetical path before pass 2 drops an early one — otherwise the list is incidentally
    // sorted already and deleting the `.sort()` cannot be detected.
    writeFileSync(join(root, "outputs", "a-plain.md"), "a".repeat(5_000));
    writeFileSync(join(root, "outputs", "y-prio.md"), "y".repeat(5_000));
    writeFileSync(join(root, "outputs", "z-prio.md"), "z".repeat(5_000));
    const mixed = capture({ priorityGlobs: ["outputs/y-prio.md", "outputs/z-prio.md"], perFileBytes: 1_000, totalBytes: 1_000 });
    // pass 1 exhausts the budget on y-prio and drops z-prio; pass 2 then drops a-plain — insertion order
    // is [z-prio, a-plain], which is NOT sorted.
    expect(mixed.health.omittedPaths).toContain("outputs/z-prio.md");
    expect(mixed.health.omittedPaths).toContain("outputs/a-plain.md");
    expect(mixed.health.omittedPaths).toEqual([...mixed.health.omittedPaths].sort());
  });

  it("hashUnknownPaths is not double-counted by the two-pass capture", () => {
    // Reaching the branch takes a PRIOR hash whose POST-run hash cannot be produced. Two earlier versions
    // of this test asserted the dedupe invariant on a fixture with an EMPTY preRunHashes map, where the
    // branch is never entered and the assertion is `0 === 0` — it would have passed with the double-push
    // present. The `toBeGreaterThan(0)` below is what stops that happening a third time.
    const f = join(root, "outputs", "report.md");
    writeFileSync(f, "x".repeat(2_000));
    chmodSync(f, 0o000);
    // Capability probe: as root (some CI images) the chmod does not deny the read, and the branch would go
    // unreached — skip loudly rather than let the invariant pass vacuously again.
    let unreadable = false;
    try {
      readFileSync(f);
    } catch {
      unreadable = true;
    }
    if (!unreadable) {
      chmodSync(f, 0o644);
      return; // cannot construct the state on this host
    }
    const cap = captureAuthoredFilesWithHealth(
      root,
      ["outputs"],
      [],
      { "outputs/report.md": sha("a different body") },
      {
        priorityGlobs: ["outputs/report.md"],
      },
    );
    chmodSync(f, 0o644); // restore before the fixture teardown
    // prior hash present + post-run hash unavailable => authorship UNKNOWN => the branch under test.
    expect(cap.health.hashUnknownPaths.length).toBeGreaterThan(0);
    expect(cap.health.hashUnknownPaths).toEqual([...new Set(cap.health.hashUnknownPaths)]);
  });

  // ---- regressions found by adversarial review of the first implementation ----

  it("F1: an UNSCOPED assert whose evidence the DOC cap cut refuses — the raise-the-budget remedy is not a hole", async () => {
    // Reachable by doing exactly what the unscoped refusal message advises: raise the capture budget.
    // The capture then reports clean (nothing omitted, nothing truncated) while the composed document
    // overflows JUDGE_DOC_CAP and the tail files never reach the judge. The first implementation gated
    // this refusal on `scoped` and passed here — stamping reason "graded" over evidence never shown.
    for (let i = 0; i < 30; i++)
      writeFileSync(join(root, "outputs", `f${String(i).padStart(2, "0")}.md`), `MARK${i}\n` + "x".repeat(10_000));
    const cap = capture({ totalBytes: 400_000 });
    expect(cap.health.omittedPaths).toEqual([]);
    expect(cap.files.some((f) => f.truncated)).toBe(false); // capture looks perfectly healthy
    const judge = recordingJudge();
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), judge);
    expect(judge.seen[0]).not.toContain("MARK29"); // the tail really was cut
    expect(res[0].pass).toBe(false);
    expect(res[0].semanticEvidence?.reason).toBe("authored_evidence_truncated");
    // The remedy must be one that can actually clear this. "add" (not "narrow") because an unscoped
    // assert has no evidence_files key yet; and LOWERING the capture budget can never help — it only
    // moves the evidence loss to the capture, landing in a different refusal branch.
    expect(res[0].message).toContain("add semantic_matches.evidence_files");
    expect(res[0].message).toMatch(/Lowering \$COWORK_HARNESS_AUTHORED_TOTAL_BYTES will NOT help/);
  });

  it("F2: a cut that lands ONLY in the trailing health note is not an evidence cut", async () => {
    // Every in-scope byte reached the judge; only the note about out-of-scope omissions was clipped.
    // Refusing here (as `doc.length > cap` did) is a false fail whose message states a falsehood.
    const size = 262_000;
    writeFileSync(join(root, "outputs", "report.md"), "BODYSTART" + "r".repeat(size) + "BODYEND");
    for (const n of ["z1", "z2", "z3"]) writeFileSync(join(root, "outputs", `${n}.json`), "z".repeat(5_000));
    const cap = capture({ priorityGlobs: ["outputs/report.md"], perFileBytes: 100, totalBytes: size + 150 });
    expect(cap.health.omittedPaths.length).toBeGreaterThan(0); // health note exists → doc overflows
    expect(cap.files.find((f) => f.path === "outputs/report.md")!.truncated).toBeUndefined();
    const judge = recordingJudge();
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), judge);
    expect(judge.seen[0]).toContain("BODYEND"); // graded evidence intact…
    expect(res[0].pass).toBe(true); // …so the verdict stands
  });

  it("F3: an overflow driven by SUB-AGENT text names that section, not the file scope", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "short body");
    const cap = capture({ priorityGlobs: ["outputs/report.md"] });
    const ctx = {
      ...ctxFrom(cap),
      subagents: Array.from({ length: 30 }, (_, i) => ({
        description: `sa${i}`,
        reasoning: [{ kind: "text", text: "s".repeat(20_000) }],
      })),
    } as unknown as AssertContext;
    const a: Assertion[] = [
      { semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"], include_subagent_text: true } },
    ] as Assertion[];
    const res = await judgeAndEvaluate(a, ctx, recordingJudge());
    expect(res[0].pass).toBe(false);
    expect(res[0].message).toContain("Sub-agent output"); // names the real cause…
    expect(res[0].message).toContain("include_subagent_text: false"); // …and a lever that can move it
  });

  it("F5: with no judge grade, the reason is 'judge not run' — not a bogus glob complaint", async () => {
    // verify-run populates authoredFiles only when no_lost_write_back is asserted, so the authored set can
    // be empty on a lane that never captured it. Reporting scope_matched_nothing there sends an author to
    // fix a glob that is already correct.
    const ctx = { transcript: "", finalMessage: "f", userVisiblePrefixes: ["outputs"] } as unknown as AssertContext;
    const res = evaluate([{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[], ctx);
    expect(res[0].pass).toBe(false);
    expect(res[0].message).toMatch(/semantic judge not run/);
    expect(res[0].semanticEvidence).toBeUndefined();
  });

  it("F7: an in-scope file truncated AND a sibling omitted are reported together", async () => {
    writeFileSync(join(root, "outputs", "a-big.md"), "d".repeat(200_000));
    writeFileSync(join(root, "outputs", "b-small.md"), "s".repeat(100));
    const cap = capture({ priorityGlobs: ["outputs/*.md"], totalBytes: 64 * 1024 });
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/*.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), recordingJudge());
    expect(res[0].pass).toBe(false);
    // The 200 KB file that ATE the budget must appear, not just the 100-byte casualty it starved.
    expect(res[0].message).toContain("outputs/a-big.md");
    expect(res[0].message).toContain("outputs/b-small.md");
    expect(res[0].semanticEvidence?.paths).toEqual(["outputs/a-big.md", "outputs/b-small.md"]);
  });

  it("a scoped substantive FAIL still records what the judge was shown", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "body");
    const cap = capture();
    const failing: SemanticJudge = async (rubric) => rubric.map((claim, index) => ({ index, claim, pass: false }));
    const a: Assertion[] = [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const res = await judgeAndEvaluate(a, ctxFrom(cap), failing);
    expect(res[0].pass).toBe(false);
    // A red is only actionable next to the evidence set — the guarded bug is a false ABSENCE.
    expect(res[0].semanticEvidence).toEqual({ reason: "graded", paths: ["outputs/report.md"] });
  });

  it("F4: ANY multi-assert scenario carrying a scope warns — including two SCOPED asserts", () => {
    writeFileSync(join(root, "outputs", "report.md"), "body");
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errs.push(String(c));
      return true;
    }) as never);
    evaluate(
      [
        { semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } },
        { semantic_matches: { rubric: ["y"] } },
      ] as Assertion[],
      ctxFrom(capture()),
    );
    spy.mockRestore();
    expect(errs.join("")).toMatch(/2 semantic_matches asserts \(1 scoped\) sharing ONE authored-file/);

    // The case a `scoped < total` condition misses, and it is the WORSE one: with both files exempt from
    // the per-file cap the starvation is larger, yet nothing warned.
    const errs2: string[] = [];
    const spy2 = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errs2.push(String(c));
      return true;
    }) as never);
    evaluate(
      [
        { semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } },
        { semantic_matches: { rubric: ["y"], evidence_files: ["outputs/other.md"] } },
      ] as Assertion[],
      ctxFrom(capture()),
    );
    spy2.mockRestore();
    expect(errs2.join("")).toMatch(/2 semantic_matches asserts \(2 scoped\)/);
  });
});

describe("composeJudgedDocument — overflow bookkeeping with NO authored evidence", () => {
  // Both guards below are load-bearing and neither is observable from a verdict, so they are asserted on
  // the composer directly. Shape: a document that overflows purely on sub-agent text, with zero authored
  // files and a clean capture (hence no evidence-health note).
  const ctx = {
    transcript: "",
    finalMessage: "f",
    userVisiblePrefixes: ["outputs"],
    authoredFiles: [],
    subagents: Array.from({ length: 30 }, (_, i) => ({
      description: `sa${i}`,
      reasoning: [{ kind: "text", text: "s".repeat(20_000) }],
    })),
  } as unknown as AssertContext;

  it("does not report an evidence cut when there was no authored evidence to cut", () => {
    const built = composeJudgedDocument(ctx, true);
    expect(built.doc.length).toBeGreaterThan(0);
    // The document DID overflow — but refusing "your authored evidence was cut" here would be a failure
    // with no possible remedy, since the run authored nothing.
    expect(built.evidenceCut).toBe(false);
  });

  it("does not claim the evidence-health note was trimmed when no note was composed", () => {
    const built = composeJudgedDocument(ctx, true);
    expect(built.doc).not.toContain("Evidence health");
    expect(built.healthNoteCut).toBe(false);
  });
});

describe("evidence_files — schema and budget validator", () => {
  const base = { prompt: "p", assert: [] as unknown[] };

  it("rejects an EMPTY evidence_files list at load time (a scope of nothing is not a scope)", () => {
    const r = Scenario.safeParse({
      ...base,
      assert: [{ semantic_matches: { rubric: ["x"], evidence_files: [] } }],
    });
    expect(r.success).toBe(false);
  });

  it("accepts a well-formed scope", () => {
    const r = Scenario.safeParse({
      ...base,
      assert: [{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } }],
    });
    expect(r.success).toBe(true);
  });

  it("env and validator agree, and a malformed budget THROWS rather than silently defaulting", () => {
    delete process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
    expect(authoredTotalBytes()).toBe(64 * 1024);
    process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES = "262144";
    expect(authoredTotalBytes()).toBe(parseAuthoredTotalBytes("262144"));
    expect(authoredTotalBytes()).toBe(262_144);
    for (const bad of ["0", "-5", "abc"]) {
      process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES = bad;
      expect(parseAuthoredTotalBytes(bad)).toBeNull();
      expect(() => authoredTotalBytes()).toThrow(/must be a positive integer/);
    }
    delete process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
  });
});

describe("buildJudgedDocument — scoping is opt-in", () => {
  it("an absent scope is byte-identical to the pre-change document", () => {
    const ctx = {
      transcript: "t",
      finalMessage: "f",
      userVisiblePrefixes: ["outputs"],
      authoredFiles: [
        { path: "outputs/a.md", content: "AAA" },
        { path: "outputs/b.md", content: "BBB" },
      ],
    } as unknown as AssertContext;
    const doc = buildJudgedDocument(ctx, false);
    expect(doc).toContain("AAA");
    expect(doc).toContain("BBB");
    expect(buildJudgedDocument(ctx, false, undefined)).toBe(doc);
    expect(buildJudgedDocument(ctx, false, ["outputs/a.md"])).not.toContain("BBB");
  });
});

// The regex-habit warning fires on a path glob, not only on tool-name keys.
describe("evidence_files — authoring warnings", () => {
  it("warns when a scope glob looks like a regex", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
      errs.push(String(c));
      return true;
    }) as never);
    const ctx = {
      transcript: "",
      finalMessage: "f",
      userVisiblePrefixes: ["outputs"],
      authoredFiles: [{ path: "outputs/report.md", content: "x" }],
    } as unknown as AssertContext;
    evaluate([{ semantic_matches: { rubric: ["x"], evidence_files: ["outputs/.*\\.md"] } }] as Assertion[], ctx);
    spy.mockRestore();
    expect(errs.join("")).toMatch(/looks like a regex/);
  });
});
