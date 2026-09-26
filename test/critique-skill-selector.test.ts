import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCritiquedSkillDir, parseArgs } from "../src/critique/command";
import { packageEvidence, renderSections } from "../src/critique/package-evidence";
import { snapshotTurnBoundary } from "../src/critique/evidence";

// WS "--skill / plugin-aware packaging": the resolver that decides WHICH folder the packager grades, and
// the agents/references content sections. The field failure this covers: a multi-skill plugin root graded
// as "SKILL.md: missing" -> 100% of coverage findings not-adjudicable.

function makePlugin(skills: string[], opts: { agentsFor?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "crit-plugin-"));
  for (const s of skills) {
    mkdirSync(join(root, "skills", s), { recursive: true });
    writeFileSync(join(root, "skills", s, "SKILL.md"), `# ${s}\nguidance for ${s}`);
  }
  for (const a of opts.agentsFor ?? []) {
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", `${a}.md`), `system prompt for ${a} sub-agents`);
  }
  return root;
}

describe("resolveCritiquedSkillDir", () => {
  it("a plain skill folder resolves to itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# plain");
    // `agents` is [] rather than absent: a bare skill dir with no plugin manifest has no agents/ to
    // resolve against. Asserted field-by-field, not with an exact-object match — the resolver gained an
    // `agents` array and a whole-object toEqual would red on any future additive field.
    const r = resolveCritiquedSkillDir(dir, undefined);
    expect(r.skillDir).toBe(dir);
    expect(r.agents).toEqual([]);
  });

  it("--skill <name> resolves skills/<name>/ and its agents/<name>.md", () => {
    const root = makePlugin(["market-sizing", "ic-sim"], { agentsFor: ["market-sizing"] });
    const r = resolveCritiquedSkillDir(root, "market-sizing");
    expect(r.skillDir).toBe(join(root, "skills", "market-sizing"));
    expect(r.agents.map((a) => a.absPath)).toEqual([join(root, "agents", "market-sizing.md")]);
    expect(r.pluginRoot).toBe(root);
  });

  it("--skill with a wrong name fails loud NAMING the available skills", () => {
    const root = makePlugin(["market-sizing", "ic-sim"]);
    expect(() => resolveCritiquedSkillDir(root, "nope")).toThrow(/available skills: ic-sim, market-sizing/);
  });

  it("a multi-skill root with NO --skill is refused before any model spend", () => {
    const root = makePlugin(["a", "b"]);
    expect(() => resolveCritiquedSkillDir(root, undefined)).toThrow(/multi-skill plugin root.*pass --skill/s);
  });

  it("a single-skill plugin auto-selects (with the name reported)", () => {
    const root = makePlugin(["only"]);
    const r = resolveCritiquedSkillDir(root, undefined);
    expect(r.skillDir).toBe(join(root, "skills", "only"));
    expect(r.autoSelectedSkill).toBe("only");
  });

  it("no SKILL.md anywhere falls through to the packager's existing missing/degraded flow", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-empty-"));
    const r = resolveCritiquedSkillDir(dir, undefined);
    expect(r.skillDir).toBe(dir);
    expect(r.agents).toEqual([]);
  });
});

