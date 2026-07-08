import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEvals,
  loadSkillPayload,
  loadEvalFiles,
  buildAnswerContext,
  parseJudge,
  aggregate,
  runAll,
  EVALS_DIR,
  type CallModel,
  type JudgeResult,
} from "../scripts/run-evals.js";

describe("loadEvals", () => {
  it("returns 9 evals, each with required non-empty fields", () => {
    const evals = loadEvals();
    expect(evals.length).toBe(9);
    for (const e of evals) {
      expect(typeof e.id).toBe("number");
      expect(e.name.trim()).not.toBe("");
      expect(e.prompt.trim()).not.toBe("");
      expect(e.expected_output.trim()).not.toBe("");
      expect(Array.isArray(e.files)).toBe(true);
    }
  });

  it("throws a clear error on a missing/empty required field", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-evals-test-"));
    const badPath = join(dir, "evals.bad.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        skill_name: "test",
        evals: [{ id: 1, name: "", prompt: "p", expected_output: "e", files: [] }],
      }),
    );
    expect(() => loadEvals(badPath)).toThrow(/missing a non-empty "name"/);
  });

  it("throws a clear error when an eval has no numeric id", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-evals-test-"));
    const badPath = join(dir, "evals.bad-id.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        skill_name: "test",
        evals: [{ name: "n", prompt: "p", expected_output: "e", files: [] }],
      }),
    );
    expect(() => loadEvals(badPath)).toThrow(/numeric "id"/);
  });
});

describe("buildAnswerContext", () => {
  it("includes SKILL.md content and every reference file's content", () => {
    const { skillMd, references } = loadSkillPayload();
    expect(references.length).toBeGreaterThan(0);

    const ctx = buildAnswerContext(skillMd, references, []);

    // A known, stable substring from the skill's frontmatter/name.
    expect(skillMd).toContain("cowork-harness");
    expect(ctx).toContain("=== SKILL.md ===");
    expect(ctx).toContain(skillMd);

    for (const r of references) {
      expect(ctx).toContain(`=== ${r.path} ===`);
      expect(ctx).toContain(r.content);
    }
  });

  it("includes an eval's referenced evals/files/* content when present", () => {
    const evals = loadEvals();
    const withFiles = evals.find((e) => e.files.length > 0);
    expect(withFiles).toBeDefined();

    const files = loadEvalFiles(withFiles!, EVALS_DIR);
    expect(files.length).toBeGreaterThan(0);

    const ctx = buildAnswerContext("skill content", [], files);
    for (const f of files) {
      expect(ctx).toContain(`=== evals/${f.path} ===`);
      expect(ctx).toContain(f.content);
    }
  });
});

describe("parseJudge", () => {
  it("parses a well-formed judge JSON response", () => {
    const raw = JSON.stringify({
      claims: [
        { claim: "does X", pass: true },
        { claim: "does Y", pass: false },
      ],
      notes: "looks fine",
    });
    const result = parseJudge(raw);
    expect(result.claims).toEqual([
      { claim: "does X", pass: true },
      { claim: "does Y", pass: false },
    ]);
    expect(result.notes).toBe("looks fine");
  });

  it("tolerates a stray markdown code fence around the JSON", () => {
    const inner = JSON.stringify({ claims: [{ claim: "a", pass: true }], notes: "" });
    const raw = "```json\n" + inner + "\n```";
    const result = parseJudge(raw);
    expect(result.claims).toEqual([{ claim: "a", pass: true }]);
  });

  it("throws a clear error on malformed (non-JSON) judge output", () => {
    expect(() => parseJudge("this is not JSON at all")).toThrow(/not valid JSON/);
  });

  it("throws a clear error when the claims array is missing", () => {
    expect(() => parseJudge(JSON.stringify({ notes: "no claims field here" }))).toThrow(/missing a "claims" array/);
  });

  it("throws a clear error when a claim entry is malformed", () => {
    const raw = JSON.stringify({ claims: [{ claim: "ok", pass: "yes" }], notes: "" });
    expect(() => parseJudge(raw)).toThrow(/malformed/);
  });
});

describe("aggregate", () => {
  it("turns N reps of judge results into per-claim pass counts", () => {
    const reps: JudgeResult[] = [
      {
        claims: [
          { claim: "A", pass: true },
          { claim: "B", pass: false },
        ],
        notes: "",
      },
      {
        claims: [
          { claim: "A", pass: true },
          { claim: "B", pass: true },
        ],
        notes: "",
      },
      {
        claims: [
          { claim: "A", pass: false },
          { claim: "B", pass: true },
        ],
        notes: "",
      },
    ];
    const agg = aggregate(reps);
    const byClaim = Object.fromEntries(agg.map((c) => [c.claim, c]));
    expect(byClaim.A.passCount).toBe(2);
    expect(byClaim.A.reps).toBe(3);
    expect(byClaim.B.passCount).toBe(2);
    expect(byClaim.B.reps).toBe(3);
  });

  it("handles a claim only seen in some reps (fewer reps than the run's rep count)", () => {
    const reps: JudgeResult[] = [
      { claims: [{ claim: "only-in-rep-1", pass: true }], notes: "" },
      { claims: [], notes: "" },
    ];
    const agg = aggregate(reps);
    expect(agg).toEqual([{ claim: "only-in-rep-1", passCount: 1, reps: 1 }]);
  });
});

describe("end-to-end with a stubbed callModel", () => {
  it("produces a well-formed report without any real model calls", async () => {
    const evals = loadEvals().slice(0, 2); // keep the test fast
    const { skillMd, references } = loadSkillPayload();

    const canned: CallModel = async (model, _system, _user) => {
      if (model === "stub-judge") {
        return JSON.stringify({ claims: [{ claim: "stub claim", pass: true }], notes: "stub" });
      }
      return "stub candidate answer";
    };

    const report = await runAll(evals, skillMd, references, EVALS_DIR, {
      answerModel: "stub-answer",
      judgeModel: "stub-judge",
      reps: 2,
      callModel: canned,
    });

    expect(report.model).toEqual({ answer: "stub-answer", judge: "stub-judge", reps: 2 });
    expect(report.evals.length).toBe(2);

    for (let i = 0; i < report.evals.length; i++) {
      const e = report.evals[i];
      expect(e.id).toBe(evals[i].id);
      expect(e.name).toBe(evals[i].name);
      expect(e.claimsTotal).toBeGreaterThan(0);
      expect(e.claimsPassedAllReps).toBe(e.claimsTotal); // stub always passes, every rep
      for (const c of e.claims) {
        expect(c.reps).toBe(2);
        expect(c.passCount).toBe(2);
      }
    }
  });

  it("propagates a callModel rejection instead of swallowing it", async () => {
    const evals = loadEvals().slice(0, 1);
    const { skillMd, references } = loadSkillPayload();

    const failing: CallModel = async () => {
      throw new Error("boom");
    };

    await expect(
      runAll(evals, skillMd, references, EVALS_DIR, {
        answerModel: "stub-answer",
        judgeModel: "stub-judge",
        reps: 1,
        callModel: failing,
      }),
    ).rejects.toThrow("boom");
  });
});
