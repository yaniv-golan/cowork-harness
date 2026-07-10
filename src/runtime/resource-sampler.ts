import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { warn } from "../io.js";

const pexec = promisify(execFile);
const DEFAULT_SAMPLE_TIMEOUT_MS = 2000;
/** Upper bound `stop()` will wait for an in-flight tick — comfortably above the probe timeout above so a
 *  well-behaved probe always lands, without letting a hung one block teardown indefinitely. */
const STOP_WAIT_DEADLINE_MS = 2500;

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
  malformedLines: number;
  /** Count of `sampleOnce()` calls that returned `undefined` for a tier that IS sampleable (nonzero
   *  exit, timeout, spawn failure, parse failure) — distinct from a genuinely-unsupported tier, which
   *  never counts here. Only populated when the caller passes it through from the live `ResourceSampler`
   *  (see `ResourceSampler.probeFailures`); omitted (undefined) otherwise. */
  probeFailures?: number;
}

/** Sentinel identity for `makeSampleOnce`'s "this tier can't be sampled" fallback (protocol/replay, or a
 *  required container/pid/instance id missing). `ResourceSampler` compares against this reference so a
 *  genuinely-unsupported tier is never counted as a probe *failure* — only a real probe returning
 *  `undefined` (nonzero exit, timeout, spawn failure, parse failure) increments `probeFailures`. */
const UNSUPPORTED_PROBE: () => Promise<ResourceSample | undefined> = async () => undefined;

/** COWORK_HARNESS_RESOURCE_INTERVAL_MS (positive int) else 1000. A set-but-invalid value (non-integer,
 *  non-positive) warns and falls back to the default rather than silently sampling on the wrong cadence. */
export function resolveIntervalMs(): number {
  const raw = process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    warn(`::warning:: [resources] COWORK_HARNESS_RESOURCE_INTERVAL_MS=${raw} must be a positive integer; using default 1000ms\n`);
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
  private probeFailureCount = 0;
  /** Latest in-flight (or just-completed) tick, so `stop()` can await it instead of racing it. */
  private tickPromise: Promise<void> | undefined;
  constructor(
    outDir: string,
    private tier: string,
    private sampleOnce: () => Promise<ResourceSample | undefined>,
    private intervalMs: number = resolveIntervalMs(),
  ) {
    this.path = join(outDir, "resources.jsonl");
  }
  /** Count of `sampleOnce()` calls that returned `undefined` for THIS tier, excluding the genuinely-
   *  unsupported-tier fallback (see `UNSUPPORTED_PROBE`) — "sampling failed" vs. "sampling impossible". */
  get probeFailures(): number {
    return this.probeFailureCount;
  }
  start(): void {
    if (this.timer) return;
    this.tickPromise = this.tick(); // sample immediately so a run shorter than one interval still records a sample
    this.timer = setInterval(() => {
      this.tickPromise = this.tick();
    }, this.intervalMs);
    this.timer.unref?.(); // never keep the process alive past teardown
  }
  private async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return; // no overlap; no work after stop
    this.inFlight = true;
    try {
      const sample = await this.sampleOnce();
      if (sample === undefined && this.sampleOnce !== UNSUPPORTED_PROBE) this.probeFailureCount++;
      if (sample && !this.stopped) appendFileSync(this.path, JSON.stringify(sample) + "\n");
    } catch (e) {
      warn(`::warning:: [resources] sample failed (${this.tier}): ${String((e as Error)?.message ?? e)}\n`);
    } finally {
      this.inFlight = false;
    }
  }
  /** Stops future ticks, then awaits the in-flight tick (bounded — a hung probe can't block teardown
   *  forever) so a run shorter than one interval still has its immediate first sample land in
   *  resources.jsonl BEFORE the caller reads it via `foldResources` right after `stop()` returns.
   *
   *  `stopped` is set only AFTER that wait (not before): the append it guards
   *  (`if (sample && !this.stopped)` above) must stay open while we're waiting on THIS in-flight tick,
   *  or the very sample we're waiting for would suppress itself. If the tick is still pending once the
   *  bounded wait elapses (a hung probe), setting `stopped` afterward still suppresses that late write
   *  once it eventually resolves — the original race this flag existed to prevent. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.tickPromise) {
      await Promise.race([this.tickPromise, new Promise<void>((r) => setTimeout(r, STOP_WAIT_DEADLINE_MS))]);
    }
    this.stopped = true;
  }
}

/** Aggregate `resources.jsonl` into a summary. Returns `undefined` when the file is missing/empty (the
 *  tier never sampled — protocol/replay, a run shorter than one interval, or a tier whose probe tool was
 *  unavailable), so a downstream assertion reads evidence-unavailable rather than a vacuous pass.
 *  Malformed lines are skipped but counted in `malformedLines`. */
