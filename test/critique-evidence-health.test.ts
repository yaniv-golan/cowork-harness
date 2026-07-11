import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshotTurnBoundary,
  readTurn1Slice,
  verifyBoundaryIntegrity,
  readTurn1ResultWithStatus,
  type TurnBoundary,
} from "../src/critique/evidence.js";
import { packageEvidence } from "../src/critique/package-evidence.js";

// Critique-evidence-packaging health cluster (F28-F31): the reflective skill-critique loop's safety claim
// depends on the evaluator being able to tell "this evidence is solid ground truth" apart from "this
// evidence is missing/corrupted/unverifiable" — a stat error, a corrupt file, or an unreadable SKILL.md must
// never silently collapse into the same shape as a legitimate empty/absent result.

// Armed fs-failure simulation, same technique as test/artifact-json-stat-throw.test.ts: a permission
// (EACCES) fixture won't reliably fire when tests run as root, so simulate the throw via a module mock
// instead of relying on chmod. Only the specific path(s) armed for a given test throw; everything else goes
// through the real implementation.
const armed = vi.hoisted(() => ({
  statThrow: new Set<string>(),
  readFileThrow: new Set<string>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    statSync: (...args: Parameters<typeof real.statSync>) => {
      if (armed.statThrow.has(String(args[0]))) throw new Error("EACCES: simulated stat failure");
      return real.statSync(...args);
    },
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (armed.readFileThrow.has(String(args[0]))) throw new Error("EACCES: simulated read failure");
      return real.readFileSync(...args);
    },
  };
});

beforeEach(() => {
  armed.statThrow.clear();
  armed.readFileThrow.clear();
});

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "cwh-crit-health-"))));

describe("F28 — a stat error is distinguishable from a real zero-byte boundary", () => {
  it("a genuinely empty (0-byte) stream captures size:0, not null", () => {
    writeFileSync(join(dir, "events.jsonl"), "");
    const boundary = snapshotTurnBoundary(dir);
    expect(boundary.events.size).toBe(0);
    expect(boundary.events.size).not.toBeNull();
  });

  it("a statSync failure captures size:null, distinct from a real zero-byte boundary", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n'); // a real, non-empty file — if stat succeeded this would be >0
    armed.statThrow.add(path);
    const boundary = snapshotTurnBoundary(dir);
    expect(boundary.events.size).toBeNull();
  });

  it("readTurn1Slice ABORTS (throws) on an unestablished boundary rather than returning a false empty slice", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/x.md"}\n');
    const boundary: TurnBoundary = { events: { size: null }, timeline: { size: 0 } };
    expect(() => readTurn1Slice(dir, "events.jsonl", boundary)).toThrow();
  });

  it("readTurn1Slice still returns '' for a legitimately-absent file even with a null-size boundary", () => {
    // events.jsonl was never created — existsSync is false, which is the genuine "not written yet" case,
    // orthogonal to a stat ERROR on a file that does exist.
    const boundary: TurnBoundary = { events: { size: null }, timeline: { size: 0 } };
    expect(readTurn1Slice(dir, "events.jsonl", boundary)).toBe("");
  });

  it("packaging surfaces turn1SliceDegraded when the events.jsonl boundary was never established", () => {
    writeFileSync(join(dir, "events.jsonl"), '{"t":"init"}\n');
    // No run.turn-1.jsonl archive present, so packageEvidence falls back to the events.jsonl slice, which
    // depends on the boundary below being valid.
    const boundary: TurnBoundary = { events: { size: null }, timeline: { size: 0 } };
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1SliceDegraded).toBe(true);
    expect(result.pkg).toMatch(/DEGRADED/);
    rmSync(skillDir, { recursive: true, force: true });
  });
});

