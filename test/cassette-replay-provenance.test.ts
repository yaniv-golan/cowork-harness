import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayCassette, buildSessionFingerprint, sessionFingerprintDrift, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";

// Covers three validated findings in src/run/cassette.ts:
//  - F46: the replay result assembler dropped `prompt`/`toolResults`/`fingerprint` as `undefined` even
//    though the replay drive already has them in hand.
//  - F45: `sessionFingerprintDrift` collapses "verified identical" and "couldn't verify" into the same
//    `{drifted:false}` shape — a consumer can't tell the two apart.
//  - F51: `sessionFingerprintDrift` could hard-fail against a same-named-but-unrelated session file after
//    a cassette relocation that didn't preserve the original directory layout.

// Silence the ::warning:: lines a couple of these cassettes intentionally provoke.
const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function mute(): void {
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

const baseScenario = (session: string) => ({
  name: "c",
  baseline: "latest",
  session,
  fidelity: "container" as const,
  prompt: "do the thing",
  answers: [],
  expect_denied: [],
  assert: [{ result: "success" as const }],
});

describe("F46: replay populates prompt/toolResults/fingerprint from values already in hand", () => {
  it("a replay result carries the scenario prompt, the re-drive's tool results, and a frozen fingerprint", async () => {
    mute();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { path: "x" } }] },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: [{ type: "text", text: "ok" }] }],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette: any = {
      scenario: baseScenario("(inline)"),
      events,
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      // A record-time fingerprint the replay must surface FROZEN, not silently drop.
      fingerprint: { baseline: "1.0.0", skillHash: "deadbeef" },
    };
    const r = await replayCassette(cassette);

    // prompt: sourced from the scenario that drove the replay re-drive.
    expect(r.prompt).toBe("do the thing");

    // toolResults: rec.toolResults is already built and fed to the eval context (toolResultTexts/
    // toolResultsTruncated) during replay — was dropped as `undefined` even though it's on hand.
    expect(r.toolResults).toEqual([{ toolUseId: "toolu_1", isError: false, text: "ok", assertText: "ok", assertTextTruncated: false }]);

    // fingerprint: the cassette's record-time fingerprint, passed through with a `frozen:true` marker so
    // it can't be mistaken for a fresh run-time recompute (RunResult.fingerprint's documented default
    // meaning per src/types.ts:978-980) — a replay never recomputes it.
    expect(r.fingerprint).toEqual({ baseline: "1.0.0", skillHash: "deadbeef", frozen: true });
  });

  it("no cassette fingerprint ⇒ replay result carries no fingerprint (never fabricates one)", async () => {
    mute();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette: any = { scenario: baseScenario("(inline)"), events, controlOut: [], cassetteVersion: CASSETTE_VERSION };
    const r = await replayCassette(cassette);
    expect(r.fingerprint).toBeUndefined();
  });
});

describe("F45: sessionFingerprintDrift surfaces a distinct 'unverifiable' signal, still non-failing", () => {
  it("verified identical ⇒ drifted:false, unverifiable absent (a real, positive verification)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-f45-match-"));
    const folder = join(d, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folder}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);
    const cassette = { sessionFingerprint: fp, scenario: baseScenario("s.yaml") } as unknown as Cassette;
    const r = sessionFingerprintDrift(cassette, d);
    expect(r).toEqual({ drifted: false });
    expect(r.unverifiable).toBeFalsy();
  });

  it("current session unresolvable ⇒ drifted:false BUT unverifiable:true (distinct from verified-identical)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-f45-unres-"));
    const cassette = { sessionFingerprint: "deadbeef", scenario: baseScenario("gone.yaml") } as unknown as Cassette;
    const r = sessionFingerprintDrift(cassette, d);
    expect(r.drifted).toBe(false); // non-failing — never a false mismatch
    expect(r.unverifiable).toBe(true); // but a consumer CAN see this wasn't a real verification
    expect(r.note).toBeDefined();
  });
});

describe("F51: a relocated cassette resolving a same-named-but-different session does not hard-fail", () => {
  it("sourceVia 'persisted' (directory structure confirmed intact) ⇒ a genuine mismatch still hard-fails", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-f51-persisted-"));
    const folderA = join(d, "a");
    mkdirSync(folderA, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderA}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);
    // session content changed since record (folder swapped).
    const folderB = join(d, "b");
    mkdirSync(folderB, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderB}\n`);
    const cassette = { sessionFingerprint: fp, scenario: baseScenario("s.yaml") } as unknown as Cassette;
    // Regression guard: unchanged behavior when the caller vouches the resolution is trustworthy.
    expect(sessionFingerprintDrift(cassette, d, "persisted")).toEqual({ drifted: true });
    // Regression guard: unchanged behavior for a caller that hasn't computed sourceVia at all (the
    // pre-F51 2-arg call site, e.g. a future caller or an older test) — same hard-fail as before.
    expect(sessionFingerprintDrift(cassette, d)).toEqual({ drifted: true });
  });

  it("sourceVia 'name-lookup' (structure NOT confirmed — resolved by name, may be an unrelated sibling) ⇒ downgraded to a non-failing note", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-f51-namelookup-"));
    const folderA = join(d, "a");
    mkdirSync(folderA, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderA}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);
    // Simulate relocation: the cassette (and a same-named session file at the SAME relative offset) is
    // now next to an UNRELATED s.yaml — same name, different content, never recorded by this cassette.
    const folderB = join(d, "b");
    mkdirSync(folderB, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderB}\n`);
    const cassette = { sessionFingerprint: fp, scenario: baseScenario("s.yaml") } as unknown as Cassette;
    const r = sessionFingerprintDrift(cassette, d, "name-lookup");
    expect(r.drifted).toBe(false); // NEVER false-red on an unconfirmed relative-offset resolution
    expect(r.unverifiable).toBe(true);
    expect(r.note).toMatch(/unrelated same-named sibling|structure could not be confirmed/);
  });

  it("sourceVia 'none' (nothing to compare the layout against) ⇒ unchanged pre-F51 behavior, still hard-fails", () => {
    // Precedent parity: scenarioContentDrift's OWN 'none' case means "nothing to compare" (silent, no
    // note at all) — it is not the same signal as 'name-lookup' ("found something, low confidence").
    // sessionFingerprintDrift mirrors that distinction: only 'name-lookup' downgrades; 'none' (and the
    // omitted-argument 2-arg call) keep trusting the resolution, so an existing hard-fail (e.g. the
    // session-fingerprint.test.ts end-to-end cassette, which never records a scenarioSource) doesn't
    // silently stop catching genuine session drift.
    const d = mkdtempSync(join(tmpdir(), "cwh-f51-none-"));
    const folderA = join(d, "a");
    mkdirSync(folderA, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderA}\n`);
    const fp = buildSessionFingerprint("s.yaml", d);
    const folderB = join(d, "b");
    mkdirSync(folderB, { recursive: true });
    writeFileSync(join(d, "s.yaml"), `folders:\n  - from: ${folderB}\n`);
    const cassette = { sessionFingerprint: fp, scenario: baseScenario("s.yaml") } as unknown as Cassette;
    expect(sessionFingerprintDrift(cassette, d, "none")).toEqual({ drifted: true });
  });
});
