// The keys the runtime refuses at load on `lane: remote` (src/run/lane-notice.ts) and the keys the companion
// skill's linter flags as `lane-remote-incompatible-key` (scenario.py) are one list in two languages. A key added
// to one alone would let lint call a scenario clean that the runtime then refuses, or the reverse.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { LANE_REMOTE_INCOMPATIBLE } from "../src/run/lane-notice.js";

const SCRIPTS = resolve(".claude/skills/cowork-harness/scripts");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

describe.runIf(havePython)("lane: remote refusals — runtime and linter agree", () => {
  it("the same keys, and the same by-value semantic keys", () => {
    const r = spawnSync(
      py,
      [
        "-c",
        "import json,sys; sys.path.insert(0, sys.argv[1]); import scenario as s; print(json.dumps([sorted(s.LANE_REMOTE_INCOMPATIBLE_KEYS), list(s.LANE_REMOTE_EVIDENCE_FILES_KEYS), list(s.LANE_REMOTE_AUTHORED_KEYS)]))",
        SCRIPTS,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const [keys, byValue, authored] = JSON.parse(r.stdout) as [string[], string[], string[]];
    expect(keys).toEqual(Object.keys(LANE_REMOTE_INCOMPATIBLE).sort());
    // by value, in laneRemoteLoadRefusal: semantic_* with evidence_files, file_exists with authored: true
    expect(byValue).toEqual(["semantic_matches", "semantic_pairwise"]);
    expect(authored).toEqual(["file_exists"]);
  });
});

describe("the device_bridge hint is one text in two languages", () => {
  it("lane-notice.ts DEVICE_BRIDGE_HINT equals scenario.py _DEVICE_BRIDGE_HINT", async () => {
    const { readFileSync } = await import("node:fs");
    const { DEVICE_BRIDGE_HINT } = await import("../src/run/lane-notice.js");
    const py = readFileSync(".claude/skills/cowork-harness/scripts/scenario.py", "utf8");
    const block = py.slice(py.indexOf("_DEVICE_BRIDGE_HINT = ("), py.indexOf("\n)\n", py.indexOf("_DEVICE_BRIDGE_HINT = (")));
    const joined = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
    expect(joined).toBe(DEVICE_BRIDGE_HINT);
  });
});
