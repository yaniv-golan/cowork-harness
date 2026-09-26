import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { listBaselineNames } from "../src/baseline.js";
import { resolveScenarioScript } from "../src/run/scenario-tool.js";

// `cowork-harness lint` runs the harness's own scenario loader before the bundled python linter, so a
// scenario `lint` calls clean is one `run`/`record` will load. These drive the BUILT CLI end to end.
// Everything here is token-free: nothing spawns an agent.

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

function runCli(args: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: merged as NodeJS.ProcessEnv, cwd });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function scenario(dir: string, name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const HEAD = ["baseline: latest", "fidelity: container", "on_unanswered: fail", "prompt: hello"];
const CLEAN = [...HEAD, "assert:", "  - result: success"];
const RUBRIC_SCALAR = [...HEAD, "assert:", "  - result: success", "  - semantic_matches:", '      rubric: "the reply greets the user"'];

const jsonFindings = (stdout: string) =>
  JSON.parse(stdout.trim()).findings as { rule: string; severity: string; file: string; fix: string; message: string }[];

describe.skipIf(!can || !havePython)("lint reports what the scenario loader rejects", () => {
  it("a wrong-typed field fails `lint --strict --min-severity WARN` with the loader's own path", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    const r = runCli(["lint", f, "--strict", "--min-severity", "WARN"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/scenario-invalid/);
    expect(r.stdout).toMatch(/assert\[1\]\.semantic_matches\.rubric/);
  });

  it("gates plain `lint` too (no --strict): a loader rejection is an ERROR", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    expect(runCli(["lint", f]).code).toBe(1);
  });

  it("json mode: ok:false with an ERROR scenario-invalid finding, never filtered by --min-severity ERROR", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    for (const extra of [[], ["--strict", "--min-severity", "ERROR"]]) {
      const r = runCli(["lint", f, "--output-format", "json", ...extra]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout.trim()).ok).toBe(false);
      expect(jsonFindings(r.stdout)).toContainEqual(expect.objectContaining({ severity: "ERROR", rule: "scenario-invalid", file: f }));
    }
  });

  it("a `baseline:` naming no committed baseline is baseline-unknown, and the fix names real ones and `latest`", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", ["baseline: desktop-0.0.0", ...CLEAN.slice(1)]);
    const r = runCli(["lint", f, "--output-format", "json"]);
    expect(r.code).toBe(1);
    const hit = jsonFindings(r.stdout).find((x) => x.rule === "baseline-unknown");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("ERROR");
    expect(hit!.fix).toMatch(/desktop-\d/);
    expect(hit!.fix).toMatch(/latest/);
  });

  it("`baseline: latest` and a committed baseline name produce no loader finding", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const a = scenario(d, "a.yaml", CLEAN);
    const b = scenario(d, "b.yaml", [`baseline: ${listBaselineNames()[0]}`, ...CLEAN.slice(1)]);
    const r = runCli(["lint", a, b, "--strict", "--min-severity", "WARN"]);
    expect(r.code).toBe(0);
  });

  it("a bad regex (a plain-Error load refusal, not a schema error) is scenario-invalid", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", [...HEAD, "assert:", "  - transcript_matches: '('"]);
    const r = runCli(["lint", f, "--output-format", "json"]);
    expect(r.code).toBe(1);
    expect(jsonFindings(r.stdout).map((x) => x.rule)).toContain("scenario-invalid");
  });

  it("does NOT check anything that depends on the machine: session file, absolute baseline path, env", () => {
    // Green before this change too (lint loaded nothing) — it guards against an implementation that reaches
    // for the session loader or the pre-spawn checks, which read the filesystem and environment.
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", ["baseline: /nonexistent/abs/baseline.json", "session: ./missing/session.yaml", ...CLEAN.slice(1)]);
    const r = runCli(["lint", f, "--strict", "--min-severity", "WARN", "--output-format", "json"], {
      COWORK_HARNESS_AUTHORED_TOTAL_BYTES: "garbage",
    });
    expect(r.code).toBe(0);
    expect(jsonFindings(r.stdout)).toEqual([]);
  });

  it("the loader's defaulted-fidelity notice is not printed by lint; python's WARN still is, once", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", ["baseline: latest", "prompt: hello", "assert:", "  - transcript_matches: '('"]);
    const r = runCli(["lint", f]);
    expect(r.stderr).not.toMatch(/::warning:: \[scenario\]/);
    expect(r.stdout.match(/fidelity-defaulted/g)?.length).toBe(1);
    expect(r.stdout).toMatch(/scenario-invalid/);
  });

  it("a directory target attributes the loader finding to the same path python prints", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const sub = join(d, "d");
    mkdirSync(sub);
    scenario(sub, "good.yaml", CLEAN);
    // `bogus_key` is a python WARN (unknown-top-key) AND a loader rejection — both land on one file string.
    scenario(sub, "bad.yaml", [...CLEAN, "bogus_key: 1"]);
    for (const target of [sub + "/", "./d/", "x/../d"]) {
      if (target === "x/../d") mkdirSync(join(d, "x"), { recursive: true });
      const r = runCli(["lint", target, "--output-format", "json"], {}, d);
      expect(r.code).toBe(1);
      const fs = jsonFindings(r.stdout);
      const loader = fs.filter((x) => x.rule === "scenario-invalid");
      const pyOwn = fs.filter((x) => x.rule === "unknown-top-key");
      expect(loader).toHaveLength(1);
      expect(pyOwn.length).toBeGreaterThan(0);
      expect(loader[0].file).toBe(pyOwn[0].file);
    }
  });

  it("a directory mixing a scenario and a session file reports the session file (a file the loader rejects)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const good = scenario(d, "a.yaml", CLEAN);
    const session = scenario(d, "b-session.yaml", ["model: claude-sonnet-4-5"]);
    const r = runCli(["lint", d, "--output-format", "json"]);
    expect(r.code).toBe(1);
    const loader = jsonFindings(r.stdout).filter((x) => x.rule === "scenario-invalid");
    expect([...new Set(loader.map((x) => x.file))]).toEqual([session]);
    expect(loader[0].fix).toMatch(/not a scenario/);
    expect(loader.some((x) => x.file === good)).toBe(false);
  });

  it("an inherited COWORK_HARNESS_LINT_EXTRA_FINDINGS never reaches python on a clean corpus", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", CLEAN);
    const planted = join(d, "planted.json");
    writeFileSync(planted, JSON.stringify([{ severity: "ERROR", rule: "planted", message: "m", fix: "f", file: f, line: null }]));
    const dump = join(d, "env.txt");
    const stub = join(d, "py.sh");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s' "\${COWORK_HARNESS_LINT_EXTRA_FINDINGS-UNSET}" > "${dump}"\nexec ${py} "$@"\n`);
    chmodSync(stub, 0o755);
    const r = runCli(["lint", f], { PYTHON: stub, COWORK_HARNESS_LINT_EXTRA_FINDINGS: planted });
    expect(readFileSync(dump, "utf8")).toBe("UNSET");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/planted/);
  });

  it("if the findings cannot be handed to python, lint fails loud instead of passing", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    const r = runCli(["lint", f], { TMPDIR: join(d, "does", "not", "exist") });
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/clean/);
    expect(r.stderr).toMatch(/lint/);
  });

  it("direct `python3 scenario.py lint` is unchanged: it does not run the loader", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    const r = spawnSync(py, [resolveScenarioScript(), "lint", f], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

describe.skipIf(!can || !havePython)("lint input edge cases never crash the wrapper", () => {
  it("a dangling *.yaml symlink in a linted dir is python's not-found, not a node stack trace", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    scenario(d, "good.yaml", CLEAN);
    symlinkSync(join(d, "nowhere", "target.yaml"), join(d, "gone.yaml"));
    const r = runCli(["lint", d]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/not-found/);
    expect(r.stderr).not.toMatch(/\bat \S+ \(|statSync|ENOENT/);
  });

  it("with python missing, a loader rejection is still named rather than silently dropped", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    const r = runCli(["lint", f], { PYTHON: "/does/not/exist" });
    expect(r.code).toBe(127);
    expect(r.stderr).toMatch(/not found/i);
    expect(r.stderr).toMatch(/loader rejected 1 file/);
    expect(r.stderr).toContain(f);
  });

  it("the fix text quotes the path so the suggested command survives a space", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh lint load "));
    const f = scenario(d, "s.yaml", RUBRIC_SCALAR);
    const r = runCli(["lint", f, "--output-format", "json"]);
    const hit = jsonFindings(r.stdout).find((x) => x.rule === "scenario-invalid");
    expect(hit!.fix).toContain(`record '${f}' --dry-run`);
  });
});

describe.skipIf(!can)("record --dry-run keeps the defaulted-fidelity notice ahead of a regex refusal", () => {
  it("prints the notice once, then the load error", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    scenario(d, "s.yaml", ["baseline: latest", "prompt: hello", "assert:", "  - transcript_matches: '('"]);
    const r = runCli(["record", "s.yaml", "--dry-run"], {}, d);
    expect(r.code).toBe(2);
    const all = r.stdout + r.stderr;
    expect(all.match(/::warning:: \[scenario\]/g)?.length).toBe(1);
    expect(all.indexOf("::warning:: [scenario]")).toBeLessThan(all.indexOf("bad regex"));
  });
});
