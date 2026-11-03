import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The per-run directory the sync-child watchdog (test/setup/sync-child-watchdog.ts) writes its dumps to, and the
// run's backstop. Each vitest fork's watchdog fails the TEST that hung (its afterEach), but a hang inside a
// beforeAll/afterAll or at module load has no afterEach to fail: once the watchdog kills the stuck child, that hook
// finishes and the file would pass. So the run itself fails here whenever this run wrote any dump.
//
// The directory is unique per run (mkdtemp under the base), so dumps from an earlier run, or from a child vitest a
// test starts with its own base, can never fail this one. Set COWORK_TEST_HANG_DIR to choose the base (CI points it
// at the uploaded artifact directory); the default is <tmpdir>/cowork-test-hangs. A clean run removes its directory.
export default function setup(): () => void {
  const base = process.env.COWORK_TEST_HANG_DIR || join(tmpdir(), "cowork-test-hangs");
  mkdirSync(base, { recursive: true });
  const run = mkdtempSync(join(base, "run-"));
  // Set before the pool starts, so every fork inherits it.
  process.env.COWORK_TEST_HANG_RUN_DIR = run;
  return () => {
    const events = readdirSync(run).sort();
    if (events.length === 0) {
      rmSync(run, { recursive: true, force: true });
      return;
    }
    const lines = events.map((e) => {
      try {
        const s = JSON.parse(readFileSync(join(run, e, "summary.json"), "utf8")) as {
          file?: string;
          children?: { command: string }[];
          silentMs?: number;
        };
        const what = s.children?.length ? s.children.map((c) => c.command).join(" | ") : "(no child: the fork's own thread was blocked)";
        return `  ${e}: ${s.file ?? "?"} — blocked ${Math.round((s.silentMs ?? 0) / 1000)}s on ${what}`;
      } catch {
        return `  ${e}: (no readable summary.json)`;
      }
    });
    throw new Error(`a test process was blocked past the sync-child watchdog's limit; stacks are in ${run}:\n${lines.join("\n")}`);
  };
}
