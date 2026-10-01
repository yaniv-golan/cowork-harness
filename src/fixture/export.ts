// `fixture export`: copy a kept run's outputs tree into a directory a scenario can stage as its starting
// workspace. The fixture is test input that gets committed, so the export never alters a byte — a file that would
// leak a secret or tie the fixture to one machine is REFUSED by name, and the author fixes the source run instead.
//
// What it reads: the run's latest turn `result.json` → `outputsDir` (the session's outputs, cumulative across
// turns — there is no per-turn snapshot). Scratchpad deliverables at the session root are not exported.

import { lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { FsRefusal, NoFollowRoot, isSymlink, lstatOrNull } from "../hillclimb/fs.js";
import { isUnderRealRoot } from "../boundary-paths.js";
import { tildeify } from "../io.js";
import { hostPathTokens } from "../run/host-path-tokens.js";
import { requireTurns, turnArtifactPath } from "../run/turn-layout.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { VM_WORK_HOST } from "../runtime/lima.js";
import { scanText } from "../scan.js";
import type { RunResult } from "../types.js";

export interface ExportFinding {
  file: string;
  /** `secret`: a value from the secret set (never printed), in the file's bytes or its relative path. `host_path`:
   *  a host path. `run_path`: a path into a harness run dir, the runs root, the VM work dir or a guest session
   *  (`/sessions/<id>/mnt/…` or `/sessions/<id>/.claude/…`) — refused even with --allow-host-paths. */
  kind: "secret" | "host_path" | "run_path";
}

export interface ExportNote {
  file: string;
  /** `binary`: secret-checked byte-for-byte, but not scanned for paths or PII. `pii`: a non-gating finding of the
   *  scanner's class `cls`. */
  kind: "binary" | "pii";
  cls?: string;
  sample?: string;
}

export interface ExportSkip {
  file: string;
  why: "symlink" | "hard link" | "not a regular file" | "unreadable";
  /** For `unreadable`: the error or refusal that stopped the read. */
  reason?: string;
}

/** `written`, `skipped`, `notes` and `bytes` are present once the outputs tree was read — on success and on every
 *  refusal after that point — and absent on a refusal before it. */
export interface ExportOutcome {
  exitCode: 0 | 2;
  message: string;
  outputsDir?: string;
  written?: string[];
  skipped?: ExportSkip[];
  refused: ExportFinding[];
  notes?: ExportNote[];
  bytes?: number;
  /** The source run's `partial` flag (stopped at a gate), when the run's result.json was read. */
  partial?: boolean;
  /** The source run's final result, when the run's result.json was read; a result.json with none reads as `error`. */
  result?: "success" | "error";
}

/** The scanner classes reported as notes. `path` gates the export (its findings are unioned with the host-path
 *  tokens below, so a path either one sees is refused); `currency` is the ordinary content of the finance
 *  deliverables fixtures are made from, so reporting it would be noise. */
const NOTE_CLASSES = new Set(["email", "domain", "machine-inventory"]);

const refuse = (message: string, extra: Partial<ExportOutcome> = {}): ExportOutcome => ({
  exitCode: 2,
  message,
  refused: [],
  ...extra,
});

/** Text when it holds no NUL in its first 8 KiB. Decoded as UTF-8 when that is lossless, else as Latin-1 (a
 *  legacy-encoded CSV is still text, and every path root is ASCII). */
function asText(buf: Buffer): string | null {
  if (buf.subarray(0, 8192).includes(0)) return null;
  const utf8 = buf.toString("utf8");
  return Buffer.from(utf8, "utf8").equals(buf) ? utf8 : buf.toString("latin1");
}

/** Every host path in `text`: the union of the host-path tokens and the scanner's `path` class, which each see
 *  delimiters and roots the other does not (`,/Users/…`, `|/home/…`, `/System/Volumes/…`). `/opt/cowork/` is a
 *  guest-only path — the microvm tier mounts the agent there — so, as in the scanner (see its `path` class), it
 *  is not a host path. */
function hostPaths(text: string): string[] {
  const tokens = hostPathTokens(text).filter((t) => !t.startsWith("/opt/cowork/"));
  return [...tokens, ...scanText(text, "", []).flatMap((f) => (f.cls === "path" ? [f.sample] : []))];
}

/** Every spelling a path into a run can take: as given, its realpath, the macOS aliases of that realpath
 *  (`/var/folders/…` for `/private/var/folders/…`, and the `/System/Volumes/Data` firmlink form), and the `~/`
 *  form of each. */
function spellings(p: string): string[] {
  const abs = resolve(p);
  const out = [abs];
  let real: string | undefined;
  try {
    real = realpathSync.native(abs);
  } catch {
    /* absent: the given spelling is the only one */
  }
  if (real !== undefined) {
    out.push(real, `/System/Volumes/Data${real}`);
    if (real.startsWith("/private/")) {
      const alias = real.slice("/private".length);
      try {
        if (realpathSync.native(alias) === real) out.push(alias);
      } catch {
        /* no such alias on this machine */
      }
    }
  }
  for (const s of [...out]) out.push(tildeify(s));
  return [...new Set(out)];
}

/** A guest session path: `/sessions/<id>/` followed by `mnt` or `.claude` (the VM session layout), bounded on both
 *  sides as in `namesRunPath`, so an API route (`GET /sessions/{id}`) or a URL path is not one. */
const GUEST_SESSION = /\/sessions\/[A-Za-z0-9._~-]+\/(?:mnt|\.claude)(?![A-Za-z0-9._~-])/g;
function namesGuestSession(text: string): boolean {
  for (const m of text.matchAll(GUEST_SESSION)) {
    const before = text[m.index - 1];
    if (before === undefined || !/[A-Za-z0-9._~-]/.test(before)) return true;
  }
  return false;
}

/** True when `text` names a path under one of `roots` — matched as a substring, so independently of where a
 *  host-path token would start or stop, but bounded: the character before a root does not continue a name or a
 *  URL path (`https://x/api/sessions/1` is not a guest path), nor does the one after it (`runs-old` is not
 *  `runs`). */
function namesRunPath(text: string, roots: readonly string[]): boolean {
  const nameChar = /[A-Za-z0-9._~-]/;
  for (const root of roots) {
    for (let i = text.indexOf(root); i !== -1; i = text.indexOf(root, i + 1)) {
      const before = text[i - 1];
      const after = text[i + root.length];
      if (before !== undefined && nameChar.test(before)) continue;
      if (!root.endsWith("/") && after !== undefined && (nameChar.test(after) || after === "@")) continue;
      return true;
    }
  }
  return false;
}

/** The two places a run keeps its outputs, as path tails under the run dir: `work/session/mnt/outputs`
 *  (container, microvm, hostloop) and `work/outputs` (protocol). */
const OUTPUTS_TAILS: readonly string[][] = [
  ["work", "session", "mnt", "outputs"],
  ["work", "outputs"],
];

export function exportFixture(opts: { runDir: string; out: string; allowHostPaths: boolean; secrets: readonly string[] }): ExportOutcome {
  const cmd = "fixture export";
  let turns: number[];
  try {
    turns = requireTurns(opts.runDir, cmd);
  } catch (e) {
    return refuse((e as Error).message);
  }
  if (turns.length === 0) return refuse(`${cmd}: ${opts.runDir} has no turns/`);
  // The latest turn that wrote a result.json: a turn still in progress (or killed) has none yet.
  const turn = [...turns].reverse().find((t) => lstatOrNull(turnArtifactPath(opts.runDir, t, "result.json")) !== null);
  if (turn === undefined) return refuse(`${cmd}: no turn of ${opts.runDir} has a result.json`);
  const resultPath = turnArtifactPath(opts.runDir, turn, "result.json");
  let result: RunResult;
  try {
    result = JSON.parse(NoFollowRoot.existing(opts.runDir).readFile(resultPath)) as RunResult;
  } catch (e) {
    return refuse(`${cmd}: cannot read ${resultPath}: ${(e as Error).message}`);
  }
  if (result.command === "replay")
    return refuse(
      `${cmd}: ${opts.runDir} is a \`replay\` run — its outputs were materialized from a cassette, not produced by a run; export the original live run dir`,
    );
  const source = { partial: result.partial === true, result: result.result === "success" ? ("success" as const) : ("error" as const) };
  const recorded = result.outputsDir;
  if (typeof recorded !== "string" || recorded === "") return refuse(`${cmd}: ${resultPath} records no outputsDir`, source);
  const runReal = realpathSync.native(opts.runDir);
  const shapes = OUTPUTS_TAILS.map((t) => join(runReal, ...t));
  // The outputs are always read from the given run dir's OWN tree, never from the recorded path: a run dir moved or
  // copied since it ran records an outputs dir under its old location (which, for a copy, still exists and is a
  // different run's). The recorded path picks WHICH of the two shapes, by its tail; result.json is a plain file
  // anyone can edit, so a recorded path that is neither shape is refused.
  const recordedParts = resolve(recorded).split("/");
  const tailIdx = OUTPUTS_TAILS.findIndex((t) => recordedParts.slice(-t.length).join("/") === t.join("/"));
  if (tailIdx === -1)
    return refuse(
      `${cmd}: ${resultPath} names ${recorded}, which is not this run's outputs dir (expected work/session/mnt/outputs or work/outputs under the run dir); refusing to export it`,
      source,
    );
  const named = shapes[tailIdx]!;
  const outputsDir = lstatOrNull(named) !== null ? named : shapes.find((s) => lstatOrNull(s) !== null);
  if (outputsDir === undefined)
    return refuse(`${cmd}: ${opts.runDir} has no outputs dir of its own (work/session/mnt/outputs or work/outputs; a pruned run?)`, source);
  if (isSymlink(outputsDir) || !lstatSync(outputsDir).isDirectory())
    return refuse(`${cmd}: the run's outputs dir ${outputsDir} is not a plain directory`, { outputsDir, ...source });
  // --out inside the run dir would write into the kept run it is reading from.
  let anchor = resolve(opts.out);
  while (lstatOrNull(anchor) === null && dirname(anchor) !== anchor) anchor = dirname(anchor);
  if (isUnderRealRoot(runReal, realpathSync.native(anchor)))
    return refuse(`${cmd}: --out ${opts.out} is inside the run dir; exporting there would alter the kept run`, {
      outputsDir,
      ...source,
    });

  const src = NoFollowRoot.existing(outputsDir);
  const files: Array<{ rel: string; data: Buffer; mode: number }> = [];
  const skipped: ExportSkip[] = [];
  const unreadable = (rel: string, e: unknown): void => {
    if (e instanceof FsRefusal || typeof (e as NodeJS.ErrnoException)?.code === "string")
      skipped.push({ file: rel, why: "unreadable", reason: (e as Error).message });
    else throw e;
  };
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = src.readdirNoFollow(dir);
    } catch (e) {
      return unreadable(relative(src.root, dir), e);
    }
    for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, d.name);
      const rel = relative(src.root, abs);
      if (d.isSymbolicLink()) skipped.push({ file: rel, why: "symlink" });
      else if (d.isDirectory()) walk(abs);
      else if (!d.isFile()) skipped.push({ file: rel, why: "not a regular file" });
      else {
        // The tree can change under the walk: a file gone, swapped for a link or made unreadable is listed, not fatal.
        try {
          const st = lstatOrNull(abs);
          if (st === null || !st.isFile()) skipped.push({ file: rel, why: "not a regular file" });
          else if (st.nlink > 1) skipped.push({ file: rel, why: "hard link" });
          else files.push({ rel, data: src.readBytes(abs), mode: st.mode & 0o777 });
        } catch (e) {
          unreadable(rel, e);
        }
      }
    }
  };
  walk(src.root);
  if (files.length === 0)
    return refuse(`${cmd}: ${outputsDir} holds no regular files — nothing for a later step to resume from`, {
      outputsDir,
      written: [],
      skipped,
      notes: [],
      bytes: 0,
      ...source,
    });

  // Each secret in every encoding that stores it verbatim: UTF-8, Latin-1 (when the value fits it; for an ASCII value
  // it is the UTF-8 bytes), UTF-16LE and UTF-16BE.
  const secrets = opts.secrets
    .filter((s) => s.length > 0)
    .map((s) => ({
      s,
      forms: [
        Buffer.from(s),
        ...(/^[\u0000-\u00ff]*$/.test(s) ? [Buffer.from(s, "latin1")] : []),
        Buffer.from(s, "utf16le"),
        Buffer.from(s, "utf16le").swap16(),
      ],
    }));
  const runRoots = [...spellings(opts.runDir), ...spellings(runsWriteRoot()), ...spellings(VM_WORK_HOST)];
  const underRunRoot = (t: string): boolean => runRoots.some((r) => t === r || t.startsWith(`${r}/`));
  const refused: ExportFinding[] = [];
  const notes: ExportNote[] = [];
  for (const f of files) {
    // Every file's raw bytes and its name, before any text/binary split: a secret is a secret in any encoding
    // that carries it verbatim. Compressed formats (xlsx, docx, pdf, images) hide it and are not inspected.
    if (secrets.some(({ s, forms }) => f.rel.includes(s) || forms.some((b) => f.data.includes(b)))) {
      refused.push({ file: f.rel, kind: "secret" });
      continue;
    }
    const text = asText(f.data);
    const scanned = text === null ? f.rel : `${f.rel}\n${text}`;
    const paths = hostPaths(scanned);
    if (namesRunPath(scanned, runRoots) || namesGuestSession(scanned) || paths.some(underRunRoot))
      refused.push({ file: f.rel, kind: "run_path" });
    else if (paths.length && !opts.allowHostPaths) refused.push({ file: f.rel, kind: "host_path" });
    if (text === null) {
      notes.push({ file: f.rel, kind: "binary" });
      continue;
    }
    for (const s of scanText(text, f.rel, []))
      if (NOTE_CLASSES.has(s.cls)) notes.push({ file: f.rel, kind: "pii", cls: s.cls, sample: s.sample });
  }
  const bytes = files.reduce((n, f) => n + f.data.length, 0);
  const scannedPayload = { outputsDir, written: [], skipped, notes, bytes, ...source };
  if (refused.length)
    return refuse(
      `${cmd}: refused — ${refused.length} file(s) would carry a secret or a machine-specific path into a committed fixture: ` +
        refused.map((r) => `${r.file} (${r.kind})`).join(", ") +
        `. The export never alters bytes; fix the source run${refused.some((r) => r.kind === "host_path") ? " or pass --allow-host-paths" : ""}.`,
      { ...scannedPayload, refused },
    );

  // --out: absent, or an existing EMPTY plain directory. Never merges.
  const outSt = lstatOrNull(opts.out);
  if (outSt !== null) {
    if (outSt.isSymbolicLink() || !outSt.isDirectory())
      return refuse(`${cmd}: --out ${opts.out} exists and is not a plain directory`, scannedPayload);
    if (readdirSync(opts.out).length > 0)
      return refuse(`${cmd}: --out ${opts.out} is not empty; a fixture export never merges`, scannedPayload);
  }
  // Everything this export creates, so a failure removes exactly that and nothing that was already there.
  const createdDirs: string[] = [];
  for (let d = resolve(opts.out); lstatOrNull(d) === null && dirname(d) !== d; d = dirname(d)) createdDirs.unshift(d);
  const createdFiles: string[] = [];
  try {
    const dst = NoFollowRoot.open(opts.out);
    for (const f of files) {
      const target = join(dst.root, f.rel);
      // Record every level BEFORE creating it, so a mkdir that fails partway still removes the levels it made.
      for (let d = dirname(target); d !== dst.root && lstatOrNull(d) === null; d = dirname(d)) createdDirs.push(d);
      createdDirs.sort((a, b) => a.length - b.length);
      dst.mkdir(dirname(target));
      dst.createFile(target, f.data, f.mode);
      createdFiles.push(target);
    }
  } catch (e) {
    // Never leave a half-written fixture behind. Directories go with a NON-recursive rmdir, deepest first: one
    // that holds anything this export did not put there stays.
    for (const f of createdFiles) rmSync(f, { force: true });
    for (const d of [...createdDirs].reverse())
      try {
        rmdirSync(d);
      } catch {
        /* not empty or already gone: not ours to remove */
      }
    if (e instanceof FsRefusal || typeof (e as NodeJS.ErrnoException)?.code === "string")
      return refuse(`${cmd}: ${(e as Error).message}`, scannedPayload);
    throw e;
  }
  return {
    exitCode: 0,
    message: `${cmd}: wrote ${files.length} file(s), ${bytes} bytes, to ${opts.out}`,
    outputsDir,
    written: files.map((f) => f.rel),
    skipped,
    refused: [],
    notes,
    bytes,
    ...source,
  };
}
