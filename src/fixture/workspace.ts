// `workspace_fixture: <dir>`: a saved outputs tree staged into a FRESH session's `outputs/` before turn 1, so a
// scenario can test one late step of a long skill pipeline without paying for the steps before it.
//
// Fidelity: a fixture run equals re-invoking the skill in the SAME Cowork session after it stopped mid-work or
// finished — the files persist in `outputs/` and the skill resumes from them. The only difference is that in Cowork
// the prior conversation context also persists, while a fixture run starts with a fresh context. The copy mirrors
// what a Cowork session keeps in outputs: regular files only, permission bits kept, fresh mtimes, nothing injected
// into the prompt (the model is never told which files exist).
//
// One module owns the file set: the scan (refusals + per-file digests), the staging copy, the staleness signature
// recorded in a cassette, and the listing the hillclimb gate digest reads. They share ONE walk and ONE filter, so
// the staged set, the hashed set and the listed set cannot disagree.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, type Dirent, type Stats } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { UsageError } from "../errors.js";
import { FsRefusal, NoFollowRoot, lstatOrNull } from "../hillclimb/fs.js";
import { gitModeEnabled, gitTrackedSet, GITSET_ENV } from "../run/skill-files.js";
import { OS_JUNK_PATTERN } from "../run/skill-hash.js";
import { preRunHashCap } from "../run/pre-run-manifest.js";
import { listTurns, turnArtifactPath } from "../run/turn-layout.js";
import type { Assertion, Fingerprint, Scenario } from "../types.js";

/** The env var overriding the fixture size cap (bytes, a whole number >= 1). */
export const WORKSPACE_FIXTURE_MAX_BYTES_ENV = "COWORK_HARNESS_WORKSPACE_FIXTURE_MAX_BYTES";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** One staged file. `path` is fixture-relative (POSIX), so it lands at `outputs/<path>`. */
export interface WorkspaceFixtureFile {
  path: string;
  sha256: string;
  /** The owner-executable bit — the only permission bit the signature carries (git's rule): a umask difference
   *  between two checkouts is not drift. The full mode is still kept on the staged copy. */
  exec: boolean;
  /** Permission bits (`mode & 0o777`) the staged copy is created with. */
  mode: number;
  bytes: number;
}

export interface ScannedWorkspaceFixture {
  /** The fixture directory, absolute. */
  dir: string;
  /** Sorted by `path` (code-point order). */
  files: WorkspaceFixtureFile[];
  /** sha256 over the sorted `(path, sha256, exec)` triples — `Fingerprint.workspaceFixtureSig`. */
  sig: string;
  /** Per-file `[path, sig]` pairs, so a drift finding names the file. */
  fileSigs: Array<[string, string]>;
  bytes: number;
}

/** The cap, from the env or the default. A malformed value is refused rather than defaulted: a silently ignored
 *  override reads later as an unexplained refusal. */
