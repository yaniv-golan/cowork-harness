import { describe, it, expect } from "vitest";
import { validateReflectionTurn } from "../src/critique/command.js";

/** The critique loop passes `--session-id crit-<uuid>`, but a session-pinned run dir is named
 *  `sess-<id>` (execute.ts's `local_<hrtime> | sess-<id>` convention). The protocol check compared
 *  `basename(outDir)` against the raw session id, so the prefix made every reflection turn look like a
 *  resume of a different session — a live smoke of `cowork-harness critique` failed on exactly this,
 *  with the evaluator (correctly) never invoked. */
const SESSION = "crit-593ac9f9-0da5-4994-b0e2-f8345ebd70a4";
const OUT_DIR = `/runs/skill-x/sess-${SESSION}`;

function turn(over: Record<string, unknown> = {}) {
  return {
    timedOut: false,
    truncated: false,
    stdout: JSON.stringify({ ok: true, results: [{ turn: 2, outDir: OUT_DIR, result: "success" }] }),
    code: 0,
    ...over,
  } as Parameters<typeof validateReflectionTurn>[0];
}

describe("validateReflectionTurn session-id round-trip", () => {
  it("accepts a run dir whose basename carries the `sess-` prefix", () => {
    const r = validateReflectionTurn(turn(), SESSION, OUT_DIR);
    expect(r.ok).toBe(true);
  });

  it("still rejects a genuinely different session", () => {
    const otherDir = "/runs/skill-x/sess-crit-deadbeef";
    const r = validateReflectionTurn(
      turn({ stdout: JSON.stringify({ ok: true, results: [{ turn: 2, outDir: otherDir, result: "success" }] }) }),
      SESSION,
      otherDir,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/session id/);
  });
});
