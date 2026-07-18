// Baseline staleness gate — fails (exit 1) when the newest committed parity baseline is too old,
// or when ANY committed baseline carries an invalid / future `capturedAt` timestamp.
//
//   npx tsx scripts/check-baseline-staleness.ts [baselineDirOrFile ...]   # defaults to "baselines"
//
// Why this exists as a checked-in, unit-tested script rather than inline `node -e` in ci.yml:
// the previous inline version had three latent false-greens that a shell one-liner made easy to
// miss and impossible to test —
//   1. `Date.parse("garbage")` is NaN, and `NaN > 90` is false → a baseline with a broken
//      `capturedAt` sailed through as "fresh".
//   2. A future-dated `capturedAt` yields a NEGATIVE age → also < 90 → green forever.
//   3. Newest-selection used `t > newest.t`; because every NaN comparison is false, if the FIRST
//      baseline iterated had an invalid timestamp, no valid later baseline could ever displace it —
//      one corrupt file permanently disabled the gate for ALL baselines.
//
// This script closes all three: every baseline's `capturedAt` must parse to a finite epoch and must
// not be in the future beyond a small clock-skew allowance (else the whole job fails), and staleness
// is measured against the newest of the VALID baselines only — a corrupt file can never mask a stale
// one, because both conditions independently fail the gate.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Wall-clock staleness ceiling: force a human to re-run `sync` if the newest baseline is older. */
export const DEFAULT_MAX_AGE_DAYS = 90;
/** Small allowance for a dev machine whose clock is slightly ahead when it captured a baseline. */
export const DEFAULT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 1 day
const MS_PER_DAY = 86_400_000;

export interface CheckOptions {
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
  maxAgeDays?: number;
  futureSkewMs?: number;
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  /** Newest VALID baseline, if any parsed cleanly. */
  newest?: { file: string; capturedAt: string; ageDays: number };
}

/**
 * Expand each input into concrete baseline file paths. A directory contributes its
 * `desktop-*.json` children; a file path is taken as-is.
 */
export function resolveBaselineFiles(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    let st;
    try {
      st = statSync(input);
    } catch {
      // Non-existent path: surface it as a "file" so the reader reports a clear read error.
      files.push(input);
      continue;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(input)) {
        if (/^desktop-.*\.json$/.test(f)) files.push(join(input, f));
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

/**
 * Validate a set of baseline files and check the newest for staleness.
 * Any unreadable/unparseable file, any non-finite `capturedAt`, and any future-dated `capturedAt`
 * are hard errors — the gate must never go green on invalid ground truth.
 */
export function checkBaselineStaleness(files: string[], opts: CheckOptions = {}): CheckResult {
  const now = opts.now ?? Date.now();
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const futureSkewMs = opts.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS;
  const errors: string[] = [];

  if (files.length === 0) {
    errors.push("no baseline files found (expected baselines/desktop-*.json)");
    return { ok: false, errors };
  }

  // Parse and validate EVERY file independently — a corrupt entry cannot short-circuit the scan,
  // so it can never hide a stale sibling (a corrupt file must never disable the gate for its siblings).
  const valid: Array<{ file: string; capturedAt: string; t: number }> = [];
  for (const file of files) {
    let capturedAt: unknown;
    try {
      capturedAt = JSON.parse(readFileSync(file, "utf8")).capturedAt;
    } catch (e) {
      errors.push(`${file}: could not read/parse baseline JSON (${(e as Error).message})`);
      continue;
    }
    if (typeof capturedAt !== "string") {
      errors.push(`${file}: missing or non-string "capturedAt"`);
      continue;
    }
    const t = Date.parse(capturedAt);
    if (!Number.isFinite(t)) {
      errors.push(`${file}: "capturedAt" ("${capturedAt}") does not parse to a valid date`);
      continue;
    }
    if (t > now + futureSkewMs) {
      const aheadDays = ((t - now) / MS_PER_DAY).toFixed(1);
      errors.push(`${file}: "capturedAt" ("${capturedAt}") is ${aheadDays} days in the future — bogus clock or hand-edited baseline`);
      continue;
    }
    valid.push({ file, capturedAt, t });
  }

  let newest: CheckResult["newest"];
  if (valid.length === 0) {
    errors.push("no baseline with a valid, non-future capturedAt — cannot evaluate staleness");
  } else {
    const top = valid.reduce((a, b) => (b.t > a.t ? b : a));
    const ageDays = (now - top.t) / MS_PER_DAY;
    newest = { file: top.file, capturedAt: top.capturedAt, ageDays };
    if (ageDays > maxAgeDays) {
      errors.push(
        `newest valid baseline ${top.file} is ${ageDays.toFixed(0)} days old (>${maxAgeDays}) — run ` +
          "`cowork-harness sync --diff` on macOS against the current Claude Desktop and commit the refreshed baseline.",
      );
    }
  }

  return { ok: errors.length === 0, errors, newest };
}

function main(): void {
  const inputs = process.argv.slice(2);
  const files = resolveBaselineFiles(inputs.length > 0 ? inputs : ["baselines"]);
  const { ok, errors, newest } = checkBaselineStaleness(files);
  if (newest) {
    process.stdout.write(`newest baseline: ${newest.file} (capturedAt ${newest.capturedAt}, ${newest.ageDays.toFixed(1)} days ago)\n`);
  }
  if (ok) {
    process.stdout.write("✓ baseline freshness OK\n");
    return;
  }
  for (const e of errors) process.stderr.write(`::error::${e}\n`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