describe("F29 — append-only prefix tamper detection (defense-in-depth)", () => {
  it("verifyBoundaryIntegrity is 'ok' when the captured prefix is untouched", () => {
    writeFileSync(join(dir, "events.jsonl"), '{"t":"init"}\n{"t":"read","path":"a.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    expect(verifyBoundaryIntegrity(dir, "events.jsonl", boundary)).toBe("ok");
  });

  it("detects a boundary whose bytes changed under it (truncation/replacement) as 'mismatch'", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"a.md"}\n');
    const boundary = snapshotTurnBoundary(dir); // captures a prefix hash of the ORIGINAL content
    // Same length, different bytes under the already-captured boundary — a plain byte-length comparison
    // would miss this entirely.
    const tampered = '{"t":"init"}\n{"t":"read","path":"Z.md"}\n';
    expect(tampered.length).toBe('{"t":"init"}\n{"t":"read","path":"a.md"}\n'.length);
    writeFileSync(path, tampered);
    expect(verifyBoundaryIntegrity(dir, "events.jsonl", boundary)).toBe("mismatch");
  });

  it("is 'unavailable' (not a false 'ok' or 'mismatch') when the boundary was never established", () => {
    const boundary: TurnBoundary = { events: { size: null }, timeline: { size: 0 } };
    writeFileSync(join(dir, "events.jsonl"), "anything");
    expect(verifyBoundaryIntegrity(dir, "events.jsonl", boundary)).toBe("unavailable");
  });

  it("packaging surfaces turn1SliceDegraded when the events.jsonl prefix was tampered with after capture", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"a.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"Z.md"}\n'); // same length, different bytes
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1SliceDegraded).toBe(true);
    rmSync(skillDir, { recursive: true, force: true });
  });
});

describe("F29 residual — truncation BELOW the captured boundary is detected, not silently served as 'ok'", () => {
  it("verifyBoundaryIntegrity reports 'mismatch' (not 'ok') when the file shrank below the captured boundary", () => {
    const path = join(dir, "events.jsonl");
    const original = '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n{"t":"read","path":"references/answers.md"}\n';
    writeFileSync(path, original);
    const boundary = snapshotTurnBoundary(dir); // captures size + prefix hash of the FULL original content
    // Truncate to well under the captured boundary — the surviving bytes are still an untouched PREFIX of
    // the original (so a prefix-hash-only compare would wrongly say "ok"), but the stream is now shorter
    // than what was captured as the turn-1 region.
    writeFileSync(path, '{"t":"init"}\n');
    expect(verifyBoundaryIntegrity(dir, "events.jsonl", boundary)).toBe("mismatch");
  });

  it("readTurn1Slice throws (never returns a silent short slice) when the file is now shorter than the captured boundary", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n{"t":"read","path":"references/answers.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    writeFileSync(path, '{"t":"init"}\n'); // truncated below the captured boundary
    expect(() => readTurn1Slice(dir, "events.jsonl", boundary)).toThrow(/SHORTER than its captured turn-1 boundary/);
  });

  it("packageEvidence surfaces turn1SliceDegraded (not a silently-short transcript) when events.jsonl was truncated below its boundary", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n{"t":"read","path":"references/answers.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    writeFileSync(path, '{"t":"init"}\n'); // truncated below the captured boundary — no run.turn-1.jsonl archive,
    // so packageEvidence falls back to the events.jsonl slice, which must now be flagged degraded.
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1SliceDegraded).toBe(true);
    expect(result.pkg).toMatch(/DEGRADED/);
    rmSync(skillDir, { recursive: true, force: true });
  });
});

describe("F30 — a corrupt canonical turn-1 result surfaces a typed degradation flag (never a silent turn-2 substitution)", () => {
  it("readTurn1ResultWithStatus reports 'corrupted' for a malformed result.turn-1.json and does NOT fall back to result.json", () => {
    writeFileSync(join(dir, "result.turn-1.json"), "{ this is not valid json");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ turn: 2, finalMessage: "TURN-2 DATA — must not leak" }));
    const { value, status } = readTurn1ResultWithStatus(dir);
    expect(status).toBe("corrupted");
    expect(value).toBeNull(); // never silently substitutes result.json (turn-2) for a corrupt turn-1 file
  });

  it("readTurn1ResultWithStatus reports 'missing' (distinct from 'corrupted') when neither result file exists", () => {
    const { value, status } = readTurn1ResultWithStatus(dir);
    expect(status).toBe("missing");
    expect(value).toBeNull();
  });

  it("readTurn1ResultWithStatus reports 'ok' for a well-formed result.turn-1.json", () => {
    writeFileSync(join(dir, "result.turn-1.json"), JSON.stringify({ finalMessage: "hi" }));
    const { value, status } = readTurn1ResultWithStatus(dir);
    expect(status).toBe("ok");
    expect((value as { finalMessage: string }).finalMessage).toBe("hi");
  });

  it("packageEvidence sets turn1ResultDegraded and never leaks the turn-2 result.json content into the package", () => {
    writeFileSync(join(dir, "result.turn-1.json"), "{ not valid json at all");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ finalMessage: "TURN-2-ONLY-SENTINEL-TEXT" }));
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1ResultDegraded).toBe(true);
    expect(result.pkg).toMatch(/DEGRADED/);
    expect(result.pkg).not.toContain("TURN-2-ONLY-SENTINEL-TEXT"); // no silent turn-2 substitution
    rmSync(skillDir, { recursive: true, force: true });
  });
});