export function workspaceFixtureMaxBytes(): number {
  const raw = process.env[WORKSPACE_FIXTURE_MAX_BYTES_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError(`${WORKSPACE_FIXTURE_MAX_BYTES_ENV} must be a whole number of bytes >= 1 (got ${JSON.stringify(raw)})`);
  return n;
}

/** Agent and configuration files, not deliverables: a fixture is staged into the agent's working tree, where these
 *  names configure the agent itself (settings, MCP servers, memory) rather than being read as the skill's output.
 *  Matched case-insensitively on any path segment (`.claude`, `.git`) or file name. */
const CONTROL_SEGMENTS = new Set([".claude", ".git"]);
const CONTROL_FILES = new Set([".mcp.json", "claude.md", "claude.local.md"]);

function controlPathReason(rel: string): string | undefined {
  const parts = rel.split("/");
  const seg = parts.find((p) => CONTROL_SEGMENTS.has(p.toLowerCase()));
  if (seg !== undefined) return `${seg} is agent configuration, not a deliverable`;
  const leaf = parts[parts.length - 1]!.toLowerCase();
  if (CONTROL_FILES.has(leaf)) return `${parts[parts.length - 1]} is agent configuration, not a deliverable`;
  return undefined;
}

/** The per-file signature value: the content digest, plus `+x` when the owner-executable bit is set. */
function fileSig(f: Pick<WorkspaceFixtureFile, "sha256" | "exec">): string {
  return f.exec ? `${f.sha256}+x` : f.sha256;
}

/** The aggregate signature over a file list, independent of the list's order. NUL-framed so `a` + `b\0c` cannot
 *  collide with `a\0b` + `c`. */
export function workspaceFixtureSig(files: ReadonlyArray<Pick<WorkspaceFixtureFile, "path" | "sha256" | "exec">>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    h.update(`F:${f.path}\0${f.sha256}\0${f.exec ? "x" : "-"}\0`);
  return h.digest("hex");
}

const describe = (rel: string) => JSON.stringify(rel);

/**
 * Walk and validate a fixture directory, read nothing outside it, and return its file set with digests. Throws a
 * `UsageError` (exit 2, before any spawn) naming every problem found:
 *  - the directory is missing or not a directory, or holds no file to stage;
 *  - a symlink anywhere (a fixture is authored test data — a link in it is a mistake or a leak);
 *  - a file with a second hard link, or anything that is not a regular file or directory;
 *  - an agent/configuration path (`.claude/`, `.git/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`);
 *  - in git mode (the default; `COWORK_HARNESS_GITSET=0` opts out), a file git does not track — the same boundary
 *    a skill source is staged and hashed under, so what the cassette's signature covers is what is committed;
 *  - a total size over the cap (`COWORK_HARNESS_WORKSPACE_FIXTURE_MAX_BYTES`, default 64 MiB), checked as the walk
 *    goes, so a mis-pointed fixture (a home directory) fails fast.
 * OS metadata files (`.DS_Store`, `Thumbs.db`, …) are skipped, never staged or hashed.
 */
export function scanWorkspaceFixture(dir: string): ScannedWorkspaceFixture {
  const what = `workspace_fixture ${dir}`;
  const st = lstatOrNull(dir);
  if (st === null) throw new UsageError(`${what}: no such directory`);
  if (st.isSymbolicLink()) throw new UsageError(`${what}: is a symlink — point workspace_fixture at the directory itself`);
  if (!st.isDirectory()) throw new UsageError(`${what}: not a directory`);
  let root: NoFollowRoot;
  try {
    root = NoFollowRoot.existing(dir);
  } catch (e) {
    if (e instanceof FsRefusal) throw new UsageError(`${what}: ${e.message}`);
    throw e;
  }
  const cap = workspaceFixtureMaxBytes();
  const hashCap = preRunHashCap();
  const tracked = gitModeEnabled() ? gitTrackedSet(root.root) : null;

  const problems: string[] = [];
  const found: Array<{ rel: string; abs: string; st: Stats }> = [];
  let total = 0;
  let overCap = false;
  const walk = (absDir: string): void => {
    if (overCap) return;
    let entries: Dirent[];
    try {
      entries = root.readdirNoFollow(absDir);
    } catch (e) {
      problems.push(`${describe(relative(root.root, absDir) || ".")}: cannot be listed (${(e as Error).message})`);
      return;
    }
    for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (overCap) return;
      const abs = join(absDir, d.name);
      const rel = relative(root.root, abs).split("\\").join("/");
      if (OS_JUNK_PATTERN.test(rel)) continue;
      if (d.isSymbolicLink()) {
        problems.push(`${describe(rel)} is a symlink (a fixture holds regular files only)`);
        continue;
      }
      const control = controlPathReason(rel);
      if (control !== undefined) {
        problems.push(`${describe(rel)}: ${control}`);
        continue;
      }
      if (d.isDirectory()) {
        walk(abs);
        continue;
      }
      let fst: Stats;
      try {
        fst = lstatSync(abs);
      } catch (e) {
        problems.push(`${describe(rel)}: cannot be read (${(e as Error).message})`);
        continue;
      }
      if (!fst.isFile()) {
        problems.push(`${describe(rel)} is not a regular file`);
        continue;
      }
      if (fst.nlink > 1) {
        problems.push(`${describe(rel)} has a second hard link (another name for the same file) — replace it with a plain copy`);
        continue;
      }
      if (tracked !== null && !tracked.has(rel)) {
        problems.push(
          `${describe(rel)} is not tracked by git — only tracked files are staged and hashed ('git add' it, or ${GITSET_ENV}=0 to include untracked files)`,
        );
        continue;
      }
      // A file the pre-run manifest cannot hash has no decidable authorship: `authored: true` on it could only
      // ever be evidence-unavailable, and `artifacts[].preRun` could never mark it. Refuse it here rather than
      // stage a file the rest of the feature cannot reason about.
      if (fst.size > hashCap) {
        problems.push(
          `${describe(rel)} is ${fst.size} bytes, over the pre-run hash cap (${hashCap}; COWORK_HARNESS_PRERUN_HASH_CAP raises it) — its authorship could never be decided`,
        );
        continue;
      }
      total += fst.size;
      if (total > cap) {
        overCap = true;
        problems.push(
          `the fixture is larger than ${cap} bytes (the cap; ${WORKSPACE_FIXTURE_MAX_BYTES_ENV} raises it) — is workspace_fixture pointed at the right directory?`,
        );
        return;
      }
      found.push({ rel, abs, st: fst });
    }
  };
  walk(root.root);
  if (problems.length)
    throw new UsageError(`${what}: refused — ${problems.length} problem(s): ${problems.join("; ")}`, problems.join("\n"));
  if (found.length === 0)
    throw new UsageError(`${what}: holds no file to stage — an empty fixture tests nothing (OS metadata files are skipped)`);

  const files: WorkspaceFixtureFile[] = [];
  for (const f of found) {
    let bytes: Buffer;
    try {
      bytes = root.readBytes(f.abs);
    } catch (e) {
      if (e instanceof FsRefusal || typeof (e as NodeJS.ErrnoException)?.code === "string")
        throw new UsageError(`${what}: ${describe(f.rel)} cannot be read (${(e as Error).message})`);
      throw e;
    }
    files.push({
      path: f.rel,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      exec: (f.st.mode & 0o100) !== 0,
      mode: f.st.mode & 0o777,
      bytes: bytes.length,
    });
  }
  return {
    dir: root.root,
    files,
    sig: workspaceFixtureSig(files),
    fileSigs: files.map((f) => [f.path, fileSig(f)]),
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  };
}

