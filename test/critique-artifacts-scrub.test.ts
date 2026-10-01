import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { persistCritiqueArtifacts, writeOutFile } from "../src/critique/command";

// Every file `critique` writes is secret-scrubbed like the run's own result.json/run.jsonl/trace.json.
// The evaluator's replies, the skill's self-report and the evidence package are free text the graded run
// produced, and could carry a value every other artifact of the same run shows as [REDACTED].
//
// The secret comes from COWORK_HARNESS_SCRUB_VALUES and is read by the write path itself (no secrets
// argument is passed anywhere here), so these tests cover the wiring, not just a scrub function.

const SECRET = "sk-planted-9f3a7c1e5b";
const ENV_KEY = "COWORK_HARNESS_SCRUB_VALUES";
const savedEnv = process.env[ENV_KEY];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function stateWith(secret: string, overrides: Record<string, unknown> = {}) {
  return {
    skillFolder: "./s",
    prompt: `analyse the deck, key is ${secret}`,
    sessionId: "sess-x",
    outDir: "/tmp/ignored",
    fidelity: "container",
    taskResult: "success" as const,
    gradedSkillHash: "0123456789abcdef0123",
    gradedSkill: "deck-review",
    selfReportStatus: "captured" as const,
    gateAnswers: [{ question: `use token ${secret}?`, answer: `yes, ${secret}`, answeredBy: "script" }],
    items: [
      {
        source: "evaluator" as const,
        idea: `the skill echoed ${secret} into its report`,
        classification: "grounded-and-actionable" as const,
        evidence: `printed: ${secret}`,
        recommendedAction: `stop printing ${secret}`,
        citationResolved: true,
        findingFingerprint: "aaaabbbbccccdddd",
      },
    ],
    requestedModel: "m",
    ...overrides,
  };
}

const filesIn = (dir: string) => readdirSync(dir).map((f) => join(dir, f));

describe("critique run-dir artifacts are secret-scrubbed", () => {
  it("critique-report.json and critique-evidence-package.txt: no planted value, [REDACTED] in its place, JSON parses, ids intact", () => {
    process.env[ENV_KEY] = SECRET;
    const dir = tmp("crit-scrub-");
    persistCritiqueArtifacts(dir, { ...stateWith(SECRET), outDir: dir }, `EVIDENCE: the agent wrote ${SECRET} to stdout`, {
      rawEvaluatorReplies: [],
    });
    const written = filesIn(dir);
    expect(written.map((f) => f.slice(dir.length + 1)).sort()).toEqual(["critique-evidence-package.txt", "critique-report.json"]);
    for (const f of written) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain(SECRET);
      expect(text, f).toContain("[REDACTED]");
    }
    const report = JSON.parse(readFileSync(join(dir, "critique-report.json"), "utf8"));
    expect(report.prompt).toBe("analyse the deck, key is [REDACTED]");
    expect(report.items[0].idea).toBe("the skill echoed [REDACTED] into its report");
    expect(report.items[0].evidence).toBe("printed: [REDACTED]");
    expect(report.items[0].recommendedAction).toBe("stop printing [REDACTED]");
    expect(report.gateAnswers[0]).toEqual({ question: "use token [REDACTED]?", answer: "yes, [REDACTED]", answeredBy: "script" });
    // join / identity fields kept as written
    expect(report.sessionId).toBe("sess-x");
    expect(report.outDir).toBe(dir);
    expect(report.gradedSkillHash).toBe("0123456789abcdef0123");
    expect(report.gradedSkill).toBe("deck-review");
    expect(report.items[0].findingFingerprint).toBe("aaaabbbbccccdddd");
    expect(report.items[0].classification).toBe("grounded-and-actionable");
    expect(report.items[0].citationResolved).toBe(true);
    expect(readFileSync(join(dir, "critique-evidence-package.txt"), "utf8")).toBe("EVIDENCE: the agent wrote [REDACTED] to stdout");
  });

  it("critique-salvage.json: self-report, raw evaluator replies and the error text are scrubbed; the file parses", () => {
    process.env[ENV_KEY] = SECRET;
    const dir = tmp("crit-scrub-");
    persistCritiqueArtifacts(dir, { ...stateWith(SECRET, { evaluatorError: `pass 2 choked on ${SECRET}` }), outDir: dir }, undefined, {
      selfReport: `I had to paste ${SECRET} to continue`,
      rawEvaluatorReplies: [
        { pass: 1, raw: `{"items":[{"idea":"${SECRET}"}]}` },
        { pass: 2, raw: `NOT JSON ${SECRET}` },
      ],
    });
    const written = filesIn(dir);
    expect(written.map((f) => f.slice(dir.length + 1)).sort()).toEqual(["critique-report.json", "critique-salvage.json"]);
    for (const f of written) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain(SECRET);
      expect(text, f).toContain("[REDACTED]");
    }
    const salvage = JSON.parse(readFileSync(join(dir, "critique-salvage.json"), "utf8"));
    expect(salvage.selfReport).toBe("I had to paste [REDACTED] to continue");
    expect(salvage.evaluatorError).toBe("pass 2 choked on [REDACTED]");
    expect(salvage.rawEvaluatorReplies).toEqual([
      { pass: 1, raw: '{"items":[{"idea":"[REDACTED]"}]}' },
      { pass: 2, raw: "NOT JSON [REDACTED]" },
    ]);
    expect(salvage.reportState.sessionId).toBe("sess-x");
    expect(salvage.reportState.gradedSkillHash).toBe("0123456789abcdef0123");
  });

  it("scrubs string VALUES, not the serialized text: a JSON-token scrub value cannot break parsing", () => {
    // `true` is a JSON literal in every report (`citationResolved: true`). A text-level scrub of the
    // serialized report rewrites it to `[REDACTED]` and the file no longer parses.
    process.env[ENV_KEY] = "true";
    const dir = tmp("crit-scrub-");
    persistCritiqueArtifacts(dir, { ...stateWith("true", { evaluatorError: "x is true" }), outDir: dir }, "evidence is true", {
      selfReport: "it is true",
      rawEvaluatorReplies: [{ pass: 1, raw: "true" }],
    });
    const report = JSON.parse(readFileSync(join(dir, "critique-report.json"), "utf8"));
    expect(report.items).toEqual([]); // evaluator-error branch
    const salvage = JSON.parse(readFileSync(join(dir, "critique-salvage.json"), "utf8"));
    expect(salvage.selfReport).toBe("it is [REDACTED]");
    expect(salvage.rawEvaluatorReplies[0].raw).toBe("[REDACTED]");
    expect(salvage.reportState.verdictProvenance.advisory).toBe(true);
    // and the clean-run report's booleans survive too
    const dir2 = tmp("crit-scrub-");
    persistCritiqueArtifacts(dir2, { ...stateWith("true"), outDir: dir2 }, undefined, { rawEvaluatorReplies: [] });
    const r2 = JSON.parse(readFileSync(join(dir2, "critique-report.json"), "utf8"));
    expect(r2.items[0].citationResolved).toBe(true);
    expect(r2.items[0].idea).toBe("the skill echoed [REDACTED] into its report");
  });

  it("a short scrub value never rewrites an identifier, hash or enum field", () => {
    process.env[ENV_KEY] = "beef";
    const dir = tmp("crit-scrub-");
    persistCritiqueArtifacts(
      dir,
      {
        ...stateWith("beef", {
          sessionId: "sess-beef",
          gradedSkillHash: "deadbeefcafe",
          gradedSkill: "beef-skill",
          gradedModels: ["claude-beef"],
        }),
        outDir: join(dir, "."),
      },
      undefined,
      { rawEvaluatorReplies: [] },
    );
    const report = JSON.parse(readFileSync(join(dir, "critique-report.json"), "utf8"));
    expect(report.sessionId).toBe("sess-beef");
    expect(report.gradedSkillHash).toBe("deadbeefcafe");
    expect(report.gradedSkill).toBe("beef-skill");
    expect(report.gradedModels).toEqual(["claude-beef"]);
    expect(report.items[0].idea).toBe("the skill echoed [REDACTED] into its report");
  });
});

