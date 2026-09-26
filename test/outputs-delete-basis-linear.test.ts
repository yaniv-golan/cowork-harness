import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PROBES } from "./helpers/outputs-delete-basis-probe.js";
import { BASIS_STATEMENT_CAP } from "../src/run/execute.js";

/**
 * `outputsDeleteBasis` runs synchronously, post-run, on every flagged command the agent wrote. A regex that
 * backtracks catastrophically hangs the harness process, so each probe runs in a CHILD process with a hard
 * SIGKILL timeout: a regression then FAILS this test in seconds instead of blocking the worker until CI kills
 * the job (an in-process timing assertion cannot fire while the regex holds the thread).
 *
 * Two budgets. The hang class — inputs that once took seconds to forever — must finish under 1 s. The
 * quadratic class — single 40–80k-character statements — must finish under 50 ms (best of 3 runs in the
 * child, so one scheduler hiccup does not fail it); the classifier caps what it scans per statement to get
 * there. Earlier in-process units (`x=1 sudo -u a nice -n 1`, `xargs -n 1 -I {}`, `2>a 1>b`) were measured
 * to stay fast even with the atomic prefix match removed, so they guarded nothing and are not kept.
 */
const PROBE = join(process.cwd(), "test/helpers/outputs-delete-basis-probe.ts");
const HANG_CLASS = new Set(["wrapper chain: timeout … env × 140", "comprehension: for + 2000 spaces × 2"]);

describe("outputsDeleteBasis never hangs and stays fast on huge statements", () => {
  it("the hang-class probes sit under the per-statement cap, so they exercise the operand-level regexes", () => {
    for (const name of HANG_CLASS) expect(PROBES[name]().length, name).toBeLessThan(BASIS_STATEMENT_CAP);
  });

  it.each(Object.keys(PROBES))(
    "%s",
    (name) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", PROBE, name], {
        encoding: "utf8",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
      expect(r.signal, `probe was killed (hung): ${name}`).toBeNull();
      expect(r.status, r.stderr).toBe(0);
      const { ms } = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { ms: number };
      expect(ms).toBeLessThan(HANG_CLASS.has(name) ? 1000 : 50);
    },
    15_000,
  );
});
