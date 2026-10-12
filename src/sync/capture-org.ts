/**
 * Which organisation Desktop's gate cache was captured under.
 *
 * Desktop rewrites its GrowthBook cache (the fcache `sync` decodes into `provenance.gates`) for the organisation it
 * is signed in to, and some gates differ between organisations. A re-sync under a different organisation therefore
 * shows gate "flips" that are not production changes. `sync` records which organisation the cache belonged to, and
 * remembers on this machine (never committed) the organisation it last synced under. It refuses a write captured
 * under a different one from that, unless overridden. A capture under another organisation from the shipped
 * baseline's only warns: anyone outside that organisation re-syncs under their own.
 *
 * MEASURED in Desktop 2.31226.1's `main.log` (2026-10-12): every org-scoped token lookup logs
 * `using cached token for orgId=<uuid>`, and an org switch logs `Org changed from <uuid> to <uuid>,` immediately
 * before the cache is rewritten (two seconds apart in the measured switch). The organisation active when the cache
 * was last written is the one named by the newest such entry at or before the cache's modification time.
 *
 * Only a salted hash of the organisation id: it cannot be reversed, but anyone who already holds the id can confirm it (the salt is public). The baseline is public.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { CaptureOrg } from "../types.js";
import { ENTRY, localMs, logLines } from "./observed-spawn-env.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN_ORG = new RegExp(`using cached token for orgId=(${UUID})\\b`);
const ORG_CHANGED = new RegExp(`Org changed from ${UUID} to (${UUID})\\b`);

/** A short salted hash of an organisation id (a commitment under a public salt): never the id, and not reversible,
 *  but anyone holding the id can confirm it. */
export function orgRef(orgId: string): string {
  return createHash("sha256").update(`cowork-harness capture org\0${orgId}`, "utf8").digest("hex").slice(0, 12);
}

/** The organisation id named by the newest org-naming entry at or before `atMs`, from log lines in time order. */
export function captureOrgAt(lines: Iterable<string>, atMs: number): string | null {
  let org: string | null = null;
  for (const line of lines) {
    const entry = line.match(ENTRY);
    if (!entry) continue;
    const named = entry[7]!.match(ORG_CHANGED)?.[1] ?? entry[7]!.match(TOKEN_ORG)?.[1];
    if (!named) continue;
    if (localMs(entry) > atMs) break;
    org = named;
  }
  return org;
}

/** The organisation the gate cache was captured under, from Desktop's rotated logs in `logsDir`. `orgId` is for
 *  in-memory use only (choosing that organisation's other caches); only `record` may be written. */
export function readCaptureOrg(logsDir: string, cacheMtimeMs: number): { orgId: string | null; record: CaptureOrg } {
  const counts = { unreadable: 0, nonEmpty: 0 };
  const found = captureOrgAt(logLines(logsDir, counts), cacheMtimeMs);
  // An unreadable log file could hold the switch, which would make `found` stale: then the organisation cannot be told.
  const org = counts.unreadable > 0 ? null : found;
  return { orgId: org, record: org === null ? { observed: false } : { observed: true, orgRef: orgRef(org) } };
}

/** Where this machine remembers the organisation it last synced under. Local state, never committed. */
export const LOCAL_ORG_RECORD = join(homedir(), ".cowork-harness", "sync-capture-org.json");

const LocalOrgFile = z.strictObject({ orgRef: z.string().regex(/^[0-9a-f]{12}$/) });

/** This machine's record: `absent` only when the file does not exist; any other read, parse or schema failure is
 *  `corrupt`, and the gate fails closed on it. */
export type LocalOrg = { state: "absent" } | { state: "ok"; orgRef: string } | { state: "corrupt" };

export function readLocalOrg(path: string): LocalOrg {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "corrupt" };
  }
  try {
    const parsed = LocalOrgFile.safeParse(JSON.parse(text));
    return parsed.success ? { state: "ok", orgRef: parsed.data.orgRef } : { state: "corrupt" };
  } catch {
    return { state: "corrupt" };
  }
}

/** After a written sync: remember an observed capture's organisation (0600, in a 0700 dir it creates). An unobserved
 *  capture never writes or resets the record. A failed write is a warning: the old record stays and is still checked. */
export function recordCaptureOrg(path: string, now: CaptureOrg): string | null {
  if (!now.observed) return null;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify({ orgRef: now.orgRef }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return null;
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort: the warning below is what matters
    }
    return `WARNING: captureOrg: could not record this machine's organisation at ${path} (${(e as NodeJS.ErrnoException).code ?? "error"}); the next sync compares against the old record`;
  }
}

/** `sync`'s write gate: the capture organisation must match the one this machine last synced under (`local`).
 *  `allowChange` (the `--allow-org-change` flag) turns a refusal into a warning, for when the organisation really
 *  changed. A capture under another organisation from the previous baseline's (`baseline`) only warns. */
export function checkCaptureOrg(
  local: LocalOrg,
  baseline: CaptureOrg | undefined,
  now: CaptureOrg,
  allowChange: boolean,
): { refuse: string | null; notes: string[] } {
  const notes: string[] = [];
  const baseRef = baseline?.observed ? baseline.orgRef : undefined;
  if (now.observed && baseRef !== undefined && now.orgRef !== baseRef)
    notes.push(
      `WARNING: captureOrg: the gate cache was captured under a different org (${now.orgRef}) from the previous baseline's (${baseRef}); Desktop rewrites gates per org, so gate changes in this sync may be the org, not production`,
    );
  let problem: string | null = null;
  if (local.state === "corrupt")
    problem = `this machine's record of the organisation it last synced under is unreadable (${LOCAL_ORG_RECORD_NAME})`;
  else if (local.state === "absent")
    notes.push(
      now.observed
        ? `captureOrg: first sync on this machine; recording its organisation (${now.orgRef}) once the baseline is written`
        : "captureOrg: not recorded — no org-naming Desktop log entry before the gate cache was written",
    );
  else if (!now.observed)
    problem = `Desktop's logs cannot tell which organisation the gate cache was captured under, and this machine last synced under ${local.orgRef}`;
  else if (now.orgRef !== local.orgRef)
    problem = `the gate cache was captured under a different org (${now.orgRef}) from the one this machine last synced under (${local.orgRef}); Desktop rewrites gates per org, so gate changes in this sync may be the org, not production`;
  if (problem === null) return { refuse: null, notes };
  if (allowChange) return { refuse: null, notes: [...notes, `WARNING: captureOrg: ${problem} (written anyway: --allow-org-change)`] };
  return {
    refuse:
      local.state === "corrupt"
        ? `captureOrg: ${problem}. Fix or remove that file and re-run sync, or pass --allow-org-change to write and record the current organisation.`
        : `captureOrg: ${problem}. Switch Desktop back to that organisation and re-run sync, or pass --allow-org-change if the organisation you sync under has changed.`,
    notes,
  };
}

const LOCAL_ORG_RECORD_NAME = "~/.cowork-harness/sync-capture-org.json";
