import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureAuthoredFilesWithHealth, type CaptureAuthoredFilesOpts } from "../src/run/artifacts";
import { runSemanticJudges, evaluate, type AssertContext, type SemanticJudge } from "../src/assert";
import type { Assertion } from "../src/types";

// A semantic_matches assert whose evidence is unavailable refuses its verdict whatever the judge says, so the
// judge is not called for it: no spend, and no per-claim grades beside a refusal for a consumer (an eval row)
// to read as graded. The verdict and message must be exactly what they were when the judge WAS called.
//
// Oracle: the messages and typed reasons below were produced by the build of the commit BEFORE this change
// (the judge was called for every one of these), from these same fixtures — not derived from the code under
// test. The budget figures in them are the defaults, so the budget env var is cleared for every case.
const BEFORE: Record<string, { message: string; semanticEvidence: { reason: string; paths?: string[] } }> = {
  evidence_incomplete: {
    message:
      'evidence unavailable: the authored evidence the judge would grade is incomplete — 7 dropped at the capture budget (outputs/f3.md, outputs/f4.md, outputs/f5.md, outputs/f6.md, outputs/f7.md, outputs/f8.md, outputs/f9.md); 3 kept only as a TRUNCATED prefix (outputs/f0.md, outputs/f1.md, outputs/f2.md). A partial deliverable grades as a partial document, so a "claim not satisfied" could be an artefact of the cut. To grade it: raise $COWORK_HARNESS_AUTHORED_TOTAL_BYTES (currently 65536 bytes); or scope this assert with semantic_matches.evidence_files: ["<the deliverable>"], which exempts it from the 16384-byte per-file cap (raising the total alone will NOT lift that cap)',
    semanticEvidence: {
      reason: "evidence_incomplete",
      paths: [
        "outputs/f0.md",
        "outputs/f1.md",
        "outputs/f2.md",
        "outputs/f3.md",
        "outputs/f4.md",
        "outputs/f5.md",
        "outputs/f6.md",
        "outputs/f7.md",
        "outputs/f8.md",
        "outputs/f9.md",
      ],
    },
  },
  in_scope_truncated: {
    message:
      'evidence unavailable: the in-scope authored evidence the judge would grade is incomplete — 1 kept only as a TRUNCATED prefix (outputs/report.md). A partial deliverable grades as a partial document, so a "claim not satisfied" could be an artefact of the cut. To grade it: raise $COWORK_HARNESS_AUTHORED_TOTAL_BYTES (currently 65536 bytes) — an in-scope file is already exempt from the per-file cap, so it is the TOTAL that did not fit. Keep the composed document under 262144 chars or it is cut at the other end',
    semanticEvidence: {
      reason: "in_scope_truncated",
      paths: ["outputs/report.md"],
    },
  },
  in_scope_omitted: {
    message:
      'evidence unavailable: the in-scope authored evidence the judge would grade is incomplete — 1 dropped at the capture budget (outputs/report.md). A partial deliverable grades as a partial document, so a "claim not satisfied" could be an artefact of the cut. To grade it: raise $COWORK_HARNESS_AUTHORED_TOTAL_BYTES (currently 65536 bytes). Keep the composed document under 262144 chars or it is cut at the other end',
    semanticEvidence: {
      reason: "in_scope_omitted",
      paths: ["outputs/report.md"],
    },
  },
  scope_matched_nothing: {
    message:
      'evidence unavailable: semantic_matches.evidence_files ["report.md"] matched NONE of the 1 path(s) this run authored — grading would have used zero authored evidence. Paths are <root>/<rel> (not a bare filename) and globs use */?/** (not regex). This run authored: outputs/report.md',
    semanticEvidence: {
      reason: "scope_matched_nothing",
      paths: ["outputs/report.md"],
    },
  },
  no_pre_run_manifest: {
    message:
      "evidence unavailable: no pre-run manifest for this run, so the set of files it AUTHORED could not be computed — the judge would have graded the final message and transcript alone while reporting complete authored evidence. This is a --resume turn (the baseline belongs to the first turn), or the run predates the manifest seam; re-run live without --resume.",
    semanticEvidence: {
      reason: "no_pre_run_manifest",
    },
  },
  authored_evidence_truncated: {
    message:
      'evidence unavailable: the composed judge document exceeded its 262144-char budget and the authored-file evidence was cut (the overflow lands in "Authored file: outputs/report.md") — narrow semantic_matches.evidence_files so only the files the rubric is about reach the judge — but this scope already names a SINGLE file, so it cannot be narrowed further: that deliverable is simply too large to grade whole against a 262144-char judge document, and the rubric needs to target a smaller artifact. (Lowering $COWORK_HARNESS_AUTHORED_TOTAL_BYTES will NOT help — it only drops the evidence at the capture instead.)',
    semanticEvidence: {
      reason: "authored_evidence_truncated",
    },
  },
};

