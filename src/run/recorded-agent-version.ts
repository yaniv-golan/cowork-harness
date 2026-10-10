// The agent version a recording actually ran: the `claude_code_version` its own init frame reports. Not the baseline
// the recording names — a hostloop run may substitute a patch-bumped native binary, protocol runs whatever `claude` is
// on PATH, and a fingerprint baseline can be re-stamped by hand — so only the stream says which agent ran.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentTurnEventLines } from "./turn-events.js";

/** The init frame's `claude_code_version` among stream-json lines, or undefined when none carries it. */
export function initAgentVersion(lines: readonly string[] | undefined): string | undefined {
  if (!Array.isArray(lines)) return undefined;
  for (const line of lines) {
    let m: { type?: string; subtype?: string; claude_code_version?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== "system" || m?.subtype !== "init") continue;
    return typeof m.claude_code_version === "string" && m.claude_code_version.length > 0 ? m.claude_code_version : undefined;
  }
  return undefined;
}

/** Every init frame's agent version in the CURRENT turn of a run dir's `events.jsonl` (the file is append-only across
 *  turns, and a resumed turn can run a different agent than turn 1 — a hostloop patch bump, a newer host `claude`).
 *  An init frame with no version contributes undefined. Empty when there is no file or no init frame in the turn; with
 *  no turn marker the whole file counts, so an earlier turn's old agent can only add an entry, never stand alone. */
export function currentTurnAgentVersions(runDir: string): Array<string | undefined> {
  let lines: string[];
  try {
    lines = readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n");
  } catch {
    return [];
  }
  const out: Array<string | undefined> = [];
  for (const line of currentTurnEventLines(lines)) {
    let m: { type?: string; subtype?: string; claude_code_version?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== "system" || m?.subtype !== "init") continue;
    out.push(typeof m.claude_code_version === "string" && m.claude_code_version.length > 0 ? m.claude_code_version : undefined);
  }
  return out;
}

/** The agent version a kept run dir's own stream reports (`events.jsonl`), or undefined. */
export function runDirAgentVersion(runDir: string): string | undefined {
  try {
    return initAgentVersion(readFileSync(join(runDir, "events.jsonl"), "utf8").split("\n"));
  } catch {
    return undefined;
  }
}
