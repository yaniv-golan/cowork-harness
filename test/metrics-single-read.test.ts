// The extractor reads a metric's artifact ONCE: the bytes it hashes to decide "the run wrote this" are the bytes it
// parses, so a file that changes between the two can never pair one content's authorship with another's number.
// Asserted by counting reads of the artifact through a spy on node:fs. Synthetic data only.

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, readFileSync: vi.fn(real.readFileSync) };
});

const { extractMetrics } = await import("../src/metrics.js");

describe("one read per metric artifact", () => {
  it("a new file and a rewritten pre-run file are each read exactly once", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "metrics-1r-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "a.json"), '{"n":1}');
    writeFileSync(join(mnt, "outputs", "b.json"), '{"n":2}');
    const spy = vi.mocked(fs.readFileSync);
    spy.mockClear();
    const out = extractMetrics({ workRoot: mnt, userVisiblePrefixes: ["outputs"], preRunHashes: { "outputs/b.json": "0".repeat(64) } }, [
      { id: "a", artifact: "outputs/a.json", path: "n", better: "higher", scale: 1 },
      { id: "b", artifact: "outputs/b.json", path: "n", better: "higher", scale: 1 },
    ]);
    expect(out).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);
    const reads = spy.mock.calls.map((c) => String(c[0]));
    expect(reads.filter((p) => p.endsWith("a.json"))).toHaveLength(1);
    expect(reads.filter((p) => p.endsWith("b.json"))).toHaveLength(1);
  });
});
