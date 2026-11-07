/**
 * Requested exits, without `process.exit`.
 *
 * `process.exit` from deep inside a command ends the process while its event loop still holds work, and on Node 24+
 * that can deadlock inside the exit itself. A command now asks to exit by throwing {@link ExitRequested} through
 * {@link exitWith}; the top level sets `process.exitCode` and lets the loop drain, and a fallback timer exits only if
 * something is still holding it.
 *
 * The first requested code wins, as the first `process.exit` did: a catch that swallows the request cannot turn it
 * into a later, different code without the top level noticing (it prints a warning naming both).
 */

/** Thrown by {@link exitWith}. Not an error: every broad `catch` that can see one must rethrow it ({@link rethrowIfExit}). */
export class ExitRequested extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit requested (code ${code})`);
    this.name = "ExitRequested";
    this.code = code;
  }
}

let latched: number | undefined;
/** The code of the first exit request that reached a top-level handler (the settle arms or a process-level one). */
let reachedTop: number | undefined;

/** Ask the process to exit with `code` once the current work unwinds. Never returns. */
export function exitWith(code: number): never {
  if (latched === undefined) {
    latched = code;
    process.exitCode = code;
  }
  throw new ExitRequested(code);
}

/** The first code {@link exitWith} was asked for, if any. */
export function latchedExitCode(): number | undefined {
  return latched;
}

/** The first statement of a broad `catch`: an exit request is not this catch's to handle. */
export function rethrowIfExit(e: unknown): void {
  if (e instanceof ExitRequested) throw e;
}

/** Test-only: forget the latched code (an in-process test file shares one module instance across its tests). */
export function __resetExitLatch(): void {
  latched = undefined;
  reachedTop = undefined;
}

/**
 * Settle the process's exit code once the command is done, `arrived` being the code of an exit request that reached
 * the top level (undefined when the command finished without one). The first requested code wins. When a request was
 * made but a catch swallowed it, or a different code arrived after it, a warning names it: that is a bug in the catch,
 * and before this design it was invisible. Returns the code the process will exit with.
 */
export function settleExitCode(arrived: number | undefined, warn: (line: string) => void): number | undefined {
  if (arrived !== undefined) reachedTop ??= arrived;
  if (latched !== undefined && reachedTop === undefined)
    warn(`::warning:: [exit] an exit (code ${latched}) was caught and dropped before it reached the top level\n`);
  else if (latched !== undefined && arrived !== undefined && arrived !== latched)
    warn(
      `::warning:: [exit] an exit (code ${latched}) was caught and dropped before it reached the top level; exiting ${latched}, not ${arrived}\n`,
    );
  const code = latched ?? arrived;
  if (code !== undefined) process.exitCode = code;
  return code;
}

/** How long the event loop may stay busy after the command is done before the fallback ends the process. */
export const EXIT_FALLBACK_MS = 5000;
let fallbackArmed = false;

/**
 * Arm the fallback: an unref'd timer, so it fires only if something still holds the event loop after the command is
 * done (`process.getActiveResourcesInfo()` non-empty; that API is experimental on Node 22). It names the kinds still
 * holding the loop on stderr, then exits with the settled code. Idempotent.
 */
export function armExitFallback(warn: (line: string) => void, ms = EXIT_FALLBACK_MS): void {
  if (fallbackArmed) return;
  fallbackArmed = true;
  const t = setTimeout(() => {
    let kinds = "unknown";
    try {
      const counts = new Map<string, number>();
      for (const k of process.getActiveResourcesInfo()) counts.set(k, (counts.get(k) ?? 0) + 1);
      kinds = [...counts].map(([k, n]) => `${k}×${n}`).join(", ") || "none";
    } catch {
      /* experimental API: name nothing rather than fail the exit */
    }
    warn(`::warning:: [exit] the event loop was still busy ${ms / 1000}s after the command finished (${kinds}); exiting now\n`);
    process.exit(process.exitCode ?? 0); // exit-allowed: the fallback, the one place a requested exit ends the process
  }, ms);
  t.unref();
}

/** The fallback's warning text starts with this; tests assert its absence. */
export const EXIT_FALLBACK_LINE = "::warning:: [exit] the event loop was still busy";

export interface TopLevelExitHooks {
  /** Kill what would otherwise keep the loop alive (helper process groups). Runs before the fallback is armed. */
  sweep: () => void;
  warn: (line: string) => void;
}

let handlersInstalled = false;

/**
 * The process-level half of the top-level catch, for an exit requested from an event callback (a stream or child
 * handler) where no `await` chain carries it to the settle arms. Installed from the CLI entry only, never at import.
 *
 * Any other uncaught error ends the process with its stack and exit 1, as Node's default does, but only while this
 * is the only listener: a later listener (analyze-artifact-runtime records a page's async throw as a crash) owns the
 * error then.
 */
export function installExitHandlers(hooks: TopLevelExitHooks): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const onError = (event: "uncaughtException" | "unhandledRejection") => (e: unknown) => {
    if (e instanceof ExitRequested) {
      settleExitCode(e.code, hooks.warn);
      hooks.sweep();
      armExitFallback(hooks.warn);
      return;
    }
    if (process.listenerCount(event) > 1) return;
    try {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    } finally {
      process.exit(1); // exit-allowed: an uncaught error, as Node's default handling would end the process
    }
  };
  process.on("uncaughtException", onError("uncaughtException"));
  process.on("unhandledRejection", onError("unhandledRejection"));
}

/** Test-only: whether {@link installExitHandlers} has run in this process. */
export function exitHandlersInstalled(): boolean {
  return handlersInstalled;
}
