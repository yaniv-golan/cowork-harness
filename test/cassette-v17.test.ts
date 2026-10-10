// Cassette v17: a frozen scenario with `device_bridge: true`. A v16 reader rejects the key as unrecognized and
// tells the user to re-record; stamping v17 makes it refuse the cassette as too new instead.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASSETTE_VERSION, cassetteSchemaUrl, requiredVersionFor } from "../src/run/cassette.js";

describe("cassette v17", () => {
  it("this build writes and reads v17, and ships its schema next to v16's", () => {
    expect(CASSETTE_VERSION).toBe(17);
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v17.json"), "utf8"));
    expect(schema.$id).toBe(cassetteSchemaUrl(17));
    expect(schema.title).toBe("cowork-harness cassette v17");
    expect(schema.description).toContain("device_bridge");
    expect(existsSync(join(process.cwd(), "schema", "cassette.v16.json"))).toBe(true);
  });
  it("device_bridge stamps v17; its absence stamps exactly what it did", () => {
    const base = { prompt: "x", fidelity: "container", lane: "remote" };
    expect(requiredVersionFor({ ...base, device_bridge: true })).toBe(17);
    expect(requiredVersionFor(base)).toBe(requiredVersionFor({ ...base, device_bridge: false }));
    expect(requiredVersionFor(base, { hookFailureBlocks: { events: ["PreToolUse"] } })).toBe(16);
  });
});
