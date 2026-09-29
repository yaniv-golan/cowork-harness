import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  CASSETTE_VERSION,
  MANIFEST_KEYS,
  MIN_SUPPORTED_CASSETTE_VERSION,
  QUESTION_GATE_KEYS,
  classifyUncheckableOnDiskKeys,
  type Cassette,
} from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

// Python owns the offline linter and TypeScript owns replay. Keep the evidence boundary conservative:
// if replay skips a key for a cassette shape, lint must never suppress that key's INFO advisory.
const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

function pythonJson(raw: unknown, expression: string): Record<string, unknown> {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("scenario_lint_sync", ${JSON.stringify(SCRIPT)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value = ${expression}
print(json.dumps(value, sort_keys=True))
`;
  const result = spawnSync(py, ["-c", code], { input: JSON.stringify(raw), encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const allKeys = [...new Set([...MANIFEST_KEYS, ...QUESTION_GATE_KEYS])] as string[];
const scenarioWith = (assert: unknown[]): Scenario => ({ name: "t", prompt: "hi", assert }) as unknown as Scenario;

function tsSkipped(cassette: Record<string, unknown>): Set<string> {
  const frozen = scenarioWith([]);
  const onDisk = scenarioWith(allKeys.map((key) => ({ [key]: true })));
  const result = classifyUncheckableOnDiskKeys(cassette as unknown as Cassette, frozen, onDisk);
  return new Set([...result.keys.keys()].map(String));
}

describe.skipIf(!havePython)("cassette evidence checkability: Python lint ↔ TypeScript replay", () => {
  it("keeps the cassette format range in sync", () => {
    const versions = pythonJson({}, '{"max": module.CASSETTE_VERSION, "min": module.MIN_SUPPORTED_CASSETTE_VERSION}');
    expect(versions).toEqual({ max: CASSETTE_VERSION, min: MIN_SUPPORTED_CASSETTE_VERSION });
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing evidence", {}],
    ["empty evidence", { artifacts: [], controlOut: [], preRunPaths: [], preRunHashes: {} }],
    ["malformed evidence", { artifacts: {}, controlOut: "not-an-array", preRunPaths: {}, preRunHashes: [] }],
    [
      "complete evidence",
      {
        artifacts: [{ path: "outputs/result.json", bytes: 2, sha256: "a".repeat(64) }],
        controlOut: ["{}"],
        preRunPaths: [],
        preRunHashes: {},
      },
    ],
  ];

  it.each(cases)("never proves a key replay skips (%s)", (name, cassette) => {
    const python = pythonJson(cassette, "module._cassette_checkability(json.load(sys.stdin))");
    const skipped = tsSkipped(cassette);
    for (const key of skipped) expect(python[key], `${name}: Python proved ${key} but replay skips it`).toBe(false);
  });
});
