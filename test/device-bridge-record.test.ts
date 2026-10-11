// RunResult.deviceBridge: what a device_bridge run modeled, frozen into its cassette so a later build that models the
// bridge differently cannot re-describe an old recording. It names its own divergences from production, so a bridge
// run never reads as faithful where it is not (a delete the device copy allows, an allowlist where production may
// pass everything through).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import { CASSETTE_VERSION, readCassette, replayCassette, type Cassette } from "../src/run/cassette.js";
import { deviceBridgeRecord } from "../src/runtime/device-container.js";
import { computeVerdict } from "../src/run/verdict.js";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
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
  it("says the prompt note rests on a model's report of production's instructions, not their text", () => {
    expect(r.promptNoteBasis).toBe("model-report");
  });
  it("records whether the prompt note was included (the default) or omitted for a control run", () => {
    expect(r.promptNote).toBe("included");
    expect(deviceBridgeRecord(mounts, "omitted").promptNote).toBe("omitted");
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
      "shell-user",
      "device-network-shared",
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
    expect(
      s.match(/deviceBridge: scenario\.device_bridge === true \? deviceBridgeRecord\(plan\.mounts, bridgeNote\) : undefined/g),
    ).toHaveLength(2);
    expect(s).toMatch(/deviceBridge: args\.deviceBridge,/);
  });
});

// A recorded device infra error replays with its own source, so replay grades it as the live run did: the
// container's death fails, one failed device_bash exec only warns.
describe("replay keeps the device infra-error sources", () => {
  for (const [source, fails] of [
    ["device-exec", false],
    ["device-container", true],
  ] as const)
    it(`${source} replays as ${source}`, async () => {
      const c = cassetteOf();
      (c as any).events.splice(1, 0, line({ type: "infra_error", ts: "2026-10-11T00:00:00Z", source, message: "x" }));
      const r = await replayCassette(c, []);
      expect(r.infraErrors).toEqual([{ source, message: "x" }]);
      const v = computeVerdict(r, "replay");
      expect(v.signals.some((s) => s.code === "infra_error" && s.severity === "fail")).toBe(fails);
      expect(v.signals.some((s) => s.code === "exec_infra_error")).toBe(!fails);
    });
});

// verify-run, regrade and refs rebuild an assertion context from a kept run dir. A bridge run's folders lived in the
// device container, and its delete evidence came from the device tree before teardown; nothing in the run dir lets
// those be re-checked, so the builder refuses rather than grading device-side assertions over evidence it lacks.
describe("a kept bridge run dir is refused by the run-dir context builder", () => {
  it("refuses a result carrying deviceBridge, saying to re-run or replay", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-verify-")));
    try {
      const scenario = {
        name: "b",
        fidelity: "container",
        lane: "remote",
        device_bridge: true,
        prompt: "hi",
        assert: [{ result: "success" }],
      } as unknown as Scenario;
      const runDir = (record?: unknown) => {
        const d = join(dir, `run-${record ? "bridge" : "plain"}`);
        mkdirSync(join(d, "turns", "1"), { recursive: true });
        writeFileSync(
          join(d, "turns", "1", "result.json"),
          JSON.stringify({ result: "success", command: "run", ...(record ? { deviceBridge: record } : {}) }),
        );
        return d;
      };
      const refused = assertContextFromRunDir(runDir(deviceBridgeRecord(mounts)), scenario);
      expect(refused.ok).toBe(false);
      expect((refused as { message: string }).message).toMatch(/device_bridge[\s\S]*re-run[\s\S]*replay/i);
      expect(assertContextFromRunDir(runDir(), { ...scenario, device_bridge: undefined } as Scenario).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
