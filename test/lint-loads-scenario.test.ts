import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { listBaselineNames } from "../src/baseline.js";
import { resolveScenarioScript } from "../src/run/scenario-tool.js";
import { lintPositionals } from "../src/run/lint-load.js";

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

describe("lint pre-pass positional parsing", () => {
  it("does not hand --cassette-dir's value to the scenario loader", () => {
    expect(lintPositionals(["--cassette-dir", "cassettes", "scenarios/a.yaml"])).toEqual(["scenarios/a.yaml"]);
    expect(lintPositionals(["--cassette-dir=cassettes", "scenarios/a.yaml"])).toEqual(["scenarios/a.yaml"]);
  });
});

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

  it("a scenario without `fidelity:` is a loader ERROR whose fix is the loader's remedy, printed once", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", ["baseline: latest", "prompt: hello", "assert:", "  - result: success"]);
    const r = runCli(["lint", f, "--output-format", "json"]);
    expect(r.code).toBe(1);
    expect(r.stderr, "lint prints findings, not loader notices").not.toMatch(/::warning:: \[scenario\]/);
    const loader = jsonFindings(r.stdout).filter((x) => x.rule === "scenario-invalid");
    expect(loader).toHaveLength(1);
    expect(loader[0].message).toMatch(/`fidelity:` is required/);
    expect(loader[0].fix).toMatch(/fidelity: container/);
    expect(loader[0].fix).toMatch(/fidelity: hostloop/);
  });

  it("python reports the same file as ERROR fidelity-missing, once, beside the loader's finding", () => {
    // A duplicate under the wrapper (like `enum-value-invalid`); on a direct `scenario.py lint` it is the only
    // coverage. The retired WARN must not appear next to it.
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", ["baseline: latest", "prompt: hello", "assert:", "  - result: success"]);
    const found = jsonFindings(runCli(["lint", f, "--output-format", "json"]).stdout);
    const py = found.filter((x) => x.rule === "fidelity-missing");
    expect(py).toHaveLength(1);
    expect(py[0].severity).toBe("ERROR");
    expect(found.map((x) => x.rule)).not.toContain("fidelity-defaulted");
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

describe.skipIf(!can || !havePython)("a pre-pass machinery failure reaches python's renderer", () => {
  it("lint-loader-internal is rendered by the linter, exits 1, and prints no stack trace", () => {
    // Drives the BUILT wrapper with a pre-pass whose input expansion throws — the only way to make the
    // pre-pass machinery itself fail on demand. The finding must travel the same handoff as every other
    // loader finding: python renders it and the exit rule gates on it.
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", CLEAN);
    const tool = resolve("dist/run/scenario-tool.js");
    const loader = resolve("dist/run/lint-load.js");
    const src =
      `const { cmdLint } = await import(${JSON.stringify(tool)});` +
      `const { lintPrepass } = await import(${JSON.stringify(loader)});` +
      `cmdLint([${JSON.stringify(f)}], (a) => lintPrepass(a, { expand: () => { throw new Error("expansion exploded"); } }));`;
    const r = spawnSync("node", ["--input-type=module", "-e", src], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR \[lint-loader-internal\]/);
    expect(r.stdout).toMatch(/expansion exploded/);
    expect(r.stderr).not.toMatch(/\bat \S+ \(/);
  });
});

// Running the bundled script directly skips the loader pre-pass, so its "clean" is weaker than the wrapper's.
// It says so on stderr (never stdout, which carries the --json array), and only when it was run directly:
// the wrapper always sets COWORK_HARNESS_PROG and has already run the loader.
describe.skipIf(!can || !havePython)("a direct `scenario.py lint` names the loader it skipped", () => {
  const LOADER_SKIPPED = /loader.*skipped|skipped.*loader/i;
  function direct(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.COWORK_HARNESS_PROG;
    const r = spawnSync(py, [resolveScenarioScript(), "lint", ...args], { encoding: "utf8", env });
    return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  it("direct text run: a stderr note that points at `cowork-harness lint`, exit code unchanged", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", CLEAN);
    const r = direct([f]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(LOADER_SKIPPED);
    expect(r.stderr).toContain("cowork-harness lint");
    expect(r.stdout).not.toMatch(LOADER_SKIPPED);
  });

  it("direct --json run: stdout is still exactly the findings array; the note stays on stderr", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", CLEAN);
    const r = direct([f, "--json"]);
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.stdout))).toBe(true);
    expect(r.stderr).toMatch(LOADER_SKIPPED);
  });

  it("through the wrapper (which ran the loader): no such note", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-load-"));
    const f = scenario(d, "s.yaml", CLEAN);
    const r = runCli(["lint", f]);
    expect(r.code).toBe(0);
    expect(r.stderr + r.stdout).not.toMatch(LOADER_SKIPPED);
  });
});

// `--strict` without `--min-severity` defaults the floor to WARN (4.0.0): it fails on ERROR and WARN and
// hides INFO, as `lint-skill --strict` always has. Driven through the built CLI, since that is what the
// packaged Action's `strict` input and a CI step call.
describe.skipIf(!can || !havePython)("lint --strict defaults its floor to WARN", () => {
  const INFO_ONLY = [...HEAD, "assert:", "  - file_exists: outputs/x.json"];

  it("an INFO-only scenario passes bare `--strict`, and the INFO is not printed", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-strict-floor-"));
    const f = scenario(d, "s.yaml", INFO_ONLY);
    const plain = runCli(["lint", f]);
    expect(plain.stdout, "the scenario must carry an INFO for this test to mean anything").toMatch(/manifest-needs-snapshot/);
    const r = runCli(["lint", f, "--strict"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/manifest-needs-snapshot/);
  });

  it("`--strict --min-severity INFO` keeps the old gate: the INFO is printed and fails", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-strict-floor-"));
    const f = scenario(d, "s.yaml", INFO_ONLY);
    const r = runCli(["lint", f, "--strict", "--min-severity", "INFO"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/manifest-needs-snapshot/);
  });

  it("json mode agrees: bare `--strict` reports no INFO finding and ok:true", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-strict-floor-"));
    const f = scenario(d, "s.yaml", INFO_ONLY);
    const r = runCli(["lint", f, "--strict", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(true);
    expect(jsonFindings(r.stdout)).toEqual([]);
  });
});
