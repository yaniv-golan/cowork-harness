// The child_process wrapper used by test/setup/sync-child-watchdog.ts, in its own module so the transparency test
// can import it without starting a watchdog.

/** Slot of the shared array holding the running sync call's declared timeout (ms; 0 = none). */
export const CALL_TIMEOUT = 1;
/** Slot holding when the running sync call started (epoch ms; 0 = no call running). */
export const CALL_START = 5;

/** The options object of a child_process sync call: the last plain-object argument after the command. */
export function optionsOf(args: unknown[]): { timeout?: unknown } | undefined {
  for (let i = args.length - 1; i >= 1; i--) {
    const a = args[i];
    if (a !== null && typeof a === "object" && !Array.isArray(a)) return a as { timeout?: unknown };
  }
  return undefined;
}

/**
 * Wrap one synchronous child_process function so the watchdog knows the call's declared timeout while it runs.
 * Exported for the transparency test; everything observable (return value, thrown error, `this`, arguments) passes
 * through untouched.
 */
export function wrapSync<F extends (...args: never[]) => unknown>(orig: F, slots: BigInt64Array): F {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const t = optionsOf(args)?.timeout;
    Atomics.store(slots, CALL_TIMEOUT, typeof t === "number" && Number.isFinite(t) && t > 0 ? BigInt(Math.ceil(t)) : 0n);
    Atomics.store(slots, CALL_START, BigInt(Date.now()));
    try {
      return (orig as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } finally {
      Atomics.store(slots, CALL_START, 0n);
      Atomics.store(slots, CALL_TIMEOUT, 0n);
    }
  };
  Object.defineProperty(wrapped, "name", { value: orig.name });
  Object.defineProperty(wrapped, "length", { value: orig.length });
  return wrapped as unknown as F;
}
