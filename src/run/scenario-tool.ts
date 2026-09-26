import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fail, isJsonOutput, jsonError, jsonPayloadEnvelope, parseOutputFormat } from "./envelope.js";
import { writeAllSync } from "../io.js";
import { lintPrepass, type LintFinding } from "./lint-load.js";

// Synchronous fd write (match envelope.ts/cli.ts/doctor.ts): writeAllSync retries EAGAIN and loops on
// short writes so the whole payload lands before process.exit on a pipe (see src/io.ts).
const out = (s: string) => writeAllSync(1, s + "\n");

/**
 * Resolve the bundled `scenario.py` (the linter/scaffolder). It is the single readable source of the lint
 * rules — shipped both inside the plugin (the skill-authoring agent runs it via `python3` directly) and in
 * the npm package (so an `npm i -g cowork-harness` consumer can run `cowork-harness lint` without a skill
 * checkout). Looks in the source/packed layouts; throws a clear error if absent.
 */
export function resolveScenarioScript(): string {
  const root = fileURLToPath(new URL("../..", import.meta.url)); // dist/run/.. (or src/run/..) → package root
  const script = join(root, ".claude", "skills", "cowork-harness", "scripts", "scenario.py");
  if (existsSync(script)) return script;
  throw new Error(`bundled scenario.py not found (looked in: ${script}). Reinstall cowork-harness.`);
}

/** Strip `--output-format json`/`--output-format text`/`--output-format=…` from the args forwarded to
 *  python — python's `lint`/`lint-skill` know only `--json` (bare, boolean), never `--output-format`.
 *  This is why the `lint` lane was broken in the packaged Action: `action.yml` always appends
 *  `--output-format json`, which python's argparse rejected as an unrecognized argument (exit 2, empty
 *  stdout) — and the SAME flag broke `lint --output-format text` too (argparse doesn't know the text
 *  form either). Applied in BOTH modes before the child spawns. */
function stripOutputFormatFlag(args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--output-format") {
      i++; // also skip its value token ("json"/"text"/whatever follows)
      continue;
    }
    if (a.startsWith("--output-format=")) continue;
    kept.push(a);
  }
  return kept;
}

function pythonNotFoundMessage(py: string, cmd: string): string {
  return `${py} not found — \`${cmd}\` needs Python 3 (PyYAML is bundled). Set $PYTHON or install Python.`;
}

/** Shared `lint`/`lint-skill` → `python3 scenario.py <cmd> …` passthrough (npm-consumer ergonomics;
 *  skill authors can still invoke python3 on the bundled script directly).
 *
 *  - **Text mode** (the default): unchanged behavior — `stdio: "inherit"`, exits with the child's code —
 *    after stripping `--output-format` (python doesn't know it either way; only the flag itself changes
 *    here, not how output reaches the terminal).
 *  - **JSON mode** (`isJsonOutput(args)`): python's `--output-format` is stripped and replaced with
 *    python's own `--json`; `stdio` captures stdout only (`["inherit","pipe","inherit"]` — stdin/stderr
 *    still inherited) so the child's BARE findings array can be parsed and re-wrapped in the harness's
 *    standard envelope via `jsonPayloadEnvelope(cmd, ok, { findings })`, with `ok = (r.status === 0)` —
 *    mirroring the child exit code, the same rule `analyze-skill` now follows (see analyze-skill.ts).
 *    If the child's stdout isn't valid JSON (a python-level usage error — e.g. a missing required
 *    positional — argparse exits 2, prints usage to stderr, and stdout is empty), that's reported as a
 *    `jsonError(cmd, "usage", …)` envelope instead of letting `JSON.parse` throw and crash the wrapper.
 *
 *  A missing python3 is exit 127 in both modes (the ENOENT guard, unchanged); PyYAML is bundled
 *  alongside scenario.py, so neither lane needs a separate install.
 *
 *  **`lint` also runs the scenario loader first** (lint-load.ts): every file `run`/`record` would refuse to
 *  load becomes an ERROR finding (`scenario-invalid`, `baseline-unknown`), handed to python through a temp
 *  file named by `COWORK_HARNESS_LINT_EXTRA_FINDINGS` so python's renderer, `--min-severity` filter and exit
 *  rule apply to both sets unchanged. With no loader findings python runs exactly as before. A direct
 *  `python3 scenario.py lint` does not run the loader. */
