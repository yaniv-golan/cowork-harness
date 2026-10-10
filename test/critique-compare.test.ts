// `critique --compare`: real reports and summaries, written by the real writers (`writeOutFile`,
// `writeSummaryIfAsked`), compared through the CLI and through `compareMembers`. No verdicts; k/N everywhere.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, writeOutFile, writeSummaryIfAsked } from "../src/critique/command.js";
import { compareMembers, loadMember, CompareRefusal, MARKS, STRICT_MARKS } from "../src/critique/compare.js";

const CLI = resolve("dist/cli.js");
const H = (c: string) => `sha256:${c.repeat(64)}`;
let n = 0;

type Item = { idea: string; classification: string; evidence: string; action?: string; fp: string; source?: string };
function reportState(items: Item[], over: Record<string, unknown> = {}) {
  n++;
  return {
    harnessVersion: "4.8.0",
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
      source: i.source ?? "evaluator",
      idea: i.idea,
      classification: i.classification,
      evidence: i.evidence,
      recommendedAction: i.action ?? "do the thing",
      citationResolved: true,
      findingFingerprint: i.fp,
    })),
    ...over,
  } as unknown as Parameters<typeof writeOutFile>[1];
}

const dir = () => mkdtempSync(join(tmpdir(), "cwh-compare-"));
function writeReport(d: string, name: string, st: ReturnType<typeof reportState>): string {
  const p = join(d, name);
  writeOutFile(p, st, "json");
  return p;
}
function writeSummary(d: string, name: string, st: ReturnType<typeof reportState>): string {
  const p = join(d, name);
  writeSummaryIfAsked(parseArgs(["./s", "--prompt", "p", "--summary-out", p]), st);
  return p;
}
const cmp = (files: string[], strict = false) => compareMembers(files.map(loadMember), { strict });

const PASSAGE = "the skill never says which currency the figures use";
const A = {
  idea: "Currency is unspecified in the output table",
  classification: "grounded-and-actionable",
  evidence: PASSAGE,
  fp: "aaaaaaaaaaaaaaaa",
};
const B = {
  idea: "The rounding rule is undocumented for small totals",
  classification: "grounded-and-actionable",
  evidence: PASSAGE,
  fp: "bbbbbbbbbbbbbbbb",
};
const C = {
  idea: "Currency is unspecified in the output table rows",
  classification: "grounded-and-actionable",
  evidence: "another quoted passage here",
  fp: "cccccccccccccccc",
};
const NA = { idea: "Cannot tell whether the cache was used", classification: "not-adjudicable", evidence: "", fp: "dddddddddddddddd" };

