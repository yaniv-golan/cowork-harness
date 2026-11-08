import { afterEach, describe, it, expect } from "vitest";
import { PROBES, SPIN_PROBE, SPINNING, killLiveProbes, probeSpawn, runProbe } from "./helpers/outputs-delete-basis-probe.js";
import { BASIS_STATEMENT_CAP, BASIS_COMMAND_CAP } from "../src/run/execute.js";

/**
 * `outputsDeleteBasis` runs synchronously, post-run, on every flagged command the agent wrote. A regex that
 * backtracks catastrophically hangs the harness process, so each probe runs in a CHILD process under a kernel
 * CPU-time limit: a regression then FAILS this test instead of blocking the worker until CI kills the job (an
 * in-process timing assertion cannot fire while the regex holds the thread). The limit counts CPU, not wall time,
 * because the child's startup and tsx compile wait for a core on a loaded runner, and that is not a hang.
 *
 * Two budgets. The hang class — inputs that once took seconds to forever — must finish under 1 s. Everything else
 * — mostly single 40–80k-character statements — must finish under `BUDGET_MS` (best of 3 runs in the child); the
 * classifier caps what it scans per statement to get there. Every budget is CPU time, not wall time: under load the
 * worst probe's wall time tripled (~8 to ~32 ms) while its CPU time stayed ~10 ms, so a wall budget failed whenever
 * the machine was busy. CPU time inflates under load too, several times over, which sets the floor. The ceiling is
 * set by the regressions this must catch: without the expansion budget one probe's scan costs ~500 ms, and without
 * both size caps another's classifier costs ~580 ms. Earlier in-process units (`x=1 sudo -u a nice -n 1`, `xargs -n 1 -I {}`, `2>a 1>b`) were measured
 * to stay fast even with the atomic prefix match removed, so they guarded nothing and are not kept.
 */
const BUDGET_MS = 250;
const HANG_CLASS = new Set(["wrapper chain: timeout … env × 140", "comprehension: for + 2000 spaces × 2"]);

describe("outputsDeleteBasis never hangs and stays fast on huge statements", () => {
  afterEach(killLiveProbes);

  it("the hang-class probes sit under the per-statement cap, so they exercise the operand-level regexes", () => {
    for (const name of HANG_CLASS) expect(PROBES[name]().length, name).toBeLessThan(BASIS_STATEMENT_CAP);
  });
  it("the 'under the command cap' probes sit under it, so the pre-split passes run on them", () => {
    const under = Object.keys(PROBES).filter((n) => n.startsWith("under the command cap"));
    expect(under.length).toBeGreaterThan(0);
    for (const name of under) expect(PROBES[name]().length, name).toBeLessThan(BASIS_COMMAND_CAP);
  });

  it.each(Object.keys(PROBES))(
    "%s",
    async (name) => {
      const r = await runProbe(name);
      expect(r.signal, `probe was killed (hung): ${name}`).toBeNull();
      expect(r.status, r.stderr).toBe(0);
      const { ms, detectorMs, scanMs, flagged, basis } = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        ms: number;
        detectorMs: number;
        scanMs: number;
        flagged: boolean;
        basis: string;
      };
      // Every probe is a FLAGGED command — the classifier only runs on those, and an unflagged probe would
      // time a code path production never reaches.
      expect(flagged, "probe must be flagged by the detector").toBe(true);
      expect(ms).toBeLessThan(HANG_CLASS.has(name) ? 1000 : BUDGET_MS);
      // The detector runs first on the same text; bound it too (looser: it has no size cap of its own).
      expect(detectorMs).toBeLessThan(HANG_CLASS.has(name) ? 1000 : BUDGET_MS);
      // …and the whole scan a run pays per command: the detector over every writable mount plus the finding
      // snippet's own expansion passes.
      expect(scanMs).toBeLessThan(HANG_CLASS.has(name) ? 1000 : BUDGET_MS);
      // Under the budget the exact expansion must actually run (over it the answer would be the stricter
      // `named`), or the probe would not be measuring it.
      if (name.startsWith("under the expansion budget")) expect(basis).toBe("inferred");
    },
    90_000,
  );
});

describe("the probe's hang killer counts CPU time, never wall time", () => {
  afterEach(killLiveProbes);

  it("spawns with no wall-clock kill, and hands the probe's name to the shell as an argument", () => {
    const name = 'eval " repeated, 40k';
    const { args, options } = probeSpawn(name);
    expect(options).not.toHaveProperty("timeout");
    expect(options).not.toHaveProperty("killSignal");
    expect(args[1]).not.toContain(name);
    expect(args.at(-1)).toBe(name);
  });

  it("a probe held stopped for longer than any wall-clock limit would allow still finishes normally", async () => {
    const t0 = Date.now();
    const r = await runProbe("tiny segments: $a; × 2000", {
      onSpawn: (child) => {
        child.kill("SIGSTOP");
        setTimeout(() => child.kill("SIGCONT"), 6000);
      },
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6000);
    expect(r.signal, r.stderr).toBeNull();
    expect(r.status, r.stderr).toBe(0);
  }, 90_000);

  it("a probe that spins is killed by the CPU limit, after its whole import graph has loaded", async () => {
    // No signal name: macOS sends SIGXCPU and Linux SIGKILL. A SIGXCPU listener anywhere in the import graph would
    // leave the spin running on macOS, and this would time out. The limit leaves room for the import on a loaded runner.
    const r = await runProbe(SPIN_PROBE, { cpuLimitS: 10 });
    expect(r.stdout).toContain(SPINNING);
    expect(r.status, r.stderr).toBeNull();
    expect(r.signal, r.stderr).not.toBeNull();
  }, 90_000);
});
