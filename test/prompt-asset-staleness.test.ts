import { describe, it, expect } from "vitest";
import { hashBaselinePromptAssets, computeStaleness, promptAssetStaleness } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";

describe("promptAssetsHash — prompt-asset edits stale cassettes under the SAME appVersion", () => {
  const latest = loadBaseline("latest");
  const appVersion = latest.appVersion;

  it("hashes the committed asset bytes deterministically (takes the baseline OBJECT)", () => {
    const a = hashBaselinePromptAssets(latest);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hashBaselinePromptAssets(latest)).toBe(a);
  });
  it("a baseline with no prompt pointers → undefined (evidence-unavailable, never a fake hash)", () => {
    expect(
      hashBaselinePromptAssets({
        ...latest,
        spawn: { ...latest.spawn, promptTemplate: undefined, subagentAppend: undefined, subagentAppendHostLoop: undefined },
      } as never),
    ).toBeUndefined();
  });
  it("recorded hash ≠ live hash → a 'prompt-assets' staleness FINDING (warn-by-default class)", () => {
    const cassette = {
      scenario: { fidelity: "hostloop", assert: [] },
      effectiveFidelity: "hostloop",
      fingerprint: { baseline: appVersion, promptAssetsHash: "0000000000000000" },
      events: [],
    } as never;
    const { findings } = computeStaleness(cassette, undefined);
    expect(findings.some((f) => f.class === "prompt-assets" && /re-record/.test(f.message))).toBe(true);
  });
  it("cassette without the field → informational note, NOT a finding", () => {
    const cassette = {
      scenario: { fidelity: "hostloop", assert: [] },
      effectiveFidelity: "hostloop",
      fingerprint: { baseline: appVersion },
      events: [],
    } as never;
    const { findings, notes } = computeStaleness(cassette, undefined);
    expect(findings.some((f) => f.class === "prompt-assets")).toBe(false);
    expect(notes.some((n) => /prompt-asset/.test(n))).toBe(true);
  });
  // The unverifiable branch is exercised DIRECTLY via the extracted pure helper (Step 3e) so the test
  // is non-vacuous — a live baseline whose prompt pointer dangles yields undefined, and a recorded
  // hash present + same appVersion MUST produce the unverifiable finding, never neither.
  it("recorded hash present + live baseline can't hash its assets → unverifiable-prompt-assets (never silent-green)", () => {
    const danglingLive = { ...latest, spawn: { ...latest.spawn, subagentAppendHostLoop: "prompts/does-not-exist.md" } } as never;
    const fp = { baseline: appVersion, promptAssetsHash: "deadbeefdeadbeef" } as never;
    const finding = promptAssetStaleness(fp, danglingLive); // extracted helper — returns a finding | note | null
    expect(finding).toMatchObject({ class: "unverifiable-prompt-assets" });
  });
});
