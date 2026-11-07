// A pinned `plugins.config_dir` belongs to the one run that creates it. A command that runs the scenario more than
// once refuses it before the first run, instead of spending run 1 and having the marker refuse run 2. `eval` and
// `hillclimb` are covered in their own command tests; this file covers `run --repeat` and `run --matrix` through
// the built CLI, and a batch (`run <dir/>`, `record <dir/>`) in which two scenarios pin the same dir. Token-free: a stand-in credential (never sent) and COWORK_HARNESS_FORBID_SPAWN.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configDirSingleRunRefusal } from "../src/session.js";
import { sharedConfigDirPreflight } from "../src/run/execute.js";

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

/** A directory batch: scenarios `a` and `b` (each with its own session), `b` pinning `./pinned` and `a` pinning
 *  `aDir` when given. */
function batch(aDir: string | undefined): string {
  const d = mkdtempSync(join(tmpdir(), "cfg-shared-"));
  mkdirSync(join(d, "sc"));
  const pin = (dir: string | undefined) => `model: claude-sonnet-5\n${dir ? `plugins:\n  config_dir: ${dir}\n` : ""}`;
  writeFileSync(join(d, "a-session.yaml"), pin(aDir));
  writeFileSync(join(d, "b-session.yaml"), pin("./pinned"));
  for (const n of ["a", "b"])
    writeFileSync(
      join(d, "sc", `${n}.yaml`),
      `name: ${n}\nfidelity: protocol\nsession: ../${n}-session.yaml\nprompt: hi\nassert:\n  - result: success\n`,
    );
  return d;
}
const SHARED = /scenarios a, b: plugins\.config_dir is single-run; this command runs 2 scenarios that pin /;

describe("sharedConfigDirPreflight", () => {
  it("refuses two scenarios whose sessions resolve to one dir, by any spelling; one, or two different dirs, pass", () => {
    const d = batch("./sub/../pinned");
    const sc = (n: string) => ({ name: n, session: join(d, `${n}-session.yaml`) });
    expect(sharedConfigDirPreflight([sc("a"), sc("b")])).toMatch(SHARED);
    expect(sharedConfigDirPreflight([sc("b")])).toBeUndefined();
    expect(sharedConfigDirPreflight([sc("a"), sc("b"), { name: "c", session: join(d, "missing.yaml") }])).toMatch(SHARED);
    const e = batch("./other");
    expect(
      sharedConfigDirPreflight([
        { name: "a", session: join(e, "a-session.yaml") },
        { name: "b", session: join(e, "b-session.yaml") },
      ]),
    ).toBeUndefined();
  });
});

describe.skipIf(!existsSync(CLI))("a batch in which two scenarios pin one config_dir", () => {
  for (const cmd of ["run", "record"])
    it(`${cmd} <dir/>: refused (exit 2) before any run, and the pinned dir is not created`, () => {
      const d = batch("./pinned");
      const r = cli([cmd, "sc/"], d);
      expect(r.code, r.all).toBe(2);
      expect(r.all).toMatch(SHARED);
      expect(r.all).not.toMatch(/COWORK_HARNESS_FORBID_SPAWN is set/);
      expect(existsSync(join(d, ".runs"))).toBe(false);
      expect(existsSync(join(d, "pinned"))).toBe(false);
    });

  it("exactly one scenario pinning the dir is not refused", () => {
    expect(cli(["run", "sc/"], batch(undefined)).all).not.toMatch(/single-run/);
  });
});
