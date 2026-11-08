// `stopped.json`: why an eval stopped scheduling jobs before its schedule ran out. Written by the eval loop the moment
// it stops, read by every report build (`eval` and `eval report`), so a rebuild keeps the reason. It is the ONLY record
// of a stop the LLM decider caused: runs.jsonl keeps a job's throw as `{kind, message}`, with no status. The exit code
// never depends on this file: the jobs a stop left unrun are missing from runs.jsonl, and any missing job exits 1.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STOPPED_FILE = "stopped.json";

export interface StoppedEarly {
  /** A grader (a judge, or the LLM decider) failed the way every later grade would: a rejected credential (401/403),
   *  an unknown model (404) or a spent usage quota. */
  reason: "grader_credential";
  /** Which grader failed. */
  source: "judge" | "decider";
  /** The API status, when one was reported. */
  status?: number;
  /** The schedule index of the job whose grade failed. Jobs already running then finished; no later job started. */
  atJob: number;
}

export function writeStopped(evalDir: string, s: StoppedEarly): void {
  writeFileSync(join(evalDir, STOPPED_FILE), JSON.stringify(s, null, 2) + "\n");
}

/** The recorded stop, or null when the eval did not stop. A file that does not parse as one throws rather than being
 *  read as "no stop": a report that silently dropped the reason would look like an ordinary unfinished eval. */
export function readStopped(evalDir: string): StoppedEarly | null {
  const p = join(evalDir, STOPPED_FILE);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<StoppedEarly>;
    if (o?.reason === "grader_credential" && (o.source === "judge" || o.source === "decider") && Number.isInteger(o.atJob))
      return {
        reason: o.reason,
        source: o.source,
        ...(typeof o.status === "number" ? { status: o.status } : {}),
        atJob: o.atJob!,
      };
  } catch {
    /* fall through */
  }
  throw new Error(`${p} is not a stop record this version can read`);
}
