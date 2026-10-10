// Cassette v16: a frozen, non-empty `hookFailureBlocks` (the onFailure: "block" inventory). A v15 reader ignores the
// field and would read a failed hook frame as "no decision", so such a cassette must be too new for it.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASSETTE_VERSION, cassetteSchemaUrl, requiredVersionFor } from "../src/run/cassette.js";

describe("cassette v16", () => {
  it("this build writes and reads v16, and ships its schema next to v15's", () => {
    expect(CASSETTE_VERSION).toBe(16);
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v16.json"), "utf8"));
    expect(schema.$id).toBe(cassetteSchemaUrl(16));
    expect(schema.title).toBe("cowork-harness cassette v16");
    expect(schema.properties.hookFailureBlocks).toBeDefined();
    expect(existsSync(join(process.cwd(), "schema", "cassette.v15.json"))).toBe(true);
  });
  it("a non-empty inventory stamps v16", () => {
    expect(requiredVersionFor({ prompt: "x" }, { hookFailureBlocks: { events: ["PreToolUse"] } })).toBe(16);
    expect(requiredVersionFor({ prompt: "x" }, { hookFailureBlocks: { unknown: true, why: "x" } })).toBe(16);
  });
  it("an empty or absent inventory stamps exactly what it did", () => {
    for (const scenario of [{ prompt: "x" }, { prompt: "x", lane: "remote" }, { prompt: "x", workspace_fixture: "f" }]) {
      const before = requiredVersionFor(scenario);
      expect(requiredVersionFor(scenario, { hookFailureBlocks: { events: [] } })).toBe(before);
      expect(requiredVersionFor(scenario, {})).toBe(before);
    }
    expect(requiredVersionFor({ prompt: "x" }, { answerChannel: "none", hookFailureBlocks: { events: [] } })).toBe(15);
  });
});
