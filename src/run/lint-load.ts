// The loader pre-pass `cowork-harness lint` runs before the bundled python linter.
//
// The python linter checks authoring invariants offline and never parses with the harness's schema, so on
// its own it can call a scenario clean that `run`/`record` refuse to load. This module runs the SAME load
// function those commands use (`loadScenarioPure`) plus the one baseline lookup that depends only on the
// installed harness (a committed baseline NAME), and turns every refusal into a finding shaped exactly like
// python's `Finding.as_dict()`. The wrapper hands them to python, which renders, filters and gates on them
// together with its own.
//
// Deliberately NOT checked here, because the answer depends on the machine rather than the scenario: the
// session file (and the mounts it names), an absolute `baseline:` path, environment knobs read at run time,
// and the tier-dependent pre-spawn refusals. A consumer's token-free lint lane often runs where the scenario
// never will.
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadBaseline as realLoadBaseline } from "../baseline.js";
import { UsageError, renderIssuePath } from "../errors.js";
import { loadScenarioPure } from "./execute.js";
import type { Scenario } from "../types.js";

/** Python's `Finding.as_dict()` shape (`scenario.py`), field for field. */
export interface LintFinding {
  severity: "ERROR" | "WARN" | "INFO";
  rule: string;
  message: string;
  fix: string;
  file: string;
  line: number | null;
}

export interface LoaderDeps {
  load?: (path: string) => Scenario;
  loadBaseline?: (name: string) => unknown;
}

/** Most schema findings reported for one file; the last slot then summarises the rest. */
const MAX_ISSUES_PER_FILE = 10;

const NOT_A_SCENARIO = "If this file is not a scenario (a session, matrix or answer-policy file), move it out of the linted set.";

/** Join a directory argument and an entry name the way python's `str(Path(dir) / name)` does, so a finding
 *  from here carries the same `file` string as python's own findings for that file: `./d/` and `d//`
 *  collapse to `d`, but a `..` segment is kept (python does not resolve it; `path.join` would). */
function pyPathJoin(dir: string, name: string): string {
  if (process.platform === "win32") return join(dir, name);
  const abs = dir.startsWith("/");
  const segs = dir.split("/").filter((s) => s !== "" && s !== ".");
  return (abs ? "/" : "") + [...segs, name].join("/");
}

/** The scenario files `scenario.py lint` will read for these command-line arguments, in its order: a
 *  directory becomes its non-recursive, sorted `*.yaml` + `*.yml` entries; a file stays exactly as typed.
 *  Arguments python reports on its own (a missing path, an empty directory) and non-regular entries are
 *  skipped, so nothing is reported twice and an unrecognised token can only ever be skipped. */
export function expandLintInputs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      const entries = readdirSync(p)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => pyPathJoin(p, f))
        .sort();
      for (const e of entries) if (statSync(e).isFile()) out.push(e);
    } else if (st.isFile()) out.push(p);
  }
  return out;
}

/** The positional (path) arguments of a `lint` command line, after `--output-format` was stripped. Flags
 *  and `--min-severity`'s value are dropped; anything after `--` is positional. A token misclassified here
 *  is harmless: `expandLintInputs` skips any path that does not exist. */
export function lintPositionals(args: string[]): string[] {
  const out: string[] = [];
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest) out.push(a);
    else if (a === "--") rest = true;
    else if (a === "--min-severity") i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

function zodIssues(e: unknown): { message: string; path: unknown }[] | undefined {
  if (!(e instanceof UsageError) || typeof e.hint !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(e.hint);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const issues = parsed.filter(
      (i): i is { message: string; path: unknown } =>
        !!i && typeof i === "object" && typeof (i as { message?: unknown }).message === "string",
    );
    return issues.length ? issues : undefined;
  } catch {
    return undefined;
  }
}

function loadRefusalFindings(file: string, e: unknown): LintFinding[] {
  const who = "the loader (`run`/`record`) rejects this file";
  const dryRun = `\`cowork-harness record ${file} --dry-run\` reports the same error.`;
  const issues = zodIssues(e);
  if (!issues) {
    const msg = e instanceof Error ? e.message : String(e);
    return [
      { severity: "ERROR", rule: "scenario-invalid", message: `${who}: ${msg}`, fix: `${dryRun} ${NOT_A_SCENARIO}`, file, line: null },
    ];
  }
  const shown = issues.length > MAX_ISSUES_PER_FILE ? issues.slice(0, MAX_ISSUES_PER_FILE - 1) : issues;
  const findings: LintFinding[] = shown.map((i) => {
    const where = renderIssuePath(i.path);
    return {
      severity: "ERROR",
      rule: "scenario-invalid",
      message: `${who} — ${where}: ${i.message}`,
      fix: `Fix the value at ${where}; ${dryRun} ${NOT_A_SCENARIO}`,
      file,
      line: null,
    };
  });
  if (shown.length < issues.length)
    findings.push({
      severity: "ERROR",
      rule: "scenario-invalid",
      message: `${who} — …and ${issues.length - shown.length} more schema issue(s) in this file`,
      fix: `${dryRun} lists them all.`,
      file,
      line: null,
    });
  return findings;
}

function baselineFinding(file: string, name: string, e: unknown): LintFinding {
  const msg = e instanceof Error ? e.message : String(e);
  const hint = e instanceof UsageError && e.hint ? `${e.hint}. ` : "";
  return {
    severity: "ERROR",
    rule: "baseline-unknown",
    message: `\`baseline: ${name}\` does not resolve on this install — ${msg}`,
    fix: `${hint}\`latest\` always resolves. A pinned name must be one this installed cowork-harness ships; install the version that ships it, or use \`latest\`.`,
    file,
    line: null,
  };
}

/** Loader findings for already-expanded scenario files (see `expandLintInputs`). Never throws and never
 *  writes to stdout/stderr: a failure of this function's own machinery becomes an ERROR
 *  `lint-loader-internal` finding for the file being processed, because silently falling back to the
 *  python-only lint would be the exact false green this exists to remove. */
export function loaderFindings(files: string[], deps: LoaderDeps = {}): LintFinding[] {
  const load = deps.load ?? ((p: string) => loadScenarioPure(p));
  const resolveBaseline = deps.loadBaseline ?? realLoadBaseline;
  const baselineOk = new Map<string, unknown>(); // name → the error, or null when it resolved
  const out: LintFinding[] = [];
  for (const file of files) {
    try {
      let scenario: Scenario;
      try {
        scenario = load(file);
      } catch (e) {
        out.push(...loadRefusalFindings(file, e));
        continue;
      }
      const name = scenario.baseline;
      // `latest` always resolves on a packaged install; an absolute path is a file on some machine, which the
      // lint lane may not be. Only a committed NAME is a property of the scenario plus this install.
      if (name === "latest" || isAbsolute(name)) continue;
      if (!baselineOk.has(name)) {
        try {
          resolveBaseline(name);
          baselineOk.set(name, null);
        } catch (e) {
          baselineOk.set(name, e);
        }
      }
      const err = baselineOk.get(name);
      if (err !== null) out.push(baselineFinding(file, name, err));
    } catch (e) {
      let detail: string;
      try {
        detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      } catch {
        detail = "(unprintable error)";
      }
      out.push({
        severity: "ERROR",
        rule: "lint-loader-internal",
        message: `cowork-harness could not run its loader check on this file: ${detail}`,
        fix: "This is a harness bug, not a scenario problem — please report it. Until then, `cowork-harness record <file> --dry-run` checks that the file loads.",
        file,
        line: null,
      });
    }
  }
  return out;
}