describe("critique --out file is secret-scrubbed", () => {
  for (const fmt of ["json", "text"] as const) {
    it(`--output-format ${fmt}`, () => {
      process.env[ENV_KEY] = SECRET;
      const dir = tmp("crit-scrub-out-");
      const out = join(dir, `report.${fmt}`);
      writeOutFile(out, { ...stateWith(SECRET), outDir: dir }, fmt);
      const text = readFileSync(out, "utf8");
      expect(text).not.toContain(SECRET);
      expect(text).toContain("[REDACTED]");
      if (fmt === "json") {
        const report = JSON.parse(text);
        expect(report.sessionId).toBe("sess-x");
        expect(report.items[0].findingFingerprint).toBe("aaaabbbbccccdddd");
        expect(report.items[0].idea).toBe("the skill echoed [REDACTED] into its report");
      }
    });
  }
});

// `--corpus-only --out`: no run behind it, so the only text is file names and the skill path. Black-box
// through dist/cli.js (the write is inline in the command). JSON: a packaged reference whose NAME is the value
// (the JSON lists packaged names; its `skillFolder`/`skillDir` paths are kept verbatim as join keys). Text:
// the value in the skill folder's path (the text headline prints it; it does not list packaged names).
const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("critique --corpus-only --out is secret-scrubbed", () => {
  function fixture(prefix: string): string {
    const root = tmp(prefix);
    writeFileSync(join(root, "SKILL.md"), "---\nname: simple\n---\n# Simple\nA small skill.\n");
    mkdirSync(join(root, "references"), { recursive: true });
    writeFileSync(join(root, "references", `${SECRET}.md`), "Reference.\n");
    for (const a of [
      ["init", "-q"],
      ["config", "user.email", "t@t.t"],
      ["config", "user.name", "t"],
      ["add", "-A"],
    ])
      execFileSync("git", a, { cwd: root, stdio: "ignore" });
    return root;
  }
  for (const fmt of ["json", "text"] as const) {
    it(`--output-format ${fmt}`, () => {
      const root = fixture(fmt === "json" ? "crit-scrub-corpus-" : `crit-scrub-corpus-${SECRET}-`);
      const runDir = tmp("crit-scrub-rundir-");
      const out = join(tmp("crit-scrub-outdir-"), "corpus.out");
      const r = spawnSync("node", [CLI, "--run-dir", runDir, "critique", root, "--corpus-only", "--output-format", fmt, "--out", out], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, [ENV_KEY]: SECRET },
      });
      expect(r.status, r.stderr).toBe(0);
      const text = readFileSync(out, "utf8");
      expect(text).not.toContain(SECRET);
      expect(text).toContain(fmt === "json" ? "references/[REDACTED].md" : "crit-scrub-corpus-[REDACTED]-");
      if (fmt === "json") {
        const doc = JSON.parse(text);
        expect(doc.mode).toBe("corpus-only");
        expect(doc.skillFolder).toBe(root); // path kept as written (raw by machine-capture contract)
        expect(doc.corpus.corpusPackaged).toContain("references/[REDACTED].md");
      }
    });
  }
});
