import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveScenarioScript } from "../src/run/scenario-tool.js";

describe("scenario-tool — locates the bundled scenario.py", () => {
  it("returns an existing absolute path to scenario.py", () => {
    const p = resolveScenarioScript();
    expect(p.endsWith("scenario.py")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});
