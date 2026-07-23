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
    expect(resolveCritiquedSkillDir(dir, undefined)).toEqual({ skillDir: dir });
  });

  it("--skill <name> resolves skills/<name>/ and its agents/<name>.md", () => {
    const root = makePlugin(["market-sizing", "ic-sim"], { agentsFor: ["market-sizing"] });
    const r = resolveCritiquedSkillDir(root, "market-sizing");
    expect(r.skillDir).toBe(join(root, "skills", "market-sizing"));
    expect(r.agentsMdPath).toBe(join(root, "agents", "market-sizing.md"));
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
    expect(resolveCritiquedSkillDir(dir, undefined)).toEqual({ skillDir: dir });
  });
});

describe("packageEvidence: agents/references content sections", () => {
  function runDirStub(): string {
    // packageEvidence degrades gracefully on an empty run dir — these tests only exercise the
    // skill-source sections, which read from skillDir/agentsMdPath.
    return mkdtempSync(join(tmpdir(), "crit-run-"));
  }

  it("packages the invoked skill's agents/<name>.md content when resolved", () => {
    const root = makePlugin(["ms"], { agentsFor: ["ms"] });
    const runDir = runDirStub();
    const { sections } = packageEvidence(runDir, snapshotTurnBoundary(runDir), join(root, "skills", "ms"), false, {
      agentsMdPath: join(root, "agents", "ms.md"),
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
    const { sections } = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir);
    const rendered = renderSections(sections);
    // Mutation guard: reverting to filenames-only drops the body text and reds this.
    expect(rendered).toContain("### rubric.md");
    expect(rendered).toContain("score exhaustively on 28 dimensions");
  });

  it("a references file past the total budget is marked omitted, and the package flags truncated", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# s");
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "a-big.md"), "x".repeat(9 * 1024)); // > REFERENCES_CONTENT_CAP alone
    writeFileSync(join(dir, "references", "b-late.md"), "the late file's content");
    const runDir = runDirStub();
    const { sections, truncated } = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir);
    const rendered = renderSections(sections);
    expect(truncated).toBe(true);
    expect(rendered).toContain("### b-late.md\n(omitted — references/ content budget exhausted)");
    expect(rendered).not.toContain("the late file's content");
  });
});

describe("--skill flag parsing", () => {
  it("accepts both forms and is not repeatable", () => {
    expect(parseArgs(["./p", "--prompt", "x", "--skill", "ms"]).skillSelector).toBe("ms");
    expect(parseArgs(["./p", "--prompt", "x", "--skill=ms"]).skillSelector).toBe("ms");
    expect(() => parseArgs(["./p", "--prompt", "x", "--skill", "a", "--skill", "b"])).toThrow(/not repeatable/);
  });
});

describe("skillMdTruncated (readable-but-cut is distinct from missing/unreadable)", () => {
  it("flags an oversized readable SKILL.md and the report renders the distinction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-big-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# big\n" + "x".repeat(70 * 1024)); // > SKILL_MD_CAP (64KB)
    const runDir = mkdtempSync(join(tmpdir(), "crit-run-"));
    const r = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir);
    expect(r.skillMdStatus).toBe("readable"); // NOT missing/unreadable — no mechanical downgrade
    expect(r.skillMdTruncated).toBe(true);
    const { buildTextReport, buildJsonReport } = await import("../src/critique/command");
    const state = {
      skillFolder: dir,
      prompt: "p",
      sessionId: "s",
      outDir: runDir,
      fidelity: "container",
      taskResult: "success" as const,
      selfReportStatus: "captured" as const,
      items: [],
      requestedModel: "m",
      skillMdTruncated: true,
    };
    expect(buildTextReport(state)).toMatch(/SKILL\.md: readable but TRUNCATED/);
    expect(buildJsonReport(state).skillMdTruncated).toBe(true);
  });

  it("a small readable SKILL.md is NOT flagged", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-small-skill-"));
    writeFileSync(join(dir, "SKILL.md"), "# small");
    const runDir = mkdtempSync(join(tmpdir(), "crit-run-"));
    const r = packageEvidence(runDir, snapshotTurnBoundary(runDir), dir);
    expect(r.skillMdTruncated).toBe(false);
  });
});
