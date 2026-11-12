import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSemanticJudges, evaluate, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { regradeHintEligible } from "../src/run/execute.js";
import type { AuthoredFile, AuthoredFilesHealth } from "../src/run/artifacts.js";
import type { Assertion } from "../src/types.js";

// A judged assert refused because the authored evidence was cut (truncated at a cap, or dropped at the capture budget)
// can often be recovered from the KEPT run with `regrade` — judge spend only, no agent re-run. The refusal says so,
// but only where that is true: on a live `run`/`record`, never inside regrade itself (its context has no hint flag),
// never for a leg, an eval/hillclimb arm, or a `skill` run (no scenario file to pass), and never for an unreadable file
// (no budget or scope recovers it). `--allow-unchecked` is named only when another judged assert in the same run
// recorded what its judge read: that is the case regrade measures widened content against, and refuses without it.

const health = (h: Partial<AuthoredFilesHealth>): AuthoredFilesHealth => ({
  omittedPaths: [],
  totalCapExhausted: false,
  readErrors: [],
  hashUnknownPaths: [],
  scratchpadWalkErrors: [],
  scratchpadSkippedLinks: [],
  workspaceWalkErrors: [],
  ...h,
});

function ctxFor(files: AuthoredFile[], h?: Partial<AuthoredFilesHealth>, regradeHint?: boolean): AssertContext {
  return {
    transcript: "",
    finalMessage: "done",
    workRoot: "/w",
    userVisiblePrefixes: ["outputs"],
    authoredFiles: files,
    ...(h ? { authoredFilesHealth: health(h) } : {}),
    ...(regradeHint !== undefined ? { regradeHint } : {}),
  } as unknown as AssertContext;
}

const judged = (scope?: string[]): Assertion =>
  ({ semantic_matches: { rubric: ["c1"], ...(scope ? { evidence_files: scope } : {}) } }) as Assertion;

const passingJudge = (async (rubric: string[]) => rubric.map((claim, index) => ({ index, claim, pass: true }))) as unknown as SemanticJudge;
passingJudge.model = "stub-judge";

async function messageOf(ctx: AssertContext, asserts: Assertion[], i = 0): Promise<string> {
  await runSemanticJudges(asserts, ctx, passingJudge);
  return evaluate(asserts, ctx)[i].message ?? "";
}

const REGRADE = "cowork-harness regrade <run-dir> --scenario <scenario.yaml>";

describe("judge-cap refusal: a branch-specific regrade hint on an eligible live run", () => {
  beforeEach(() => {
    delete process.env.COWORK_HARNESS_AUTHORED_TOTAL_BYTES;
  });

  it("unscoped, truncated at the per-file cap: scope evidence_files, then regrade (no budget flag)", async () => {
    const m = await messageOf(ctxFor([{ path: "outputs/big.html", content: "x", truncated: true }], undefined, true), [judged()]);
    expect(m).toContain('add semantic_matches.evidence_files: ["<the deliverable>"] to the scenario');
    expect(m).toContain(`\`${REGRADE}\``);
    expect(m).toContain("judge spend only");
    expect(m).not.toContain("--authored-total-bytes");
    expect(m).not.toContain("--allow-unchecked");
  });

  it("the truncated-prefix message names the cut file and says it may be a generated file outside the rubric", async () => {
    const m = await messageOf(ctxFor([{ path: "outputs/big.html", content: "x", truncated: true }], undefined, false), [judged()]);
    expect(m).toContain("TRUNCATED prefix (outputs/big.html)");
    expect(m).toMatch(/generated file beside the deliverable/);
  });

  it("scoped, truncated (the TOTAL did not fit): regrade with --authored-total-bytes, no scope advice", async () => {
    const m = await messageOf(ctxFor([{ path: "outputs/report.md", content: "x", truncated: true }], undefined, true), [
      judged(["outputs/report.md"]),
    ]);
    expect(m).toContain(`\`${REGRADE} --authored-total-bytes <N>\``);
    expect(m).not.toContain("add semantic_matches.evidence_files");
  });

  it("omitted at the capture budget: regrade with --authored-total-bytes", async () => {
    const m = await messageOf(ctxFor([], { omittedPaths: ["outputs/report.md"], totalCapExhausted: true }, true), [
      judged(["outputs/report.md"]),
    ]);
    expect(m).toContain(`\`${REGRADE} --authored-total-bytes <N>\``);
  });

  it("unreadable: no regrade hint (no budget or scope recovers it)", async () => {
    const m = await messageOf(ctxFor([], { readErrors: [{ path: "outputs/report.md", error: "EACCES" }] }, true), [
      judged(["outputs/report.md"]),
    ]);
    expect(m).toContain("unreadable at read-back");
    expect(m).not.toContain("regrade");
  });

  it("names --allow-unchecked only when a sibling judged assert recorded a judged document", async () => {
    const files: AuthoredFile[] = [
      { path: "outputs/report.md", content: "body" },
      { path: "outputs/big.html", content: "x", truncated: true },
    ];
    // Sibling FIRST and second: the hint must not depend on assert order (the refusal is decided in the pre-pass,
    // before a later sibling is graded).
    for (const order of ["sibling-first", "sibling-last"] as const) {
      const sib = judged(["outputs/report.md"]);
      const cut = judged();
      const asserts = order === "sibling-first" ? [sib, cut] : [cut, sib];
      const m = await messageOf(ctxFor(files, undefined, true), asserts, asserts.indexOf(cut));
      expect(m, order).toContain(`\`${REGRADE} --allow-unchecked\``);
    }
  });

  it("no hint when the context does not ask for one (replay, verify-run, regrade, skill, legs, eval/hillclimb arms)", async () => {
    for (const flag of [undefined, false]) {
      const m = await messageOf(ctxFor([{ path: "outputs/big.html", content: "x", truncated: true }], undefined, flag), [judged()]);
      expect(m).toContain("TRUNCATED prefix");
      expect(m).not.toContain("regrade");
    }
  });
});

describe("regradeHintEligible — which executions get the hint", () => {
  const leg = { outDir: "/x", runRoot: "/r", sessionId: "s", workBase: "/w", agentSessionId: "a" } as never;
  const cases: [string, Parameters<typeof regradeHintEligible>[0], boolean][] = [
    ["run", { command: "run" }, true],
    ["record", { command: "record" }, true],
    ["skill (no scenario file)", { command: "skill" }, false],
    ["no command (a library caller)", {}, false],
    ["a leg of a multi-leg run", { command: "run", leg }, false],
    ["an eval or hillclimb arm", { command: "run", noRegradeHint: true }, false],
  ];
  it.each(cases)("%s", (_name, o, expected) => {
    expect(regradeHintEligible(o)).toBe(expected);
  });
});

describe("regrade-hint wiring", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  it("execute.ts sets the context flag from regradeHintEligible, at its one assert-context site", () => {
    const src = read("src/run/execute.ts");
    expect(src.match(/regradeHint: regradeHintEligible\(opts\)/g)).toHaveLength(1);
  });

  it("the eval and hillclimb arm runners opt out", () => {
    const src = read("src/cli.ts");
    expect(src.match(/extra: \{ \.\.\.a\.extra, noRegradeHint: true \}/g)).toHaveLength(2);
  });
});
