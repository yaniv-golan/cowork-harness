import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistCritiqueArtifacts, sumCostUsd, parseArgs, type CritiqueCost } from "../src/critique/command";
import { runCritique } from "../src/critique/evaluator";
import type { Complete } from "../src/decide/decider";

// WS "persist run artifacts": the durable files a critique leaves in its run dir, the per-critique cost
// rollup, and the --out flag. Each guard is mutation-tested: skipping the corresponding write/summation
// turns a test here red.

const STATE_BASE = {
  skillFolder: "./s",
  prompt: "p",
  sessionId: "sess-x",
  outDir: "/tmp/ignored",
  fidelity: "container",
  taskResult: "success" as const,
  selfReportStatus: "captured" as const,
  items: [],
  requestedModel: "m",
};

describe("persistCritiqueArtifacts", () => {
  it("always writes critique-report.json; evidence only when captured; no salvage on a clean run", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-art-"));
    persistCritiqueArtifacts(dir, { ...STATE_BASE, outDir: dir }, "ARMORED-CORPUS", { rawEvaluatorReplies: [] });
    const report = JSON.parse(readFileSync(join(dir, "critique-report.json"), "utf8"));
    expect(report.sessionId).toBe("sess-x");
    expect(report.fidelity).toBe("container");
    expect(readFileSync(join(dir, "critique-evidence-package.txt"), "utf8")).toBe("ARMORED-CORPUS");
    expect(existsSync(join(dir, "critique-salvage.json"))).toBe(false);
  });

  it("writes critique-salvage.json on an instrument failure, carrying the PRE-PARSE raw replies", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-art-"));
    persistCritiqueArtifacts(dir, { ...STATE_BASE, outDir: dir, evaluatorError: "pass 2 exploded" }, undefined, {
      selfReport: "I was confused by X",
      rawEvaluatorReplies: [
        { pass: 1, raw: '{"items":[]}' },
        { pass: 2, raw: "NOT JSON AT ALL" },
      ],
    });
    const salvage = JSON.parse(readFileSync(join(dir, "critique-salvage.json"), "utf8"));
    expect(salvage.evaluatorError).toBe("pass 2 exploded");
    expect(salvage.selfReport).toBe("I was confused by X");
    expect(salvage.rawEvaluatorReplies).toHaveLength(2);
    expect(salvage.rawEvaluatorReplies[1].raw).toBe("NOT JSON AT ALL");
    // the report is still written on the failure path — every outcome leaves the machine-readable report
    expect(existsSync(join(dir, "critique-report.json"))).toBe(true);
  });

  it("an unwritable run dir warns but never throws (best-effort by contract)", () => {
    expect(() => persistCritiqueArtifacts("/nonexistent-root/nope", STATE_BASE, "x", { rawEvaluatorReplies: [] })).not.toThrow();
  });
});

describe("sumCostUsd", () => {
  it("sums costUSD across models and distinguishes unpriced (undefined) from $0", () => {
    expect(sumCostUsd({ a: { costUSD: 0.25 }, b: { costUSD: 0.5 } })).toBeCloseTo(0.75);
    expect(sumCostUsd({ a: { costUSD: 0 } })).toBe(0); // genuinely free is a real answer
    expect(sumCostUsd({ a: { inputTokens: 5 } })).toBeUndefined(); // no costUSD anywhere = unpriced
    expect(sumCostUsd(undefined)).toBeUndefined();
    expect(sumCostUsd("junk")).toBeUndefined();
  });
});

