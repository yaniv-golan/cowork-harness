import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile, beginTurn } from "../src/run/execute.js";
import { ResourceSampler, foldResources } from "../src/runtime/resource-sampler.js";

// THE GAP THIS CLOSES.
//
// Every other test in this feature FABRICATES a run directory and then asserts about it. That is why the
// layout shipped with resource telemetry DEAD on every live sandboxed run: the sampler opened
// `turns/<N>/resources.jsonl` at run start, nothing created that directory until post-run, every sample
// threw ENOENT into a swallowed warning — and not one unit test noticed, because none of them ever drove
// the real startup ordering.
//
// A fabricated directory cannot catch a writer that never writes. These drive the real code.

let runsRoot: string;
let prevRunsDir: string | undefined;
beforeEach(() => {
  prevRunsDir = process.env.COWORK_HARNESS_RUNS_DIR;
  runsRoot = mkdtempSync(join(tmpdir(), "layout-e2e-"));
  process.env.COWORK_HARNESS_RUNS_DIR = runsRoot;
});
afterEach(() => {
  if (prevRunsDir === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
  else process.env.COWORK_HARNESS_RUNS_DIR = prevRunsDir;
  rmSync(runsRoot, { recursive: true, force: true });
});

/** A `protocol`-tier scenario: no real agent binary spawns, so this is token-free and needs no Docker.
 *  It still drives the REAL executeScenario startup/teardown, which is the whole point — and that takes
 *  longer than vitest's 5s default, hence the explicit per-test timeouts below. */
function protocolScenario(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "layout-scn-"));
  const f = join(dir, `${name}.yaml`);
  writeFileSync(f, `name: ${name}\nbaseline: latest\nsession: (inline)\nfidelity: protocol\nprompt: hi\n`);
  return parseScenarioFile(f);
}

describe("a REAL run produces the per-turn layout on disk", () => {
  it("writes turns/1/ with the per-turn artifacts, and a root compat copy", async () => {
    const res = await executeScenario(protocolScenario("e2e-layout"), {});
    const outDir = res.outDir;

    const turn1 = join(outDir, "turns", "1");
    expect(existsSync(turn1), `no turns/1 in a real run dir — root held: ${readdirSync(outDir).join(", ")}`).toBe(true);
    for (const a of ["result.json", "run.jsonl", "trace.json"]) {
      expect(existsSync(join(turn1, a)), `turns/1/${a} was not written by a real run`).toBe(true);
    }

    // The documented compatibility alias, and it must agree with the turn it copies.
    expect(existsSync(join(outDir, "result.json")), "the root compat copy is missing").toBe(true);
    expect(readFileSync(join(outDir, "result.json"), "utf8")).toBe(readFileSync(join(turn1, "result.json"), "utf8"));
  }, 60_000);

  it("leaves the cumulative streams and session state at the ROOT, not inside turns/", async () => {
    // These must not move: `critique`'s turn-1 isolation proof records byte offsets into events.jsonl and
    // timeline.jsonl, and `cassette.events` is events.jsonl verbatim.
    const res = await executeScenario(protocolScenario("e2e-streams"), {});
    const outDir = res.outDir;
    for (const f of ["events.jsonl", "timeline.jsonl", "status.json"]) {
      expect(existsSync(join(outDir, f)), `${f} must stay at the run-dir root`).toBe(true);
    }
    expect(existsSync(join(outDir, "turns", "1", "events.jsonl")), "events.jsonl must NOT be per-turn").toBe(false);
  }, 60_000);

  it("a single-turn run has exactly one turn dir", async () => {
    const res = await executeScenario(protocolScenario("e2e-single"), {});
    const outDir = res.outDir;
    expect(readdirSync(join(outDir, "turns")).sort()).toEqual(["1"]);
  }, 60_000);
});

describe("the sampler can actually WRITE where beginTurn puts it", () => {
  // The precise mechanism of the dead-telemetry bug: turn-aware addressing with no directory to write
  // into. Driving the two real components together catches it without a container — the e2e run above
  // cannot, because the sampler only runs at container/hostloop/microvm tiers.
  it("samples land in turns/<N>/resources.jsonl and fold back out", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "sampler-"));
    const turn = beginTurn(outDir);
    const s = new ResourceSampler(outDir, "container", async () => ({ ts: Date.now(), rssBytes: 4242 }), 5, turn);
    s.start();
    await new Promise((r) => setTimeout(r, 40));
    await s.stop();

    const path = join(outDir, "turns", String(turn), "resources.jsonl");
    expect(existsSync(path), "the sampler wrote nothing — beginTurn did not create the dir it opens").toBe(true);
    expect(foldResources(outDir, "container", 5, undefined, turn)?.peakRssBytes).toBe(4242);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("a retried turn does not fuse its samples with the crashed attempt's", async () => {
    // The sampler APPENDS, and a retry reuses its own turn dir.
    const outDir = mkdtempSync(join(tmpdir(), "sampler-retry-"));
    const turn = beginTurn(outDir);
    for (const rss of [900_000_000, 1_000]) {
      const s = new ResourceSampler(outDir, "container", async () => ({ ts: Date.now(), rssBytes: rss }), 5, turn);
      s.start();
      await new Promise((r) => setTimeout(r, 40));
      await s.stop();
    }
    expect(foldResources(outDir, "container", 5, undefined, turn)?.peakRssBytes, "the crashed attempt's peak leaked into the retry").toBe(
      1_000,
    );
    rmSync(outDir, { recursive: true, force: true });
  });
});
