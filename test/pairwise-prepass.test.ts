import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import {
  PairwiseJudgeInvalid,
  outcomeValue,
  type PairwiseInput,
  type PairwiseJudge,
  type PairwiseOutcome,
} from "../src/decide/pairwise-judge.js";
import { candidateDocument, pairwiseComposeKey, runPairwiseJudges, type PairwisePrepassOpts } from "../src/run/pairwise-prepass.js";
import { freezeRef } from "../src/refs/store.js";
import type { Assertion } from "../src/types.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pairwise-prepass-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

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
    slashInvokedSkills: [],
    authoredFiles: [],
    authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [] } as never,
    ...over,
  };
}

const SRC = { command: "test", runDir: "~/r", resultSha256: "a".repeat(64), sessionId: "base" };

const TASK = "Summarise X";
const taskSha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");
/** The task identity a reference frozen for `task` records (the prepass hashes the RAW task). */
const META = (task = TASK) => ({ harnessVersion: "t", composerId: "c", scenario: "case_1", taskSha256: taskSha(task) });

/** Freeze the document a run with `finalMessage` would produce, into `store`, for assertion `a`, for `task`. */
function freezeFrom(store: string, a: Assertion, finalMessage: string, task = TASK): void {
  const doc = candidateDocument(ctx({ finalMessage }), a).candidate;
  freezeRef(store, "case_1", SRC, { [pairwiseComposeKey(a)]: doc }, META(task));
}

/** A judge that always returns `outcome`, recording every input it saw. */
function fakeJudge(outcome: PairwiseOutcome | "invalid", seen: PairwiseInput[] = []): (model: string) => PairwiseJudge {
  return (model) => async (input) => {
    seen.push(input);
    if (outcome === "invalid") throw new PairwiseJudgeInvalid("bad", 0.02, undefined, model);
    return {
      outcome,
      value: outcomeValue(outcome),
      order: "candidate_first",
      rationale: "the candidate cites a source.",
      model,
      costUsd: 0.01,
    };
  };
}

function opts(a: Assertion, over: Partial<PairwisePrepassOpts> = {}): PairwisePrepassOpts {
  return {
    caseId: "case_1",
    sessionId: "s1",
    task: TASK,
    refsFor: () => [{ name: "baseline", store: join(tmp, "baseline") }],
    judgeFor: fakeJudge("win"),
    modelFor: () => "claude-judge-1",
    ...over,
  };
}

const assertOf = (o: Partial<NonNullable<Assertion["semantic_pairwise"]>> = {}): Assertion =>
  ({ semantic_pairwise: { rubric: ["cites a source"], ...o } }) as Assertion;