describe("critique --compare", () => {
  it("one group: findings aligned by classification, exact matches as k/N, shared excerpts as an aid — and no verdict", () => {
    const d = dir();
    const out = cmp([
      writeReport(d, "1.json", reportState([A, NA])),
      writeReport(d, "2.json", reportState([A, B, NA])),
      writeReport(d, "3.json", reportState([C])),
    ]);
    const g = (out.groups as Array<Record<string, unknown>>)[0]!;
    expect(g.N).toBe(3);
    expect(g.sameWording).toEqual([
      { findingFingerprint: "aaaaaaaaaaaaaaaa", classification: "grounded-and-actionable", k: 2, N: 3 },
      { findingFingerprint: "dddddddddddddddd", classification: "not-adjudicable", k: 2, N: 3 },
    ]);
    // A and B cite the same passage with different ideas; the not-adjudicable items' empty evidence is not a passage.
    expect(g.sharedExcerpt).toEqual([
      { anchor: expect.stringMatching(/^[0-9a-f]{16}$/), k: 2, N: 3, distinctIdeas: 2, distinctActions: 1 },
    ]);
    expect(Object.keys(g.byClassification as object)).toEqual(["grounded-and-actionable", "not-adjudicable"]);
    expect((out.possibleRewordings as { pairs: unknown[] }).pairs.length).toBeGreaterThan(0); // A vs C
    expect(out.publicSafe).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/"(reproduced|oneOff|one-off|gone|new|persists|weakened|emerging|status)"/);
  });

  it("two label groups: each fingerprint with k/N per group; equal corpusHash is a noise-floor control", () => {
    const d = dir();
    const out = cmp([
      writeReport(d, "b1.json", reportState([A], { label: "before" })),
      writeReport(d, "b2.json", reportState([A, B], { label: "before" })),
      writeReport(d, "a1.json", reportState([B], { label: "after" })),
    ]);
    expect(out.noiseFloorControl).toBe(true);
    expect((out.groups as Array<{ label: string }>).map((g) => g.label)).toEqual(["after", "before"]);
    expect(out.fingerprints).toEqual([
      {
        findingFingerprint: "aaaaaaaaaaaaaaaa",
        classification: "grounded-and-actionable",
        groups: [
          { k: 0, N: 1 },
          { k: 2, N: 2 },
        ],
      },
      {
        findingFingerprint: "bbbbbbbbbbbbbbbb",
        classification: "grounded-and-actionable",
        groups: [
          { k: 1, N: 1 },
          { k: 1, N: 2 },
        ],
      },
    ]);
    const changed = cmp([
      writeReport(d, "b3.json", reportState([A], { label: "before" })),
      writeReport(
        d,
        "a3.json",
        reportState([A], {
          label: "after",
          corpus: {
            corpusHashScheme: 1,
            hashBasis: "git-commit",
            corpusHash: H("9"),
            skillTreeHash: H("c"),
            corpusManifest: [],
            skillTreeUntracked: [],
          },
        }),
      ),
    ]);
    expect(changed.noiseFloorControl).toBe(false);
  });

  it("a not-adjudicable item never keys a shared excerpt, even with a long cited passage", () => {
    const d = dir();
    const NA2 = {
      idea: "Unclear whether the cache was used",
      classification: "not-adjudicable",
      evidence: PASSAGE,
      fp: "eeeeeeeeeeeeeeee",
    };
    const NA3 = { idea: "Unclear whether retries happened", classification: "not-adjudicable", evidence: PASSAGE, fp: "ffffffffffffffff" };
    const out = cmp([writeReport(d, "1.json", reportState([NA2])), writeReport(d, "2.json", reportState([NA3]))]);
    expect((out.groups as Array<{ sharedExcerpt: unknown[] }>)[0]!.sharedExcerpt).toEqual([]);
  });

  it("two groups whose corpusHash is unknown (withheld in a summary) are NOT a noise-floor control", () => {
    const d = dir();
    const noHash = (label: string) => {
      const p = join(d, `${label}.json`);
      writeSummary(d, `${label}.json`, reportState([A], { label }));
      const j = JSON.parse(readFileSync(p, "utf8"));
      j.corpusHash = null;
      writeFileSync(p, JSON.stringify(j));
      return p;
    };
    expect(cmp([noHash("before"), noHash("after")]).noiseFloorControl).toBe(false);
  });

  it("a scripts/-only change between groups is NOT a noise-floor control; inside a group it is marked mixedSkillTree", () => {
    const d = dir();
    const corpusWith = (tree: string) => ({
      corpusHashScheme: 1,
      hashBasis: "git-commit",
      corpusHash: H("a"),
      packagedCorpusHash: H("b"),
      skillTreeHash: H(tree),
      corpusManifest: [],
      skillTreeUntracked: [],
      skillTreeUntrackedCount: 0,
    });
    const across = cmp([
      writeReport(d, "b.json", reportState([A], { label: "before", corpus: corpusWith("1") })),
      writeReport(d, "a.json", reportState([A], { label: "after", corpus: corpusWith("2") })),
    ]);
    expect(across.noiseFloorControl).toBe(false);
    const within = [
      writeReport(d, "w1.json", reportState([A], { corpus: corpusWith("1") })),
      writeReport(d, "w2.json", reportState([A], { corpus: corpusWith("2") })),
    ];
    expect((cmp(within).groups as Array<{ marks: string[] }>)[0]!.marks).toContain("mixedSkillTree");
    expect(() => cmp(within, true)).toThrow(/mixedSkillTree/);
  });

  it("--strict refuses exactly the strict marks; probeUnverified and mixedPackagedCorpus are marked only", () => {
    const d = dir();
    // probeUnverified: summaries carry no prompt hash by default. mixedPackagedCorpus: packaged hashes differ.
    const a = reportState([A]);
    const b = reportState([A], {
      corpus: {
        corpusHashScheme: 1,
        hashBasis: "git-commit",
        corpusHash: H("a"),
        packagedCorpusHash: H("f"),
        skillTreeHash: H("c"),
        corpusManifest: [],
        skillTreeUntracked: [],
        skillTreeUntrackedCount: 0,
      },
    });
    const out = cmp([writeSummary(d, "s1.json", a), writeSummary(d, "s2.json", b)], true);
    expect((out.groups as Array<{ marks: string[] }>)[0]!.marks.sort()).toEqual(["mixedPackagedCorpus", "probeUnverified"]);
    expect([...STRICT_MARKS].sort()).toEqual(["mixedBasis", "mixedEvaluator", "mixedProbe", "mixedSkillTree", "pass1Only"]);
  });

  it("excludes canary-failed and drifted critiques from N; a group with nothing left is refused", () => {
    const d = dir();
    const out = cmp([
      writeReport(d, "ok1.json", reportState([A])),
      writeReport(d, "ok2.json", reportState([A])),
      writeReport(d, "canary.json", reportState([A], { evaluatorIntegrity: { pass1Canary: false, pass2Canary: true } })),
      writeReport(
        d,
        "drift.json",
        reportState([A], {
          corpus: {
            corpusHashScheme: 1,
            hashBasis: "git-commit",
            corpusHash: H("a"),
            packagedCorpusHash: H("b"),
            skillTreeHash: H("c"),
            corpusManifest: [],
            skillTreeUntracked: [],
            skillTreeUntrackedCount: 0,
            corpusDrift: { preflightCorpusHash: H("9"), preflightSkillTreeHash: H("9"), changed: ["x"] },
          },
        }),
      ),
    ]);
    expect((out.groups as Array<{ N: number }>)[0]!.N).toBe(2);
    expect((out.excluded as Array<{ reason: string }>).map((e) => e.reason).join(" | ")).toMatch(/canary.*\|.*drift|drift.*\|.*canary/i);
    expect(() =>
      cmp([
        writeReport(d, "x1.json", reportState([A], { label: "before" })),
        writeReport(d, "x2.json", reportState([], { label: "after", infraFailure: "q", infraFailurePhase: "task turn" })),
      ]),
    ).toThrow(/has no usable critique/);
  });

  it("refuses a scheme mix, a text-format report and an unreadable file", () => {
    const d = dir();
    const ok = writeReport(d, "ok.json", reportState([A]));
    const other = join(d, "scheme.json");
    writeReport(d, "scheme.json", reportState([A]));
    const j = JSON.parse(readFileSync(other, "utf8"));
    j.fingerprintScheme = 2;
    writeFileSync(other, JSON.stringify(j));
    expect(() => cmp([ok, other])).toThrow(/fingerprint schemes/);
    const text = join(d, "report.txt");
    writeFileSync(text, "critique report\n  graded skill: x\n");
    expect(() => loadMember(text)).toThrow(/not JSON/);
    expect(() => loadMember(join(d, "nope.json"))).toThrow(/cannot be read/);
  });

  it("an excerpt under 12 characters never keys a shared excerpt", () => {
    const d = dir();
    const S1 = { idea: "Short quote one", classification: "grounded-and-actionable", evidence: "too short", fp: "1212121212121212" };
    const S2 = { idea: "Short quote two", classification: "grounded-and-actionable", evidence: "too short", fp: "3434343434343434" };
    expect(
      (
        cmp([writeReport(d, "1.json", reportState([S1])), writeReport(d, "2.json", reportState([S2]))]).groups as Array<{
          sharedExcerpt: unknown[];
        }>
      )[0]!.sharedExcerpt,
    ).toEqual([]);
  });

  it("every mark is documented in docs/critique.md and the compare schema, and the strict set in critique --help", () => {
    const doc = readFileSync(resolve("docs/critique.md"), "utf8");
    const schema = readFileSync(resolve("schema/critique-compare.json"), "utf8");
    for (const m of MARKS) {
      expect(doc, m).toContain(`\`${m}\``);
      expect(schema, m).toContain(`"${m}"`);
    }
  });

  it("refuses a summary that withheld a field compare groups on (a label would otherwise merge before/after)", () => {
    const d = dir();
    const p = writeSummary(d, "w.json", reportState([A], { label: "before" }));
    const j = JSON.parse(readFileSync(p, "utf8"));
    j.label = null;
    j.withheld = ["label"];
    writeFileSync(p, JSON.stringify(j));
    expect(() => loadMember(p)).toThrow(/withheld label/);
  });

  it("the same output whatever order the files are given in", () => {
    const d = dir();
    const files = [
      writeReport(d, "1.json", reportState([A])),
      writeReport(d, "2.json", reportState([B, A])),
      writeReport(d, "3.json", reportState([C])),
    ];
    expect(JSON.stringify(cmp([files[2]!, files[0]!, files[1]!]))).toBe(JSON.stringify(cmp(files)));
  });

  it("refusals", () => {
    const d = dir();
    const r = (st: ReturnType<typeof reportState>, name: string) => writeReport(d, name, st);
    const ok1 = r(reportState([A]), "ok1.json");
    const cases: Array<[string[], RegExp]> = [
      [[ok1], /at least two/],
      [[ok1, r(reportState([A], { summaryIdentity: { name: "plug:other", kind: "plugin_skill" } }), "s.json")], /mix graded skills/],
      [
        [
          ok1,
          r(
            reportState([A], {
              corpus: {
                corpusHashScheme: 1,
                hashBasis: "git-commit",
                corpusHash: H("e"),
                skillTreeHash: H("c"),
                corpusManifest: [],
                skillTreeUntracked: [],
              },
            }),
            "h.json",
          ),
        ],
        /mixes corpusHash/,
      ],
      [[ok1, r(reportState([A], { label: "x" }), "l.json")], /some inputs carry a --label/],
      [[ok1, ok1], /are the same critique/],
      [[ok1, r(reportState([A], { harnessVersion: "5.0.0" }), "v.json")], /harness major versions/],
    ];
    for (const [files, re] of cases) expect(() => cmp(files)).toThrow(re);
    const old = join(d, "old.json");
    writeFileSync(old, JSON.stringify({ verdictProvenance: {}, items: [], skillFolder: "x" }));
    expect(() => loadMember(old)).toThrow(/before 4\.8\.0/);
    const env = join(d, "env.json");
    writeFileSync(env, JSON.stringify({ tool: "cowork-harness", command: "critique", mode: "corpus-only" }));
    expect(() => loadMember(env)).toThrow(/corpus-only/);
    const three = ["a", "b", "c"].map((l) => r(reportState([A], { label: l }), `${l}.json`));
    expect(() => cmp(three)).toThrow(/3 label groups/);
    expect(CompareRefusal).toBeDefined();
  });

  it("marks a group mixing evaluator models; --strict refuses it", () => {
    const d = dir();
    const files = [
      writeReport(d, "1.json", reportState([A])),
      writeReport(d, "2.json", reportState([A], { evaluatorModel: "claude-sonnet-5" })),
    ];
    expect((cmp(files).groups as Array<{ marks: string[] }>)[0]!.marks).toEqual(["mixedEvaluator"]);
    expect(() => cmp(files, true)).toThrow(/--strict: .* mixedEvaluator/);
  });

  it("a critique with no result is excluded from N and listed", () => {
    const d = dir();
    const out = cmp([
      writeReport(d, "1.json", reportState([A])),
      writeReport(d, "2.json", reportState([A])),
      writeReport(d, "3.json", reportState([], { infraFailure: "quota", infraFailurePhase: "task turn" })),
    ]);
    expect((out.groups as Array<{ N: number }>)[0]!.N).toBe(2);
    expect(out.excluded).toEqual([{ file: expect.stringMatching(/3\.json$/), reason: expect.stringMatching(/no critique/) }]);
  });

  it("summaries compare by fingerprint, with no rewording bucket; a summary and its own report are the same critique", () => {
    const d = dir();
    const s1 = reportState([A, B]);
    const s2 = reportState([A]);
    const out = cmp([writeSummary(d, "s1.json", s1), writeSummary(d, "s2.json", s2)]);
    expect((out.groups as Array<{ sameWording: unknown[] }>)[0]!.sameWording).toEqual([
      { findingFingerprint: "aaaaaaaaaaaaaaaa", classification: "grounded-and-actionable", k: 2, N: 2 },
    ]);
    expect((out.possibleRewordings as { basis: string }).basis).toMatch(/unavailable/);
    expect(() => cmp([writeSummary(d, "s3.json", s1), writeReport(d, "r3.json", s1)])).toThrow(/same critique/);
  });
});