/** A judge that counts its calls, prices each one, and passes every claim. */
function countingJudge(): SemanticJudge & { calls: number } {
  const j = (async (rubric: string[]) => {
    j.calls++;
    return rubric.map((claim, index) => ({ index, claim, pass: true }));
  }) as unknown as SemanticJudge & { calls: number };
  j.calls = 0;
  j.model = "stub-judge";
  j.lastCostUsd = 0.01;
  j.promptHash = "0123456789abcdef";
  return j;
}

type Stage = (root: string) => { opts: CaptureAuthoredFilesOpts; scope?: string[]; noManifest?: boolean };
const CASES: Record<string, Stage> = {
  evidence_incomplete: (r) => {
    for (let i = 0; i < 10; i++) writeFileSync(join(r, "outputs", `f${i}.md`), "x".repeat(5000));
    return { opts: { perFileBytes: 4000, totalBytes: 9000 } };
  },
  in_scope_truncated: (r) => {
    writeFileSync(join(r, "outputs", "report.md"), "d".repeat(200_000));
    return { opts: { priorityGlobs: ["outputs/report.md"], totalBytes: 65_536 }, scope: ["outputs/report.md"] };
  },
  in_scope_omitted: (r) => {
    writeFileSync(join(r, "outputs", "aaa.json"), "a".repeat(5000));
    writeFileSync(join(r, "outputs", "report.md"), "body");
    return { opts: { perFileBytes: 1000, totalBytes: 1000 }, scope: ["outputs/report.md"] };
  },
  scope_matched_nothing: (r) => {
    writeFileSync(join(r, "outputs", "report.md"), "body");
    return { opts: {}, scope: ["report.md"] };
  },
  no_pre_run_manifest: (r) => {
    writeFileSync(join(r, "outputs", "report.md"), "body");
    return { opts: {}, noManifest: true };
  },
  // The one reason decided at COMPOSE time (the aggregate document cap), not from the capture.
  authored_evidence_truncated: (r) => {
    writeFileSync(join(r, "outputs", "report.md"), "d".repeat(300_000));
    return { opts: { priorityGlobs: ["outputs/report.md"], totalBytes: 400_000 }, scope: ["outputs/report.md"] };
  },
  graded_control: (r) => {
    writeFileSync(join(r, "outputs", "report.md"), "body");
    return { opts: {}, scope: ["outputs/report.md"] };
  },
};