describe("packageEvidence: agents/references content sections", () => {
  function runDirStub(): string {
    // packageEvidence degrades gracefully on an empty run dir — these tests only exercise the
    // skill-source sections, which read from skillDir and the resolved agent files.
    return mkdtempSync(join(tmpdir(), "crit-run-"));
  }

  it("packages the invoked skill's agents/<name>.md content when resolved", () => {
    const root = makePlugin(["ms"], { agentsFor: ["ms"] });
    const runDir = runDirStub();
    const { sections } = packageEvidence(runDir, snapshotTurnBoundary(runDir), join(root, "skills", "ms"), false, {
      agents: [{ name: "ms", absPath: join(root, "agents", "ms.md"), rel: "agents/ms.md", via: "skill-named" }],
      pluginRoot: root,
      mountRoot: root,
    });
    const rendered = renderSections(sections);
    expect(rendered).toContain("system prompt for ms sub-agents");
    expect(rendered).toContain("agents markdown (ms.md");
  });

  it("packages references/*.md CONTENT (not just filenames), bounded, with per-file headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# s");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "rubric.md"), "score exhaustively on 28 dimensions");
    const runDir = runDirStub();
    const { sections } = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir, false, { mountRoot: dir });
    const rendered = renderSections(sections);
    // Mutation guard: reverting to filenames-only drops the body text and reds this.
    expect(rendered).toContain("### rubric.md");
    expect(rendered).toContain("score exhaustively on 28 dimensions");
  });

  it("packages ALL references files WHOLE, even ones that would have exceeded the OLD shared budget", () => {
    // The design this replaced shared a single small budget across every references/ file, filled in
    // filename order — the alphabetically-first file (a-big.md here) took everything and b-late.md never
    // reached the evaluator. Both now ship whole and uncut; see test/critique-whole-corpus.test.ts for the
    // dedicated corpus-ceiling coverage (this test's own subject is skill SELECTION, not truncation).
    const dir = mkdtempSync(join(tmpdir(), "crit-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# s");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "a-big.md"), "x".repeat(9 * 1024)); // > the OLD 8KB shared budget alone
    writeFileSync(join(dir, "references", "b-late.md"), "the late file's content");
    const runDir = runDirStub();
    const { sections, truncated } = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir, false, { mountRoot: dir });
    const rendered = renderSections(sections);
    expect(truncated).toBe(false);
    expect(rendered).toContain("### a-big.md\n" + "x".repeat(9 * 1024));
    expect(rendered).toContain("### b-late.md\nthe late file's content");
  });
});

describe("--skill flag parsing", () => {
  it("accepts both forms and is not repeatable", () => {
    expect(parseArgs(["./p", "--prompt", "x", "--skill", "ms"]).skillSelector).toBe("ms");
    expect(parseArgs(["./p", "--prompt", "x", "--skill=ms"]).skillSelector).toBe("ms");
    expect(() => parseArgs(["./p", "--prompt", "x", "--skill", "a", "--skill", "b"])).toThrow(/not repeatable/);
  });
});

describe("corpus-ceiling accounting (replaces the deleted skillMdTruncated flag)", () => {
  // `skillMdTruncated` (a per-file SKILL.md-only truncation flag) is gone along with the per-section
  // SKILL_MD_CAP it was keyed to. What replaced it is corpus-wide: SKILL.md, references/** and agents md
  // all ship WHOLE unless their COMBINED size breaches SKILL_CORPUS_CEILING (512KB), in which case
  // `corpusCuts` names exactly which file(s) were cut and by how much (see
  // test/critique-whole-corpus.test.ts for that breach case). Below the ceiling, "readable" now always
  // means "whole", for a SKILL.md of any realistic size — that's the distinction worth pinning here.
  it("an oversized-but-under-ceiling SKILL.md is packaged whole — readable, no corpus cut", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-big-skill-"));
    const bigBody = "x".repeat(70 * 1024); // > the OLD 64KB per-file cap; well under the 512KB ceiling
    writeFileSync(join(dir, "SKILL.md"), "# big\n" + bigBody);
    const runDir = mkdtempSync(join(tmpdir(), "crit-run-"));
    const r = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir, false, { mountRoot: dir });
    expect(r.skillMdStatus).toBe("readable"); // NOT missing/unreadable — no mechanical downgrade
    expect(r.corpusCuts).toHaveLength(0); // nothing to cut below the ceiling
    expect(r.truncated).toBe(false);
    const rendered = renderSections(r.sections);
    expect(rendered).toContain(bigBody); // the whole body survives, not a cut copy
  });

  it("a small readable SKILL.md is likewise uncut", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-small-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# small");
    const runDir = mkdtempSync(join(tmpdir(), "crit-run-"));
    const r = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir, false, { mountRoot: dir });
    expect(r.corpusCuts).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });
});
