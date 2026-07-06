import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { warn } from "../io.js";

export interface ResourceSample {
  ts: number;
  rssBytes?: number;
  cpuPct?: number;
}

export interface ResourceSummary {
  tier: string;
  sampleCount: number;
  intervalMs: number;
  peakRssBytes?: number;
  avgCpuPct?: number;
  peakCpuPct?: number;
}

/** COWORK_HARNESS_RESOURCE_INTERVAL_MS (positive int) else 1000. */
export function resolveIntervalMs(): number {
  const raw = process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 1000;
}

/**
 * Samples the agent sandbox on an interval by awaiting a caller-supplied ASYNC `sampleOnce()` thunk (the
 * tier decides HOW to probe, non-blockingly) and appending each returned sample to `resources.jsonl`.
 *
 * Runs on the same event loop as the run's control-protocol I/O, so probes must be async and must not
 * overlap: `inFlight` skips a tick while the previous probe is still running. `stopped` suppresses a
 * late-resolving probe's append so nothing is written after `stop()` (foldResources reads right after).
 * A probe that returns `undefined` or throws writes nothing — a dropped sample is never fatal.
 */
export class ResourceSampler {
  private readonly path: string;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private stopped = false;
  constructor(
    outDir: string,
    private tier: string,
    private sampleOnce: () => Promise<ResourceSample | undefined>,
    private intervalMs: number = resolveIntervalMs(),
  ) {
    this.path = join(outDir, "resources.jsonl");
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.(); // never keep the process alive past teardown
  }
  private async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return; // no overlap; no work after stop
    this.inFlight = true;
    try {
      const sample = await this.sampleOnce();
      if (sample && !this.stopped) appendFileSync(this.path, JSON.stringify(sample) + "\n");
    } catch (e) {
      warn(`::warning:: [resources] sample failed (${this.tier}): ${String((e as Error)?.message ?? e)}\n`);
    } finally {
      this.inFlight = false;
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** Aggregate `resources.jsonl` into a summary. Returns `undefined` when the file is missing/empty (the
 *  tier never sampled — protocol/replay, a run shorter than one interval, or a tier whose probe tool was
 *  unavailable), so a downstream assertion reads evidence-unavailable rather than a vacuous pass.
 *  Malformed lines are skipped. */
export function foldResources(outDir: string, tier: string, intervalMs: number): ResourceSummary | undefined {
  let text: string;
  try {
    text = readFileSync(join(outDir, "resources.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const samples: ResourceSample[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      samples.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  if (samples.length === 0) return undefined;
  const peak = (get: (s: ResourceSample) => number | undefined): number | undefined => {
    const vals = samples.map(get).filter((v): v is number => typeof v === "number");
    return vals.length ? Math.max(...vals) : undefined;
  };
  const cpuVals = samples.map((s) => s.cpuPct).filter((v): v is number => typeof v === "number");
  return {
    tier,
    sampleCount: samples.length,
    intervalMs,
    peakRssBytes: peak((s) => s.rssBytes),
    peakCpuPct: peak((s) => s.cpuPct),
    avgCpuPct: cpuVals.length ? cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length : undefined,
  };
}
