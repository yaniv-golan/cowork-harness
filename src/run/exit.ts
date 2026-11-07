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
}
