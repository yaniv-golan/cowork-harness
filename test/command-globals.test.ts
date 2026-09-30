import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `--dotenv` / `--run-dir` are accepted AFTER the subcommand, by each command's own parser, as well as
// before it. The leading-only pre-dispatch scan is unchanged, so a `--dotenv=…` token that is another flag's
// VALUE is still never taken as the flag. Token-free: nothing here spawns an agent.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const MISSING = "/definitely/not/here/command-globals.env";

function cli(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  // Keep the caller's own knobs out of the child, so each case sees only what it sets.
  for (const k of ["COWORK_HARNESS_FIDELITY", "COWORK_HARNESS_RUNS_DIR", "COWORK_HARNESS_OUTPUT_FORMAT"])
    if (!(k in (opts.env ?? {}))) delete env[k];
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd: opts.cwd, env: env as NodeJS.ProcessEnv });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || "") };
}

// Every command, with the arguments that get its parser to the trailing flag. The per-command matrix: the
// command's own parser must reach the flag and apply it (an absent file is the observable), instead of the
// old "is a GLOBAL flag and must come BEFORE the subcommand" refusal.
const MATRIX: Array<[string, string[]]> = [
  ["skill", ["skill", "./plugin", "hi"]],
  ["run", ["run", "x.yaml"]],
  ["chat", ["chat"]],
  ["record", ["record", "x.yaml"]],
  ["replay", ["replay", "x.cassette.json"]],
  ["verify-cassettes", ["verify-cassettes", "x.cassette.json"]],
  ["verify-run", ["verify-run", "rundir", "x.yaml"]],
  ["regrade", ["regrade", "rundir", "--scenario", "x.yaml"]],
  ["trace", ["trace", "some-run"]],
  ["inspect", ["inspect", "some-run"]],
  ["diff", ["diff", "a", "b"]],
  ["critique", ["critique", "./plugin", "--prompt", "hi"]],
  ["assertions", ["assertions", "--list"]],
  ["scaffold (run-id form)", ["scaffold", "some-run"]],
  ["scaffold (flag-built form)", ["scaffold", "--name", "x", "--prompt", "p"]],
  ["status", ["status", "some-run"]],
  ["stats", ["stats"]],
  ["decide", ["decide", "--question", "q?"]],
  ["gates", ["gates", "some-dir"]],
  ["answer", ["answer", "some-dir", "--choose", "A"]],
  // sync refuses a non-macOS host before it parses anything (an environment error, by design), so off macOS
  // the flag is never reached; the case only runs where sync can.
  ...(process.platform === "darwin" ? ([["sync", ["sync"]]] as Array<[string, string[]]>) : []),
  ["list", ["list"]],
  ["boundary-check", ["boundary-check"]],
  ["vm", ["vm", "status"]],
  ["vm (flag before the vm subcommand)", ["vm"]],
  ["lint", ["lint", "x.yaml"]],
  ["lint-skill", ["lint-skill", "SKILL.md"]],
  ["analyze-skill", ["analyze-skill", "SKILL.md"]],
  ["probe-dispatch", ["probe-dispatch", "./plugin", "hi"]],
  ["doctor", ["doctor"]],
  ["rehash", ["rehash", "x.cassette.json"]],
  ["init-redact", ["init-redact"]],
  ["prune", ["prune"]],
  ["migrate-run-dir", ["migrate-run-dir"]],
];

describe.skipIf(!can)("per-command --dotenv reaches every command's parser", () => {
  for (const [name, argv] of MATRIX) {
    for (const form of [["--dotenv", MISSING], [`--dotenv=${MISSING}`]]) {
      it(`${name} … ${form.join(" ")} → the command applies it (file not found), not a placement error`, () => {
        const d = mkdtempSync(join(tmpdir(), "cmd-globals-"));
        const r = cli([...argv, ...form], { cwd: d });
        expect(r.out).not.toMatch(/GLOBAL flag and must come BEFORE/);
        expect(r.out).not.toMatch(/unknown flag: --dotenv/);
        expect(r.out).toContain("--dotenv file not found");
        expect(r.code).toBe(2);
      });
    }
  }
});