/** The fixture a scenario declares, scanned — or `null` when it declares none. `workspace_fixture` is the
 *  absolute directory a loaded scenario carries (the loader resolves it against the scenario file). This is the
 *  listing a harness-gate digest reads: `files` is exactly what a run stages into `outputs/`, and `sig` is the
 *  value recorded as `Fingerprint.workspaceFixtureSig`. Throws the same `UsageError` the run would refuse with. */
export function scenarioWorkspaceFixture(
  scenario: Pick<Scenario, "workspace_fixture">,
): { dir: string; files: Array<{ path: string; sha256: string; exec: boolean; bytes: number }>; sig: string } | null {
  if (scenario.workspace_fixture === undefined) return null;
  const s = scanWorkspaceFixture(scenario.workspace_fixture);
  return { dir: s.dir, files: s.files.map(({ path, sha256, exec, bytes }) => ({ path, sha256, exec, bytes })), sig: s.sig };
}

/**
 * Copy a scanned fixture into a FRESH session's outputs dir: regular files only, permission bits kept, fresh
 * mtimes, never overwriting. Refuses an outputs dir that already holds anything (a stale tree the fixture would
 * merge over), and re-verifies each file's digest against the scan, so what is staged is exactly what the
 * signature describes — a fixture edited between load and staging is refused, not half-staged.
 */
export function stageWorkspaceFixture(scan: ScannedWorkspaceFixture, outputsDir: string): void {
  const present = readdirSync(outputsDir);
  if (present.length > 0)
    throw new Error(
      `cowork-harness: cannot stage workspace_fixture ${scan.dir}: the session's outputs dir ${outputsDir} is not empty ` +
        `(${present.slice(0, 5).join(", ")}${present.length > 5 ? ", …" : ""}) — a fixture is staged only into a fresh session`,
    );
  const src = NoFollowRoot.existing(scan.dir);
  const dst = NoFollowRoot.existing(outputsDir);
  for (const f of scan.files) {
    const bytes = src.readBytes(join(src.root, ...f.path.split("/")));
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== f.sha256)
      throw new UsageError(
        `workspace_fixture ${scan.dir}: ${describe(f.path)} changed between the scan and staging — re-run once the fixture is stable`,
      );
    const target = join(dst.root, ...f.path.split("/"));
    dst.mkdir(dirname(target));
    dst.createFile(target, bytes, f.mode);
  }
}

