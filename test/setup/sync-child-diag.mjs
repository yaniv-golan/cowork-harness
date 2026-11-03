// Diagnostic-command bounding for the sync-child watchdog's worker thread (sync-child-watchdog-worker.mjs), in its
// own module so test/sync-child-diag.test.ts can exercise it.

/**
 * `[cmd, args]` that runs `cmd args` and has a SEPARATE process kill it after `sec` seconds: coreutils `timeout` on
 * Linux (TERM, then KILL 5 s later), a perl alarm-then-exec wrapper elsewhere (macOS has no `timeout`). The caller's
 * own timers cannot be trusted for this: a gdb attached to the caller's process stops every thread in it.
 * Under sudo, put the whole result after `sudo -n`, so the killer runs as the same user as the diagnostic.
 */
export function bounded(sec, cmd, args) {
  if (process.platform === "linux") return ["timeout", ["-s", "TERM", "-k", "5", String(sec), cmd, ...args]];
  return ["perl", ["-e", "alarm shift; exec @ARGV or die $!", String(sec), cmd, ...args]];
}