describe.skipIf(!can)("per-command --run-dir", () => {
  it("sets the runs root, both forms (observed through `prune`, which echoes the root it resolved)", () => {
    for (const form of [["--run-dir", "/tmp/cwh-percmd-space-DOESNOTEXIST"], ["--run-dir=/tmp/cwh-percmd-eq-DOESNOTEXIST"]]) {
      const r = cli(["prune", ...form]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(form.join(" ").includes("space") ? "cwh-percmd-space" : "cwh-percmd-eq");
    }
  });

  it("flag > COWORK_HARNESS_RUNS_DIR, same as the leading form", () => {
    const r = cli(["prune", "--run-dir", "/tmp/cwh-percmd-wins-DOESNOTEXIST"], { env: { COWORK_HARNESS_RUNS_DIR: "/tmp/cwh-env-loses" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("cwh-percmd-wins");
    expect(r.out).not.toContain("cwh-env-loses");
  });

  it("given both before and after the subcommand → usage error, never a silent pick", () => {
    const r = cli(["--run-dir", "/tmp/a-DOESNOTEXIST", "prune", "--run-dir", "/tmp/b-DOESNOTEXIST"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--run-dir given both before and after the subcommand/);
  });

  it("given twice after the subcommand → usage error", () => {
    const r = cli(["prune", "--run-dir", "/tmp/a-DOESNOTEXIST", "--run-dir", "/tmp/b-DOESNOTEXIST"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--run-dir given more than once/);
  });
});

describe.skipIf(!can)("per-command --dotenv keeps the documented precedence", () => {
  // COWORK_HARNESS_FIDELITY is visible in `skill --dry-run`'s plan, so it shows which source won.
  function setup() {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-prec-"));
    writeFileSync(join(d, ".env"), "COWORK_HARNESS_FIDELITY=protocol\n");
    writeFileSync(join(d, "explicit.env"), "COWORK_HARNESS_FIDELITY=hostloop\n");
    mkdirSync(join(d, "plugin")); // a dry run refuses a plugin folder that does not exist
    return d;
  }
  const fidelity = (r: { stdout: string }) => JSON.parse(r.stdout).fidelity;

  it("./.env alone applies (the control)", () => {
    const r = cli(["skill", "./plugin", "hi", "--dry-run"], { cwd: setup() });
    expect(r.code, r.out).toBe(0);
    expect(fidelity(r)).toBe("protocol");
  });

  it("--dotenv after the subcommand beats ./.env — exactly like the leading form", () => {
    const d = setup();
    const after = cli(["skill", "./plugin", "hi", "--dry-run", "--dotenv", "explicit.env"], { cwd: d });
    const before = cli(["--dotenv", "explicit.env", "skill", "./plugin", "hi", "--dry-run"], { cwd: d });
    expect(after.code, after.out).toBe(0);
    expect(fidelity(after)).toBe("hostloop");
    expect(fidelity(after)).toBe(fidelity(before));
  });

  it("an exported variable still beats --dotenv after the subcommand", () => {
    const r = cli(["skill", "./plugin", "hi", "--dry-run", "--dotenv", "explicit.env"], {
      cwd: setup(),
      env: { COWORK_HARNESS_FIDELITY: "container" },
    });
    expect(r.code, r.out).toBe(0);
    expect(fidelity(r)).toBe("container");
  });

  it("given both before and after the subcommand → usage error", () => {
    const r = cli(["--dotenv", "explicit.env", "skill", "./plugin", "hi", "--dry-run", "--dotenv", "explicit.env"], { cwd: setup() });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--dotenv given both before and after the subcommand/);
  });

  it("a file that would change COWORK_HARNESS_OUTPUT_FORMAT is refused after the subcommand (too late to apply), accepted before it", () => {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-fmt-"));
    writeFileSync(join(d, "fmt.env"), "COWORK_HARNESS_OUTPUT_FORMAT=json\n");
    const after = cli(["prune", "--dotenv", "fmt.env", "--run-dir", "/tmp/cwh-fmt-DOESNOTEXIST"], { cwd: d });
    expect(after.code).toBe(2);
    expect(after.out).toMatch(/COWORK_HARNESS_OUTPUT_FORMAT/);
    const before = cli(["--dotenv", "fmt.env", "prune", "--run-dir", "/tmp/cwh-fmt-DOESNOTEXIST"], { cwd: d });
    expect(before.code, before.out).toBe(0);
  });

  it("`record <file> --dotenv <path> --dry-run` answers exactly what the leading form answers (it loads)", () => {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-rec-"));
    writeFileSync(
      join(d, "s.yaml"),
      "baseline: latest\nfidelity: container\non_unanswered: fail\nprompt: hello\nassert:\n  - result: success\n",
    );
    writeFileSync(join(d, "e.env"), "SOME_UNRELATED_KEY=1\n");
    const after = cli(["record", "s.yaml", "--dotenv", "e.env", "--dry-run"], { cwd: d });
    const before = cli(["--dotenv", "e.env", "record", "s.yaml", "--dry-run"], { cwd: d });
    expect(after.out).not.toMatch(/GLOBAL flag|unknown flag/);
    expect(after.code).toBe(before.code);
  });
});

describe.skipIf(!can)("a --dotenv-shaped token that is another flag's VALUE is never taken as the flag", () => {
  it("skill --answer=--dotenv=x=foo keeps the literal answer (the equals form is the escape for a dash value)", () => {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-hijack-"));
    mkdirSync(join(d, "plugin"));
    const r = cli(["skill", "./plugin", "hi", "--dry-run", "--answer=--dotenv=x=foo"], { cwd: d });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.stdout).answers).toEqual([{ when_question: "--dotenv", choose: "x=foo" }]);
    expect(r.out).not.toContain("--dotenv file not found");
  });

  it("run --label=--run-dir=x keeps the literal label (a common value flag consumed it first)", () => {
    // The spawn guard stops the run right after it is staged, but status.json is already written, so the
    // label that reached the run is observable, and the runs root it landed in shows --run-dir was not applied
    // from inside the label.
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-hijack-"));
    mkdirSync(join(d, "plugin"));
    writeFileSync(
      join(d, "s.yaml"),
      "baseline: latest\nfidelity: container\non_unanswered: fail\nprompt: hello\nassert:\n  - result: success\n",
    );
    const runs = join(d, "runs");
    const r = cli(["run", "s.yaml", "--label=--run-dir=x", "--run-dir", runs, "--model", "claude-sonnet-5"], {
      cwd: d,
      env: { COWORK_HARNESS_FORBID_SPAWN: "1" },
    });
    expect(r.out).toMatch(/COWORK_HARNESS_FORBID_SPAWN/);
    const statusFiles = readdirSync(join(runs, "s")).map((id) => join(runs, "s", id, "status.json"));
    expect(statusFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(statusFiles[0], "utf8")).runLabel).toBe("--run-dir=x");
    expect(existsSync(join(d, "x"))).toBe(false);
  });
});

describe.skipIf(!can)("the trailing --dotenv reports what it loaded the way the leading form does", () => {
  it("same `[env] loaded` line (keys only — no absolute path) before or after the subcommand", () => {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-log-"));
    writeFileSync(join(d, "e.env"), "CWH_LOG_PROBE_KEY=1\n");
    const line = (out: string) => out.split("\n").find((l) => l.startsWith("[env] loaded"));
    const after = cli(["prune", "--dotenv", "e.env", "--run-dir", "/tmp/cwh-log-DOESNOTEXIST"], { cwd: d });
    const before = cli(["--dotenv", "e.env", "prune", "--run-dir", "/tmp/cwh-log-DOESNOTEXIST"], { cwd: d });
    expect(line(before.out)).toBe("[env] loaded 1 var(s): CWH_LOG_PROBE_KEY");
    expect(line(after.out)).toBe(line(before.out));
    expect(after.out).not.toContain(d);
  });
});

describe.skipIf(!can)("the OUTPUT_FORMAT refusal fires only when the effective format would change", () => {
  it("a file that sets COWORK_HARNESS_OUTPUT_FORMAT=text when nothing was set (text either way) is accepted after the subcommand", () => {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-fmt-"));
    writeFileSync(join(d, "fmt.env"), "COWORK_HARNESS_OUTPUT_FORMAT=text\n");
    const r = cli(["prune", "--dotenv", "fmt.env", "--run-dir", "/tmp/cwh-fmt-text-DOESNOTEXIST"], { cwd: d });
    expect(r.code, r.out).toBe(0);
  });

  it("a file repeating the json already in force is accepted too", () => {
    const d = mkdtempSync(join(tmpdir(), "cmd-globals-fmt-"));
    writeFileSync(join(d, "fmt.env"), "COWORK_HARNESS_OUTPUT_FORMAT=json\n");
    writeFileSync(join(d, ".env"), "COWORK_HARNESS_OUTPUT_FORMAT=json\n");
    const r = cli(["stats", "--dotenv", "fmt.env", "--run-dir", "/tmp/cwh-fmt-json-DOESNOTEXIST"], { cwd: d });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.stdout).command).toBe("stats");
  });
});
