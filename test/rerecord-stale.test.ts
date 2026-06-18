import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { selectStaleCassettes, _findScenarioOnDisk } from "../src/run/cassette.js";

const cassette = (fingerprint?: unknown, name = "c") => ({
  scenario: {
    name,
    baseline: "latest",
    session: "(inline)",
    fidelity: "container",
    prompt: "hi",
    answers: [],
    expect_denied: [],
    assert: [],
  },
  events: [],
  ...(fingerprint ? { fingerprint } : {}),
});

describe("selectStaleCassettes — B2 selection", () => {
  it("returns only cassettes whose fingerprint drifted", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rrs-"));
    writeFileSync(join(d, "stale.cassette.json"), JSON.stringify(cassette({ baseline: "0.0.0-ancient" })));
    writeFileSync(join(d, "fresh.cassette.json"), JSON.stringify(cassette())); // no fingerprint → not stale
    const stale = selectStaleCassettes(d);
    expect(stale.map((s) => basename(s.path))).toEqual(["stale.cassette.json"]);
    expect(stale[0].staleness.length).toBeGreaterThan(0);
  });
});

describe("_findScenarioOnDisk — on-disk scenario probe", () => {
  it("returns null when neither layout has the scenario file", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-find-"));
    const cassettePath = join(d, "cassettes", "my-scenario.cassette.json");
    mkdirSync(join(d, "cassettes"), { recursive: true });
    writeFileSync(cassettePath, "{}");
    expect(_findScenarioOnDisk(cassettePath, "my-scenario")).toBeNull();
  });

  it("returns the sibling-layout path when ../scenarios/<name>.yaml exists", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-find2-"));
    mkdirSync(join(d, "cassettes"), { recursive: true });
    mkdirSync(join(d, "scenarios"), { recursive: true });
    const cassettePath = join(d, "cassettes", "my-scenario.cassette.json");
    const scenarioPath = join(d, "scenarios", "my-scenario.yaml");
    writeFileSync(cassettePath, "{}");
    writeFileSync(scenarioPath, "prompt: hi\n");
    expect(_findScenarioOnDisk(cassettePath, "my-scenario")).toBe(scenarioPath);
  });

  it("returns the flat-layout path when <cassetteDir>/<name>.yaml exists", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-find3-"));
    const cassettePath = join(d, "my-scenario.cassette.json");
    const scenarioPath = join(d, "my-scenario.yaml");
    writeFileSync(cassettePath, "{}");
    writeFileSync(scenarioPath, "prompt: hi\n");
    expect(_findScenarioOnDisk(cassettePath, "my-scenario")).toBe(scenarioPath);
  });
});