/** The path a presence/body assertion names, whichever form it was authored in: the string form, `{path}` for
 *  `file_exists` / `user_visible_artifact`, `{artifact}` for `artifact_text` / `artifact_json` (whose own `path` is
 *  a JSON path, not a file). */
export function assertedArtifactPath(key: (typeof PRESENCE_KEYS)[number], v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const p = key === "artifact_text" || key === "artifact_json" ? o.artifact : o.path;
    if (typeof p === "string") return p;
  }
  return undefined;
}

/** The `authored` value an assertion states, or undefined when it states none (the string form never does). */
export function assertedAuthored(v: unknown): boolean | undefined {
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).authored === "boolean")
    return (v as Record<string, unknown>).authored as boolean;
  return undefined;
}

/** The four keys whose pass proves presence or a body, not authorship. */
export const PRESENCE_KEYS = ["file_exists", "user_visible_artifact", "artifact_text", "artifact_json"] as const;

/** Normalize a workRoot-relative assertion path for comparison with `outputs/<fixture path>`: separators,
 *  `./`, `a/../`, a trailing `/`, and CASE. Case is folded on every platform: a case-insensitive filesystem
 *  (macOS APFS, the default) resolves `outputs/REPORT.md` to the fixture's `report.md`, so comparing exactly
 *  would let it pass on the fixture alone there; folding everywhere keeps the verdict platform-independent
 *  (a deliberately different-case new file on a case-sensitive filesystem is over-refused, and stating
 *  `authored:` resolves that). */
