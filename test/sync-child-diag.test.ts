import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bounded } from "./setup/sync-child-diag.mjs";

// The watchdog bounds every stack dump (gdb, sample) from OUTSIDE its own process, because a gdb attached to the
// fork stops the watchdog's thread too, and a timer there could never fire. spawnSync below blocks this process
// completely, the same way: so if the command still ends on time, the kill came from outside.

function blockedRun(argv: [string, string[]]) {
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv[1], { stdio: "ignore" });
  return { ms: Date.now() - t0, status: r.status, signal: r.signal };
}

describe("the sync-child watchdog's diagnostic bound", () => {
  it("ends a wedged diagnostic from outside the blocked process", () => {
    const r = blockedRun(bounded(1, "sleep", ["600"]));
    expect(r.ms).toBeLessThan(8_000);
    expect(r.status === 0 && r.signal === null).toBe(false);
  });

  it("passes a normal diagnostic's result through", () => {
    const r = spawnSync(...bounded(5, "sh", ["-c", "echo ok"]), { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  // GitHub's runner user has passwordless sudo; there the bound must also work as root (a root gdb).
  it.skipIf(process.platform !== "linux" || spawnSync("sudo", ["-n", "true"]).status !== 0)(
    "ends a wedged root diagnostic when the bound runs under sudo too",
    () => {
      const [cmd, args] = bounded(1, "sleep", ["600"]);
      const r = blockedRun(["sudo", ["-n", cmd, ...args]]);
      expect(r.ms).toBeLessThan(8_000);
    },
  );
});
