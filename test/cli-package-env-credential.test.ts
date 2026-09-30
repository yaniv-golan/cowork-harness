import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticPackageRoot } from "./helpers/hermetic-cli.js";

// The CLI loads `./.env` and then the install's own `.env` silently. A credential that comes from the INSTALL's
// file while the CLI runs from another directory is the one exception: one stderr line names the file and the
// variables, never the values. Token-free: the values below are dummies and nothing here reaches a model.
const can = existsSync(resolve("dist/cli.js"));
const CREDS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const VALUE = "cwh-dummy-not-a-credential-7f3a";
const home = realpathSync(mkdtempSync(join(tmpdir(), "cwh-home-"))); // the entry script's path is a realpath
const cleanup: string[] = [home];
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true }); // removes the links, not their targets
});

function pkg(packageEnv: string) {
  return hermeticPackageRoot({ packageEnv, parent: join(home, "clones") });
}

function cli(cliPath: string, cwd: string, extraEnv: Record<string, string> = {}, args: string[] = ["--version"]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv };
  // The caller's own credentials must not decide what these cases see.
  for (const k of CREDS) if (!(k in extraEnv)) delete env[k];
  delete env.COWORK_HARNESS_DEBUG;
  const r = spawnSync("node", [cliPath, ...args], { encoding: "utf8", cwd, env });
  return { code: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
}

const line = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("[env] using"));

describe.skipIf(!can)("a credential loaded from the install's .env is named on stderr", () => {
  it("names each credential variable and the file (tildeified) — never a value", () => {
    const p = pkg(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}\nANTHROPIC_API_KEY=${VALUE}\nCWH_OTHER_KEY=1\n`);
    const elsewhere = mkdtempSync(join(home, "work-"));
    const r = cli(p.cli, elsewhere);
    expect(r.code, r.stderr).toBe(0);
    const rel = p.root.slice(home.length + 1);
    expect(line(r.stderr)).toEqual([
      `[env] using CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY from ~/${rel}/.env (the install's .env, not this directory's)`,
    ]);
    expect(r.stderr + r.stdout).not.toContain(VALUE);
    expect(r.stderr).not.toContain("CWH_OTHER_KEY"); // non-credential keys stay silent
  });

  it("ANTHROPIC_AUTH_TOKEN counts as a credential too", () => {
    const p = pkg(`ANTHROPIC_AUTH_TOKEN=${VALUE}\n`);
    const r = cli(p.cli, mkdtempSync(join(home, "work-")));
    expect(line(r.stderr)).toHaveLength(1);
    expect(line(r.stderr)[0]).toContain("ANTHROPIC_AUTH_TOKEN");
  });
});

describe.skipIf(!can)("a --dotenv after the subcommand that replaces the install's credential", () => {
  it("says the credential now comes from the --dotenv file", () => {
    const p = pkg(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}\n`);
    const cwd = mkdtempSync(join(home, "work-"));
    writeFileSync(join(cwd, "my.env"), "CLAUDE_CODE_OAUTH_TOKEN=cwh-dummy-from-my-env\n");
    const r = cli(p.cli, cwd, {}, ["stats", "--dotenv", "my.env", "--run-dir", join(cwd, "runs")]);
    expect(r.code, r.stderr).toBe(0);
    const rel = cwd.slice(home.length + 1);
    const lines = r.stderr.split("\n").filter((l) => l.startsWith("[env]"));
    expect(lines).toContain(`[env] CLAUDE_CODE_OAUTH_TOKEN from ~/${rel}/my.env (replacing the install's .env)`);
    expect(r.stderr + r.stdout).not.toContain(VALUE);
    expect(r.stderr + r.stdout).not.toContain("cwh-dummy-from-my-env");
  });

  it("a trailing --dotenv without the credential adds no correction", () => {
    const p = pkg(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}\n`);
    const cwd = mkdtempSync(join(home, "work-"));
    writeFileSync(join(cwd, "my.env"), "CWH_OTHER_KEY=1\n");
    const r = cli(p.cli, cwd, {}, ["stats", "--dotenv", "my.env", "--run-dir", join(cwd, "runs")]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("replacing");
  });
});

describe.skipIf(!can)("…and everything else stays silent", () => {
  it("the install's .env with no credential in it", () => {
    const p = pkg("CWH_OTHER_KEY=1\n");
    const r = cli(p.cli, mkdtempSync(join(home, "work-")));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("the credential is already exported", () => {
    const p = pkg(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}\n`);
    const r = cli(p.cli, mkdtempSync(join(home, "work-")), { CLAUDE_CODE_OAUTH_TOKEN: "exported-dummy" });
    expect(r.stderr).toBe("");
  });

  it("the credential is in the working directory's own .env", () => {
    const p = pkg(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}\n`);
    const cwd = mkdtempSync(join(home, "work-"));
    writeFileSync(join(cwd, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=cwd-dummy\n");
    const r = cli(p.cli, cwd);
    expect(r.stderr).toBe("");
  });

  it("the working directory IS the install (its .env is this directory's)", () => {
    const p = pkg(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}\n`);
    const r = cli(p.cli, p.root);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  });
});
