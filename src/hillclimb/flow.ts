// Every byte `hillclimb` writes into a flow dir goes through this writer.
//
// The flow dir is model-influenced (a round's analyzer reads and may write it) AND committable (the loop
// offers to commit it, build-eval.md l.213-219), so:
//   - every read and write is confined to the flow root by the shared no-follow root (fs.ts): a planted
//     `results.jsonl -> ~/.bashrc` is refused, not appended to (runner-scaffold.mjs l.34-131);
//   - every output path is preflighted before any spend (runner-scaffold.mjs l.359-385, plus the files only we write);
//   - every string is redacted before it lands: the run's secrets first, then host paths (`~/…` under $HOME,
//     `<host-path>` elsewhere).
// One addition over the scaffold, named as a divergence: a per-variant lock. The scaffold lets two runners append to one variant;
// with VM-length jobs a loop that re-launches while the old process lives would duplicate (case, rep) rows.

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../errors.js";
import { scrub } from "../secrets.js";
import { redactHostPaths } from "../eval/report.js";
import { FsRefusal, lstatOrNull, NoFollowRoot, preflightRoot } from "./fs.js";

/** Redact every string in a JSON value (keys are left alone): secrets, then host paths. */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactHostPaths(scrub(v, [...secrets])).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export class FlowWriter {
  private constructor(
    private readonly r: NoFollowRoot,
    readonly variant: string,
    private readonly secrets: readonly string[],
  ) {}

  /** Preflight and bind the flow root, then create `<variant>/traces`. Throws FsRefusal on a planted link. */
  static open(flowArg: string, variant: string, opts: { cwd?: string; secrets: readonly string[] }): FlowWriter {
    const cwd = opts.cwd ?? process.cwd();
    const v = (rel: string) => `${variant}/${rel}`;
    // the scaffold's list (l.361-363) plus the files only the harness writes.
    preflightRoot(
      flowArg,
      [
        "baseline",
        variant,
        v("traces"),
        v("results.jsonl"),
        v("errors.jsonl"),
        v("progress.txt"),
        "baseline/ref",
        "_state.json",
        v("summary.json"),
        "inputs",
        v("out"),
        v("regrade.md"),
        v(".lock"),
      ].map((p) => `${flowArg.replace(/\/+$/, "")}/${p}`),
      cwd,
    );
    const r = NoFollowRoot.open(flowArg, { cwd });
    const w = new FlowWriter(r, variant, opts.secrets);
    r.mkdir(w.vpath("traces"));
    return w;
  }

  get root(): string {
    return this.r.root;
  }

  /** Absolute path of `rel` inside the variant dir. */
  vpath(rel: string): string {
    return join(this.r.root, this.variant, rel);
  }

  /** `_state.json`, read-only (runner-scaffold.mjs l.386-397). Absent ⇒ {}; present but unparsable ⇒ refuse before spend. */
  state(): Record<string, unknown> {
    const text = this.r.readIfPresent(join(this.r.root, "_state.json"));
    if (text === null) return {};
    let st: unknown;
    try {
      st = JSON.parse(text);
    } catch {
      // the parse message is not echoed: it can quote the file's first bytes (runner-scaffold.mjs l.391-396)
      throw new UsageError(`${join(this.r.root, "_state.json")} exists but is not valid JSON - fix it before spending a pass`);
    }
    if (st === null || typeof st !== "object" || Array.isArray(st))
      throw new UsageError(`${join(this.r.root, "_state.json")} must hold a JSON object`);
    return st as Record<string, unknown>;
  }

  /** A variant file's text, or null when absent (read-only, no-follow). */
  readVariantFile(name: string): string | null {
    return this.r.readIfPresent(this.vpath(name));
  }

  appendResult(row: Record<string, unknown>): void {
    this.r.appendJsonl(this.vpath("results.jsonl"), redactDeep(row, this.secrets));
  }

  appendError(row: Record<string, unknown>): void {
    this.r.appendJsonl(this.vpath("errors.jsonl"), redactDeep(row, this.secrets));
  }

  writeTrace(caseId: string, rep: number, turns: unknown[]): void {
    this.r.writeFile(this.vpath(join("traces", `${caseId}_rep${rep}.json`)), JSON.stringify(redactDeep(turns, this.secrets), null, 2));
  }

  /** A file under the flow root (sidecars, output copies, inputs). Text is redacted; bytes are written as-is. */
  writeUnderFlow(rel: string, data: string | Uint8Array): void {
    const p = join(this.r.root, rel);
    this.r.mkdir(join(p, ".."));
    this.r.writeFile(p, typeof data === "string" ? redactDeep(data, this.secrets) : data);
  }

  writeProgress(line: string): void {
    this.r.writeFile(this.vpath("progress.txt"), `${line}\n`);
  }

  /** Add the runner's keys to `summary.json` without overwriting any key already there — the loop writes
   *  description/target/suspicious into the same file (eval-hillclimb.md l.185-190, l.269). */
  mergeSummary(keys: Record<string, unknown>): void {
    const p = this.vpath("summary.json");
    const text = this.r.readIfPresent(p);
    let cur: Record<string, unknown> = {};
    if (text !== null)
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cur = parsed;
        else return; // not ours to repair
      } catch {
        return; // a loop-written file we cannot parse is left alone
      }
    const missing = Object.fromEntries(Object.entries(keys).filter(([k, v]) => !(k in cur) && v !== undefined));
    if (Object.keys(missing).length === 0) return; // nothing to add: never create an empty summary.json
    this.r.writeFile(p, JSON.stringify({ ...cur, ...redactDeep(missing, this.secrets) }, null, 2) + "\n");
  }

  /** The one sanctioned `_state.json` write (runner-scaffold.mjs l.262-266): record the approved harness sha, keep everything else. */
  approveHarness(sha: string): void {
    const st = this.state();
    this.r.writeFile(join(this.r.root, "_state.json"), JSON.stringify({ ...st, harness_sha: sha }, null, 2) + "\n");
  }

  /** Hold the variant for this process. Refuses while a live process holds it; takes over a dead one's lock.
   *  Returns the release function. */
  lock(): () => void {
    const p = this.vpath(".lock");
    const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
    try {
      this.r.createFile(p, mine);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      let holder: { pid?: unknown } = {};
      try {
        holder = JSON.parse(this.r.readFile(p));
      } catch (err) {
        if (err instanceof FsRefusal) throw err;
      }
      if (typeof holder.pid === "number" && alive(holder.pid))
        throw new UsageError(
          `another hillclimb process (pid ${holder.pid}) holds ${p}; wait for it, or remove the file if that process is gone`,
        );
      this.r.writeFile(p, mine);
    }
    return () => {
      const st = lstatOrNull(p);
      if (st?.isFile()) unlinkSync(p);
    };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** The (prompt_id, rep) slots named by a JSONL file's rows; a torn or malformed line names none. */
export function slotsIn(text: string | null): Set<string> {
  const out = new Set<string>();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { prompt_id?: unknown; rep?: unknown };
      out.add(`${r.prompt_id}\0${r.rep}`);
    } catch {
      /* a torn line names no slot */
    }
  }
  return out;
}
