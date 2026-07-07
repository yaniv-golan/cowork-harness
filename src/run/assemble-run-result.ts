import type { RunResult } from "../types.js";

/**
 * Every key of `RunResult` made mandatory-to-supply, while each value KEEPS its original type
 * (including `| undefined` for the optional fields). This is deliberately NOT `Required<RunResult>`:
 * `Required<T>`'s `-?` modifier strips `undefined` from every value type, which would make
 * `partial: undefined` (and ~34 other `field: undefined` assignments the call sites need) a
 * `TS2322` compile error. `{ [K in keyof Required<RunResult>]: RunResult[K] }` forces presence
 * (keys are non-optional) without stripping `undefined` from the values. Verified against TS 6.0.3.
 */
export type CompleteRunResult = { [K in keyof Required<RunResult>]: RunResult[K] };

/**
 * The single seam every `RunResult`-producing lane must call. Its parameter has no optional keys,
 * so every one of `RunResult`'s ~37 optional keys must be supplied explicitly (a real value, or
 * `undefined` for a lane it doesn't apply to). This makes "a new field was wired into only some
 * producers" a compile error at every call site, not a silent runtime gap — the historical failure
 * mode this function exists to close off structurally.
 *
 * Deliberately just an identity function: this refactor changes NO lane's computed values, only
 * forces every lane to state its omissions explicitly instead of implicitly.
 *
 * Note the guarantee's scope: this forces every field to be *enumerated*, not to be *correct* — a
 * call site can still satisfy the compiler with `field: undefined` at a lane that should actually
 * compute a real value. That's an accepted tradeoff of this design, not a defect.
 */
export function assembleRunResult(fields: CompleteRunResult): RunResult {
  return fields;
}
