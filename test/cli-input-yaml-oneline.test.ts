// Input files named on the command line: a YAML syntax error reads as ONE line (the parser's first line,
// which names the problem and position), and a `~/…` `--session` path expands to the home directory.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const GOOD = "name: a\nprompt: hi\nfidelity: protocol\nassert:\n  - result: success\n";

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-cli-yaml-"));
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "1", COWORK_HARNESS_RUNS_DIR: join(cwd, ".runs"), ...env },
  });
  return { code: r.status, stdout: r.stdout || "", all: (r.stdout || "") + (r.stderr || "") };
}

const errMsg = (stdout: string) => (JSON.parse(stdout) as { error?: { message?: string } }).error?.message ?? "";

describe.skipIf(!existsSync(CLI))("a YAML syntax error in a CLI input file is one line", () => {
  it("--matrix", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), GOOD);
    writeFileSync(join(d, "m.yaml"), "models: [\n");
    const r = cli(["run", "s.yaml", "--matrix", "m.yaml", "--output-format", "json"], d, { COWORK_HARNESS_MODEL: "claude-sonnet-5" });
    expect(r.code, r.all).toBe(2);
    expect(errMsg(r.stdout)).toMatch(/^invalid matrix file: \S/);
    expect(errMsg(r.stdout)).not.toMatch(/\n/);
  });

  it("--answer-policy", () => {
    const d = work();
    mkdirSync(join(d, "skill"));
    writeFileSync(join(d, "p.yaml"), "- match: [\n");
    const r = cli(["skill", "./skill", "--answer-policy", "p.yaml", "--dry-run", "--output-format", "json"], d, {
      COWORK_HARNESS_MODEL: "claude-sonnet-5",
    });
    expect(r.code, r.all).toBe(2);
    expect(errMsg(r.stdout)).toMatch(/^cannot parse --answer-policy p\.yaml: \S/);
    expect(errMsg(r.stdout)).not.toMatch(/\n/);
  });
});

describe.skipIf(!existsSync(CLI))("`--session=~/…` expands to the home directory", () => {
  // The session file does not parse, so the command stops at the parse, naming the path it expanded, before it stands
  // up the Docker boundary (a sidecar and a run per check). Running that boundary only to read this path made the test
  // time out under Docker contention in a full suite; the boundary itself is covered by the boundary CI job.
  it("boundary-check", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), "egress: [\n");
    // Run from another directory, so a `~/` that resolved against the cwd instead of HOME cannot find the file.
    const r = cli(["boundary-check", "--session=~/s.yaml", "--output-format", "json"], work(), { HOME: d });
    expect(r.code, r.all).toBe(2);
    expect(errMsg(r.stdout)).toContain(`cannot parse --session ${join(d, "s.yaml")}:`);
  });

  it("verify-cassettes", () => {
    const d = work();
    mkdirSync(join(d, "c"));
    const c = JSON.parse(readFileSync("examples/replays/example-pdf-skill.cassette.json", "utf8"));
    writeFileSync(join(d, "c", "x.cassette.json"), JSON.stringify(c));
    copyFileSync("examples/sessions/default.yaml", join(d, "s.yaml"));
    const r = cli(["verify-cassettes", join(d, "c", "x.cassette.json"), "--session=~/s.yaml", "--output-format", "json"], d, { HOME: d });
    expect(r.all).not.toMatch(/not a session file|no session file at/);
  });
});
