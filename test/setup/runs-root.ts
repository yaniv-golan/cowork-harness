import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// EVERY TEST PROCESS GETS ITS OWN RUNS ROOT.
//
// `runsWriteRoot()` resolves to `COWORK_HARNESS_RUNS_DIR` or, failing that, the machine-global
// `~/.cowork-harness/runs`. Only 15 of 264 test files set that variable, so any test that spawns the CLI
// or calls `executeScenario` without it wrote into the DEVELOPER'S REAL runs root — a live directory that
// on this machine holds 122k files of history. Measured: a full suite run deposited two run dirs there,
// every time.
//
// That is worse than untidy. The migrator (`migrate-run-dir`) walks that same root, and `prune` deletes
// from it by a keep-count; a test suite writing into it means the population under test changes while it
// is being measured. It also silently invalidates any backup taken before the run.
//
// Fixing this per-file would mean auditing 30+ files and re-auditing every new one. Making the SAFE
// DEFAULT STRUCTURAL costs one file: a test that wants its own root still sets the variable and wins,
// because this only fills in a value when none is present.
//
// Subprocesses inherit this too — the CLI-spawning tests get it for free.
if (!process.env.COWORK_HARNESS_RUNS_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "cowork-test-runs-"));
  process.env.COWORK_HARNESS_RUNS_DIR = dir;
  // Only remove what we created. A test file that sets its own root owns its own cleanup.
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: a leaked temp dir is noise, a failed teardown that fails the suite is not */
    }
  });
}