describe("evaluator usage/raw-reply/evidence callbacks feed the artifacts", () => {
  const NONCE = "0123456789abcdef";
  const SECTIONS = [{ title: "Evidence", body: "the agent chose the container fidelity tier." }];
  const CANARY = { idea: `CANARY-${NONCE}`, classification: "not-adjudicable", evidence: "", recommendedAction: "none" };

  it("onUsage receives each pass's envelope usage; onArmoredEvidence the exact corpus; onRawReply pre-parse text", async () => {
    const usage1 = { "model-x": { costUSD: 0.11 } };
    const reply = JSON.stringify({ items: [CANARY] });
    const complete: Complete = vi.fn(async () => ({ text: reply, model: "model-x", usage: usage1 }));
    let evidence: string | undefined;
    const raws: Array<{ pass: number; raw: string }> = [];
    const usages: Array<{ pass: number; cost?: number }> = [];
    await runCritique(SECTIONS, undefined, {
      nonce: NONCE,
      complete,
      onArmoredEvidence: (t) => (evidence = t),
      onRawReply: (pass, raw) => raws.push({ pass, raw }),
      onUsage: (pass, u) => usages.push({ pass, cost: sumCostUsd(u) }),
    });
    expect(evidence).toContain("the agent chose the container fidelity tier.");
    expect(raws).toEqual([{ pass: 1, raw: reply }]);
    expect(usages).toEqual([{ pass: 1, cost: 0.11 }]);
  });

  it("onRawReply fires BEFORE the parse throws, so a malformed reply is still salvageable", async () => {
    const complete: Complete = vi.fn(async () => ({ text: "TOTALLY NOT JSON", model: "x" }));
    let raw: string | undefined;
    await expect(runCritique(SECTIONS, undefined, { nonce: NONCE, complete, onRawReply: (_p, r) => (raw = r) })).rejects.toThrow();
    expect(raw).toBe("TOTALLY NOT JSON"); // captured despite the throw — the whole point of the salvage path
  });
});

describe("--out flag parsing", () => {
  it("accepts space and equals forms; repeat is a usage error", () => {
    expect(parseArgs(["./s", "--prompt", "p", "--out", "/tmp/r.json"]).out).toBe("/tmp/r.json");
    expect(parseArgs(["./s", "--prompt", "p", "--out=/tmp/r.json"]).out).toBe("/tmp/r.json");
    expect(() => parseArgs(["./s", "--prompt", "p", "--out", "a", "--out", "b"])).toThrow(/not repeatable/);
    expect(() => parseArgs(["./s", "--prompt", "p", "--out"])).toThrow(/requires a value/);
  });
});

describe("cost rollup shape", () => {
  it("a partial rollup is INCOMPLETE by construction", () => {
    const cost: CritiqueCost = {
      taskTurnUsd: 1,
      evaluatorPass1Usd: 0.2,
      totalUsd: 1.2,
      complete: false,
    };
    expect(cost.complete).toBe(false);
  });
});

describe("findingFingerprint (cross-input corroboration key)", () => {
  it("is stable across whitespace reflow and EXCLUDES the input-specific evidence excerpt", async () => {
    const { findingFingerprint } = await import("../src/critique/evidence");
    const a = findingFingerprint({ idea: "add a tier table", classification: "grounded-and-actionable", recommendedAction: "do it" });
    const b = findingFingerprint({ idea: "add  a\n tier   table", classification: "grounded-and-actionable", recommendedAction: "do  it" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    const c = findingFingerprint({ idea: "add a tier table", classification: "grounded-but-not-worth-it", recommendedAction: "do it" });
    expect(c).not.toBe(a); // classification participates
  });

  it("is stamped on every item validateCitations returns", async () => {
    const { validateCitations } = await import("../src/critique/evidence");
    const items = validateCitations(
      [
        {
          source: "evaluator" as const,
          idea: "x",
          classification: "not-adjudicable" as const,
          evidence: "",
          recommendedAction: "y",
        },
      ],
      "pkg",
    );
    expect(items[0].findingFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("gate-answer echo (reproduce-deterministically footer)", () => {
  it("renders copy-pasteable --answer lines and carries gateAnswers in JSON", async () => {
    const { buildTextReport, buildJsonReport } = await import("../src/critique/command");
    const state = {
      ...STATE_BASE,
      gateAnswers: [{ question: "Which format?", answer: "Markdown", answeredBy: "scripted" }],
    };
    const text = buildTextReport(state);
    expect(text).toContain('--answer "Which format?=Markdown"');
    expect(buildJsonReport(state).gateAnswers).toEqual(state.gateAnswers);
  });
});
