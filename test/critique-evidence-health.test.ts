import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

/** Write turn N's result.json (`turns/<N>/result.json` — the single addressable shape; no root compat
 *  copy, no `result.turn-<N>.json` archive). */
function putTurnResult(n: number, body: string): void {
  const d = join(dir, "turns", String(n));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "result.json"), body);
}

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

describe("a captured non-empty boundary whose file later vanishes is an integrity failure, not a silent empty slice", () => {
  it("readTurn1Slice throws when a positive captured boundary's file is deleted before packaging", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    expect(boundary.events.size).toBeGreaterThan(0);
    rmSync(path); // deleted between the boundary snapshot and packaging
    expect(() => readTurn1Slice(dir, "events.jsonl", boundary)).toThrow(/missing/);
  });

  it("readTurn1Slice throws when a positive captured boundary's file becomes unreadable before packaging", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    armed.readFileThrow.add(path); // still exists, but the read itself fails (e.g. permission error)
    expect(() => readTurn1Slice(dir, "events.jsonl", boundary)).toThrow();
  });

  it("verifyBoundaryIntegrity reports a distinct value (not bare 'unavailable', not 'mismatch') for a positive boundary whose file vanished", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    rmSync(path);
    const integrity = verifyBoundaryIntegrity(dir, "events.jsonl", boundary);
    expect(integrity).not.toBe("unavailable");
    expect(integrity).not.toBe("mismatch");
    expect(integrity).not.toBe("ok");
  });

  it("packageEvidence surfaces turn1SliceDegraded (not a falsely-clean empty transcript) when the events.jsonl boundary was positive but the file is now gone", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n');
    const boundary = snapshotTurnBoundary(dir);
    rmSync(path); // deleted before packaging — no run.turn-1.jsonl archive, so packageEvidence falls back
    // to the events.jsonl slice, which must now be flagged degraded rather than silently reporting "(none)".
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1SliceDegraded).toBe(true);
    expect(result.pkg).toMatch(/DEGRADED/);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("a stream that was genuinely 0 bytes AT CAPTURE stays non-degraded even if the file is later removed (regression guard: do not blanket-degrade every non-'ok' integrity result)", () => {
    const path = join(dir, "events.jsonl");
    writeFileSync(path, ""); // 0 bytes at the moment of capture
    const boundary = snapshotTurnBoundary(dir);
    expect(boundary.events.size).toBe(0);
    expect(readTurn1Slice(dir, "events.jsonl", boundary)).toBe(""); // slice is empty regardless of what happens next
    rmSync(path); // file disappears entirely before packaging — must NOT be treated as an integrity failure
    expect(readTurn1Slice(dir, "events.jsonl", boundary)).toBe(""); // still just returns the (definitionally empty) slice
    expect(verifyBoundaryIntegrity(dir, "events.jsonl", boundary)).toBe("unavailable"); // benign: nothing was ever captured to compare against

    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1SliceDegraded).toBe(false);
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("happy path: a positive captured boundary whose file is intact reads back the exact slice, non-degraded", () => {
    const turn1 = '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n';
    const path = join(dir, "events.jsonl");
    writeFileSync(path, turn1);
    const boundary = snapshotTurnBoundary(dir);
    writeFileSync(path, turn1 + '{"t":"read","path":"references/answers.md"}\n'); // reflection turn appends
    expect(readTurn1Slice(dir, "events.jsonl", boundary)).toBe(turn1);
    expect(verifyBoundaryIntegrity(dir, "events.jsonl", boundary)).toBe("ok");

    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir);
    expect(result.turn1SliceDegraded).toBe(false);
    rmSync(skillDir, { recursive: true, force: true });
  });
});

describe("a partly-corrupt archived turn-1 transcript degrades, never reads as clean ground truth", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "cwh-crit-arch-"))));
  const skill = () => {
    const s = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(s, "SKILL.md"), "# a skill\nguidance");
    return s;
  };
  // The archived branch (turns/1/run.jsonl) short-circuits before the boundary-dependent slice fallback,
  // so the boundary is irrelevant here — a benign zero-size one keeps turn1SliceDegraded sourced ONLY from
  // the archived-transcript read under test.
  const BENIGN: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };

  it("a malformed (skipped) JSONL row sets turn1SliceDegraded — but the transcript is still delivered (resilient)", () => {
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(
      join(dir, "turns", "1", "run.jsonl"),
      '{"t":"init"}\n{ this is not valid json\n' + JSON.stringify({ t: "transcript", text: "the agent read the file" }) + "\n",
    );
    const result = packageEvidence(dir, BENIGN, skill());
    expect(result.turn1SliceDegraded).toBe(true); // corruption surfaced, not silently clean
    const transcript = result.sections.find((s) => s.title.startsWith("Transcript"));
    expect(transcript?.body).toContain("the agent read the file"); // still resilient — the transcript is delivered
  });

  it("a clean archive (exactly one transcript record, no corruption) is NOT degraded", () => {
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "run.jsonl"), '{"t":"init"}\n' + JSON.stringify({ t: "transcript", text: "clean" }) + "\n");
    expect(packageEvidence(dir, BENIGN, skill()).turn1SliceDegraded).toBe(false);
  });

  it("an ambiguous archive with TWO transcript records degrades (completeness unknown)", () => {
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(
      join(dir, "turns", "1", "run.jsonl"),
      JSON.stringify({ t: "transcript", text: "first" }) + "\n" + JSON.stringify({ t: "transcript", text: "second" }) + "\n",
    );
    expect(packageEvidence(dir, BENIGN, skill()).turn1SliceDegraded).toBe(true);
  });
});