export function foldResources(outDir: string, tier: string, intervalMs: number, probeFailures?: number): ResourceSummary | undefined {
  let text: string;
  try {
    text = readFileSync(join(outDir, "resources.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const samples: ResourceSample[] = [];
  let malformedLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    // Valid JSON that isn't a non-null object (e.g. `null`, a number, an array) parses fine here but
    // would throw on the field reads below (s.rssBytes / s.cpuPct), OUTSIDE this catch — crashing the
    // fold instead of counting the line as malformed. Reject it the same way here.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedLines++;
      continue;
    }
    samples.push(parsed as ResourceSample);
  }
  if (samples.length === 0) {
    // All-malformed ≠ never-sampled: if lines WERE present but every one failed to parse, surface an
    // evidence-corruption summary (sampleCount 0 + malformedLines) rather than undefined, which reads as
    // "this tier never sampled". A genuinely empty/absent log still returns undefined.
    if (malformedLines > 0) return { tier, sampleCount: 0, intervalMs, malformedLines, probeFailures };
    return undefined;
  }
  const peak = (get: (s: ResourceSample) => number | undefined): number | undefined => {
    const vals = samples.map(get).filter((v): v is number => typeof v === "number");
    return vals.length ? Math.max(...vals) : undefined;
  };
  const cpuVals = samples.map((s) => s.cpuPct).filter((v): v is number => typeof v === "number");
  return {
    tier,
    sampleCount: samples.length,
    intervalMs,
    malformedLines,
    probeFailures,
    peakRssBytes: peak((s) => s.rssBytes),
    peakCpuPct: peak((s) => s.cpuPct),
    avgCpuPct: cpuVals.length ? cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length : undefined,
  };
}

/** Run one probe child async (never blocks the event loop). Returns stdout, or undefined on nonzero
 *  exit / timeout / spawn error — a dropped sample, never fatal. */
async function probe(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const { stdout } = await pexec(cmd, args, { encoding: "utf8", timeout: timeoutMs });
    return stdout;
  } catch {
    return undefined;
  }
}

/** limactl path — mirrors lima.ts's resolution so the sampler needn't import run/ code. */
function limaBin(): string {
  return process.env.COWORK_LIMACTL ?? "/opt/homebrew/bin/limactl";
}

/** "123.4MiB" | "2GiB" | "512KiB" | "900B" -> bytes; undefined on an unrecognized unit. */
function parseSize(s: string): number | undefined {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
  };
  const f = mult[unit];
  return f && Number.isFinite(n) ? n * f : undefined;
}

function nowMs(): number {
  return Date.now();
}

/** One `docker stats --no-stream --format '{{json .}}'` object. MemUsage="used / limit", CPUPerc="12.34%". */
export function parseDockerStats(json: string): ResourceSample | undefined {
  let o: any;
  try {
    o = JSON.parse(json);
  } catch {
    return undefined;
  }
  const used = typeof o?.MemUsage === "string" ? o.MemUsage.split("/")[0] : undefined;
  const rssBytes = used ? parseSize(used) : undefined;
  const cpu = typeof o?.CPUPerc === "string" ? Number(o.CPUPerc.replace("%", "")) : undefined;
  const cpuPct = Number.isFinite(cpu) ? (cpu as number) : undefined;
  if (rssBytes === undefined && cpuPct === undefined) return undefined;
  return { ts: nowMs(), rssBytes, cpuPct };
}