describe("semantic_pairwise — pre-pass and check", () => {
  it("a graded win passes and carries the outcome, the reference sha and judge provenance", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "REFERENCE ANSWER");
    const c = ctx({ finalMessage: "CANDIDATE ANSWER" });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("win", seen) }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(true);
    expect(r!.pairwise).toMatchObject([{ ref: "baseline", status: "graded", outcome: "win", value: 1 }]);
    expect(r!.pairwise![0]!.refDocSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r!.judgeModel).toBe("claude-judge-1");
    expect(r!.judgePromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r!.judgeCostUsd).toBeCloseTo(0.01);
    expect(seen[0]!.candidate).toContain("CANDIDATE ANSWER");
    expect(seen[0]!.reference).toContain("REFERENCE ANSWER");
    expect(seen[0]!.task).toBe("Summarise X");
  });

  it("records how the judge was called when the real transport is used, and nothing for an injected one", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "REFERENCE ANSWER");
    const real = ctx({ finalMessage: "CANDIDATE ANSWER" });
    await runPairwiseJudges(
      [a],
      real,
      opts(a, { judgeFor: fakeJudge("win"), transport: () => ({ isolation: "1", cliVersion: "2.1.286" }) }),
    );
    expect(evaluate([a], real)[0]!.judgeTransport).toEqual({ isolation: "1", cliVersion: "2.1.286" });
    const injected = ctx({ finalMessage: "CANDIDATE ANSWER" });
    await runPairwiseJudges([a], injected, opts(a, { judgeFor: fakeJudge("win") }));
    expect(evaluate([a], injected)[0]!.judgeTransport).toBeUndefined();
  });

  const table: Array<[PairwiseOutcome, "win" | "not_worse" | "any", boolean]> = [
    ["win", "win", true],
    ["tie", "win", false],
    ["win", "not_worse", true],
    ["tie", "not_worse", true],
    ["loss", "not_worse", false],
    ["both_bad", "not_worse", false],
    ["both_bad", "win", false],
    ["loss", "any", true],
    ["both_bad", "any", true],
  ];
  it.each(table)("%s under pass_if %s ⇒ pass %s", async (outcome, passIf, want) => {
    const a = assertOf({ pass_if: passIf });
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: "C" });
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge(outcome) }));
    expect(evaluate([a], c)[0]!.pass).toBe(want);
  });

  it("the default pass_if is not_worse", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: "C" });
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("tie") }));
    expect(evaluate([a], c)[0]!.pass).toBe(true);
  });

  it("every reference must satisfy pass_if", async () => {
    const a = assertOf({ pass_if: "win" });
    freezeFrom(join(tmp, "baseline"), a, "R");
    freezeFrom(join(tmp, "v2"), a, "R2");
    const c = ctx({ finalMessage: "C" });
    let n = 0;
    const judgeFor =
      (model: string): PairwiseJudge =>
      async () => {
        const outcome: PairwiseOutcome = n++ === 0 ? "win" : "tie";
        return { outcome, value: outcomeValue(outcome), order: "ref_first", model };
      };
    const refsFor = () => [
      { name: "baseline", store: join(tmp, "baseline") },
      { name: "v2", store: join(tmp, "v2") },
    ];
    await runPairwiseJudges([a], c, opts(a, { judgeFor, refsFor }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.pairwise!.map((o) => o.outcome)).toEqual(["win", "tie"]);
  });

  it("a neutral reference (this run's own variant) passes under every pass_if without a judge call", async () => {
    for (const passIf of ["win", "not_worse", "any"] as const) {
      const a = assertOf({ pass_if: passIf });
      const c = ctx({ finalMessage: "C" });
      const seen: PairwiseInput[] = [];
      await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("loss", seen), neutralRefs: new Set(["baseline"]) }));
      const [r] = evaluate([a], c);
      expect(r!.pass).toBe(true);
      expect(r!.pairwise).toEqual([{ ref: "baseline", status: "neutral", value: 0.5 }]);
      expect(seen).toHaveLength(0);
      expect(r!.judgeModel).toBeUndefined();
    }
  });

  it("a missing reference fails evidence-unavailable under EVERY pass_if, any included, and calls no judge", async () => {
    const a = assertOf({ pass_if: "any" });
    const c = ctx({ finalMessage: "C" });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("win", seen) }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/evidence unavailable: reference\(s\) could not be read — baseline: missing/);
    expect(seen).toHaveLength(0);
  });

  it("a tampered reference is an integrity failure, never compared", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const dir = join(tmp, "baseline", "case_1");
    const f = readdirSync(dir).find((n) => n.endsWith(".txt"))!;
    writeFileSync(join(dir, f), "edited");
    const c = ctx({ finalMessage: "C" });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("win", seen) }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.pairwise![0]!.status).toBe("integrity");
    expect(seen).toHaveLength(0);
  });

  it("a reference composed with a different scope is missing (no cross-scope comparison)", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), assertOf({ evidence_files: ["outputs/x.md"] }), "R");
    const c = ctx({ finalMessage: "C" });
    await runPairwiseJudges([a], c, opts(a));
    expect(evaluate([a], c)[0]!.pairwise![0]!.status).toBe("missing");
  });

  it("unavailable candidate evidence refuses before any judge call, with the semantic_matches reason", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({
      finalMessage: "C",
      authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [], noPreRunManifest: true } as never,
    });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("win", seen) }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.semanticEvidence?.reason).toBe("no_pre_run_manifest");
    expect(seen).toHaveLength(0);
  });

  it("an invalid judge grade marks the rep invalid and keeps its spend", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: "C" });
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("invalid") }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.judgeInvalid).toBe(true);
    expect(r!.judgeCostUsd).toBeCloseTo(0.02);
  });

  it("without the pre-pass (replay, verify-run) the assert fails 'not run', never passes", () => {
    const a = assertOf({ pass_if: "any" });
    const [r] = evaluate([a], ctx({ finalMessage: "C" }));
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/pairwise judge not run/);
  });

  it("the candidate reaches the judge with the same host-path transform the reference got", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: `saved to ${join(homedir(), "Documents", "plan.md")}` });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("tie", seen) }));
    expect(seen[0]!.candidate).toContain("~/Documents/plan.md");
    expect(seen[0]!.candidate).not.toContain(homedir());
  });

  it("the task and the rationale are scrubbed of the run's secrets", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R", "use S3CR3T");
    const c = ctx({ finalMessage: "C", secrets: ["S3CR3T"] });
    const seen: PairwiseInput[] = [];
    const judgeFor =
      (model: string): PairwiseJudge =>
      async (input) => {
        seen.push(input);
        return { outcome: "win", value: 1, order: "candidate_first", rationale: "quotes S3CR3T", model };
      };
    await runPairwiseJudges([a], c, opts(a, { judgeFor, task: "use S3CR3T" }));
    expect(seen[0]!.task).not.toContain("S3CR3T");
    expect(JSON.stringify(evaluate([a], c)[0])).not.toContain("S3CR3T");
  });
});