describe("F30 — a corrupt canonical turn-1 result surfaces a typed degradation flag (never a silent turn-2 substitution)", () => {
  it("readTurn1ResultWithStatus reports 'corrupted' for a malformed turns/1/result.json and does NOT fall back to a later turn's", () => {
    putTurnResult(1, "{ this is not valid json");
    putTurnResult(2, JSON.stringify({ turn: 2, finalMessage: "TURN-2 DATA — must not leak" }));
    const { value, status } = readTurn1ResultWithStatus(dir);
    expect(status).toBe("corrupted");
    expect(value).toBeNull(); // never silently substitutes a later turn's result for a corrupt turn-1 file
  });

  it("readTurn1ResultWithStatus reports 'missing' (distinct from 'corrupted') when no turns/1/result.json exists", () => {
    const { value, status } = readTurn1ResultWithStatus(dir);
    expect(status).toBe("missing");
    expect(value).toBeNull();
  });

  it("readTurn1ResultWithStatus reports 'ok' for a well-formed turns/1/result.json", () => {
    putTurnResult(1, JSON.stringify({ finalMessage: "hi" }));
    const { value, status } = readTurn1ResultWithStatus(dir);
    expect(status).toBe("ok");
    expect((value as { finalMessage: string }).finalMessage).toBe("hi");
  });

  it("packageEvidence sets turn1ResultDegraded and never leaks a later turn's result.json content into the package", () => {
    putTurnResult(1, "{ not valid json at all");
    putTurnResult(2, JSON.stringify({ finalMessage: "TURN-2-ONLY-SENTINEL-TEXT" }));
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

describe("F30 residual — a MISSING (not corrupt) turn-1 result on a validated resume never silently serves a later turn's data", () => {
  it("readTurn1ResultWithStatus(outDir, requireArchive:true) reports 'missing' — and never even looks at a later turn's result — when turns/1/result.json was never written", () => {
    // No turns/1/result.json at all; turns/2/result.json exists (the reflection turn's result on a resumed
    // run). `requireArchive` predates the per-turn layout and no longer changes which file is READ (see
    // readTurn1ResultWithStatus's doc comment) — this pins that it still can't leak a later turn's data.
    putTurnResult(2, JSON.stringify({ turn: 2, finalMessage: "TURN-2 DATA — must not leak" }));
    const { value, status } = readTurn1ResultWithStatus(dir, true);
    expect(status).toBe("missing");
    expect(value).toBeNull(); // never falls through to turns/2/result.json
  });

  it("readTurn1ResultWithStatus(outDir, requireArchive:false) (the default) still reads an ordinary single-shot turns/1/result.json", () => {
    putTurnResult(1, JSON.stringify({ turn: 1, from: "single-shot" }));
    const { value, status } = readTurn1ResultWithStatus(dir); // default requireArchive:false, unchanged behavior
    expect(status).toBe("ok");
    expect((value as { from: string }).from).toBe("single-shot");
  });

  it("packageEvidence(..., isResume:true) sets turn1ResultDegraded and never leaks a later turn's content when turns/1/result.json is simply MISSING", () => {
    // No turns/1/result.json — only the reflection turn's turns/2/result.json, exactly the shape a resumed
    // session has if turn 1 somehow never completed.
    putTurnResult(2, JSON.stringify({ finalMessage: "TURN-2-ONLY-SENTINEL-TEXT", turn: 2 }));
    const boundary: TurnBoundary = { events: { size: 0 }, timeline: { size: 0 } };
    const skillDir = mkdtempSync(join(tmpdir(), "cwh-crit-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "# a skill\nguidance");
    const result = packageEvidence(dir, boundary, skillDir, true); // isResume:true
    expect(result.turn1ResultDegraded).toBe(true);
    expect(result.pkg).toMatch(/DEGRADED/);
    expect(result.pkg).not.toContain("TURN-2-ONLY-SENTINEL-TEXT"); // never substituted a later turn's data for turn-1
    rmSync(skillDir, { recursive: true, force: true });
  });

  it("packageEvidence(..., isResume:false) (the default) does NOT flag the same missing-turn-1 shape as degraded — an ordinary single-shot run legitimately has one", () => {
    putTurnResult(1, JSON.stringify({ finalMessage: "single-shot turn-1 result", turn: 1 }));
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
