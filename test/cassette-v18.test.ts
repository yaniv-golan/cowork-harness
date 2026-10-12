// Cassette v18, one bump shared by two 4.9.0 shapes, each stamped only when used:
// - a device_bridge recording's frozen record carries the delete card's fields (`deleteRefusal`, `grants`) and lists
//   the card among the served tools. A v17 reader's strict record shape would reject them as unrecognized, so a
//   bridge recording stamps v18 and an older reader refuses it as too new. A v17 bridge recording, which lacks them,
//   still reads and replays as recorded.
// - the multi-leg form. An older reader must refuse it (never grade its first leg as the whole run), and this build
//   says "too new" rather than "invalid" for a shape it cannot know.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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

/** A FROZEN LITERAL copy of the v17 CassetteShape's required core (src/run/cassette.ts as of v17): what a v17 reader
 *  checks before anything else. Kept literal on purpose — the live shape is what v18 changes. */
const V17_SHAPE = z.looseObject({
  events: z.array(z.string()),
  scenario: z.looseObject({ prompt: z.string(), session: z.string(), assert: z.array(z.unknown()).optional() }),
});

const multiLeg = {
  cassetteVersion: 18,
  scenario: {
    name: "ml",
    session: "(inline)",
    fidelity: "protocol",
    legs: [
      { id: "a", prompt: "x" },
      { id: "b", prompt: "y" },
    ],
  },
  legs: [
    {
      id: "a",
      kind: "prompt",
      status: "passed",
      cassette: { cassetteVersion: 15, scenario: { prompt: "x", session: "(inline)", assert: [] }, events: [] },
    },
    {
      id: "b",
      kind: "prompt",
      status: "passed",
      cassette: { cassetteVersion: 15, scenario: { prompt: "y", session: "(inline)", assert: [] }, events: [] },
    },
  ],
  verdict: { pass: true },
};

describe("cassette v18: the multi-leg form", () => {
  it("this build writes and reads v18, and ships its schema next to v17's", () => {
    expect(CASSETTE_VERSION).toBe(18);
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v18.json"), "utf8"));
    expect(schema.$id).toBe(cassetteSchemaUrl(18));
    expect(schema.title).toBe("cowork-harness cassette v18");
    expect(schema.description).toContain("multi-leg");
    expect(existsSync(join(process.cwd(), "schema", "cassette.v17.json"))).toBe(true);
  });
  it("a multi-leg scenario stamps v18; a single-prompt one stamps exactly what it did", () => {
    expect(requiredVersionFor({ fidelity: "protocol", legs: [] })).toBe(18);
    expect(requiredVersionFor({ prompt: "x", fidelity: "container" })).toBeLessThan(18);
  });
  it("a v17 reader's shape check refuses a multi-leg cassette: no top-level prompt, no events", () => {
    const r = V17_SHAPE.safeParse(multiLeg);
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["events", "scenario.prompt"]));
  });
  it("this build's single-cassette reader refuses it by name; a newer shape it cannot parse reads as too new", () => {
    const dir = mkdtempSync(join(tmpdir(), "v18-"));
    try {
      const p = join(dir, "ml.cassette.json");
      writeFileSync(p, JSON.stringify(multiLeg));
      expect(readCassette(p)).toEqual({ error: expect.stringMatching(/is a multi-leg cassette.*`replay`.*`verify-cassettes`/) });
      const future = join(dir, "future.cassette.json");
      writeFileSync(future, JSON.stringify({ cassetteVersion: 99, something: "new" }));
      expect(readCassette(future)).toEqual({ error: expect.stringMatching(/cassette format too new: v99 > this harness's v18/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
