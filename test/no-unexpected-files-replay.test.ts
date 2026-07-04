import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { computeVerdict } from "../src/run/verdict.js";
import { loadBaseline } from "../src/baseline.js";

const LIVE = loadBaseline("latest").appVersion;

const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function mute(): void {
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

const okEvents = () => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

describe("no_unexpected_files on replay", () => {
  it("evaluates token-free when manifest + preRunPaths are present", async () => {
    mute();
    const body = "{}";
    const sha = createHash("sha256").update(body).digest("hex");
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ no_unexpected_files: ["outputs/good.json"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: [],
      artifacts: [
        { path: "outputs/good.json", bytes: 2, sha256: sha, body, encoding: undefined },
        { path: "outputs/stray.json", bytes: 2, sha256: sha, body, encoding: undefined },
      ],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.no_unexpected_files !== undefined);
    expect(a).toBeDefined();
    expect(a!.pass).toBe(false);
    expect(a!.message).toMatch(/stray\.json/);
  });

  it("excludes the key loudly when preRunPaths is absent (pre-0.24 cassette)", async () => {
    mute();
    const body = "{}";
    const sha = createHash("sha256").update(body).digest("hex");
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }, { no_unexpected_files: ["outputs/**"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      artifacts: [{ path: "outputs/x.json", bytes: 2, sha256: sha, body, encoding: undefined }],
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.assertions.some((a) => a.assertion.no_unexpected_files !== undefined)).toBe(false);
    expect(computeVerdict(r, "replay").pass).toBe(true);
  });

  it("green fixture: replays and passes when every created file is allowlisted", async () => {
    mute();
    const body = "{}";
    const sha = createHash("sha256").update(body).digest("hex");
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ no_unexpected_files: ["outputs/good.json"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: [],
      artifacts: [{ path: "outputs/good.json", bytes: 2, sha256: sha, body, encoding: undefined }],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.no_unexpected_files !== undefined);
    expect(a).toBeDefined();
    expect(a!.pass).toBe(true);
  });

  it("empty-but-present manifest evaluates the canonical [] green case", async () => {
    mute();
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ no_unexpected_files: [] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: [],
      artifacts: [],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.no_unexpected_files !== undefined);
    expect(a).toBeDefined();
    expect(a!.pass).toBe(true);
    expect(r.skippedAssertions?.full).toBe(0);
  });

  it("manifest-less cassette counts a mixed-assertion drop as a partial skip", async () => {
    mute();
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success", no_unexpected_files: ["outputs/**"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.assertions.some((a) => a.assertion.no_unexpected_files !== undefined)).toBe(false);
    expect(r.assertions.some((a) => a.assertion.result !== undefined)).toBe(true);
    expect(r.skippedAssertions?.partial).toBe(1);
  });
});