/** `ps -o rss=,pcpu= -p <pid>` -> "  20480  7.5" (rss in KiB; pcpu is a decaying lifetime average). */
export function parsePsLine(line: string): ResourceSample | undefined {
  const m = /^\s*(\d+)\s+([\d.]+)\s*$/.exec(line);
  if (!m) return undefined;
  return { ts: nowMs(), rssBytes: Number(m[1]) * 1024, cpuPct: Number(m[2]) };
}

/** `/proc/meminfo` + first line of `/proc/stat` (separated by "---"). RSS = (MemTotal-MemAvailable) whole-VM
 *  (kB->bytes) — the sandbox's footprint, coarser than container/hostloop's per-container/per-process figure.
 *  CPU% from idle/total deltas vs the previous tick (undefined on tick 1). */
export function parseProcMeminfoStat(
  text: string,
  prev?: { idle: number; total: number },
): { sample: ResourceSample | undefined; cpuState: { idle: number; total: number } | undefined } {
  const [meminfo, statLine] = text.split("---");
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(meminfo ?? "");
    return m ? Number(m[1]) : undefined;
  };
  const total = kb("MemTotal");
  const avail = kb("MemAvailable");
  const rssBytes = total !== undefined && avail !== undefined ? (total - avail) * 1024 : undefined;
  let cpuPct: number | undefined;
  let cpuState: { idle: number; total: number } | undefined;
  const nums = (statLine ?? "")
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (nums.length >= 4) {
    const idle = nums[3] + (nums[4] ?? 0); // idle + iowait
    const sum = nums.reduce((a, b) => a + b, 0);
    cpuState = { idle, total: sum };
    if (prev) {
      const dTotal = sum - prev.total;
      const dIdle = idle - prev.idle;
      if (dTotal > 0) cpuPct = ((dTotal - dIdle) / dTotal) * 100;
    }
  }
  if (rssBytes === undefined && cpuPct === undefined) return { sample: undefined, cpuState };
  return { sample: { ts: nowMs(), rssBytes, cpuPct }, cpuState };
}

/** Build the per-tick async probe for a tier. Returns `async () => undefined` when the tier can't be
 *  sampled (protocol/replay, or a required identifier is missing) — foldResources then reads it as
 *  never-sampled (undefined summary), never a vacuous pass. */
export function makeSampleOnce(opts: {
  tier: string;
  runner: string;
  containerName?: string;
  pid?: number;
  instance?: string;
  timeoutMs?: number;
}): () => Promise<ResourceSample | undefined> {
  const timeout = opts.timeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS;
  if (opts.tier === "container" && opts.containerName) {
    const name = opts.containerName;
    return async () => {
      const out = await probe(opts.runner, ["stats", name, "--no-stream", "--format", "{{json .}}"], timeout);
      return out ? parseDockerStats(out.trim().split("\n")[0] ?? "") : undefined;
    };
  }
  if (opts.tier === "hostloop" && opts.pid) {
    const pid = opts.pid;
    return async () => {
      const out = await probe("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], timeout);
      return out ? parsePsLine(out.split("\n").find((l) => l.trim()) ?? "") : undefined;
    };
  }
  if (opts.tier === "microvm" && opts.instance) {
    const instance = opts.instance;
    let prevCpu: { idle: number; total: number } | undefined;
    return async () => {
      const out = await probe(limaBin(), ["shell", instance, "--", "sh", "-c", "cat /proc/meminfo; echo ---; head -1 /proc/stat"], timeout);
      if (!out) return undefined;
      const parsed = parseProcMeminfoStat(out, prevCpu);
      prevCpu = parsed.cpuState;
      return parsed.sample;
    };
  }
  return UNSUPPORTED_PROBE; // protocol/replay or missing id — never sampled, never a "failure"
}
