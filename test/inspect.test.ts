import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInspectView } from "../src/run/inspect-view.js";

/** A kept run dir: result.json + a work tree with one JSON artifact. */
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
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
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