describe("semantic_matches: no judge call for an assert whose evidence is unavailable", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cwh-refuse-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    delete process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function staged(name: string): { ctx: AssertContext; a: Assertion[] } {
    const { opts, scope, noManifest } = CASES[name](root);
    const cap = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, opts);
    const ctx = {
      transcript: "",
      finalMessage: "done",
      workRoot: root,
      userVisiblePrefixes: ["outputs"],
      authoredFiles: noManifest ? [] : cap.files,
      authoredFilesHealth: noManifest
        ? { ...cap.health, omittedPaths: [], readErrors: [], noPreRunManifest: true }
        : cap.health.omittedPaths.length || cap.health.readErrors.length
          ? cap.health
          : undefined,
    } as unknown as AssertContext;
    const a = [{ semantic_matches: { rubric: ["c1", "c2"], ...(scope ? { evidence_files: scope } : {}) } }] as Assertion[];
    return { ctx, a };
  }

  for (const name of Object.keys(BEFORE)) {
    it(`${name}: the judge is not called, nothing judge-shaped is recorded, and the verdict is unchanged`, async () => {
      const { ctx, a } = staged(name);
      const judge = countingJudge();
      await runSemanticJudges(a, ctx, judge);
      const [r] = evaluate(a, ctx);
      expect(judge.calls).toBe(0);
      expect(r.semanticClaims).toBeUndefined();
      expect(r.judgeCostUsd).toBeUndefined();
      expect(r.judgeUsage).toBeUndefined();
      expect(r.judgeModel).toBeUndefined();
      expect(r.judgePromptHash).toBeUndefined();
      // No judge received a document, so there is no judged-document fingerprint to claim it matched.
      expect(r.judgedDoc).toBeUndefined();
      expect(r.judgeInvalid).toBeUndefined();
      // Why it was not called is recorded, as the same typed reason the verdict carries.
      expect(ctx.semanticRefused?.get(a[0])?.semanticEvidence).toEqual(BEFORE[name].semanticEvidence);
      expect(r.pass).toBe(false);
      expect(r.message).toBe(BEFORE[name].message);
      expect(r.semanticEvidence).toEqual(BEFORE[name].semanticEvidence);
    });
  }

  it("an assert whose evidence is complete is still graded, with every judge field recorded", async () => {
    const { ctx, a } = staged("graded_control");
    const judge = countingJudge();
    await runSemanticJudges(a, ctx, judge);
    const [r] = evaluate(a, ctx);
    expect(judge.calls).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.semanticClaims).toHaveLength(2);
    expect(r.judgeCostUsd).toBe(0.01);
    expect(r.judgeModel).toBe("stub-judge");
    expect(r.judgePromptHash).toBe("0123456789abcdef");
    expect(r.judgedDoc).toBeDefined();
    expect(r.semanticEvidence).toEqual({ reason: "graded", paths: ["outputs/report.md"] });
    expect(ctx.semanticRefused?.has(a[0])).toBe(false);
  });

  it("only the refused assert is skipped: a sibling with complete evidence is graded in the same pass", async () => {
    writeFileSync(join(root, "outputs", "report.md"), "body");
    const cap = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, {});
    const ctx = {
      transcript: "",
      finalMessage: "done",
      workRoot: root,
      userVisiblePrefixes: ["outputs"],
      authoredFiles: cap.files,
    } as unknown as AssertContext;
    const a = [
      { semantic_matches: { rubric: ["c1"], evidence_files: ["nope/*.md"] } },
      { semantic_matches: { rubric: ["c1"], evidence_files: ["outputs/report.md"] } },
    ] as Assertion[];
    const judge = countingJudge();
    await runSemanticJudges(a, ctx, judge);
    const [refused, graded] = evaluate(a, ctx);
    expect(judge.calls).toBe(1);
    expect(refused.semanticEvidence?.reason).toBe("scope_matched_nothing");
    expect(refused.semanticClaims).toBeUndefined();
    expect(graded.semanticEvidence?.reason).toBe("graded");
    expect(graded.semanticClaims).toHaveLength(1);
  });

  it("with no pre-pass at all (verify-run, replay) the reason is still 'judge not run', not an evidence reason", () => {
    const ctx = { transcript: "", workRoot: root, authoredFiles: [] } as unknown as AssertContext;
    const a = [{ semantic_matches: { rubric: ["c1"], evidence_files: ["outputs/report.md"] } }] as Assertion[];
    const [r] = evaluate(a, ctx);
    expect(r.message).toBe("evidence unavailable: semantic judge not run (semantic_matches is live-only; skipped on replay)");
    expect(r.semanticEvidence).toBeUndefined();
  });
});
