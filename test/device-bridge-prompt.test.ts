// Under `device_bridge: true` the agent's container holds no connected folder, so the local-lane prompt's claims that
// a folder is mounted in the agent's own tree are false there. Those claims give way to a harness note, in the main
// append and the VM sub-agent append, and the note is hashed into the prompt-asset fingerprint of a bridge run only.
import { describe, expect, it } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import { renderPrompts, DEVICE_BRIDGE_PROMPT_NOTE, DEVICE_BRIDGE_SUBAGENT_NOTE } from "../src/prompt.js";
import { hashBaselinePromptAssets, promptAssetStaleness } from "../src/run/cassette.js";
import { deviceBridgeNoteMode } from "../src/runtime/device-container.js";
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
    expect(
      s.match(/buildFingerprint\([^;]*\{\s*deviceBridge: scenario\.device_bridge === true,\s*deviceBridgeNote: bridgeNote,?\s*\}\)/g),
    ).toHaveLength(2);
  });
  it("replay staleness reads it off the frozen scenario", () => {
    expect(read("run/cassette.ts")).toMatch(
      /promptAssetStaleness\(fp, liveBaselineObj, \{\s*deviceBridge: cassette\.scenario\.device_bridge === true,/,
    );
  });
});

// A maintainer control: COWORK_HARNESS_DEVICE_BRIDGE_NOTE=off renders the bridge with the folder claims removed and NO
// note, to measure whether the model finds device_bash from the tool's own description alone. The run records which,
// and the prompt-asset fingerprint follows it, so a no-note recording never reads as stale against a note one.
describe("the device_bridge note can be omitted for a control run", () => {
  it("deviceBridgeNoteMode reads the env switch: only 'off' omits it", () => {
    expect(deviceBridgeNoteMode({ COWORK_HARNESS_DEVICE_BRIDGE_NOTE: "off" })).toBe("omitted");
    for (const v of [undefined, "", "on", "OFF "]) expect(deviceBridgeNoteMode({ COWORK_HARNESS_DEVICE_BRIDGE_NOTE: v })).toBe("included");
  });
  it("omitted: no note in either append, and the false folder claims are still gone", () => {
    const r = renderPrompts(baseline, {} as never, "abc", "proj", {
      effectiveFidelity: "container",
      deviceBridge: true,
      deviceBridgeNote: "omitted",
    });
    expect(r.systemPromptAppend).not.toContain("device_bash");
    expect(r.systemPromptAppend).not.toContain("a connected work folder is mounted under");
    expect(r.systemPromptAppend).not.toContain("this folder IS that folder");
    expect(r.subagentAppend).not.toContain("device_bash");
    expect(r.subagentAppend).not.toContain("User-attached folders are mounted under");
  });
  it("the fingerprint tells included, omitted and no bridge apart, and staleness reads the recorded mode", () => {
    const b = loadBaseline("latest");
    const inc = hashBaselinePromptAssets(b, { deviceBridge: true });
    const om = hashBaselinePromptAssets(b, { deviceBridge: true, deviceBridgeNote: "omitted" });
    expect(new Set([inc, om, hashBaselinePromptAssets(b)]).size).toBe(3);
    expect(hashBaselinePromptAssets(b, { deviceBridge: true, deviceBridgeNote: "included" })).toBe(inc);
    const fp = { baseline: b.appVersion, promptAssetsHash: om } as never;
    expect(promptAssetStaleness(fp, b, { deviceBridge: true, deviceBridgeNote: "omitted" })).toBeNull();
    expect(readFileSync(join(import.meta.dirname, "..", "src", "run", "cassette.ts"), "utf8")).toMatch(
      /promptAssetStaleness\(fp, liveBaselineObj, \{\s*deviceBridge: cassette\.scenario\.device_bridge === true,\s*deviceBridgeNote: cassette\.deviceBridge\?\.promptNote \?\? "included",?\s*\}\)/,
    );
  });
  it("execute.ts renders, fingerprints and records with the mode", () => {
    const s = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");
    expect(s).toMatch(/deviceBridgeNote: bridgeNote,/);
    expect(s.match(/deviceBridgeRecord\(plan\.mounts, bridgeNote, plan, bridgeGrants\(\)\)/g)).toHaveLength(2);
    expect(s.match(/deviceBridge: scenario\.device_bridge === true,\s*deviceBridgeNote: bridgeNote,/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("a no-note recording and a note recording are stale against each other", () => {
  const b = loadBaseline("latest");
  const fpOf = (deviceBridgeNote: "included" | "omitted") =>
    ({ baseline: b.appVersion, promptAssetsHash: hashBaselinePromptAssets(b, { deviceBridge: true, deviceBridgeNote }) }) as never;
  it("note-off recording, checked as note-on: drift", () => {
    expect(promptAssetStaleness(fpOf("omitted"), b, { deviceBridge: true, deviceBridgeNote: "included" })).toMatchObject({
      class: "prompt-assets",
    });
  });
  it("note-on recording, checked as note-off: drift", () => {
    expect(promptAssetStaleness(fpOf("included"), b, { deviceBridge: true, deviceBridgeNote: "omitted" })).toMatchObject({
      class: "prompt-assets",
    });
  });
});

describe("a control run says so on stderr", () => {
  it("execute.ts prints a notice when the note is omitted", () => {
    const s = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");
    expect(s).toMatch(
      /if \(scenario\.device_bridge === true && bridgeNote === "omitted"\)\s*warn\(\s*`::notice:: \[device_bridge\] prompt note OMITTED/,
    );
  });
});
