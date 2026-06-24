import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pMapBounded } from "../src/async-pool.js";

describe("pMapBounded — bounded-concurrency async map", () => {
  it("runs every item and preserves result order", async () => {
    const out = await pMapBounded([1, 2, 3, 4, 5], 2, async (x) => x * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency cap", async () => {
    let inflight = 0;
    let peak = 0;
    await pMapBounded(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return 0;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it actually overlapped
  });

  it("empty input → empty output, no calls", async () => {
    let calls = 0;
    const out = await pMapBounded([], 4, async () => (calls++, 1));
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("clamps concurrency to at least 1 (0 does not deadlock)", async () => {
    const out = await pMapBounded([1, 2], 0, async (x) => x);
    expect(out).toEqual([1, 2]);
  });

  it("a throwing item rejects the pool (callers that want per-item capture must not throw in fn)", async () => {
    await expect(
      pMapBounded([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!can)("record --concurrency validation", () => {
  it("out-of-range / non-integer → exit 2 (parse-time, no token needed)", () => {
    const d = mkdtempSync(join(tmpdir(), "rc-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["record", "s.yaml", "--concurrency", "0"], d).code).toBe(2);
    expect(run(["record", "s.yaml", "--concurrency", "99"], d).code).toBe(2);
    expect(run(["record", "s.yaml", "--concurrency", "abc"], d).code).toBe(2);
  });

  it("--concurrency on a SINGLE scenario → exit 2 (nothing to parallelize)", () => {
    const d = mkdtempSync(join(tmpdir(), "rc-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["record", "s.yaml", "--concurrency", "2"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/applies to a directory batch/);
  });

  it("dir batch with two scenarios sharing a cassette name → exit 2 (would clobber/race)", () => {
    const d = mkdtempSync(join(tmpdir(), "rc-"));
    const dir = join(d, "scenarios");
    mkdirSync(dir);
    // Same `name:` → same default cassette path → collision.
    writeFileSync(join(dir, "a.yaml"), "name: dup\nprompt: hi\nfidelity: container\n");
    writeFileSync(join(dir, "b.yaml"), "name: dup\nprompt: hey\nfidelity: container\n");
    // Dummy token so the pre-record auth guard passes and we reach the dir-batch dupe guard (which exits
    // BEFORE any live recording). The guard fires regardless of --concurrency value.
    const r = run(["record", dir], d, { ANTHROPIC_API_KEY: "sk-ant-dummy-for-guard-test" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/share a cassette output path/);
  });
});