function normRel(p: string): string {
  return posix.normalize(p.split("\\").join("/")).replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

/** Every path a presence assertion could name and pass on the fixture alone: each staged file, and each
 *  directory above one (`outputs/scores`, `outputs`) — `file_exists` passes on a directory. Case-folded. */
function vacuousTargets(files: ReadonlyArray<{ path: string }>): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const parts = `outputs/${f.path}`.toLowerCase().split("/");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

/**
 * Refuse, before any spend, a presence/body assertion (`file_exists`, `user_visible_artifact`, `artifact_text`,
 * `artifact_json`) whose path is a file the fixture provides — or a directory holding one — unless it states
 * `authored:`. Such an assertion passes on the fixture alone, before the step under test does anything, so it
 * verifies nothing. `authored: true` makes it require that THIS run wrote the file; `authored: false` says
 * inheriting it is fine. Returns the refusal text, or undefined.
 */
export function workspaceFixtureAssertRefusal(
  scenario: Pick<Scenario, "name" | "assert">,
  files: ReadonlyArray<{ path: string }>,
): string | undefined {
  const targets = vacuousTargets(files);
  const hits: Array<{ key: string; path: string }> = [];
  for (const a of scenario.assert as Assertion[]) {
    for (const key of PRESENCE_KEYS) {
      const v = (a as Record<string, unknown>)[key];
      if (v === undefined) continue;
      const p = assertedArtifactPath(key, v);
      if (p === undefined || assertedAuthored(v) !== undefined) continue;
      if (targets.has(normRel(p))) hits.push({ key, path: p });
    }
  }
  if (!hits.length) return undefined;
  return (
    `scenario "${scenario.name}": ${hits.length} assertion(s) name a file (or a directory) the workspace_fixture already provides, so they pass on the fixture alone ` +
    `before the step under test does anything: ${hits.map((h) => `${h.key} ${h.path}`).join(", ")}. State what you mean: \`authored: true\` ` +
    `(this run must write it — e.g. \`file_exists: {path: ${hits[0]!.path}, authored: true}\`; it applies to a file, not a directory), \`authored: false\` (inheriting it is fine), ` +
    `or assert on a file the step writes.`
  );
}

/**
 * The same refusal, against a fixture file list a run or cassette RECORDED (`fingerprint.workspaceFixtureFileSigs`)
 * rather than a fresh scan — for the paths that check an assertion after the fact: `verify-run`, a `--resume`
 * turn, `replay --assert-from`. When the list is missing, or the record redaction policy rewrote a fixture path
 * (so the real names are unknown), the check cannot run: an unannotated presence/body assertion under
 * `outputs/` is then refused as cannot-be-checked rather than allowed to pass. Undefined when the scenario
 * declares no fixture, or nothing is refused.
 */
export function recordedFixtureRefusal(
  scenario: Pick<Scenario, "name" | "assert"> & { workspace_fixture?: string },
  fileSigs: ReadonlyArray<readonly [string, string]> | undefined,
): string | undefined {
  if (scenario.workspace_fixture === undefined) return undefined;
  const known = fileSigs !== undefined && !fileSigs.some(([p]) => p.includes("[REDACTED"));
  if (known)
    return workspaceFixtureAssertRefusal(
      scenario,
      fileSigs.map(([path]) => ({ path })),
    );
  const unannotated: string[] = [];
  for (const a of scenario.assert as Assertion[])
    for (const key of PRESENCE_KEYS) {
      const v = (a as Record<string, unknown>)[key];
      if (v === undefined || assertedAuthored(v) !== undefined) continue;
      const p = assertedArtifactPath(key, v);
      if (p !== undefined && (normRel(p) === "outputs" || normRel(p).startsWith("outputs/"))) unannotated.push(`${key} ${p}`);
    }
  if (!unannotated.length) return undefined;
  return (
    `scenario "${scenario.name}": ${unannotated.join(", ")} cannot be checked against the workspace_fixture — ` +
    `${fileSigs === undefined ? "no record of the files it staged was found" : "the record redaction policy rewrote a fixture file name"}, ` +
    `so it may pass on the fixture alone. State \`authored: true\` or \`authored: false\` on it.`
  );
}

/** A run's fingerprint with the staged fixture's signature added — taken from the SCAN that staging verified
 *  byte-for-byte, so it describes exactly what this run started from (the fixture dir may change later). */
export function withWorkspaceFixtureSig(fp: Fingerprint, scan: ScannedWorkspaceFixture | undefined): Fingerprint {
  if (scan === undefined) return fp;
  return { ...fp, workspaceFixtureSig: scan.sig, workspaceFixtureFileSigs: scan.fileSigs };
}

/** The `workspace_fixture` ref exactly as the scenario FILE wrote it (relative to that file), kept beside the
 *  resolved absolute path the loader stores in `scenario.workspace_fixture`. A symbol-keyed property: it
 *  survives an object spread (every scenario copy in the run path) and is never serialized, so it cannot
 *  reach a cassette. Undefined for a scenario not loaded from a file. */
const AS_WRITTEN = Symbol.for("cowork-harness.workspace_fixture.as-written");
export function setWorkspaceFixtureAsWritten<T extends object>(scenario: T, ref: string): T {
  Object.defineProperty(scenario, AS_WRITTEN, { value: ref, enumerable: true, writable: true, configurable: true });
  return scenario;
}
export function workspaceFixtureAsWritten(scenario: object): string | undefined {
  const v = (scenario as Record<symbol, unknown>)[AS_WRITTEN];
  return typeof v === "string" ? v : undefined;
}

/** The fixture file list a kept run recorded: the first turn's `result.json` whose fingerprint carries
 *  `workspaceFixtureFileSigs` (turn 1 staged the fixture; a `--resume` turn stages nothing, so its own
 *  fingerprint has none). Undefined when no turn recorded one, or the run dir is unreadable. */
export function recordedFixtureFileSigs(runDir: string): Array<[string, string]> | undefined {
  let turns: number[];
  try {
    turns = listTurns(runDir);
  } catch {
    return undefined;
  }
  for (const t of turns) {
    try {
      const r = JSON.parse(readFileSync(turnArtifactPath(runDir, t, "result.json"), "utf8")) as {
        fingerprint?: { workspaceFixtureFileSigs?: unknown };
      };
      const sigs = r.fingerprint?.workspaceFixtureFileSigs;
      if (Array.isArray(sigs)) return sigs as Array<[string, string]>;
    } catch {
      /* a turn with no (readable) result.json: try the next */
    }
  }
  return undefined;
}
