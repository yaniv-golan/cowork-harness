// `critique --compare --cluster lexical`: candidate groups of findings by lexical similarity, a JUDGEMENT, never a
// match. No k/N, no `once`, no "reproduced", input order. The similarity is char_wb 3–5-gram TF-IDF (sublinear tf,
// IDF over the compared items) on idea + " || " + recommended action; the reference values below come from
// scikit-learn's TfidfVectorizer with the same settings, so the port is checked against an outside implementation.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { parseArgs, writeOutFile, writeSummaryIfAsked } from "../src/critique/command.js";
import { compareMembers, loadMember, renderCompareText } from "../src/critique/compare.js";
import {
  CLUSTER_GATE,
  LEXICAL_GROUP_THRESHOLD,
  USER_FACING_CLUSTER_JUDGE,
  candidateGroupsOf,
  lexicalSimilarity,
} from "../src/critique/cluster-lexical.js";

const CLI = resolve("dist/cli.js");
const H = (c: string) => `sha256:${c.repeat(64)}`;
let n = 0;

type Item = { idea: string; action: string; classification?: string; fp: string; resolved?: boolean };
function writeReport(d: string, name: string, items: Item[], over: Record<string, unknown> = {}, summary = false): string {
  n++;
  const st = {
    harnessVersion: "4.9.0",
    label: undefined,
    corpus: {
      corpusHashScheme: 1,
      hashBasis: "git-commit",
      corpusHash: H("a"),
      packagedCorpusHash: H("b"),
      skillTreeHash: H("c"),
      corpusManifest: [],
      skillTreeUntracked: [],
    },
    source: { kind: "dir" },
    summaryIdentity: { name: "plug:ms", kind: "plugin_skill" },
    skillFolder: "./plug",
    prompt: "the same probe",
    sessionId: `crit-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
    outDir: "/tmp/x",
    fidelity: "container",
    evaluatorModel: "claude-opus-4-8",
    taskResult: "success",
    selfReportStatus: "captured",
    evaluatorIntegrity: { pass1Canary: true, pass2Canary: true },
    requestedModel: "claude-opus-4-8",
    items: items.map((i) => ({
      source: "evaluator",
      idea: i.idea,
      classification: i.classification ?? "grounded-and-actionable",
      evidence: "an excerpt of the skill",
      recommendedAction: i.action,
      citationResolved: i.resolved ?? true,
      findingFingerprint: i.fp,
    })),
    ...over,
  } as unknown as Parameters<typeof writeOutFile>[1];
  const p = join(d, name);
  if (summary) writeSummaryIfAsked(parseArgs(["./s", "--prompt", "p", "--summary-out", p]), st);
  else writeOutFile(p, st, "json");
  return p;
}
const dir = () => mkdtempSync(join(tmpdir(), "cwh-cluster-"));

describe("lexicalSimilarity matches scikit-learn's char_wb 3–5 TF-IDF (sublinear tf, smooth idf, l2)", () => {
  const docs: Array<[string, string]> = [
    ["SKILL.md does not say what a bare invocation should do.", "Add a section for a bare invocation."],
    ["The skill never says what to do when it is merely invoked.", "Describe the bare-invocation behaviour."],
    ["Nothing was unclear.", "No change needed."],
    ["The   path was given verbatim, so no guessing was needed!", "None."],
    ["a", "b"],
  ];
  // TfidfVectorizer(analyzer="char_wb", ngram_range=(3,5), sublinear_tf=True) on norm(idea) + " || " + norm(action),
  // scikit-learn 1.8.0, rounded to 9 places.
  const SKLEARN = [
    [1.0, 0.31528907, 0.025066992, 0.016137969, 0.102987798],
    [0.31528907, 1.0, 0.033136639, 0.067617092, 0.033275367],
    [0.025066992, 0.033136639, 1.0, 0.220881856, 0.053070794],
    [0.016137969, 0.067617092, 0.220881856, 1.0, 0.042590879],
    [0.102987798, 0.033275367, 0.053070794, 0.042590879, 1.0],
  ];
  it("every pair to 6 places", () => {
    const S = lexicalSimilarity(docs.map(([idea, action]) => ({ idea, recommendedAction: action })));
    for (let i = 0; i < docs.length; i++) for (let j = 0; j < docs.length; j++) expect(S[i]![j]).toBeCloseTo(SKLEARN[i]![j]!, 6);
  });
});

describe("candidateGroupsOf: complete linkage, so groups never chain", () => {
  it("A~B and B~C above the threshold but A–C below it: not one group", () => {
    const S = [
      [1, 0.3, 0.05],
      [0.3, 1, 0.3],
      [0.05, 0.3, 1],
    ];
    const g = candidateGroupsOf(S, 0.2);
    expect(g.some((grp) => grp.length === 3)).toBe(false);
    expect(g).toEqual([[0, 1]]); // ties broken toward input order; C is left unmatched
  });
  it("a group holds only items whose every pair clears the threshold; singletons are not listed", () => {
    const S = [
      [1, 0.5, 0.4, 0.0],
      [0.5, 1, 0.3, 0.0],
      [0.4, 0.3, 1, 0.0],
      [0.0, 0.0, 0.0, 1],
    ];
    expect(candidateGroupsOf(S, 0.2)).toEqual([[0, 1, 2]]);
  });
});

describe("critique --compare with cluster: lexical", () => {
  const BARE_A = { idea: "SKILL.md does not say what a bare invocation should do.", action: "Add a section for a bare invocation." };
  const BARE_B = { idea: "SKILL.md does not say what a bare invocation should do here.", action: "Add a section on bare invocation." };
  const OTHER = { idea: "The resume codeword is never explained.", action: "Explain the resume codeword in one line." };

  it("writes candidateGroups with no k, N or once; `clusters` is absent; members in input order", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [
      { ...OTHER, fp: "1".repeat(16) },
      { ...BARE_A, fp: "2".repeat(16) },
    ]);
    const b = writeReport(d, "b.json", [{ ...BARE_B, fp: "3".repeat(16) }]);
    const out = compareMembers([loadMember(a), loadMember(b)], { cluster: "lexical" });
    const c = out.clustering as Record<string, unknown>;
    expect(c.mode).toBe("lexical");
    expect(c.population).toBe("citation-resolved");
    expect(c.validated).toBeNull();
    expect(out).not.toHaveProperty("clusters");
    const groups = out.candidateGroups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.basis).toBe("lexical-similarity (a judgement, not a match)");
    expect(groups[0]!.groups).toBeNull();
    expect(groups[0]).not.toHaveProperty("k");
    expect(groups[0]).not.toHaveProperty("label");
    const members = groups[0]!.members as Array<Record<string, unknown>>;
    expect(members.map((m) => m.findingFingerprint)).toEqual(["2".repeat(16), "3".repeat(16)]);
    expect(JSON.stringify(out)).not.toMatch(/reproduced|"once"|not seen after/);
  });

  it("classification is not a key: the same finding under two classifications is grouped", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ ...BARE_A, classification: "grounded-and-actionable", fp: "4".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ ...BARE_B, classification: "speculative", fp: "5".repeat(16) }]);
    const groups = compareMembers([loadMember(a), loadMember(b)], { cluster: "lexical" }).candidateGroups as unknown[];
    expect(groups).toHaveLength(1);
  });

  it("an item whose citation did not resolve is never in a group", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ ...BARE_A, fp: "6".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ ...BARE_B, fp: "7".repeat(16), resolved: false }]);
    expect(compareMembers([loadMember(a), loadMember(b)], { cluster: "lexical" }).candidateGroups).toEqual([]);
  });

  it("the same bytes whatever order the files are given in", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [
      { ...OTHER, fp: "8".repeat(16) },
      { ...BARE_A, fp: "9".repeat(16) },
    ]);
    const b = writeReport(d, "b.json", [{ ...BARE_B, fp: "a".repeat(16) }]);
    const x = compareMembers([loadMember(a), loadMember(b)], { cluster: "lexical" });
    const y = compareMembers([loadMember(b), loadMember(a)], { cluster: "lexical" });
    expect(JSON.stringify(y)).toBe(JSON.stringify(x));
  });

  it("without --cluster the mode is none and there are no candidate groups", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ ...BARE_A, fp: "b".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ ...BARE_B, fp: "c".repeat(16) }]);
    const out = compareMembers([loadMember(a), loadMember(b)]);
    expect((out.clustering as Record<string, unknown>).mode).toBe("none");
    expect(out).not.toHaveProperty("candidateGroups");
  });

  it("the output validates against schema/critique-compare.json in both modes", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ ...BARE_A, fp: "d".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ ...BARE_B, fp: "e".repeat(16) }]);
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(JSON.parse(readFileSync("schema/critique-compare.json", "utf8")));
    for (const cluster of ["none", "lexical"] as const) {
      const ok = validate(compareMembers([loadMember(a), loadMember(b)], { cluster }));
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describe("critique --compare with cluster: lexical — order, indexes, summaries", () => {
  const BIG = (w: string) => ({
    idea: `The ${w} section never says which file to open first.`,
    action: `Name the first file in the ${w} section.`,
  });
  const SMALL = { idea: "The resume codeword is never explained.", action: "Explain the resume codeword in one line." };
  const SMALL2 = { idea: "The resume codeword is never explained here.", action: "Explain the resume codeword in a line." };

  it("groups are listed in input order, never by size (text and JSON)", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [
      { ...SMALL, fp: "1".repeat(16) },
      { ...BIG("setup"), fp: "2".repeat(16) },
    ]);
    const b = writeReport(d, "b.json", [
      { ...SMALL2, fp: "3".repeat(16) },
      { ...BIG("setup"), fp: "4".repeat(16) },
    ]);
    const c = writeReport(d, "c.json", [{ ...BIG("setup"), fp: "5".repeat(16) }]);
    const out = compareMembers([a, b, c].map(loadMember), { cluster: "lexical" });
    const groups = out.candidateGroups as Array<{ members: Array<{ findingFingerprint: string }> }>;
    // the small (2-member) group starts at the first item, so it comes first although the other group is bigger
    expect(groups.map((g) => g.members.map((m) => m.findingFingerprint[0]))).toEqual([
      ["1", "3"],
      ["2", "4", "5"],
    ]);
    const text = renderCompareText(out);
    expect(text.indexOf("candidate group 1:")).toBeLessThan(text.indexOf("candidate group 2:"));
    expect(text.indexOf("1111111111111111")).toBeLessThan(text.indexOf("2222222222222222"));
    const section = text.slice(text.indexOf("candidate groups ("), text.indexOf("excluded ") >= 0 ? text.indexOf("excluded ") : undefined);
    expect(section).toMatch(/a judgement, not a match/);
    expect(section).not.toMatch(/\b\d+\/\d+\b|reproduced|\bonce\b/);
  });

  it("a member's itemIndex is its index in the report, counting the unresolved items left out", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [
      { idea: "An unrelated remark about tone.", action: "None.", fp: "6".repeat(16), resolved: false },
      { ...SMALL, fp: "7".repeat(16) },
    ]);
    const b = writeReport(d, "b.json", [{ ...SMALL2, fp: "8".repeat(16) }]);
    const groups = compareMembers([a, b].map(loadMember), { cluster: "lexical" }).candidateGroups as Array<{
      members: Array<{ itemIndex: number; report: number }>;
    }>;
    expect(groups[0]!.members.map((m) => [m.report, m.itemIndex])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("summaries carry no finding text: they take no part, and the output says so", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ ...SMALL, fp: "9".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ ...SMALL2, fp: "a".repeat(16) }]);
    const s = writeReport(d, "s.json", [{ ...SMALL2, fp: "b".repeat(16) }], {}, true);
    const out = compareMembers([a, b, s].map(loadMember), { cluster: "lexical" });
    const c = out.clustering as Record<string, unknown>;
    expect(c.summariesSkipped).toMatch(/no finding text/);
    expect(c.findingsCompared).toBe(2);
    const fps = (out.candidateGroups as Array<{ members: Array<{ findingFingerprint: string }> }>).flatMap((g) =>
      g.members.map((m) => m.findingFingerprint),
    );
    expect(fps).not.toContain("b".repeat(16));
  });
});

describe("critique --compare with cluster: lexical — groups are across critiques", () => {
  const A1 = { idea: "The resume codeword is never explained.", action: "Explain the resume codeword in one line." };
  const A2 = { idea: "The resume codeword is never explained here.", action: "Explain the resume codeword in a line." };
  const OTHER = { idea: "The output folder is not named anywhere.", action: "Name the output folder." };

  it("two near-identical findings in ONE report make no group; the same pair across two reports does", () => {
    const d = dir();
    const one = writeReport(d, "one.json", [
      { ...A1, fp: "1".repeat(16) },
      { ...A2, fp: "2".repeat(16) },
    ]);
    const other = writeReport(d, "other.json", [{ ...OTHER, fp: "3".repeat(16) }]);
    expect(compareMembers([one, other].map(loadMember), { cluster: "lexical" }).candidateGroups).toEqual([]);

    const a = writeReport(d, "a.json", [{ ...A1, fp: "4".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ ...A2, fp: "5".repeat(16) }]);
    const groups = compareMembers([a, b].map(loadMember), { cluster: "lexical" }).candidateGroups as Array<{
      members: Array<{ report: number }>;
    }>;
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.members.map((m) => m.report)).size).toBe(2);
  });

  it("a group spanning two reports keeps its same-report members", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [
      { ...A1, fp: "6".repeat(16) },
      { ...A2, fp: "7".repeat(16) },
    ]);
    const b = writeReport(d, "b.json", [{ ...A1, fp: "8".repeat(16) }]);
    const groups = compareMembers([a, b].map(loadMember), { cluster: "lexical" }).candidateGroups as Array<{
      members: Array<{ findingFingerprint: string }>;
    }>;
    expect(groups.map((g) => g.members.map((m) => m.findingFingerprint[0]))).toEqual([["6", "7", "8"]]);
  });

  it("findings with no idea and no action text take no part (they would match on the separator alone)", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ idea: "", action: "  ", fp: "9".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ idea: "", action: "", fp: "a".repeat(16) }]);
    const out = compareMembers([a, b].map(loadMember), { cluster: "lexical" });
    expect(out.candidateGroups).toEqual([]);
    expect((out.clustering as Record<string, unknown>).findingsCompared).toBe(0);
  });
});

describe("the judge stays held and nothing can say reproduced", () => {
  it("the gate constant is null and the user-facing judge is off", () => {
    expect(CLUSTER_GATE).toBeNull();
    expect(USER_FACING_CLUSTER_JUDGE).toBe(false);
    expect(LEXICAL_GROUP_THRESHOLD).toBe(0.2);
  });
  it("compareMembers refuses cluster: judge", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [{ idea: "x one", action: "y", fp: "f".repeat(16) }]);
    const b = writeReport(d, "b.json", [{ idea: "x two", action: "y", fp: "0".repeat(16) }]);
    expect(() => compareMembers([loadMember(a), loadMember(b)], { cluster: "judge" as never })).toThrow(/--cluster judge/);
  });
});

describe.skipIf(!existsSync(CLI))("critique --compare --cluster (CLI)", () => {
  it("--cluster lexical exits 0 with candidate groups; --cluster judge is a usage refusal (exit 2); a bad value too", () => {
    const d = dir();
    const a = writeReport(d, "a.json", [
      { idea: "SKILL.md does not say what a bare invocation should do.", action: "Add a section.", fp: "1".repeat(16) },
    ]);
    const b = writeReport(d, "b.json", [
      { idea: "SKILL.md does not say what a bare invocation should do here.", action: "Add a section.", fp: "2".repeat(16) },
    ]);
    const ok = spawnSync("node", [CLI, "critique", "--compare", a, b, "--cluster", "lexical", "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).candidateGroups).toHaveLength(1);
    const text = spawnSync("node", [CLI, "critique", "--compare", a, b, "--cluster", "lexical"], { encoding: "utf8" });
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/candidate group/);
    expect(text.stdout).toMatch(/a judgement, not a match/);
    const judge = spawnSync("node", [CLI, "critique", "--compare", a, b, "--cluster", "judge"], { encoding: "utf8" });
    expect(judge.status).toBe(2);
    expect(judge.stderr + judge.stdout).toMatch(/--cluster judge/);
    const bad = spawnSync("node", [CLI, "critique", "--compare", a, b, "--cluster", "fuzzy"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
  });
});
