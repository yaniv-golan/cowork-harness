// A scenario FILE that cannot be read — missing, a directory, not readable, not valid YAML — is a usage
// error with a one-line message on every lane, the same way an unreadable `session:` file is. `run` used to
// answer every one but "missing" with category `internal` and the parser's multi-line dump.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadScenarioPure } from "../src/run/execute.js";
import { UsageError } from "../src/errors.js";

const CLI = resolve("dist/cli.js");
const GOOD = "name: a\nprompt: hi\nfidelity: protocol\nassert:\n  - result: success\n";

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-scenario-file-"));
}

function cli(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      COWORK_HARNESS_FORBID_SPAWN: "1",
      COWORK_HARNESS_RUNS_DIR: join(cwd, ".runs"),
      COWORK_HARNESS_MODEL: "claude-sonnet-5",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    },
  });
  const env = JSON.parse(r.stdout || "{}") as { error?: { category?: string; message?: string } };
  return { code: r.status, env, all: (r.stdout || "") + (r.stderr || "") };
}

function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

describe("loadScenarioPure: an unreadable scenario file is a UsageError with one line", () => {
  it("missing", () => {
    const p = join(work(), "gone.yaml");
    const e = thrown(() => loadScenarioPure(p));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toBe(`scenario file not found: ${p}`);
  });

  it("a directory", () => {
    const p = join(work(), "dir.yaml");
    mkdirSync(p);
    const e = thrown(() => loadScenarioPure(p));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toBe(`scenario file is a directory: ${p}`);
  });

  it("invalid YAML", () => {
    const p = join(work(), "bad.yaml");
    writeFileSync(p, "name: [\n");
    const e = thrown(() => loadScenarioPure(p));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toMatch(/^scenario file is not valid YAML: .*bad\.yaml: \S/);
    expect(e.message).not.toMatch(/\n/);
  });
});

describe.skipIf(!existsSync(CLI))("run and record --dry-run agree on an unreadable scenario file", () => {
  it("run <file>: invalid YAML is usage (exit 2), one line", () => {
    const d = work();
    writeFileSync(join(d, "bad.yaml"), "name: [\n");
    const r = cli(["run", "bad.yaml", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.env.error?.category).toBe("usage");
    expect(r.env.error?.message).toMatch(/^scenario file is not valid YAML: .*bad\.yaml: [^\n]+$/);
    const dry = cli(["record", "bad.yaml", "--dry-run", "--output-format", "json"], d);
    expect(dry.env.error?.category).toBe("usage");
    expect(dry.env.error?.message).toContain(r.env.error!.message!);
  });

  it.skipIf(process.getuid?.() === 0)("run <file>: not readable is usage", () => {
    const d = work();
    writeFileSync(join(d, "locked.yaml"), GOOD);
    chmodSync(join(d, "locked.yaml"), 0o000);
    const r = cli(["run", "locked.yaml", "--output-format", "json"], d);
    chmodSync(join(d, "locked.yaml"), 0o600);
    expect(r.code, r.all).toBe(2);
    expect(r.env.error?.category).toBe("usage");
    expect(r.env.error?.message).toMatch(/^scenario file is not readable: .*locked\.yaml$/);
  });

  it("run <dir/>: a *.yaml directory and an invalid-YAML file are usage, not internal", () => {
    const d = work();
    mkdirSync(join(d, "sc", "dir.yaml"), { recursive: true });
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.env.error?.category).toBe("usage");
    expect(r.env.error?.message).toMatch(/scenario file is a directory: .*dir\.yaml/);
    const d2 = work();
    mkdirSync(join(d2, "sc"));
    writeFileSync(join(d2, "sc", "bad.yaml"), "name: [\n");
    const r2 = cli(["run", "sc/", "--output-format", "json"], d2);
    expect(r2.code, r2.all).toBe(2);
    expect(r2.env.error?.category).toBe("usage");
    expect(r2.env.error?.message).toMatch(/scenario file is not valid YAML/);
  });
});