describe("F30 residual — a MISSING (not corrupt) turn-1 archive on a validated resume never silently serves turn-2 data", () => {
  it("readTurn1ResultWithStatus(outDir, requireArchive:true) reports 'missing' — and never even looks at result.json — when result.turn-1.json was never archived", () => {
    // No result.turn-1.json at all; result.json exists (this IS the turn-2 result on a resumed run).
    writeFileSync(join(dir, "result.json"), JSON.stringify({ turn: 2, finalMessage: "TURN-2 DATA — must not leak" }));
    const { value, status } = readTurn1ResultWithStatus(dir, true);
    expect(status).toBe("missing");
    expect(value).toBeNull(); // requireArchive:true never falls through to result.json
  });

  it("readTurn1ResultWithStatus(outDir, requireArchive:false) (the default) still tolerates the single-shot 'no archive, result.json IS turn 1' case", () => {
    writeFileSync(join(dir, "result.json"), JSON.stringify({ turn: 1, from: "single-shot" }));
    const { value, status } = readTurn1ResultWithStatus(dir); // default requireArchive:false, unchanged behavior
    expect(status).toBe("ok");
    expect((value as { from: string }).from).toBe("single-shot");
  });

  it("packageEvidence(..., isResume:true) sets turn1ResultDegraded and never leaks result.json's turn-2 content when the archive is simply MISSING", () => {
    // No result.turn-1.json — only the turn-2 result.json, exactly the shape a resumed session has if the
    // archive step silently failed.
    writeFileSync(join(dir, "result.json"), JSON.stringify({ finalMessage: "TURN-2-ONLY-SENTINEL-TEXT", turn: 2 }));
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir, true); // isResume:true
    expect(result.turn1ResultDegraded).toBe(true);
    expect(result.pkg).toMatch(/DEGRADED/);
    expect(result.pkg).not.toContain("TURN-2-ONLY-SENTINEL-TEXT"); // never substituted turn-2 data for turn-1
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("packageEvidence(..., isResume:false) (the default) does NOT flag the same missing-archive shape as degraded — result.json legitimately IS turn 1 there", () => {
    writeFileSync(join(dir, "result.json"), JSON.stringify({ finalMessage: "single-shot turn-1 result", turn: 1 }));
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir); // isResume defaults to false
    expect(result.turn1ResultDegraded).toBe(false);
    expect(result.pkg).toContain("single-shot turn-1 result");
    rmSync(skillDir, { recursive: true, force: true });
  });
});

describe("F31 — SKILL.md missing vs. unreadable produce distinct, typed statuses", () => {
  it("reports 'missing' when SKILL.md legitimately does not exist", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.skillMdStatus).toBe("missing");
    expect(result.pkg).toMatch(/no SKILL\.md found/);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("reports 'readable' when SKILL.md exists and can be read", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance text here");
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.skillMdStatus).toBe("readable");
    expect(result.pkg).toContain("guidance text here");
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("reports 'unreadable' (distinct from 'missing') when SKILL.md exists but a read error occurs", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    const skillMdPath = join(skillDir, "SKILL.md");
    writeFileSync(skillMdPath, "# a skill\nguidance");
    armed.readFileThrow.add(skillMdPath);
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.skillMdStatus).toBe("unreadable");
    expect(result.skillMdStatus).not.toBe("missing");
    expect(result.pkg).not.toMatch(/no SKILL\.md found/); // must not be misreported as absent
    expect(result.pkg).toMatch(/could not be read/);
    rmSync(skillDir, { recursive: true, force: true });
  });
});
