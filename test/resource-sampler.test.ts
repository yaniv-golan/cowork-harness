import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceSampler, foldResources, resolveIntervalMs } from "../src/runtime/resource-sampler.js";

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

it("resolveIntervalMs honors the env override, rejects non-positive", () => {
  expect(resolveIntervalMs()).toBe(1000);
  process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS = "250";
  expect(resolveIntervalMs()).toBe(250);
  process.env.COWORK_HARNESS_RESOURCE_INTERVAL_MS = "0";
  expect(resolveIntervalMs()).toBe(1000);
});
