// A `baseline:` that is an absolute path to a FILE the user supplies: a directory, invalid JSON or a document
// the baseline schema rejects is a usage error with a short message (UnknownBaselineError), never a raw
// SyntaxError or a Zod issue array under category `internal`. A committed baseline NAME is unchanged.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { UnknownBaselineError } from "../src/errors.js";

const CLI = resolve("dist/cli.js");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-baseline-file-"));
}

function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

describe("loadBaseline: an unusable baseline FILE is an UnknownBaselineError with one line", () => {
  it("a directory", () => {
    const d = work();
    const e = thrown(() => loadBaseline(d));
    expect(e).toBeInstanceOf(UnknownBaselineError);
    expect(e.message).toMatch(new RegExp(`^baseline file at "${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" is a directory`));
  });

  it("invalid JSON", () => {
    const p = join(work(), "b.json");
    writeFileSync(p, "{not json");
    const e = thrown(() => loadBaseline(p));
    expect(e).toBeInstanceOf(UnknownBaselineError);
    expect(e.message).toMatch(/does not load: not valid JSON/);
    expect(e.message).not.toMatch(/\n/);
  });

  it("a document the baseline schema rejects", () => {
    const p = join(work(), "b.json");
    writeFileSync(p, "{}");
    const e = thrown(() => loadBaseline(p));
    expect(e).toBeInstanceOf(UnknownBaselineError);
    expect(e.message).toMatch(/does not load: not a platform baseline/);
    expect(e.message).not.toMatch(/\n/);
  });

  it("green pin: a bare NAME that names nothing keeps its message", () => {
    expect(() => loadBaseline("no-such-baseline")).toThrow(/^no baseline named "no-such-baseline"/);
  });
});

describe.skipIf(!existsSync(CLI) || !havePython)("lint: a baseline file path that exists but does not load is baseline-unknown", () => {
  const scenario = (baseline: string) =>
    `baseline: ${baseline}\nfidelity: container\non_unanswered: fail\nprompt: hello\nassert:\n  - result: success\n`;
  const lint = (f: string) => spawnSync("node", [CLI, "lint", f, "--json"], { encoding: "utf8" });

  it("a directory: ERROR baseline-unknown, exit 1", () => {
    const d = work();
    mkdirSync(join(d, "bl"));
    writeFileSync(join(d, "s.yaml"), scenario(join(d, "bl")));
    const r = lint(join(d, "s.yaml"));
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/"rule":\s*"baseline-unknown"/);
  });

  it("green pin: an absolute path that does not exist on THIS machine is not checked", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), scenario("/no/such/dir/baseline.json"));
    const r = lint(join(d, "s.yaml"));
    expect(r.stdout).not.toMatch(/baseline-unknown/);
  });
});

describe.skipIf(!existsSync(CLI))("record: a baseline FILE that does not load keeps exit 1; an unknown NAME keeps exit 2", () => {
  const scenario = (baseline: string) =>
    `name: m\nbaseline: ${baseline}\nfidelity: container\nprompt: hello\nassert:\n  - result: success\n`;
  const record = (d: string, extra: string[]) => {
    const r = spawnSync("node", [CLI, "record", "m.yaml", "--model", "claude-sonnet-5", "--output-format", "json", ...extra], {
      encoding: "utf8",
      cwd: d,
      env: {
        ...process.env,
        COWORK_HARNESS_FORBID_SPAWN: "1",
        COWORK_HARNESS_RUNS_DIR: join(d, ".runs"),
        CLAUDE_CODE_OAUTH_TOKEN: "dummy",
      },
    });
    const env = JSON.parse(r.stdout || "{}") as { error?: { category?: string; message?: string } };
    return { code: r.status, env, all: (r.stdout || "") + (r.stderr || "") };
  };

  it("bad JSON baseline file: real record and --dry-run both exit 1, usage", () => {
    const d = work();
    writeFileSync(join(d, "b.json"), "{not json");
    writeFileSync(join(d, "m.yaml"), scenario(join(d, "b.json")));
    const real = record(d, ["--out", join(d, "m.cassette.json")]);
    expect(real.code, real.all).toBe(1);
    expect(real.env.error?.category).toBe("usage");
    expect(real.env.error?.message).toMatch(/does not load: not valid JSON/);
    const dry = record(d, ["--dry-run"]);
    expect(dry.code, dry.all).toBe(1);
    expect(dry.env.error?.category).toBe("usage");
  });

  it("green pin: an unknown baseline NAME on the real record stays exit 2", () => {
    const d = work();
    writeFileSync(join(d, "m.yaml"), scenario("no-such-baseline"));
    const real = record(d, ["--out", join(d, "m.cassette.json")]);
    expect(real.code, real.all).toBe(2);
    expect(real.env.error?.category).toBe("usage");
  });
});
