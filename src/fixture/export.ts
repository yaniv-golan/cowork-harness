// `fixture export`: copy a kept run's outputs tree into a directory a scenario can stage as its starting
// workspace. The fixture is test input that gets committed, so the export never alters a byte — a file that would
// leak a secret or tie the fixture to one machine is REFUSED by name, and the author fixes the source run instead.
//
// What it reads: the run's latest turn `result.json` → `outputsDir` (the session's outputs, cumulative across
// turns — there is no per-turn snapshot). Scratchpad deliverables at the session root are not exported.

import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { FsRefusal, NoFollowRoot, isSymlink, lstatOrNull } from "../hillclimb/fs.js";
import { isUnderRealRoot } from "../boundary-paths.js";
import { hostPathTokens } from "../run/host-path-tokens.js";
import { latestTurn, requireTurns, turnArtifactPath } from "../run/turn-layout.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { VM_WORK_HOST } from "../runtime/lima.js";
import { scanText } from "../scan.js";
import type { RunResult } from "../types.js";

export interface ExportFinding {
  file: string;
  /** `secret`: a value from the secret set (never printed). `host_path`: a host path. `run_path`: a path into a
   *  harness run or VM work dir (refused even with --allow-host-paths). */
  kind: "secret" | "host_path" | "run_path";
}

export interface ExportNote {
  file: string;
  /** `binary`: not scanned for secrets or paths. `pii`: a non-gating finding of the scanner's class `cls`. */
  kind: "binary" | "pii";
  cls?: string;
  sample?: string;
}

export interface ExportOutcome {
  exitCode: 0 | 2;
  message: string;
  outputsDir?: string;
  written: string[];
  skipped: Array<{ file: string; why: "symlink" | "hard link" | "not a regular file" }>;
  refused: ExportFinding[];
  notes: ExportNote[];
  bytes: number;
}

/** The scanner classes reported as notes. `path` is covered (and gated) by the host-path check; `currency` is the
 *  ordinary content of the finance deliverables fixtures are made from, so reporting it would be noise. */
const NOTE_CLASSES = new Set(["email", "domain", "machine-inventory"]);

const refuse = (message: string, extra: Partial<ExportOutcome> = {}): ExportOutcome => ({
  exitCode: 2,
  message,
  written: [],
  skipped: [],
  refused: [],
  notes: [],
  bytes: 0,
  ...extra,
});

/** Text when it holds no NUL in its first 8 KiB and decodes as UTF-8 without loss. */
function isText(buf: Buffer): boolean {
  if (buf.subarray(0, 8192).includes(0)) return false;
  return Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
}

export function exportFixture(opts: { runDir: string; out: string; allowHostPaths: boolean; secrets: readonly string[] }): ExportOutcome {
  const cmd = "fixture export";
  let turns: number[];
  try {
    turns = requireTurns(opts.runDir, cmd);
  } catch (e) {
    return refuse((e as Error).message);
  }
  if (turns.length === 0) return refuse(`${cmd}: ${opts.runDir} has no turns/`);
  const resultPath = turnArtifactPath(opts.runDir, latestTurn(opts.runDir)!, "result.json");
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
  const outputsDir = result.outputsDir;
  if (typeof outputsDir !== "string" || outputsDir === "") return refuse(`${cmd}: ${resultPath} records no outputsDir`);
  if (!existsSync(outputsDir) || isSymlink(outputsDir) || !lstatSync(outputsDir).isDirectory())
    return refuse(`${cmd}: the run's outputs dir ${outputsDir} is gone or not a plain directory (a pruned run?)`);
  // result.json is a plain file anyone can edit: the outputs it names must belong to THIS run.
  if (!isUnderRealRoot(realpathSync.native(opts.runDir), realpathSync.native(outputsDir)))
    return refuse(`${cmd}: ${resultPath} names an outputs dir outside the run dir (${outputsDir}); refusing to export it`);

  const src = NoFollowRoot.existing(outputsDir);
  const files: Array<{ rel: string; data: Buffer; mode: number }> = [];
  const skipped: ExportOutcome["skipped"] = [];
  const walk = (dir: string): void => {
    for (const d of src.readdirNoFollow(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, d.name);
      const rel = relative(src.root, abs);
      if (d.isSymbolicLink()) skipped.push({ file: rel, why: "symlink" });
      else if (d.isDirectory()) walk(abs);
      else if (!d.isFile()) skipped.push({ file: rel, why: "not a regular file" });
      else if (lstatOrNull(abs)!.nlink > 1) skipped.push({ file: rel, why: "hard link" });
      else files.push({ rel, data: src.readBytes(abs), mode: lstatOrNull(abs)!.mode & 0o777 });
    }
  };
  walk(src.root);
  if (files.length === 0)
    return refuse(`${cmd}: ${outputsDir} holds no regular files — nothing for a later step to resume from`, { outputsDir, skipped });

  const secrets = opts.secrets.filter((s) => s.length > 0);
  const runRoots = [realpathSync.native(opts.runDir), runsWriteRoot(), VM_WORK_HOST];
  const refused: ExportFinding[] = [];
  const notes: ExportNote[] = [];
  for (const f of files) {
    if (!isText(f.data)) {
      notes.push({ file: f.rel, kind: "binary" });
      continue;
    }
    const text = f.data.toString("utf8");
    if (secrets.some((s) => text.includes(s))) {
      refused.push({ file: f.rel, kind: "secret" });
      continue;
    }
    const tokens = hostPathTokens(text);
    if (tokens.some((t) => runRoots.some((r) => t === r || t.startsWith(`${r}/`)))) refused.push({ file: f.rel, kind: "run_path" });
    else if (tokens.length && !opts.allowHostPaths) refused.push({ file: f.rel, kind: "host_path" });
    for (const s of scanText(text, f.rel, []))
      if (NOTE_CLASSES.has(s.cls)) notes.push({ file: f.rel, kind: "pii", cls: s.cls, sample: s.sample });
  }
  const bytes = files.reduce((n, f) => n + f.data.length, 0);
  if (refused.length)
    return refuse(
      `${cmd}: refused — ${refused.length} file(s) would carry a secret or a machine-specific path into a committed fixture: ` +
        refused.map((r) => `${r.file} (${r.kind})`).join(", ") +
        `. The export never alters bytes; fix the source run${refused.some((r) => r.kind === "host_path") ? " or pass --allow-host-paths" : ""}.`,
      { outputsDir, skipped, refused, notes, bytes },
    );

  // --out: absent, or an existing EMPTY plain directory. Never merges.
  const outSt = lstatOrNull(opts.out);
  if (outSt !== null) {
    if (outSt.isSymbolicLink() || !outSt.isDirectory()) return refuse(`${cmd}: --out ${opts.out} exists and is not a plain directory`);
    if (readdirSync(opts.out).length > 0) return refuse(`${cmd}: --out ${opts.out} is not empty; a fixture export never merges`);
  }
  const created = outSt === null;
  try {
    const dst = NoFollowRoot.open(opts.out);
    for (const f of files) {
      const target = join(dst.root, f.rel);
      dst.mkdir(join(target, ".."));
      dst.createFile(target, f.data, f.mode);
    }
  } catch (e) {
    // Never leave a half-written fixture behind; an --out we did not create is emptied, not removed.
    if (created) rmSync(opts.out, { recursive: true, force: true });
    else for (const n of readdirSync(opts.out)) rmSync(join(opts.out, n), { recursive: true, force: true });
    if (e instanceof FsRefusal) return refuse(`${cmd}: ${e.message}`);
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
  };
}
