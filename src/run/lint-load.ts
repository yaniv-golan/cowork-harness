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

/** Value-taking flags shared by the loader pre-pass and scenario.py's own positional scan. */
export const LINT_VALUE_FLAGS = ["--min-severity", "--output-format", "--cassette-dir"] as const;

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
  // `statSync` follows links, so a dangling `*.yaml` symlink throws. Such an entry is skipped rather than
  // allowed to crash the wrapper: python reports it (`not-found`), and nothing is reported twice.
  const kind = (p: string): "dir" | "file" | undefined => {
    try {
      const st = statSync(p);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : undefined;
    } catch {
      return undefined;
    }
  };
  for (const p of paths) {
    const k = kind(p);
    if (k === "dir") {
      const entries = readdirSync(p)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => pyPathJoin(p, f))
        .sort();
      for (const e of entries) if (kind(e) === "file") out.push(e);
    } else if (k === "file") out.push(p);
  }
  return out;
}

/** The positional (path) arguments of a `lint` command line, after `--output-format` was stripped. Flags
 *  and value-taking lint options are dropped; anything after `--` is positional. A token misclassified
 *  here is harmless: `expandLintInputs` skips any path that does not exist. */
export function lintPositionals(args: string[]): string[] {
  const out: string[] = [];
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest) out.push(a);
    else if (a === "--") rest = true;
    else if ((LINT_VALUE_FLAGS as readonly string[]).includes(a)) i++;
    else if (LINT_VALUE_FLAGS.some((flag) => a.startsWith(`${flag}=`))) continue;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

/** POSIX single-quoting, so a suggested command survives a path with spaces or shell metacharacters. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** One issue from a schema refusal's `hint`. `fix` is present when the loader wrote a specific remedy for
 *  that issue (a missing `fidelity:` — see `FidelityMissingError`); lint then uses it as the finding's fix
 *  instead of the generic "fix the value" text. */
type HintIssue = { message: string; path: unknown; fix?: unknown };

function zodIssues(e: unknown): HintIssue[] | undefined {
  if (!(e instanceof UsageError) || typeof e.hint !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(e.hint);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const issues = parsed.filter(
      (i): i is HintIssue => !!i && typeof i === "object" && typeof (i as { message?: unknown }).message === "string",
    );
    return issues.length ? issues : undefined;
  } catch {
    return undefined;
  }
}

function loadRefusalFindings(file: string, e: unknown): LintFinding[] {
  const who = "the loader (`run`/`record`) rejects this file";
  const dryRun = `\`cowork-harness record ${shellQuote(file)} --dry-run\` reports the same error.`;
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
      // The loader's own remedy when it wrote one. The generic text would point a scenario that only lacks
      // its tier at "fix the value" and "move it out of the linted set" — away from the one-line fix.
      fix: typeof i.fix === "string" ? `${i.fix} ${dryRun}` : `Fix the value at ${where}; ${dryRun} ${NOT_A_SCENARIO}`,
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
      // An absolute path is machine-dependent: one that does not exist HERE is not checked (it may exist on
      // the machine the run happens on). One that exists is checked like a name — a directory or a file that
      // does not load would fail every run.
      if (name === "latest" || (isAbsolute(name) && !existsSync(name))) continue;
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

/** The whole pre-pass for a `lint` command line (flags already stripped of `--output-format`): pick the
 *  path arguments, expand them like python does, run the loader on each. Never throws — a failure in the
 *  expansion itself becomes one ERROR `lint-loader-internal` finding, so the wrapper neither crashes before
 *  python runs nor falls back to a lint that skipped the loader. `deps` is a test seam. */
export function lintPrepass(args: string[], deps: LoaderDeps & { expand?: (paths: string[]) => string[] } = {}): LintFinding[] {
  let files: string[];
  try {
    files = (deps.expand ?? expandLintInputs)(lintPositionals(args));
  } catch (e) {
    let detail: string;
    try {
      detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    } catch {
      detail = "(unprintable error)";
    }
    return [
      {
        severity: "ERROR",
        rule: "lint-loader-internal",
        message: `cowork-harness could not list the files to run its loader check on: ${detail}`,
        fix: "This is a harness bug, not a scenario problem — please report it. Until then, `cowork-harness record <file> --dry-run` checks that a file loads.",
        file: "(cowork-harness)",
        line: null,
      },
    ];
  }
  return loaderFindings(files, deps);
}
