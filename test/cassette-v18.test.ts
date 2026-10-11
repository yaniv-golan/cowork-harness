// Cassette v18: a device_bridge recording's frozen record carries the delete card's fields (`deleteRefusal`, `grants`)
// and lists the card among the served tools. A v17 reader's strict record shape would reject them as unrecognized, so
// a bridge recording stamps v18 and an older reader refuses it as too new. A v17 bridge recording, which lacks them,
// still reads and replays as recorded.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { CASSETTE_VERSION, cassetteSchemaUrl, readCassette, requiredVersionFor, type Cassette } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

describe("cassette v18", () => {
  it("this build writes and reads v18, and ships its schema next to v17's", () => {
    expect(CASSETTE_VERSION).toBe(18);
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v18.json"), "utf8"));
    expect(schema.$id).toBe(cassetteSchemaUrl(18));
    expect(schema.title).toBe("cowork-harness cassette v18");
    expect(schema.description).toContain("delete");
    expect(schema.properties.deviceBridge.properties.deleteRefusal.enum).toEqual(["reported", "enforced"]);
    expect(schema.properties.deviceBridge.properties.grants).toBeDefined();
    expect(existsSync(join(process.cwd(), "schema", "cassette.v17.json"))).toBe(true);
  });
  it("device_bridge stamps v18; its absence stamps exactly what it did", () => {
    const base = { prompt: "x", fidelity: "container", lane: "remote" };
    expect(requiredVersionFor({ ...base, device_bridge: true })).toBe(18);
    expect(requiredVersionFor(base)).toBe(requiredVersionFor({ ...base, device_bridge: false }));
  });
  it("a v17 bridge recording, with no delete-card fields, still reads", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "v17-bridge-")));
    try {
      const f = join(dir, "old.cassette.json");
      const c = {
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
        events: [JSON.stringify({ type: "result", subtype: "success", is_error: false })],
        controlOut: [],
        cassetteVersion: 17,
        userVisibleRoots: ["outputs"],
        fingerprint: { baseline: loadBaseline("latest").appVersion, hashFormat: "jcs1" },
        deviceBridge: {
          served: ["device_bash", "get_device_info"],
          alwaysLoad: ["device_bash"],
          measuredOn: "2.31226.1",
          promptNoteBasis: "model-report",
          promptNote: "included",
          permissionMode: "acceptEdits",
          permissionModeSource: "bridge-default",
          egress: "allowlist",
          folders: [],
          divergences: ["delete-not-refused"],
        },
      } as unknown as Cassette;
      writeFileSync(f, JSON.stringify(c));
      const read = readCassette(f);
      expect("error" in read ? read.error : "ok").toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
