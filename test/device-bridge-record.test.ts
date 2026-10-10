// RunResult.deviceBridge: what a device_bridge run modeled, frozen into its cassette so a later build that models the
// bridge differently cannot re-describe an old recording. It names its own divergences from production, so a 1a
// run never reads as faithful where it is not (a delete the device copy allows, an allowlist where production may
// pass everything through).
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import { CASSETTE_VERSION, readCassette, replayCassette, type Cassette } from "../src/run/cassette.js";
import { deviceBridgeRecord } from "../src/runtime/device-container.js";
import type { Mount } from "../src/session.js";
import type { Scenario } from "../src/types.js";

const mounts: Mount[] = [
  { hostPath: "/x/p", mountPath: "proj", mode: "rw", kind: "folder" },
  { hostPath: "/x/r", mountPath: ".projects/ref", mode: "r", kind: "folder" },
  { hostPath: "/x/u", mountPath: "uploads/u.txt", mode: "r", kind: "upload" },
];

describe("deviceBridgeRecord", () => {
  const r = deviceBridgeRecord(mounts);
  it("names the tools served, which load without ToolSearch, and the Desktop build that was measured on", () => {
    expect(r.served).toEqual(["device_bash", "get_device_info"]);
    expect(r.alwaysLoad).toEqual(["device_bash"]);
    expect(r.measuredOn).toBe("2.31226.1");
  });
  it("lists the folders by name and mode only, never a host path", () => {
    expect(r.folders).toEqual([
      { name: "proj", mode: "rw" },
      { name: "ref", mode: "r" },
    ]);
    expect(JSON.stringify(r)).not.toContain("/x/");
  });
  it("records the egress branch it modeled and every known divergence, the delete one included", () => {
    expect(r.egress).toBe("allowlist");
    expect(r.divergences).toEqual([
      "delete-not-refused",
      "egress-allowlist",
      "description-paraphrase",
      "device-paths-tilde",
      "device-tools-unserved",
    ]);
  });
});

const line = (o: unknown) => JSON.stringify(o);
function cassetteOf(extra: Partial<Cassette> = {}): Cassette {
  return {
    scenario: {
      name: "bridge",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      lane: "remote",
      device_bridge: true,
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    } as unknown as Scenario,
    events: [
      line({ type: "system", subtype: "init", tools: [], skills: [], claude_code_version: "2.1.295" }),
      line({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [],
    cassetteVersion: CASSETTE_VERSION,
    userVisibleRoots: ["outputs"],
    fingerprint: { baseline: loadBaseline("latest").appVersion },
    ...extra,
  } as unknown as Cassette;
}

describe("the cassette freezes the record", () => {
  it("replay reports the frozen record, not one rebuilt by this build", async () => {
    const frozen = { ...deviceBridgeRecord(mounts), measuredOn: "1.0.0", divergences: ["delete-not-refused"] };
    const r = await replayCassette(cassetteOf({ deviceBridge: frozen } as Partial<Cassette>), []);
    expect(r.deviceBridge).toEqual(frozen);
  });
  it("a cassette without one replays without one", async () => {
    expect((await replayCassette(cassetteOf(), [])).deviceBridge).toBeUndefined();
  });
  it("a malformed record is refused cleanly on read", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-bad-")));
    try {
      const f = join(dir, "bad.cassette.json");
      writeFileSync(f, JSON.stringify(cassetteOf({ deviceBridge: { served: "device_bash" } } as unknown as Partial<Cassette>)));
      const read = readCassette(f);
      expect("error" in read && read.error).toMatch(/deviceBridge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the recording path writes it when the run has one", () => {
    const s = readFileSync(join(import.meta.dirname, "..", "src", "run", "cassette.ts"), "utf8");
    expect(s).toMatch(/\.\.\.\(result\.deviceBridge \? \{ deviceBridge: result\.deviceBridge \} : \{\}\)/);
  });
});

// A live run needs Docker and the agent binary, so execute.ts's hand-off is pinned on the source: the full result
// and the partial (error / unanswered) result both carry the record, built from the launch plan.
describe("wiring: a live run carries the record", () => {
  const s = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");
  it("both the full and the partial result build it from the launch plan", () => {
    expect(s.match(/deviceBridge: scenario\.device_bridge === true \? deviceBridgeRecord\(plan\.mounts\) : undefined/g)).toHaveLength(2);
    expect(s).toMatch(/deviceBridge: args\.deviceBridge,/);
  });
});