describe.skipIf(!existsSync(CLI))("critique --compare (CLI)", () => {
  it("prints the standard envelope, exits 0, and refuses a run flag with --compare", () => {
    const d = dir();
    const files = [writeReport(d, "1.json", reportState([A])), writeReport(d, "2.json", reportState([A, B]))];
    const r = spawnSync("node", [CLI, "critique", "--compare", ...files, "--output-format", "json"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout);
    expect([env.tool, env.command, env.ok, env.mode, env.publicSafe]).toEqual(["cowork-harness", "critique", true, "compare", false]);
    const bad = spawnSync("node", [CLI, "critique", "--compare", ...files, "--prompt", "x", "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout).error.message).toMatch(/--prompt is not accepted with --compare/);
    const schema = JSON.parse(readFileSync(resolve("schema/critique-compare.json"), "utf8"));
    const { tool: _t, version: _v, command: _c, ok: _o, error: _e, ...payload } = env;
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    const outFile = join(d, "cmp.json");
    const withOut = spawnSync("node", [CLI, "critique", "--compare", ...files, "--output-format", "json", "--out", outFile], {
      encoding: "utf8",
    });
    expect(readFileSync(outFile, "utf8")).toBe(withOut.stdout);
    // stdout also passes the CLI-wide scrub; the --out FILE is only scrubbed by compare itself.
    const scrubOut = join(d, "scrubbed.json");
    const scrubbed = spawnSync("node", [CLI, "critique", "--compare", ...files, "--output-format", "json", "--out", scrubOut], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_SCRUB_VALUES: d.split("/").pop()! },
    });
    expect(scrubbed.status).toBe(0);
    expect(readFileSync(scrubOut, "utf8")).not.toContain(d.split("/").pop()!); // the report paths carry the dir name
    const top = spawnSync("node", [CLI, "--help"], { encoding: "utf8" });
    expect(top.stdout + top.stderr).toMatch(/critique --compare/);
    const text = spawnSync("node", [CLI, "critique", "--compare", ...files], { encoding: "utf8" });
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/no verdicts/);
  });
});
