import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Scenario, PlatformBaseline } from "../src/types.js";
import { SessionConfig } from "../src/session.js";

// Guards against schema drift: every shipped example/self-test must validate.
const YAML = (f: string) => f.endsWith(".yaml") || f.endsWith(".yml");
// Sessions + scenarios live under both examples/ (user-facing) and e2e/ (harness self-tests).
const SESSION_DIRS = ["examples/sessions", "e2e/sessions"];
const SCENARIO_DIRS = ["examples/scenarios", "examples/scenarios/trigger-accuracy-sweep", "e2e/scenarios"];

describe("shipped baselines validate", () => {
  for (const f of readdirSync("baselines").filter((f) => f.endsWith(".json"))) {
    it(`baselines/${f}`, () => {
      expect(() => PlatformBaseline.parse(JSON.parse(readFileSync(join("baselines", f), "utf8")))).not.toThrow();
    });
  }
});

describe("shipped sessions validate", () => {
  for (const dir of SESSION_DIRS)
    for (const f of readdirSync(dir).filter(YAML)) {
      it(`${dir}/${f}`, () => {
        expect(() => SessionConfig.parse(parseYaml(readFileSync(join(dir, f), "utf8")))).not.toThrow();
      });
    }
});

describe("shipped scenarios validate", () => {
  for (const dir of SCENARIO_DIRS)
    for (const f of readdirSync(dir).filter(YAML)) {
      it(`${dir}/${f}`, () => {
        expect(() => Scenario.parse(parseYaml(readFileSync(join(dir, f), "utf8")))).not.toThrow();
      });
    }
});
