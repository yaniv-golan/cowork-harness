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
        "import json,sys; sys.path.insert(0, sys.argv[1]); import scenario as s; print(json.dumps([sorted(s.LANE_REMOTE_INCOMPATIBLE_KEYS), list(s.LANE_REMOTE_EVIDENCE_FILES_KEYS)]))",
        SCRIPTS,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const [keys, byValue] = JSON.parse(r.stdout) as [string[], string[]];
    expect(keys).toEqual(Object.keys(LANE_REMOTE_INCOMPATIBLE).sort());
    expect(byValue).toEqual(["semantic_matches", "semantic_pairwise"]);
  });
});
