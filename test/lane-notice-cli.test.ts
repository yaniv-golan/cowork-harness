// The lane notice through its REAL call sites: the `run` and `chat` commands of the built CLI. Each run is
// refused by COWORK_HARNESS_FORBID_SPAWN right after the notice would print, so no agent ever starts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const NOTICE = "[lane] this run models Cowork's local lane";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-notice-cli-"));
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", "s.yaml"), "model: claude-sonnet-5\n");
  const scenario = (name: string, assert: string) =>
    writeFileSync(join(dir, `${name}.yaml`), `name: ${name}\nfidelity: protocol\nsession: sessions/s.yaml\nprompt: hi\nassert:\n${assert}`);
  scenario("env", "  - file_exists: outputs/a.md\n");
  scenario("behaviour", "  - transcript_contains: hi\n");
  mkdirSync(join(dir, "sk"));
  writeFileSync(join(dir, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], extraEnv: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "1", COWORK_HARNESS_GITSET: "0" };
  delete env.CI; // a CI runner sets it, and CI silences the notice
  delete env.COWORK_HARNESS_NO_LANE_NOTICE;
  Object.assign(env, { COWORK_HARNESS_RUNS_DIR: join(dir, "runs"), COWORK_HARNESS_MODEL: "claude-sonnet-5", ...extraEnv });
  const r = spawnSync("node", [CLI, ...args], { cwd: dir, env, encoding: "utf8", input: "" });
  return (r.stderr ?? "") + (r.stdout ?? "");
}
const count = (out: string) => out.split(NOTICE).length - 1;

describe.runIf(existsSync(CLI))("the [lane] notice from the built CLI", () => {
  it("a default run of an environment-shaped scenario prints it once", () => {
    expect(count(cli(["run", "env.yaml"]))).toBe(1);
  });
  it("a run with only behaviour-shaped asserts does not", () => {
    expect(count(cli(["run", "behaviour.yaml"]))).toBe(0);
  });
  it("--compact, CI=1 and COWORK_HARNESS_NO_LANE_NOTICE=1 each silence it", () => {
    expect(count(cli(["run", "env.yaml", "--compact"]))).toBe(0);
    expect(count(cli(["run", "env.yaml"], { CI: "1" }))).toBe(0);
    expect(count(cli(["run", "env.yaml"], { COWORK_HARNESS_NO_LANE_NOTICE: "1" }))).toBe(0);
  });
  it("chat prints it once at session start, and CI silences it there too", () => {
    expect(count(cli(["chat", "sk", "--fidelity", "protocol"]))).toBe(1);
    expect(count(cli(["chat", "sk", "--fidelity", "protocol"], { CI: "1" }))).toBe(0);
  });
});
