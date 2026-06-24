import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// The `--run-dir` global flag is a thin shim over COWORK_HARNESS_RUNS_DIR, parsed/stripped before
// dispatch like --dotenv. We observe the resolved root via `prune` on a non-existent dir, which echoes
// the resolved path in its "does not exist — nothing to prune" line (exit 0, token-free, no Docker).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe.skipIf(!can)("--run-dir global flag", () => {
  it("space form sets the runs root", () => {
    const dir = "/tmp/cwh-rundir-space-DOESNOTEXIST";
    const r = spawnSync("node", [CLI, "--run-dir", dir, "prune"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(out(r)).toContain(dir);
  });

  it("equals form sets the runs root", () => {
    const dir = "/tmp/cwh-rundir-eq-DOESNOTEXIST";
    const r = spawnSync("node", [CLI, `--run-dir=${dir}`, "prune"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(out(r)).toContain(dir);
  });

  it("flag overrides COWORK_HARNESS_RUNS_DIR (precedence: flag > env)", () => {
    const dir = "/tmp/cwh-rundir-wins-DOESNOTEXIST";
    const r = spawnSync("node", [CLI, "--run-dir", dir, "prune"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: "/tmp/cwh-env-loses" },
    });
    expect(r.status).toBe(0);
    expect(out(r)).toContain(dir);
    expect(out(r)).not.toContain("cwh-env-loses");
  });

  it("relative value resolves against cwd to an absolute path", () => {
    const r = spawnSync("node", [CLI, "--run-dir", "rel-DOESNOTEXIST", "prune"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(out(r)).toContain(join(process.cwd(), "rel-DOESNOTEXIST"));
  });

  it("missing value exits 2", () => {
    const r = spawnSync("node", [CLI, "--run-dir"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--run-dir requires a path/);
  });

  it("rejects a command name as the value (space form)", () => {
    const r = spawnSync("node", [CLI, "--run-dir", "run", "x.yaml"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--run-dir requires a path but got the command "run"/);
  });

  it("equals form accepts a literal value that looks like a command (asymmetry pin)", () => {
    // `--run-dir=run` is one token → the dir "run", NOT the command-name guard (which is space-form only).
    const r = spawnSync("node", [CLI, "--run-dir=run", "prune"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(out(r)).toContain(join(process.cwd(), "run"));
  });

  it("strips the flag so the subcommand still dispatches (no 'unknown command')", () => {
    const r = spawnSync("node", [CLI, "--run-dir", "/tmp/cwh-x-DOESNOTEXIST", "prune"], { encoding: "utf8" });
    expect(out(r)).not.toMatch(/unknown command/);
  });
});
