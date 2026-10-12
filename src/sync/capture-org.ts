/**
 * Which organisation Desktop's gate cache was captured under.
 *
 * Desktop rewrites its GrowthBook cache (the fcache `sync` decodes into `provenance.gates`) for the organisation it
 * is signed in to, and some gates differ between organisations. A re-sync under a different organisation therefore
 * shows gate "flips" that are not production changes. `sync` records which organisation the cache belonged to and
 * refuses a write captured under a different one from the previous baseline's, unless overridden.
 *
 * MEASURED in Desktop 2.31226.1's `main.log` (2026-10-12): every org-scoped token lookup logs
 * `using cached token for orgId=<uuid>`, and an org switch logs `Org changed from <uuid> to <uuid>,` immediately
 * before the cache is rewritten (two seconds apart in the measured switch). The organisation active when the cache
 * was last written is the one named by the newest such entry at or before the cache's modification time.
 *
 * Only a short one-way hash of the organisation id is recorded: the baseline is public.
 */

import { createHash } from "node:crypto";
import type { CaptureOrg } from "../types.js";
import { ENTRY, localMs, logLines } from "./observed-spawn-env.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN_ORG = new RegExp(`using cached token for orgId=(${UUID})\\b`);
const ORG_CHANGED = new RegExp(`Org changed from ${UUID} to (${UUID})\\b`);

/** A short one-way hash of an organisation id. Never the id. */
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
  const org = captureOrgAt(logLines(logsDir, { unreadable: 0, nonEmpty: 0 }), cacheMtimeMs);
  return { orgId: org, record: org === null ? { observed: false } : { observed: true, orgRef: orgRef(org) } };
}

/** `sync`'s write gate: the capture organisation must match the previous baseline's. `allowChange` (the
 *  `--allow-org-change` flag) turns a refusal into a warning, for when the canonical organisation really changed. */
export function checkCaptureOrg(
  previous: CaptureOrg | undefined,
  now: CaptureOrg,
  allowChange: boolean,
): { refuse: string | null; notes: string[] } {
  const prevRef = previous?.observed ? previous.orgRef : undefined;
  if (prevRef === undefined)
    return {
      refuse: null,
      notes: [
        now.observed
          ? `captureOrg: recording the gate cache's organisation for the first time (${now.orgRef})`
          : "captureOrg: not recorded — no org-naming Desktop log entry before the gate cache was written",
      ],
    };
  let problem: string | null = null;
  if (!now.observed)
    problem = `Desktop's logs cannot tell which organisation the gate cache was captured under, and the previous baseline was captured under ${prevRef}`;
  else if (now.orgRef !== prevRef)
    problem = `the gate cache was captured under a different org (${now.orgRef}) from the previous baseline (${prevRef}); Desktop rewrites gates per org, so gate changes in this sync may be the org, not production`;
  if (problem === null) return { refuse: null, notes: [] };
  if (allowChange) return { refuse: null, notes: [`WARNING: captureOrg: ${problem} (written anyway: --allow-org-change)`] };
  return {
    refuse: `captureOrg: ${problem}. Switch Desktop to the organisation the baseline is captured under and re-run sync, or pass --allow-org-change if that organisation has changed.`,
    notes: [],
  };
}
