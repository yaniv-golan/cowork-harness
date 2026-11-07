// The replay contract every cassette this build reads must carry: its recorded control responses (`controlOut`) and
// the mount roots its manifest is replayed under (`userVisibleRoots`). A test that hand-builds a cassette supplies them
// through here so a fixture states the contract instead of reaching a refusal it did not mean to test.

/** The `initialize` request every real recording's `controlOut` starts with. */
export const INIT_CONTROL_LINE = JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });

/** A recording's control stream with nothing in it but the `initialize` request: no decision was answered. */
export function recordedControlOut(): string[] {
  return [INIT_CONTROL_LINE];
}

/** An EMPTY control stream — loads, and every decision in the events is then unanswered (a truncated cassette). Named
 *  so a test reaches it only on purpose. */
export function emptyControlOut(): string[] {
  return [];
}

/** The roots a recording without connected folders carries (what replay fell back to before the field was required). */
export const DEFAULT_USER_VISIBLE_ROOTS = ["outputs", ".projects"];

/** `c` with the replay contract filled in where the fixture left it out; fields it set are kept. */
export function withReplayContract<T extends object>(c: T): T & { controlOut: string[]; userVisibleRoots: string[] } {
  const o = c as T & { controlOut?: string[]; userVisibleRoots?: string[] };
  return {
    ...o,
    controlOut: o.controlOut ?? recordedControlOut(),
    userVisibleRoots: o.userVisibleRoots ?? [...DEFAULT_USER_VISIBLE_ROOTS],
  };
}
