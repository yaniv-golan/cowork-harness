import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCassette, CASSETTE_VERSION } from "../src/run/cassette.js";

function writeCassette(dir: string, body: object): string {
  const path = join(dir, "s.cassette.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe("cassette version floor (v9 minimum, pre-1.0 — no legacy-format compatibility below it)", () => {
  // Matches CassetteShape (src/run/cassette.ts): top-level `events: string[]`, `scenario.prompt`/
  // `scenario.session` as strings, `scenario.assert` an array.
  const minimalScenario = { prompt: "test prompt", session: "session.yaml", assert: [] };

  it("rejects a cassette recorded below the v9 floor with a clear re-record error", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-floor-"));
    const path = writeCassette(dir, { cassetteVersion: 8, events: [], scenario: minimalScenario });
    const result = readCassette(path);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/minimum supported/i);
      expect(result.error).toMatch(/v9/);
    }
  });

  it("rejects a cassette with no cassetteVersion field at all (reads as 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-floor-"));
    const path = writeCassette(dir, { events: [], scenario: minimalScenario });
    const result = readCassette(path);
    expect("error" in result).toBe(true);
  });

  it("accepts a cassette at exactly the v9 floor", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-floor-"));
    const path = writeCassette(dir, { cassetteVersion: 9, events: [], scenario: minimalScenario });
    const result = readCassette(path);
    expect("error" in result).toBe(false);
  });

  it("accepts the current cassette version", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-floor-"));
    const path = writeCassette(dir, { cassetteVersion: CASSETTE_VERSION, events: [], scenario: minimalScenario });
    const result = readCassette(path);
    expect("error" in result).toBe(false);
  });
});
