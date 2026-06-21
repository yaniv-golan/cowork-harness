import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:child_process so probeImageOmitted's `image inspect` + `run …` spawnSync calls are scriptable.
// The module under test imports spawnSync directly, so a module-level mock intercepts both call sites.
const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...a: unknown[]) => spawnSync(...a) }));

import { probeImageOmitted } from "../src/runtime/image-capabilities.js";

const TIER = "container";
const IMAGE = "cowork-agent-base:2";

/** Build a spawnSync result for `image inspect` (id+created) or the capability `run` probe. */
function inspectResult(idCreated: string | null) {
  return idCreated === null ? { status: 1, stdout: "", stderr: "no such image" } : { status: 0, stdout: idCreated + "\n", stderr: "" };
}
function probeRun(presentFamilies: string[]) {
  return { status: 0, stdout: `COWORK_PRESENT: ${presentFamilies.join(" ")}\n`, stderr: "" };
}

/** Route a spawnSync call to inspect-vs-run based on argv. */
function router(inspect: () => any, run: () => any) {
  return (_cmd: string, args: string[]) => (args[0] === "image" && args[1] === "inspect" ? inspect() : run());
}

let runsDir: string;
const newWarnSpy = () => vi.spyOn(process.stderr, "write").mockReturnValue(true);
let warnSpy: ReturnType<typeof newWarnSpy>;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "cap-cache-"));
  process.env.COWORK_HARNESS_RUNS_DIR = runsDir;
  spawnSync.mockReset();
  warnSpy = newWarnSpy();
});
afterEach(() => {
  delete process.env.COWORK_HARNESS_RUNS_DIR;
  warnSpy.mockRestore();
});

const cacheFile = () => join(runsDir, "capability-cache.json");

describe("probeImageOmitted cache key — (content-addressed, not the mutable tag)", () => {
  it("keys the persisted cache by the content-addressed image id, so a rebuilt-in-place tag is NOT reused", () => {
    // Run 1: image id sha-A, present={ocr} → omits everything but ocr; persisted under the id-based key.
    spawnSync.mockImplementation(
      router(
        () => inspectResult("sha256:AAA 2026-01-01T00:00:00Z"),
        () => probeRun(["ocr"]),
      ),
    );
    const first = probeImageOmitted({ runtime: "docker", image: IMAGE, tier: TIER });
    expect(first).not.toBeNull();
    expect(first).not.toContain("ocr");
    const probeRunsAfterFirst = spawnSync.mock.calls.filter((c) => c[1][0] === "run").length;
    expect(probeRunsAfterFirst).toBe(1);

    // Run 2: SAME tag rebuilt in place → NEW image id sha-B, now present={ocr, cv}. The stale entry must NOT
    // be reused: a fresh probe runs and cv is no longer reported omitted.
    spawnSync.mockImplementation(
      router(
        () => inspectResult("sha256:BBB 2026-02-02T00:00:00Z"),
        () => probeRun(["ocr", "cv"]),
      ),
    );
    const second = probeImageOmitted({ runtime: "docker", image: IMAGE, tier: TIER });
    expect(second).not.toContain("cv"); // proves the rebuilt image was re-probed, not served from sha-A's cache
    const probeRunsAfterSecond = spawnSync.mock.calls.filter((c) => c[1][0] === "run").length;
    expect(probeRunsAfterSecond).toBe(2); // a second live probe happened (no stale cache hit)

    // Same id, second call → served from cache (no third probe).
    spawnSync.mockImplementation(
      router(
        () => inspectResult("sha256:BBB 2026-02-02T00:00:00Z"),
        () => probeRun(["ocr", "cv"]),
      ),
    );
    probeImageOmitted({ runtime: "docker", image: IMAGE, tier: TIER });
    expect(spawnSync.mock.calls.filter((c) => c[1][0] === "run").length).toBe(2); // unchanged → cache hit
  });

  it("does NOT persist to disk and WARNS when no content digest is available (inspect fails → only the mutable tag)", () => {
    spawnSync.mockImplementation(
      router(
        () => inspectResult(null),
        () => probeRun(["ocr"]),
      ),
    );
    const omitted = probeImageOmitted({ runtime: "docker", image: IMAGE, tier: TIER });
    expect(omitted).not.toBeNull();

    // Uncacheable tag → cache file must not gain an entry for it.
    const onDisk = existsSync(cacheFile()) ? JSON.parse(readFileSync(cacheFile(), "utf8")) : {};
    expect(Object.keys(onDisk)).not.toContain(`${TIER}:${IMAGE}`);
    expect(onDisk).toEqual({});

    // The user is told why the probe isn't cached this run.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(warned).toMatch(/could not read a content digest/i);
    expect(warned).toMatch(/NOT cached this run/i);
  });

  it("re-probes every run for an uncacheable tag (a rebuild can never serve stale data)", () => {
    spawnSync.mockImplementation(
      router(
        () => inspectResult(null),
        () => probeRun(["ocr"]),
      ),
    );
    probeImageOmitted({ runtime: "docker", image: IMAGE, tier: TIER });
    probeImageOmitted({ runtime: "docker", image: IMAGE, tier: TIER });
    // Two probe runs, no cache short-circuit.
    expect(spawnSync.mock.calls.filter((c) => c[1][0] === "run").length).toBe(2);
  });
});
