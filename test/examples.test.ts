import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { Scenario, PlatformBaseline } from "../src/types.js";
import { SessionConfig } from "../src/session.js";

// Guards against schema drift: every shipped example/self-test must validate.
const YAML = (f: string) => f.endsWith(".yaml") || f.endsWith(".yml");
// Sessions + scenarios live under both examples/ (user-facing) and e2e/ (harness self-tests).
const SESSION_DIRS = ["examples/sessions", "examples/hillclimb/sessions", "e2e/sessions"];
const SCENARIO_DIRS = [
  "examples/scenarios",
  "examples/scenarios/trigger-accuracy-sweep",
  "examples/hillclimb/scenarios",
  "examples/probes",
  "e2e/scenarios",
];

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

describe("examples/README.md's scenario catalogue ↔ examples/scenarios/", () => {
  // Both directions: a scenario added without a row is invisible to a reader copying from the table, and a
  // row for a removed scenario sends them to a file that does not exist.
  const readme = readFileSync("examples/README.md", "utf8");
  const start = readme.indexOf("## The scenarios");
  const table = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const rows = [...table.matchAll(/^\| `scenarios\/([^`]+)` \|/gm)].map((m) => m[1]);
  // Tracked files only, as check:versions' shippedDocs() does: an untracked scratch scenario is not part of
  // the catalogue and must not red a local run.
  const onDisk = [
    ...new Set(
      execFileSync("git", ["ls-files", "-z", "examples/scenarios"], { encoding: "utf8" })
        .split("\0")
        .filter(Boolean)
        .map((p) => p.slice("examples/scenarios/".length))
        .map((rel) => (rel.includes("/") ? `${rel.split("/")[0]}/` : rel))
        .filter((rel) => rel.endsWith("/") || YAML(rel)),
    ),
  ];

  it("found the table and the directory (an empty side would pass vacuously)", () => {
    expect(start, 'examples/README.md has no "## The scenarios" section').toBeGreaterThanOrEqual(0);
    expect(rows.length).toBeGreaterThan(3);
    expect(onDisk.length).toBeGreaterThan(3);
  });

  it("every top-level scenario file and subdirectory has a row", () => {
    expect(onDisk.filter((f) => !rows.includes(f)).sort()).toEqual([]);
  });

  it("every row names a scenario that exists", () => {
    expect(rows.filter((f) => !onDisk.includes(f)).sort()).toEqual([]);
  });
});