function runLintLike(subcommand: "lint" | "lint-skill", args: string[], prepass: (args: string[]) => LintFinding[] = lintPrepass): never {
  // Validate --output-format BEFORE isJsonOutput (matching every other command's ensureOutputFormat
  // gate) — otherwise an unrecognized value (`--output-format xml`, or a valueless trailing flag) falls
  // through isJsonOutput's strict text/json match and silently degrades to text mode, unlike every other
  // command, which exits 2 "expected one of text|json" on the same input.
  try {
    parseOutputFormat(args);
  } catch (e) {
    fail(subcommand, "usage", String((e as Error).message), undefined, isJsonOutput(args));
  }
  const script = resolveScenarioScript();
  const py = process.env.PYTHON ?? "python3";
  const json = isJsonOutput(args);
  const pyArgs = stripOutputFormatFlag(args);
  // Name the command the user actually typed in python's usage/error lines. Without this the linter
  // reports `usage: scenario.py lint …` — a command a `cowork-harness` user cannot run. Passed as env
  // (not a flag) so the script stays honest when invoked DIRECTLY, which SKILL.md and three docs document:
  // there it falls back to its own basename.
  const pyEnv: NodeJS.ProcessEnv = { ...process.env, COWORK_HARNESS_PROG: "cowork-harness" };
  // Only THIS process may hand python loader findings. A value inherited from the caller's shell would
  // inject findings nobody computed (or, on a clean corpus, report ones that are not there).
  delete pyEnv[EXTRA_FINDINGS_ENV];

  // `lint` only: run the harness's own scenario loader first, so "lint is clean" means "run/record load it".
  // See lint-load.ts for what is and is not checked. Skipped for --help (python prints usage and exits 0).
  let handoffDir: string | undefined;
  let loaderRejected: LintFinding[] = [];
  if (subcommand === "lint" && !pyArgs.some((a) => a === "-h" || a === "--help")) {
    const findings = prepass(pyArgs);
    loaderRejected = findings;
    // Zero findings → no file and no variable: python runs exactly as it did before this pre-pass existed.
    if (findings.length > 0) {
      try {
        handoffDir = mkdtempSync(join(tmpdir(), "cowork-harness-lint-"));
        const file = join(handoffDir, "loader-findings.json");
        writeFileSync(file, JSON.stringify(findings));
        pyEnv[EXTRA_FINDINGS_ENV] = file;
      } catch (e) {
        // Never fall through to a findings-less python run: that would report a scenario the loader
        // rejects as clean, the false green this pre-pass exists to remove.
        cleanup(handoffDir);
        fail(
          subcommand,
          "runtime",
          `${subcommand}: could not hand ${findings.length} loader finding(s) to the linter — ${(e as Error).message}`,
          "The scenario loader rejected at least one file. Check that the temp directory is writable (TMPDIR), or run `cowork-harness record <file> --dry-run` to see the errors.",
          json,
          1,
        );
      }
    }
  }

  // process.exit() skips `finally`, so every exit below is sequenced as: status → cleanup → exit.
  const exit = (status: number): never => {
    cleanup(handoffDir);
    return process.exit(status);
  };

  if (!json) {
    const r = spawnSync(py, [script, subcommand, ...pyArgs], { stdio: "inherit", env: pyEnv });
    if (r.error) {
      const enoent = (r.error as NodeJS.ErrnoException).code === "ENOENT";
      process.stderr.write((enoent ? pythonNotFoundMessage(py, subcommand) : String(r.error.message)) + "\n");
      process.stderr.write(loaderSummary(loaderRejected));
      return exit(127);
    }
    return exit(r.status ?? 1);
  }

  const r = spawnSync(py, [script, subcommand, "--json", ...pyArgs], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    env: pyEnv,
  });
  if (r.error) {
    const enoent = (r.error as NodeJS.ErrnoException).code === "ENOENT";
    process.stderr.write((enoent ? pythonNotFoundMessage(py, subcommand) : String(r.error.message)) + "\n");
    process.stderr.write(loaderSummary(loaderRejected));
    return exit(127);
  }
  const status = r.status ?? 1;
  let findings: unknown;
  try {
    findings = JSON.parse(r.stdout ?? "");
  } catch {
    // stdio's stderr slot is "inherit" (see the spawnSync call above), so python's usage text already
    // reached the step log directly — r.stderr is always null here, there's no tail to surface as a hint.
    out(jsonError(subcommand, "usage", `${subcommand}: python emitted non-JSON output on --json (exit ${status})`));
    return exit(status);
  }
  out(jsonPayloadEnvelope(subcommand, status === 0, { findings }));
  return exit(status);
}

/** The variable naming the JSON file of loader findings python merges into its own (see scenario.py
 *  `cmd_lint`). Internal to the wrapper↔script handoff — not a user knob. */
const EXTRA_FINDINGS_ENV = "COWORK_HARNESS_LINT_EXTRA_FINDINGS";

/** When the linter itself could not be spawned, the loader findings never reach a renderer. Name the files
 *  instead of dropping them, so the user learns the scenario also fails to load. Empty when there were none. */
function loaderSummary(findings: LintFinding[]): string {
  if (findings.length === 0) return "";
  const files = [...new Set(findings.map((f) => f.file))];
  return (
    `The scenario loader rejected ${files.length} file(s) as well (not shown — the linter never ran): ${files.join(", ")}. ` +
    "`cowork-harness record <file> --dry-run` shows the errors.\n"
  );
}

function cleanup(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: a leftover temp file must not change lint's verdict */
  }
}

/** `cowork-harness lint <files…>` → `python3 scenario.py lint <files…>`. See `runLintLike` for the
 *  text/json dual-mode behavior and the ENOENT → exit-127 guard. */
export function cmdLint(args: string[], prepass: (args: string[]) => LintFinding[] = lintPrepass): never {
  // `prepass` is a test seam: the default is the real loader pre-pass.
  return runLintLike("lint", args, prepass);
}

/** `cowork-harness lint-skill <files…>` → `python3 scenario.py lint-skill <files…>`. See `runLintLike`
 *  for the text/json dual-mode behavior and the ENOENT → exit-127 guard. */
export function cmdLintSkill(args: string[]): never {
  return runLintLike("lint-skill", args);
}
