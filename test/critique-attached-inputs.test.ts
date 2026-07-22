import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { writeVmPathContextFile } from "../src/run/vm-path-ctx-file.js";
import type { TurnBoundary } from "../src/critique/evidence.js";
import type { VmPathContext } from "../src/vm-paths.js";

// Part 3-C of docs/internal/2026-07-20-critique-skill-flag-parity-plan.md: a new "Attached inputs" evidence
// section so the evaluator can distinguish "the agent said there was no file, and correctly so" from "the
// agent confabulated that" — the package previously had NO record of what files were attached at all.
//
// CRITICAL invariant under test throughout: filenames + sizes ONLY, never file CONTENT.

const ATTACHED_INPUTS_TITLE = "Attached inputs (mnt/uploads filenames + sizes, and connected-folder mount names — NOT content)";

const EMPTY_BOUNDARY: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };

function makeSkillDir(): string {
  const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-skill-"));
  writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
  return skillDir;
}

function findSection(sections: { title: string; body: string }[], title: string) {
  return sections.find((s) => s.title === title);
}

describe("Attached inputs evidence section", () => {
  it("appears in sections[] AND in the rendered pkg even with nothing attached", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const skillDir = makeSkillDir();
    const { sections, pkg } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE);
    expect(section).toBeDefined();
    expect(section!.body).toBe("(none)");
    expect(pkg).toContain(ATTACHED_INPUTS_TITLE);
    expect(pkg).toContain("(none)");
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("is positioned between 'references/ available' and 'Transcript'", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const skillDir = makeSkillDir();
    const { sections } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const refIdx = sections.findIndex((s) => s.title.startsWith("references/ available"));
    const attachedIdx = sections.findIndex((s) => s.title === ATTACHED_INPUTS_TITLE);
    const transcriptIdx = sections.findIndex((s) => s.title.startsWith("Transcript"));
    expect(refIdx).toBeGreaterThanOrEqual(0);
    expect(attachedIdx).toBe(refIdx + 1);
    expect(transcriptIdx).toBe(attachedIdx + 1);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("lists uploaded filenames with byte sizes when mounts.json points at a populated uploads dir", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const uploadsDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-uploads-"));
    writeFileSync(join(uploadsDir, "cap-table.xlsx"), "x".repeat(1234));
    writeFileSync(join(uploadsDir, "notes.pdf"), "y".repeat(10));
    const ctx: VmPathContext = {
      sessionId: "sess-abc",
      uploadsHostDir: uploadsDir,
      folders: new Map(),
    };
    writeVmPathContextFile(runDir, ctx, "hostloop");
    const skillDir = makeSkillDir();
    const { sections, pkg } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE)!;
    expect(section.body).toContain("cap-table.xlsx");
    expect(section.body).toContain("1234");
    expect(section.body).toContain("notes.pdf");
    expect(section.body).toContain("10");
    expect(pkg).toContain("cap-table.xlsx");
    // CRITICAL: never leak file content
    expect(section.body).not.toContain("x".repeat(1234));
    expect(pkg).not.toContain("x".repeat(50));
    rmSync(runDir, { recursive: true, force: true });
    rmSync(uploadsDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("lists connected-folder mount names alongside uploads", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const uploadsDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-uploads-"));
    const folderHostDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-folder-"));
    const ctx: VmPathContext = {
      sessionId: "sess-abc",
      uploadsHostDir: uploadsDir,
      folders: new Map([["ProjectDocs", folderHostDir]]),
    };
    writeVmPathContextFile(runDir, ctx, "hostloop");
    const skillDir = makeSkillDir();
    const { sections } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE)!;
    expect(section.body).toContain("ProjectDocs");
    // The mount NAME is fine; the host source path is not something to leak into evidence.
    expect(section.body).not.toContain(folderHostDir);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(uploadsDir, { recursive: true, force: true });
    rmSync(folderHostDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("surfaces UNKNOWN (not '(none)') when the uploads dir can't be read — a read fault is not 'no attachments'", () => {
    // Point uploadsHostDir at a FILE, not a dir → readdirSync throws ENOTDIR (a genuine read fault,
    // deterministically, no chmod/root dependency). Conflating this with "(none)" would tell the evaluator
    // "the agent correctly saw no file" when the truth is UNKNOWN — the confabulation-vs-correct distinction
    // this whole section exists to protect.
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const notADir = join(runDir, "uploads-is-a-file");
    writeFileSync(notADir, "x");
    const ctx: VmPathContext = { sessionId: "sess-abc", uploadsHostDir: notADir, folders: new Map() };
    writeVmPathContextFile(runDir, ctx, "hostloop");
    const skillDir = makeSkillDir();
    const { sections } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE)!;
    expect(section.body).toMatch(/could not be read|UNKNOWN/);
    expect(section.body).not.toBe("(none)"); // must NOT read as "correctly no attachments"
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("reports '(none)' when the uploads dir referenced by mounts.json is empty and there are no folders", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const uploadsDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-uploads-"));
    const ctx: VmPathContext = { sessionId: "sess-abc", uploadsHostDir: uploadsDir, folders: new Map() };
    writeVmPathContextFile(runDir, ctx, "hostloop");
    const skillDir = makeSkillDir();
    const { sections } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE)!;
    expect(section.body).toBe("(none)");
    rmSync(runDir, { recursive: true, force: true });
    rmSync(uploadsDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("falls back to the fixed container layout (work/session/mnt/uploads) when mounts.json is missing, without throwing", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    const fallbackUploads = join(runDir, "work", "session", "mnt", "uploads");
    mkdirSync(fallbackUploads, { recursive: true });
    writeFileSync(join(fallbackUploads, "financials.csv"), "a,b,c\n1,2,3\n");
    const skillDir = makeSkillDir();
    // No mounts.json written at all — loadVmPathContext must return null and packageEvidence must fall back,
    // never throw.
    expect(() => packageEvidence(runDir, EMPTY_BOUNDARY, skillDir)).not.toThrow();
    const { sections } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE)!;
    expect(section.body).toContain("financials.csv");
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("falls back gracefully to '(none)' when mounts.json is corrupt AND the fallback container path doesn't exist", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    writeFileSync(join(runDir, "mounts.json"), "{ this is not valid json");
    const skillDir = makeSkillDir();
    expect(() => packageEvidence(runDir, EMPTY_BOUNDARY, skillDir)).not.toThrow();
    const { sections } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);
    const section = findSection(sections, ATTACHED_INPUTS_TITLE)!;
    expect(section.body).toBe("(none)");
    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("the 48KB overall shave loop still terminates with the extra section present", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    // Blow every other section's budget so the shave loop has real work to do, and give the attached-inputs
    // section itself a large body to shave via a large uploads dir listing.
    writeFileSync(join(runDir, "result.turn-1.json"), JSON.stringify({ finalMessage: "m".repeat(20_000) }));
    writeFileSync(join(runDir, "run.turn-1.jsonl"), JSON.stringify({ t: "transcript", text: "t".repeat(40_000) }) + "\n");
    const uploadsDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-uploads-"));
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(uploadsDir, `file-with-a-fairly-long-name-${i}.dat`), "z".repeat(50));
    }
    const ctx: VmPathContext = { sessionId: "sess-abc", uploadsHostDir: uploadsDir, folders: new Map() };
    writeVmPathContextFile(runDir, ctx, "hostloop");
    const skillDir = makeSkillDir();
    writeFileSync(join(skillDir, "SKILL.md"), "g".repeat(20_000));

    const { pkg, sections, truncated } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir, true);
    expect(Buffer.byteLength(pkg, "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(truncated).toBe(true);
    expect(findSection(sections, ATTACHED_INPUTS_TITLE)).toBeDefined();

    rmSync(runDir, { recursive: true, force: true });
    rmSync(uploadsDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });
});
