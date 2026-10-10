// `critique --summary-out`: a summary meant for a PUBLIC repository. Driven through the real report builder and the
// real writer (`writeSummaryIfAsked` → `buildJsonReport` → `buildCritiqueSummary` → `writeSummaryFile`), and through
// the CLI for `--corpus-only` — the WRITTEN file is what the tests read.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import Ajv from "ajv";
import { parseArgs, writeSummaryIfAsked } from "../src/critique/command.js";
import { buildCritiqueSummary, writeSummaryFile } from "../src/critique/summary.js";

const SCHEMA = JSON.parse(readFileSync(resolve("schema/critique-summary.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA);

const H = (c: string) => `sha256:${c.repeat(64)}`;
const SECRET_TEXT = "SECRET-FINDING-TEXT-do-not-publish";
const HOST = "/Users/someone/private/plugin";

/** A report state with free text in every free-text field: none of it may reach the summary. */
function state(over: Record<string, unknown> = {}) {
  return {
    harnessVersion: "4.8.0",
    label: "v1.2.3-rc1",
    corpus: {
      corpusHashScheme: 1,
      hashBasis: "git-commit",
      corpusHash: H("a"),
      packagedCorpusHash: H("b"),
      skillTreeHash: H("c"),
      corpusManifest: [{ origin: "skill_md", key: `${HOST}/SKILL.md`, status: "ok", sha256: "d".repeat(64), bytes: 1 }],
      skillTreeUntracked: [`${HOST}/scratch.py`],
    },
    source: { kind: "git", ref: "feature/secret-branch", path: "private/plugins/x", commit: "e".repeat(40) },
    summaryIdentity: { name: "plug:ms", kind: "plugin_skill" },
    skillFolder: HOST,
    prompt: `probe naming ${SECRET_TEXT}`,
    sessionId: "crit-0f0e0d0c-0b0a-4090-8070-605040302010",
    outDir: `${HOST}/runs/x`,
    fidelity: "container",
    gradedBaseline: "desktop-2.31226.1",
    gradedModels: ["claude-sonnet-5", "<synthetic>"],
    evaluatorModel: "claude-opus-4-8",
    costUsd: { totalUsd: 1.5, complete: true },
    taskResult: "success",
    gradedOutcome: "delivered_clean",
    selfReportStatus: "captured",
    evaluatorIntegrity: { pass1Canary: true, pass2Canary: true },
    droppedEvaluatorItems: { pass1: 1, pass2: 0 },
    evidenceBudget: { corpusBytes: 1, corpusCeiling: 2, corpusCuts: [], corpusExcluded: [`${HOST}/x`], corpusPackaged: [] },
    gradedErrorReason: SECRET_TEXT,
    items: [
      {
        source: "evaluator",
        idea: SECRET_TEXT,
        classification: "grounded-and-actionable",
        evidence: SECRET_TEXT,
        recommendedAction: SECRET_TEXT,
        citationResolved: true,
        findingFingerprint: "0123456789abcdef",
      },
      {
        source: "self-report",
        idea: SECRET_TEXT,
        classification: "not-adjudicable",
        evidence: "",
        recommendedAction: SECRET_TEXT,
        citationResolved: true,
        findingFingerprint: "fedcba9876543210",
      },
      {
        source: "evaluator",
        idea: SECRET_TEXT,
        classification: "confabulated",
        evidence: SECRET_TEXT,
        recommendedAction: SECRET_TEXT,
        citationResolved: false,
        findingFingerprint: "1111111111111111",
      },
    ],
    requestedModel: "claude-opus-4-8",
    ...over,
  } as unknown as Parameters<typeof writeSummaryIfAsked>[1];
}

function written(args: string[], st = state()) {
  const out = join(mkdtempSync(join(tmpdir(), "cwh-summary-")), "summary.json");
  writeSummaryIfAsked(parseArgs(["./s", "--prompt", "p", "--summary-out", out, ...args]), st);
  return { out, text: existsSync(out) ? readFileSync(out, "utf8") : undefined };
}

const leafKeys = (v: unknown, p = ""): string[] =>
  Array.isArray(v)
    ? v.length === 0
      ? [p] // an empty list is still a key the file carries
      : v.flatMap((x) => leafKeys(x, `${p}[]`))
    : v && typeof v === "object"
      ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leafKeys(x, p ? `${p}.${k}` : k))
      : [p];

describe("--summary-out", () => {
  it("writes ONLY allowlisted keys, and no finding text, prompt, host path or git ref/path", () => {
    const { text } = written([]);
    expect(text).toBeDefined();
    const s = JSON.parse(text!);
    expect(validate(s), JSON.stringify(validate.errors)).toBe(true);
    expect([...new Set(leafKeys(s))].sort()).toEqual(
      [
        "schema",
        "harnessVersion",
        "timestamp",
        "sessionId",
        "gradedSkill",
        "gradedSkillKind",
        "corpusHashScheme",
        "fingerprintScheme",
        "hashBasis",
        "corpusHash",
        "packagedCorpusHash",
        "skillTreeHash",
        "source.kind",
        "source.commit",
        "label",
        "fidelity",
        "gradedBaseline",
        "evaluatorModel",
        "gradedModels[]",
        "status",
        "selfReportStatus",
        "evaluatorIntegrity.pass1Canary",
        "evaluatorIntegrity.pass2Canary",
        "droppedEvaluatorItems.pass1",
        "droppedEvaluatorItems.pass2",
        "corpusCuts",
        "corpusDrift",
        "items[].findingFingerprint",
        "items[].classification",
        "items[].source",
        "items[].adjudicable",
        "withheld",
      ].sort(),
    );
    for (const banned of [SECRET_TEXT, HOST, "/Users/", "feature/secret-branch", "private/plugins", "<synthetic>"])
      expect(text).not.toContain(banned);
    expect(s.items.map((i: { findingFingerprint: string }) => i.findingFingerprint)).toEqual(["0123456789abcdef", "fedcba9876543210"]); // the dropped item is out
    expect(s.items[1].adjudicable).toBe(false);
    expect(s.gradedModels).toEqual(["claude-sonnet-5"]);
    expect(s).not.toHaveProperty("costUsd");
    expect(s).not.toHaveProperty("promptSha256");
  });

  it("cost and the prompt hash only when asked for", () => {
    const s = JSON.parse(written(["--summary-include-cost", "--summary-include-prompt-hash"]).text!);
    expect(s.costUsd).toEqual({ totalUsd: 1.5, complete: true });
    expect(s.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validate(s), JSON.stringify(validate.errors)).toBe(true);
  });

  it("a value that fails its shape check is written null and named in withheld, never passed through", () => {
    const s = JSON.parse(
      written(
        [],
        state({
          label: "has spaces and /Users/x",
          evaluatorModel: "arn:aws:bedrock:us-east-1:123456789012:model/x",
          gradedBaseline: "/Users/x/baseline.json",
          gradedModels: ["arn:aws:bedrock:us-east-1:123456789012:model/x"],
        }),
      ).text!,
    );
    expect([s.label, s.evaluatorModel, s.gradedBaseline]).toEqual([null, null, null]);
    expect(s.gradedModels).toEqual([]);
    expect(s.withheld).toEqual(expect.arrayContaining(["label", "evaluatorModel", "gradedBaseline", "gradedModels"]));
    expect(JSON.stringify(s)).not.toContain("123456789012");
  });

  it("a summary a configured secret would alter is NOT written, with a warning", () => {
    const st = state();
    const summary = buildCritiqueSummary(JSON.parse(JSON.stringify({ ...st, ...(st as { corpus: object }).corpus })), {
      identity: { name: "plug:ms", kind: "plugin_skill" },
      includeCost: false,
      includePromptHash: false,
    });
    const out = join(mkdtempSync(join(tmpdir(), "cwh-summary-")), "s.json");
    const warnings: string[] = [];
    expect(writeSummaryFile(out, summary, (m) => warnings.push(m), ["v1.2.3-rc1"])).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(warnings.join("")).toMatch(/NOT written/);
    expect(writeSummaryFile(out, summary, (m) => warnings.push(m), [])).toBe(true);
  });

  it("an infra-failure report still writes a summary, with its status and no items", () => {
    const s = JSON.parse(
      written([], state({ infraFailure: SECRET_TEXT, infraFailurePhase: "task turn", infraFailureKind: "usage_limit" })).text!,
    );
    expect(s.status).toBe("task_turn_failed");
    expect(s.items).toEqual([]);
    expect(JSON.stringify(s)).not.toContain(SECRET_TEXT);
  });

  it("refuses --summary-out equal to --out, and the include flags without --summary-out", () => {
    expect(() => parseArgs(["./s", "--prompt", "p", "--out", "a.json", "--summary-out", "./a.json"])).toThrow(/name the same file/);
    expect(() => parseArgs(["./s", "--prompt", "p", "--summary-include-cost"])).toThrow(/need --summary-out/);
  });
});

const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("--summary-out with --corpus-only (CLI)", () => {
  it("writes a corpus_only summary for a plain skill folder, named by its frontmatter", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-summary-cli-"));
    const skill = join(root, "my-skill");
    mkdirSync(dirname(join(skill, "SKILL.md")), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: my-skill\ndescription: d\n---\n# body\n");
    execFileSync("git", ["init", "-q"], { cwd: skill });
    execFileSync("git", ["add", "-A"], { cwd: skill });
    const out = join(root, "summary.json");
    const r = spawnSync("node", [CLI, "critique", skill, "--corpus-only", "--summary-out", out, "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const s = JSON.parse(readFileSync(out, "utf8"));
    expect(validate(s), JSON.stringify(validate.errors)).toBe(true);
    expect([s.status, s.gradedSkill, s.gradedSkillKind, s.items.length]).toEqual(["corpus_only", "my-skill", "folder", 0]);
    expect(s.corpusHash).toBe(JSON.parse(r.stdout).corpusHash);
    expect(readFileSync(out, "utf8")).not.toContain(root);
  });
});
