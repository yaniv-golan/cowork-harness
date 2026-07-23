import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packageEvidence, SKILL_MD_CAP, TRANSCRIPT_CAP, MAX_PACKAGE_BYTES, TRUNCATION_MARKER } from "../src/critique/package-evidence.js";
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

// The per-turn packager reads `turns/1/result.json` and `turns/1/run.jsonl` (via `turnArtifactPath` /
// `readTurn1Transcript` in package-evidence.ts) — NOT root `result.turn-1.json` / `run.turn-1.jsonl`. A
// fixture written at the root is silently inert: packageEvidence falls back to empty defaults instead of
// erroring, so a misplaced fixture makes a test pass for the wrong reason. This helper writes fixtures
// where the packager actually reads them, and keeps their bodies small enough (well under TRANSCRIPT_CAP
// and the small structured-section caps) that they never contribute their own truncation.
function writeTurn1Fixtures(runDir: string, opts: { transcript?: string; result?: Record<string, unknown> } = {}): void {
  const turnDir = join(runDir, "turns", "1");
  mkdirSync(turnDir, { recursive: true });
  const result = opts.result ?? { finalMessage: "ok", referencesRead: [], skillActivity: [], toolCounts: {}, result: "success" };
  writeFileSync(join(turnDir, "result.json"), JSON.stringify(result));
  writeFileSync(join(turnDir, "run.jsonl"), JSON.stringify({ t: "transcript", text: opts.transcript ?? "small transcript" }) + "\n");
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

  // Was "the 48KB overall shave loop": at 64/32/128KB budgets the per-section sum is under the overall cap,
  // so the overall trim is unreachable via packageEvidence. What packageEvidence still guarantees is that an
  // over-cap SKILL.md is cut to its per-section budget and the whole package stays within MAX_PACKAGE_BYTES.
  it("an over-cap SKILL.md is cut to its per-section budget and the whole package stays within MAX_PACKAGE_BYTES", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    writeTurn1Fixtures(runDir); // small turn-1 result + transcript, at the paths the packager actually reads
    const skillDir = makeSkillDir();
    const bigSkillMd = "S".repeat(SKILL_MD_CAP + 5_000); // overflow the SKILL.md per-section budget
    writeFileSync(join(skillDir, "SKILL.md"), bigSkillMd);

    const { pkg, sections, truncated } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);

    const skillSection = sections.find((s) => s.title.startsWith("SKILL.md"))!;
    const transcriptSection = sections.find((s) => s.title.startsWith("Transcript"))!;
    // Marker must be in the SKILL.md section specifically, not just somewhere in the flat pkg — anchors this
    // test to the fixture actually populating the section it claims to overflow (see writeTurn1Fixtures doc).
    expect(skillSection.body, "the SKILL.md section itself must be cut").toContain(TRUNCATION_MARKER);
    // The small transcript fixture must stay well under its own cap, so truncation here is driven ONLY by
    // the oversized SKILL.md, not incidentally by an also-oversized transcript.
    expect(Buffer.byteLength(transcriptSection.body, "utf8")).toBeLessThan(TRANSCRIPT_CAP);
    expect(truncated, "an over-cap SKILL.md must report truncation").toBe(true);
    expect(pkg).toContain(TRUNCATION_MARKER); // the REAL lowercase marker, not "[TRUNCATED"
    expect(Buffer.byteLength(pkg, "utf8")).toBeLessThanOrEqual(MAX_PACKAGE_BYTES);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a just-under-cap (~63KB) SKILL.md packages untruncated", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-crit-attach-run-"));
    writeTurn1Fixtures(runDir);
    const skillDir = makeSkillDir();
    // Just under the new cap; would have blown the old 16KB one. A flagship-sized (~51KB) SKILL.md
    // now fits with headroom to spare, so this just-under-cap fixture is the stronger regression.
    const flagship = "S".repeat(SKILL_MD_CAP - 1_000);
    writeFileSync(join(skillDir, "SKILL.md"), flagship);

    const { pkg, truncated } = packageEvidence(runDir, EMPTY_BOUNDARY, skillDir);

    expect(truncated, "a sub-cap SKILL.md must not be reported as truncated").toBe(false);
    expect(pkg, "no truncation marker anywhere when nothing was cut").not.toContain(TRUNCATION_MARKER);

    rmSync(runDir, { recursive: true, force: true });
    rmSync(skillDir, { recursive: true, force: true });
  });
});
