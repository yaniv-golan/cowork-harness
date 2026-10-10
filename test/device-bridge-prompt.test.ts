// Under `device_bridge: true` the agent's container holds no connected folder, so the local-lane prompt's claims that
// a folder is mounted in the agent's own tree are false there. Those claims give way to a harness note, in the main
// append and the VM sub-agent append, and the note is hashed into the prompt-asset fingerprint of a bridge run only.
import { describe, expect, it } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import { renderPrompts, DEVICE_BRIDGE_PROMPT_NOTE, DEVICE_BRIDGE_SUBAGENT_NOTE } from "../src/prompt.js";
import { hashBaselinePromptAssets, promptAssetStaleness } from "../src/run/cassette.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const baseline = loadBaseline("latest") as never;
const render = (deviceBridge?: boolean) =>
  renderPrompts(baseline, {} as never, "abc", "proj", { effectiveFidelity: "container", ...(deviceBridge ? { deviceBridge } : {}) });

describe("device_bridge prompt note", () => {
  const plain = render();
  const bridged = render(true);

  it("the main append carries the note and no longer says a folder is mounted in the agent's tree", () => {
    const a = bridged.systemPromptAppend!;
    expect(plain.systemPromptAppend).toContain("a connected work folder is mounted under");
    expect(a).toContain(DEVICE_BRIDGE_PROMPT_NOTE.replace("{{cwd}}", "/sessions/abc"));
    expect(a).not.toContain("a connected work folder is mounted under");
    expect(a).not.toContain("this folder IS that folder");
    expect(a).not.toContain("/mnt/proj");
    expect(a).toContain("/mnt/outputs");
    expect(a).toContain("User selected a folder: true");
  });

  it("the VM sub-agent append carries its note instead of the mounted-folders sentence", () => {
    const s = bridged.subagentAppend!;
    expect(plain.subagentAppend).toContain("User-attached folders are mounted under");
    expect(s).toContain(DEVICE_BRIDGE_SUBAGENT_NOTE);
    expect(s).not.toContain("User-attached folders are mounted under");
  });

  it("names device_bash and where the folders are, as the model reports production's own instructions do", () => {
    for (const note of [DEVICE_BRIDGE_PROMPT_NOTE, DEVICE_BRIDGE_SUBAGENT_NOTE]) {
      expect(note).toContain("device_bash");
      expect(note).toContain("$HOME/mnt/<folder-name>");
    }
  });

  it("leaves a run without the bridge exactly as it was", () => {
    expect(render(false)).toEqual(plain);
  });
});

describe("device_bridge prompt-asset fingerprint", () => {
  const b = loadBaseline("latest");
  it("a bridge run hashes the note in; every other run hashes what it did", () => {
    expect(hashBaselinePromptAssets(b, { deviceBridge: true })).not.toBe(hashBaselinePromptAssets(b));
    expect(hashBaselinePromptAssets(b, { deviceBridge: false })).toBe(hashBaselinePromptAssets(b));
  });
});

describe("device_bridge prompt-asset staleness", () => {
  const b = loadBaseline("latest");
  const fp = { baseline: b.appVersion, promptAssetsHash: hashBaselinePromptAssets(b, { deviceBridge: true }) } as never;
  it("a bridge recording checks against the bridge hash, and is clean when nothing moved", () => {
    expect(promptAssetStaleness(fp, b, { deviceBridge: true })).toBeNull();
  });
  it("checked as a non-bridge recording, the same hash reads as drift", () => {
    expect(promptAssetStaleness(fp, b)).toMatchObject({ class: "prompt-assets" });
  });
});

describe("wiring: the bridge flag reaches the render and both fingerprint sites", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  it("execute.ts renders with it and fingerprints with it", () => {
    const s = read("run/execute.ts");
    expect(s).toMatch(/renderPrompts\([^;]*deviceBridge: scenario\.device_bridge === true/);
    expect(s.match(/buildFingerprint\([^;]*\{\s*deviceBridge: scenario\.device_bridge === true,?\s*\}\)/g)).toHaveLength(2);
  });
  it("replay staleness reads it off the frozen scenario", () => {
    expect(read("run/cassette.ts")).toMatch(
      /promptAssetStaleness\(fp, liveBaselineObj, \{ deviceBridge: cassette\.scenario\.device_bridge === true \}\)/,
    );
  });
});
