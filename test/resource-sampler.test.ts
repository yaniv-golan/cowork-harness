import { it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResourceSampler,
  foldResources,
  resolveIntervalMs,
  parseDockerStats,
  parsePsLine,
  parseProcMeminfoStat,
  makeSampleOnce,
} from "../src/runtime/resource-sampler.js";

type ResourceSampleT = { ts: number; rssBytes?: number; cpuPct?: number };

const dirs: string[] = [];
const mkdir = () => {
  const d = mkdtempSync(join(tmpdir(), "res-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS;
});

it("appends real samples to resources.jsonl, skips undefined, stop() halts", async () => {
  const d = mkdir();
  const queue: (ResourceSampleT | undefined)[] = [{ ts: 1, rssBytes: 100 }, undefined, { ts: 2, rssBytes: 200 }];
  let i = 0;
  const s = new ResourceSampler(d, "container", async () => queue[i++], 5);
  s.start();
  await new Promise((r) => setTimeout(r, 40));
  s.stop();
  const lines = existsSync(join(d, "resources.jsonl"))
    ? readFileSync(join(d, "resources.jsonl"), "utf8").trim().split("\n").filter(Boolean)
    : [];
  expect(lines.length).toBeGreaterThanOrEqual(1);
  expect(lines.every((l) => JSON.parse(l).ts !== undefined)).toBe(true); // no `undefined` sample was written
});

it("foldResources aggregates peak RSS, peak+avg CPU; undefined when empty/missing", () => {
  const d = mkdir();
  expect(foldResources(d, "container", 1000)).toBeUndefined(); // never sampled
  writeFileSync(
    join(d, "resources.jsonl"),
    [
      { ts: 1, rssBytes: 100, cpuPct: 10 },
      { ts: 2, rssBytes: 300, cpuPct: 30 },
      { ts: 3, rssBytes: 200, cpuPct: 20 },
    ]
      .map((s) => JSON.stringify(s))
      .join("\n") + "\n",
  );
  const sum = foldResources(d, "container", 1000)!;
  expect(sum).toMatchObject({ tier: "container", sampleCount: 3, intervalMs: 1000, peakRssBytes: 300, peakCpuPct: 30 });
  expect(sum.avgCpuPct).toBeCloseTo(20, 5);
});

// #35: an all-malformed log must be distinguishable from a never-sampled tier (evidence-corruption,
// not "this tier never sampled").
it("foldResources returns sampleCount:0 + malformedLines for an all-garbage log (not undefined)", () => {
  const d = mkdir();
  writeFileSync(join(d, "resources.jsonl"), "not json\n{also bad\n\n{still bad}\n");
  const sum = foldResources(d, "container", 1000);
  expect(sum).not.toBeUndefined();
  expect(sum!.sampleCount).toBe(0);
  expect(sum!.malformedLines).toBeGreaterThan(0);
  expect(sum!.peakRssBytes).toBeUndefined();
});

it("resolveIntervalMs honors the env override, rejects non-positive", () => {
  expect(resolveIntervalMs()).toBe(1000);
  process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS = "250";
  expect(resolveIntervalMs()).toBe(250);
  process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS = "0";
  expect(resolveIntervalMs()).toBe(1000);
});

it("parseDockerStats reads MemUsage + CPUPerc", () => {
  const s = parseDockerStats(JSON.stringify({ MemUsage: "123.4MiB / 2GiB", CPUPerc: "12.34%" }))!;
  expect(s.rssBytes).toBeCloseTo(123.4 * 1024 * 1024, -3);
  expect(s.cpuPct).toBeCloseTo(12.34, 5);
});
it("parseDockerStats returns undefined on garbage / empty object", () => {
  expect(parseDockerStats("not json")).toBeUndefined();
  expect(parseDockerStats(JSON.stringify({}))).toBeUndefined();
});
it("parsePsLine reads rss(KiB)->bytes and pcpu; undefined on empty", () => {
  const s = parsePsLine("  20480  7.5")!;
  expect(s.rssBytes).toBe(20480 * 1024);
  expect(s.cpuPct).toBeCloseTo(7.5, 5);
  expect(parsePsLine("")).toBeUndefined();
});
// F42: a `null` (or array) JSON line parses fine but has no fields; reading s.rssBytes/s.cpuPct on it
// must not throw — it should count as malformed, like unparseable JSON.
it("foldResources counts a JSON `null` / array line as malformed instead of throwing", () => {
  const d = mkdir();
  writeFileSync(
    join(d, "resources.jsonl"),
    [JSON.stringify({ ts: 1, rssBytes: 100, cpuPct: 10 }), "null", "[1,2,3]", JSON.stringify({ ts: 2, rssBytes: 200, cpuPct: 20 })].join(
      "\n",
    ) + "\n",
  );
  expect(() => foldResources(d, "container", 1000)).not.toThrow();
  const sum = foldResources(d, "container", 1000)!;
  expect(sum.sampleCount).toBe(2);
  expect(sum.malformedLines).toBe(2);
});

// F41: a probe that always returns undefined for a sampleable tier should be visible as "sampling
// failed" via probeFailures, distinct from a genuinely-unsupported tier (makeSampleOnce's fallback),
// which must NOT increment it.
it("ResourceSampler.probeFailures counts undefined returns from a real (sampleable) probe", async () => {
  const d = mkdir();
  const s = new ResourceSampler(d, "container", async () => undefined, 5);
  s.start();
  await new Promise((r) => setTimeout(r, 30));
  await s.stop();
  expect(s.probeFailures).toBeGreaterThan(0);
});

it("ResourceSampler.probeFailures stays 0 for the genuinely-unsupported-tier fallback (makeSampleOnce)", async () => {
  const d = mkdir();
  // No containerName/pid/instance supplied -> makeSampleOnce returns its "can't be sampled" fallback.
  const sampleOnce = makeSampleOnce({ tier: "container", runner: "docker" });
  const s = new ResourceSampler(d, "container", sampleOnce, 5);
  s.start();
  await new Promise((r) => setTimeout(r, 30));
  await s.stop();
  expect(s.probeFailures).toBe(0);
});

// F40: start() fires an immediate tick so a run shorter than one interval still samples; stop() must
// await that in-flight tick so the sample lands before a caller reads resources.jsonl right after.
it("stop() awaits the in-flight first tick so a run stopped immediately still yields the first sample", async () => {
  const d = mkdir();
  let resolveProbe!: (v: ResourceSampleT) => void;
  const probePromise = new Promise<ResourceSampleT>((r) => (resolveProbe = r));
  const s = new ResourceSampler(d, "container", () => probePromise, 10_000); // long interval: only the immediate tick fires
  s.start();
  await new Promise((r) => setTimeout(r, 5)); // let start()'s immediate tick begin and mark inFlight
  const stopPromise = s.stop(); // must await the in-flight tick rather than returning immediately
  resolveProbe({ ts: 1, rssBytes: 42 });
  await stopPromise;
  const written = existsSync(join(d, "resources.jsonl")) ? readFileSync(join(d, "resources.jsonl"), "utf8").trim() : "";
  expect(written).not.toBe("");
  const sum = foldResources(d, "container", 10_000)!;
  expect(sum.sampleCount).toBe(1);
  expect(sum.peakRssBytes).toBe(42);
});

it("parseProcMeminfoStat computes RSS from Mem, CPU% from a delta across two ticks", () => {
  const text = (total: number, avail: number, work: number, idle: number) =>
    `MemTotal:       ${total} kB\nMemAvailable:   ${avail} kB\n---\ncpu  ${work} 0 0 ${idle} 0 0 0 0`;
  const first = parseProcMeminfoStat(text(2_000_000, 1_500_000, 100, 900));
  expect(first.sample!.rssBytes).toBe((2_000_000 - 1_500_000) * 1024);
  expect(first.sample!.cpuPct).toBeUndefined(); // no prior tick
  const second = parseProcMeminfoStat(text(2_000_000, 1_400_000, 200, 900), first.cpuState); // +100 work, +0 idle
  expect(second.sample!.cpuPct).toBeCloseTo(100, 5); // all delta was busy
});
