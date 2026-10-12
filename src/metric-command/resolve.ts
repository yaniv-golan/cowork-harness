// Resolve a scenario's command metrics against the filesystem: where each script and dep really is, that it is a
// regular, contained, tracked file, and the content hash of exactly those bytes.
//
// A step BESIDE the loader (like `inlineSchemaFiles`), never inside it: the cassette drift and discovery paths and
// `verify-cassettes` parse on-disk scenarios too, and a command metric must never make them stat or read a script
// (replay never executes one). Callers: run, record, eval, hillclimb, regrade, verify-run and lint.
//
// "The repo" is the scenario's git work tree (resolved from the scenario's directory with any ambient GIT_DIR
// removed), or the scenario's own directory outside one. Every file must lie under its real path; no path component
// INSIDE the repo may be a symlink (a symlink above it — a compat link to the checkout — is fine); a hard-linked file
// is another name for an out-of-repo file and is refused; in git mode (the default; COWORK_HARNESS_GITSET=0 opts
// out) each file must be tracked.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";
import type { Scenario, ScenarioMetric } from "../types.js";
import { gitEnvWithoutAmbientRepo, gitModeEnabled, gitTrackedSet } from "../run/skill-files.js";

export const MAX_COMMAND_FILE_BYTES = 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface ResolvedCommand {
  /** The repo's real path. */
  root: string;
  inGit: boolean;
  /** Root-relative, `/`-joined. */
  scriptRel: string;
  depsRel: string[];
  /** sha256 over `relpath\0bytes\0` for the script, then each dep in declaration order. */
  scriptSha256: string;
}

const RESOLVED = Symbol.for("cowork-harness.metric.command-resolved");

/** The resolution attached to a command metric declaration, or undefined when it was never resolved (a scenario
 *  loaded leniently from a cassette, which never executes). A symbol-keyed property: it survives the object spreads
 *  the run path makes and is never serialized, so it cannot reach a cassette or a manifest. */
export function resolvedCommand(m: ScenarioMetric): ResolvedCommand | undefined {
  return (m as unknown as Record<symbol, ResolvedCommand | undefined>)[RESOLVED];
}

export function setResolvedCommand(m: ScenarioMetric, r: ResolvedCommand): void {
  Object.defineProperty(m, RESOLVED, { value: r, enumerable: true, writable: true, configurable: true });
}

function repoOf(scenarioPath: string): { root: string; inGit: boolean } {
  const dir = dirname(resolve(scenarioPath));
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", env: gitEnvWithoutAmbientRepo() });
  const inGit = top.status === 0 && top.stdout.trim() !== "";
  return { root: realpathSync.native(inGit ? top.stdout.trim() : dir), inGit };
}

const under = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** One file's checks; returns its root-relative path. Throws UsageError naming the metric and the file. */
function checkFile(
  repo: { root: string; inGit: boolean },
  tracked: Set<string> | null,
  scenarioPath: string,
  ref: string,
  what: string,
): { rel: string; real: string } {
  const lexical = resolve(dirname(resolve(scenarioPath)), ref);
  let real: string;
  try {
    real = realpathSync.native(lexical);
  } catch {
    throw new UsageError(`${what}: no such file (${lexical}); the path is relative to the scenario file`);
  }
  const where = repo.inGit ? "the scenario's repository" : "the scenario's directory";
  if (!under(repo.root, real))
    throw new UsageError(`${what}: outside ${where} (${repo.root}) — a command metric's files must live in the scenario's repo`);
  // Walk the LEXICAL path: a symlink whose own directory is inside the repo is refused (the realpath has already
  // resolved every link, so walking it would prove nothing). A symlink above the repo is fine.
  const parts = lexical.split(sep);
  for (let i = 2; i <= parts.length; i++) {
    const p = parts.slice(0, i).join(sep) || sep;
    let isLink = false;
    try {
      isLink = lstatSync(p).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue;
    let parentReal: string;
    try {
      parentReal = realpathSync.native(dirname(p));
    } catch {
      continue;
    }
    if (parentReal === repo.root || under(repo.root, parentReal))
      throw new UsageError(`${what}: ${p} is a symlink inside ${where} — a command metric's files must be named by their real paths`);
  }
  const st = statSync(real);
  if (!st.isFile()) throw new UsageError(`${what}: not a regular file`);
  if (st.nlink > 1) throw new UsageError(`${what}: hard-linked (another name for a file that may live outside the repo)`);
  if (st.size > MAX_COMMAND_FILE_BYTES) throw new UsageError(`${what}: larger than ${MAX_COMMAND_FILE_BYTES} bytes`);
  const rel = relative(repo.root, real).split(sep).join("/");
  if (tracked !== null && !tracked.has(rel) && ![...tracked].some((t) => t.normalize("NFC") === rel.normalize("NFC")))
    throw new UsageError(
      `${what}: not tracked by git (git mode is the default) — 'git add' it, or set COWORK_HARNESS_GITSET=0 to accept untracked files. A file inside a submodule is refused too.`,
    );
  return { rel, real };
}

/** The content hash of a command's files: sha256 over `relpath\0bytes\0`, script first, then deps in order. */
export function commandFilesSha256(files: ReadonlyArray<{ rel: string; bytes: Buffer }>): string {
  const h = createHash("sha256");
  for (const f of files) h.update(f.rel).update("\0").update(f.bytes).update("\0");
  return h.digest("hex");
}

/** Resolve every command metric of `scenario` (in place). Throws UsageError on the first violation. */
export function resolveCommandMetrics(scenario: Pick<Scenario, "metrics">, scenarioPath: string): void {
  const cmds = (scenario.metrics ?? []).filter((m) => m.command !== undefined);
  if (cmds.length === 0) return;
  const repo = repoOf(scenarioPath);
  const tracked = repo.inGit && gitModeEnabled() ? gitTrackedSet(repo.root) : null;
  for (const m of cmds) {
    const prefix = `invalid scenario ${scenarioPath}: metric "${m.id}"`;
    const script = checkFile(repo, tracked, scenarioPath, m.command![0], `${prefix} command script ${m.command![0]}`);
    const deps = (m.deps ?? []).map((d) => checkFile(repo, tracked, scenarioPath, d, `${prefix} dep ${d}`));
    const files = [script, ...deps].map((f) => ({ rel: f.rel, bytes: readFileSync(f.real) }));
    setResolvedCommand(m, {
      root: repo.root,
      inGit: repo.inGit,
      scriptRel: script.rel,
      depsRel: deps.map((d) => d.rel),
      scriptSha256: commandFilesSha256(files),
    });
  }
}

/** Where a resolved command's files are now, for a re-read at execution. */
export function commandFilePaths(r: ResolvedCommand): Array<{ rel: string; abs: string }> {
  return [r.scriptRel, ...r.depsRel].map((rel) => ({ rel, abs: join(r.root, ...rel.split("/")) }));
}

/** The absolute paths of every resolved command metric's script and deps in `metrics` — the files the answer-key
 *  guard keeps out of every mount, and the hillclimb gate hashes. A metric that was never resolved contributes none. */
export function commandMetricFiles(metrics: readonly ScenarioMetric[] | undefined): string[] {
  return (metrics ?? []).flatMap((m) => {
    const r = m.command !== undefined ? resolvedCommand(m) : undefined;
    return r ? commandFilePaths(r).map((f) => f.abs) : [];
  });
}
