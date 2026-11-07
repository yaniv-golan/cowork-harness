// A pinned `plugins.config_dir` belongs to the one run that creates it. A command that runs the scenario more than
// once refuses it before the first run, instead of spending run 1 and having the marker refuse run 2. `eval` and
// `hillclimb` are covered in their own command tests; this file covers `run --repeat` and `run --matrix` through
// the built CLI. Token-free: a stand-in credential (never sent) and COWORK_HARNESS_FORBID_SPAWN.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configDirSingleRunRefusal } from "../src/session.js";

const CLI = resolve("dist/cli.js");
const REFUSAL = /scenario "s": plugins\.config_dir is single-run; this command runs (\d+) times/;

function cli(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: cwd,
      COWORK_HARNESS_FORBID_SPAWN: "1",
      COWORK_HARNESS_RUNS_DIR: join(cwd, ".runs"),
      COWORK_HARNESS_MODEL: "",
      CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token",
    },
  });
  return { code: r.status, all: (r.stdout || "") + (r.stderr || "") };
}

function work(pinned: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "cfg-single-run-"));
  writeFileSync(join(d, "session.yaml"), `model: claude-sonnet-5\n${pinned ? "plugins:\n  config_dir: ./pinned\n" : ""}`);
  writeFileSync(join(d, "s.yaml"), "name: s\nfidelity: protocol\nsession: session.yaml\nprompt: hi\nassert:\n  - result: success\n");
  writeFileSync(join(d, "m.yaml"), "models: [claude-sonnet-5, claude-opus-4-8]\n");
  return d;
}

describe("configDirSingleRunRefusal", () => {
  it("refuses only a pinned dir with more than one run", () => {
    expect(configDirSingleRunRefusal("x", null, 5)).toBeUndefined();
    expect(configDirSingleRunRefusal("x", "/p", 1)).toBeUndefined();
    expect(configDirSingleRunRefusal("x", "/p", 2)).toMatch(/^x: plugins\.config_dir is single-run; this command runs 2 times\./);
    expect(configDirSingleRunRefusal("x", "/p", "it every round")).toContain("this command runs it every round.");
  });
});

describe.skipIf(!existsSync(CLI))("run with a pinned config_dir", () => {
  it("--repeat 2: refused (exit 2) before any run dir, and the pinned dir is not created", () => {
    const d = work(true);
    const r = cli(["run", "s.yaml", "--repeat", "2"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toMatch(REFUSAL);
    expect(r.all.match(REFUSAL)![1]).toBe("2");
    expect(existsSync(join(d, ".runs"))).toBe(false);
    expect(existsSync(join(d, "pinned"))).toBe(false);
  });

  it("--matrix: refused before the first cell, counting every cell", () => {
    const d = work(true);
    const r = cli(["run", "s.yaml", "--matrix", "m.yaml"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all.match(REFUSAL)?.[1]).toBe("2");
    expect(existsSync(join(d, "pinned"))).toBe(false);
  });

  it("a single run is not refused (it reaches the spawn guard), and neither is --repeat without a pin", () => {
    expect(cli(["run", "s.yaml"], work(true)).all).not.toMatch(REFUSAL);
    expect(cli(["run", "s.yaml", "--repeat", "2"], work(false)).all).not.toMatch(REFUSAL);
  });
});
