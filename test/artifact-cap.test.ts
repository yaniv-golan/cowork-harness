import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, artifactJsonTargetsTruncated } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

/** The inline-body cap is configurable, and a `record` truncates a body over the cap to hash-only. */
function workRootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-cap-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("configurable artifact body cap + record-time truncation guard", () => {
  it("buildManifest inlines a body at/under the cap and truncates (hash-only) over it", () => {
    const root = workRootWith({ "outputs/small.json": "{}", "outputs/big.json": JSON.stringify({ x: "y".repeat(200) }) });
    const m = buildManifest(root, 64); // cap = 64 bytes
    const small = m.find((e) => e.path === "outputs/small.json")!;
    const big = m.find((e) => e.path === "outputs/big.json")!;
    expect(small.body).toBeDefined();
    expect(small.truncated).toBeUndefined();
    expect(big.truncated).toBe(true);
    expect(big.body).toBeUndefined();
    expect(big.sha256).toMatch(/^[0-9a-f]{64}$/); // hash still recorded
  });

  it("a generous cap inlines what the default would truncate", () => {
    const big = JSON.stringify({ x: "y".repeat(200) });
    const root = workRootWith({ "outputs/big.json": big });
    const m = buildManifest(root, 1024 * 1024);
    expect(m[0].truncated).toBeUndefined();
    expect(m[0].body).toBe(big);
  });

  const scenarioAsserting = (artifact: string): Scenario =>
    ({
      name: "s",
      prompt: "p",
      session: "(inline)",
      fidelity: "protocol",
      answers: [],
      expect_denied: [],
      assert: [{ artifact_json: { artifact, path: "x" } }],
    }) as unknown as Scenario;

  it("flags an artifact_json that targets a TRUNCATED artifact (the green-record/red-replay trap)", () => {
    const root = workRootWith({ "outputs/big.json": JSON.stringify({ x: "y".repeat(200) }) });
    const manifest = buildManifest(root, 64);
    const hits = artifactJsonTargetsTruncated(scenarioAsserting("outputs/big.json"), root, manifest);
    expect(hits).toEqual(["outputs/big.json"]);
  });

  it("normalizes ./-prefixed assertion paths against the manifest walk paths", () => {
    const root = workRootWith({ "outputs/big.json": JSON.stringify({ x: "y".repeat(200) }) });
    const manifest = buildManifest(root, 64);
    const hits = artifactJsonTargetsTruncated(scenarioAsserting("./outputs/big.json"), root, manifest);
    expect(hits).toEqual(["./outputs/big.json"]);
  });

  it("does NOT flag when the asserted artifact fits under the cap (committed body present)", () => {
    const root = workRootWith({ "outputs/small.json": "{}" });
    const manifest = buildManifest(root, 64);
    const hits = artifactJsonTargetsTruncated(scenarioAsserting("outputs/small.json"), root, manifest);
    expect(hits).toEqual([]);
  });
});