describe("semantic_pairwise — review fixes", () => {
  it("scrubs the rubric before it reaches the judge, naming the redacted claim indexes", async () => {
    const a = assertOf({ rubric: ["must not leak S3CR3TVALUE123", "is short"] });
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: "C", secrets: ["S3CR3TVALUE123"] });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("tie", seen) }));
    expect(JSON.stringify(seen[0]!.rubric)).not.toContain("S3CR3TVALUE123");
    expect(seen[0]!.rubric![1]).toBe("is short");
  });

  it("warns once when the judge model is the model under test", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: "C" });
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      await runPairwiseJudges([a], c, opts(a, { modelFor: () => "claude-sonnet-5", mainModels: ["claude-sonnet-5"] }));
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.filter((w) => /judge model .* is also the model under test/.test(w))).toHaveLength(1);
  });

  it.each([
    ["claude-sonnet-5", ["claude-sonnet-5-20260101"], 1],
    ["claude-sonnet-5-20260101", ["claude-sonnet-5[1m]"], 1],
    ["Claude-Sonnet-5[1M]", ["claude-sonnet-5"], 1],
    ["claude-sonnet-5", ["claude-opus-5-20260101"], 0],
    ["claude-sonnet-5", ["claude-sonnet-5-1"], 0],
  ] as const)("self-judge: judge %s vs run model(s) %j ⇒ %i warning(s), across date and context suffixes", async (judge, mains, n) => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const c = ctx({ finalMessage: "C" });
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      await runPairwiseJudges([a], c, opts(a, { modelFor: () => judge, mainModels: mains }));
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.filter((w) => /judge model .* is also the model under test/.test(w))).toHaveLength(n);
  });

  it("an unchecked reference is visible on its outcome", async () => {
    const a = assertOf();
    const doc = candidateDocument(ctx({ finalMessage: "R" }), a).candidate;
    freezeRef(join(tmp, "baseline"), "case_1", SRC, { [pairwiseComposeKey(a)]: doc }, { ...META(), unchecked: true });
    const c = ctx({ finalMessage: "C" });
    await runPairwiseJudges([a], c, opts(a));
    expect(evaluate([a], c)[0]!.pairwise![0]).toMatchObject({ status: "graded", unchecked: true });
  });

  it.each(["win", "not_worse", "any"] as const)("missing AND integrity both fail under pass_if %s", async (passIf) => {
    const a = assertOf({ pass_if: passIf });
    freezeFrom(join(tmp, "baseline"), a, "R");
    const dir = join(tmp, "baseline", "case_1");
    writeFileSync(
      join(
        dir,
        readdirSync(dir).find((n) => n.endsWith(".txt"))!,
      ),
      "edited",
    );
    const refsFor = () => [
      { name: "baseline", store: join(tmp, "baseline") },
      { name: "gone", store: join(tmp, "gone") },
    ];
    const c = ctx({ finalMessage: "C" });
    await runPairwiseJudges([a], c, opts(a, { refsFor }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.pairwise!.map((o) => o.status)).toEqual(["integrity", "missing"]);
  });

  it.each(["win", "any"] as const)("win and tie under pass_if %s", async (passIf) => {
    for (const [outcome, want] of [
      ["win", true],
      ["tie", passIf === "any"],
    ] as const) {
      const a = assertOf({ pass_if: passIf });
      rmSync(join(tmp, "baseline"), { recursive: true, force: true });
      freezeFrom(join(tmp, "baseline"), a, "R");
      const c = ctx({ finalMessage: "C" });
      await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge(outcome) }));
      expect(evaluate([a], c)[0]!.pass).toBe(want);
    }
  });
});

describe("semantic_pairwise — task identity", () => {
  it("a reference frozen for a different task is never compared (missing, with the reason)", async () => {
    const a = assertOf();
    const doc = candidateDocument(ctx({ finalMessage: "R" }), a).candidate;
    freezeRef(join(tmp, "baseline"), "case_1", SRC, { [pairwiseComposeKey(a)]: doc }, { ...META(), taskSha256: "9".repeat(64) });
    const c = ctx({ finalMessage: "C" });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("win", seen) }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.pairwise![0]).toMatchObject({ status: "missing", why: expect.stringMatching(/different task/) });
    expect(seen).toHaveLength(0);
  });
});

describe("semantic_pairwise — a reference without a task identity", () => {
  it("is an integrity failure at judge time, never compared", async () => {
    const a = assertOf();
    freezeFrom(join(tmp, "baseline"), a, "R");
    const ref = join(tmp, "baseline", "case_1", "ref.json");
    const m = JSON.parse(readFileSync(ref, "utf8")) as Record<string, unknown>;
    delete m.taskSha256;
    writeFileSync(ref, JSON.stringify(m, null, 2) + "\n");
    const c = ctx({ finalMessage: "C" });
    const seen: PairwiseInput[] = [];
    await runPairwiseJudges([a], c, opts(a, { judgeFor: fakeJudge("win", seen) }));
    const [r] = evaluate([a], c);
    expect(r!.pass).toBe(false);
    expect(r!.pairwise![0]).toMatchObject({ status: "integrity", why: expect.stringMatching(/task identity/) });
    expect(seen).toHaveLength(0);
  });
});
