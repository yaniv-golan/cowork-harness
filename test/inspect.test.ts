import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInspectView } from "../src/run/inspect-view.js";
import { LegacyRunDirError } from "../src/errors.js";

/** A kept run dir: turns/1/result.json + a work tree with one JSON artifact. */
function runDir(over: Record<string, unknown> = {}, opts: { withWork?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-inspect-"));
  const workDir = join(root, "work", "session", "mnt");
  if (opts.withWork !== false) {
    mkdirSync(join(workDir, "outputs"), { recursive: true });
    writeFileSync(
      join(workDir, "outputs", "model.json"),
      JSON.stringify({ detected_stage: "seed", founders: ["A", "B"], warnings: [], fd: { fully_diluted: 1000000 } }),
    );
  }
  const result = {
    scenario: "cap-table",
    fidelity: "container",
    result: "success",
    durationMs: 4200,
    outDir: root,
    workDir,
    userVisibleRoots: ["outputs"],
    artifacts: [{ path: "outputs/model.json", bytes: 80 }],
    ...over,
  };
  const turn1 = join(root, "turns", "1");
  mkdirSync(turn1, { recursive: true });
  writeFileSync(join(turn1, "result.json"), JSON.stringify(result, null, 2));
  return root;
}

describe("buildInspectView — surface what a run produced", () => {
  it("lists artifacts and previews top-level JSON fields", () => {
    const out = buildInspectView(runDir());
    expect(out).toContain("cap-table");
    expect(out).toContain("outputs/model.json");
    expect(out).toContain("detected_stage");
    expect(out).toContain("seed");
    // arrays shown as a count, not dumped
    expect(out).toMatch(/founders.*\[2/);
  });

  it("flags a PARTIAL run and shows the unanswered gate", () => {
    const out = buildInspectView(runDir({ result: "error", partial: true, unansweredGate: { message: "unscripted gate: Confirm?" } }));
    expect(out).toMatch(/PARTIAL/);
    expect(out).toContain("Confirm?");
  });

  it("degrades when the work dir was torn down: manifest survives, preview unavailable", () => {
    const out = buildInspectView(runDir({}, { withWork: false }));
    expect(out).toContain("outputs/model.json"); // manifest paths survive in result.json
    expect(out).toMatch(/work dir|--keep|unavailable/i);
  });

  it("emits a structured digest under json mode", () => {
    const digest = JSON.parse(buildInspectView(runDir(), { json: true }));
    expect(digest.scenario).toBe("cap-table");
    expect(digest.artifacts[0].path).toBe("outputs/model.json");
    expect(digest.artifacts[0].preview.detected_stage).toBe("seed");
  });

  // artifacts === undefined means evidence-unavailable (replay, or a run whose root vanished — the same
  // lanes workspaceFiles is dropped in), NOT a genuine zero-artifact run. `artifacts ?? []` +
  // "artifacts (0):" erased that; these lock the honest marker.
  it("artifacts ABSENT → artifactsRecorded:false and a loud UNAVAILABLE marker (not 'artifacts (0):')", () => {
    const text = buildInspectView(runDir({ artifacts: undefined })); // JSON.stringify drops the key
    expect(text).toMatch(/UNAVAILABLE/);
    expect(text).not.toContain("artifacts (0):");
    const digest = JSON.parse(buildInspectView(runDir({ artifacts: undefined }), { json: true }));
    expect(digest.artifactsRecorded).toBe(false);
  });

  it("artifacts: [] → artifactsRecorded:true and the affirming zero-artifact line, distinct from the absent case", () => {
    const text = buildInspectView(runDir({ artifacts: [] }));
    expect(text).not.toMatch(/UNAVAILABLE/);
    expect(text).toContain("artifacts (0):");
    const digest = JSON.parse(buildInspectView(runDir({ artifacts: [] }), { json: true }));
    expect(digest.artifactsRecorded).toBe(true);
  });
});

// Before the per-turn layout, a dir with no result.json at all just threw a generic "no result.json"
// message (`inspect-view.ts:49-50`, pre-seam) — which reads as corruption on a LEGACY dir, where the file
// is sitting right there at the root. `requireTurns` refuses these loudly instead, naming the shape.
describe("buildInspectView refuses a legacy/mixed/pre-completion run dir, naming the shape", () => {
  it("legacy: root result.json, no turns/ — the pre-per-turn-layout shape", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-inspect-legacy-"));
    writeFileSync(join(root, "result.json"), JSON.stringify({ scenario: "s", result: "success" }));
    writeFileSync(join(root, "run.jsonl"), "{}\n");
    expect(() => buildInspectView(root)).toThrow(LegacyRunDirError);
    expect(() => buildInspectView(root)).toThrow(/pre-layout run dir/);
  });

  it("mixed: turns/ present AND a stray root marker — a pre-layout dir resumed under current code", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-inspect-mixed-"));
    mkdirSync(join(root, "turns", "2"), { recursive: true });
    writeFileSync(join(root, "turns", "2", "result.json"), JSON.stringify({ scenario: "s", result: "success" }));
    writeFileSync(join(root, "result.turn-1.json"), JSON.stringify({ scenario: "s", result: "success" }));
    expect(() => buildInspectView(root)).toThrow(/MIXED run dir/);
  });

  it("none: neither turns/ nor any pre-layout marker — this run never completed", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-inspect-none-"));
    expect(() => buildInspectView(root)).toThrow(/never completed/);
  });
});
