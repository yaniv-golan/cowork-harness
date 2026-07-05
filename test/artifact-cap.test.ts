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

// T3: a `mode: "r"` connected-folder input is captured BODY-LESS (path + bytes + sha256, no body,
// truncated:true) — the SAME representation the 64-KiB cap already produces — regardless of size,
// so it neither bloats the cassette nor trips the `binary` privacy finding, but the entry still
// survives so replay's materializeManifest can write a 0-byte placeholder for `computer_links_resolve`.
describe("buildManifest — bodyLessPrefixes (T3 read-only connected-folder capture)", () => {
  it("strips the body for a path under a bodyLessPrefix even though it's well under the size cap", () => {
    const root = workRootWith({ "carta-folder/synthetic_carta.xlsx": "tiny input content" });
    const m = buildManifest(root, 1024 * 1024, ["carta-folder"], ["carta-folder"]);
    const entry = m.find((e) => e.path === "carta-folder/synthetic_carta.xlsx")!;
    expect(entry.body).toBeUndefined();
    expect(entry.encoding).toBeUndefined();
    expect(entry.truncated).toBe(true);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/); // integrity preserved without leaking content
    expect(entry.bytes).toBeGreaterThan(0); // positive proof the file existed at record time
  });

  it("leaves a path OUTSIDE the bodyLessPrefixes fully captured (a mode:rw deliverable keeps its body)", () => {
    const root = workRootWith({
      "carta-folder/synthetic_carta.xlsx": "tiny input content",
      "outputs/report.md": "# generated deliverable",
    });
    const m = buildManifest(root, 1024 * 1024, ["carta-folder", "outputs"], ["carta-folder"]);
    const input = m.find((e) => e.path === "carta-folder/synthetic_carta.xlsx")!;
    const output = m.find((e) => e.path === "outputs/report.md")!;
    expect(input.truncated).toBe(true);
    expect(input.body).toBeUndefined();
    expect(output.truncated).toBeUndefined();
    expect(output.body).toBe("# generated deliverable"); // rw output: full body committed, unaffected
  });

  it("a body-less input raises NO `binary` privacy finding even though its content is non-UTF-8", async () => {
    const { scanCassette, CASSETTE_VERSION } = await import("../src/run/cassette.js");
    const root = mkdtempSync(join(tmpdir(), "cwh-cap-bin-"));
    mkdirSync(join(root, "carta-folder"), { recursive: true });
    // A raw byte sequence that is NOT valid UTF-8 (a lone 0xff/0xfe pair) — mirrors an .xlsx's binary body.
    writeFileSync(join(root, "carta-folder", "synthetic_carta.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]));
    const artifacts = buildManifest(root, 1024 * 1024, ["carta-folder"], ["carta-folder"]);
    const cassette = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "t",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "p",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      controlOut: [],
      artifacts,
      userVisibleRoots: ["outputs", "carta-folder"], // full root set survives — only the body was stripped
    } as unknown as Parameters<typeof scanCassette>[0];
    const findings = scanCassette(cassette, []);
    expect(findings.some((f) => f.cls === "binary")).toBe(false);
  });

  it("artifactJsonTargetsTruncated: flags an OVER-CAP deliverable but EXCLUDES a read-only input", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-cap-ajt-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    mkdirSync(join(root, "carta-folder"), { recursive: true });
    writeFileSync(join(root, "outputs", "big.json"), JSON.stringify({ x: "y".repeat(200) })); // over the 64B cap
    writeFileSync(join(root, "carta-folder", "in.json"), JSON.stringify({ a: 1 })); // read-only input
    const artifacts = buildManifest(root, 64, ["outputs", "carta-folder"], ["carta-folder"]);
    const scenario = {
      assert: [
        { artifact_json: { artifact: "outputs/big.json", path: "x", exists: true } },
        { artifact_json: { artifact: "carta-folder/in.json", path: "a", equals: 1 } },
      ],
    } as unknown as Parameters<typeof artifactJsonTargetsTruncated>[0];
    // over-cap deliverable IS flagged (raise the cap is the right remedy); the read-only input is NOT
    // (it's body-less by policy — handled by the symmetric evidence-unavailable, not "too large").
    expect(artifactJsonTargetsTruncated(scenario, root, artifacts)).toEqual(["outputs/big.json"]);
  });
});
