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

describe("input_unmodified on replay", () => {
  // The central regression guard for this assertion: replay's materialized tree writes a 0-byte
  // placeholder for a body-less manifest entry (see materializeManifest). A naive implementation that
  // re-hashes the materialized workRoot would hash that empty placeholder and wrongly report "modified
  // in place" for a file the agent never touched. The correct implementation reads the AUTHORITATIVE
  // sha256 straight off the cassette manifest (ctx.postRunHashes, built from `artifacts[].sha256`) instead.
  it("uses the manifest's authoritative post-run hash, not a re-hash of the materialized 0-byte placeholder", async () => {
    mute();
    const preRunSha = createHash("sha256").update("the real pre-existing content").digest("hex");
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ input_unmodified: ["ref/**"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: ["ref/in.md"],
      preRunHashes: { "ref/in.md": preRunSha },
      // body-less entry (over the artifact-body cap / read-only input) → materialized as a 0-byte
      // placeholder, but the manifest's sha256 is still the real recorded hash.
      artifacts: [{ path: "ref/in.md", bytes: 512_000, sha256: preRunSha, truncated: true, truncationReason: "size" }],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.input_unmodified !== undefined);
    expect(a).toBeDefined();
    expect(a!.pass).toBe(true); // would FAIL against a naive re-hash of the empty placeholder
  });

  it("a real content change IS caught on replay via the manifest's post-run hash", async () => {
    mute();
    const preRunSha = createHash("sha256").update("the real pre-existing content").digest("hex");
    const postRunSha = createHash("sha256").update("a different post-run content").digest("hex");
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ input_unmodified: ["ref/**"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: ["ref/in.md"],
      preRunHashes: { "ref/in.md": preRunSha },
      artifacts: [{ path: "ref/in.md", bytes: 29, sha256: postRunSha, body: "a different post-run content", encoding: undefined }],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.input_unmodified !== undefined);
    expect(a).toBeDefined();
    expect(a!.pass).toBe(false);
    expect(a!.message).toMatch(/modified in place/);
    expect(a!.message).toMatch(/ref\/in\.md/);
  });

  it("a deleted pre-existing file is caught on replay (present-but-empty manifest, path absent from postRunHashes)", async () => {
    // The agent DELETED a matched pre-existing file: its path is in preRunHashes (it existed at spawn)
    // but absent from the cassette manifest (gone at run end). This exercises the replay-lane
    // `postRunHashes[p] ?? null` branch — a missing key resolves to null ⇒ removed ⇒ content change.
    // The manifest is present-but-empty, so the presence-gated `iumReplayable` (not length-gated) must
    // still evaluate the key rather than silently strip it — the same asymmetry no_unexpected_files avoids.
    mute();
    const preRunSha = createHash("sha256").update("content that was deleted").digest("hex");
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ input_unmodified: ["ref/**"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: ["ref/in.md"],
      preRunHashes: { "ref/in.md": preRunSha },
      artifacts: [], // present-but-empty: the file is gone at run end
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.input_unmodified !== undefined);
    expect(a).toBeDefined();
    expect(a!.pass).toBe(false);
    expect(a!.message).toMatch(/removed/);
    expect(a!.message).toMatch(/ref\/in\.md/);
  });

  it("excludes the key loudly when preRunHashes is absent (cassette predates the hash manifest)", async () => {
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
        assert: [{ result: "success" }, { input_unmodified: ["ref/**"] }],
      },
      events: okEvents(),
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      preRunPaths: ["ref/in.md"],
      // preRunHashes deliberately absent
      artifacts: [{ path: "ref/in.md", bytes: 2, sha256: sha, body, encoding: undefined }],
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.assertions.some((a) => a.assertion.input_unmodified !== undefined)).toBe(false);
    expect(computeVerdict(r, "replay").pass).toBe(true);
  });
});
