import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTrace, noteIfMultiTurn } from "../src/run/trace-view.js";

// Two consumers of a multi-turn run dir, fixed together because they are the same defect at opposite
// ends: one CERTIFIED the wrong turn, the other SHOWED two turn scopes at once.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "multi-turn-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const marker = JSON.stringify({ _emu: "turn_start", turn: 2 });
const toolUse = (name: string, id: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } });

describe("trace shows ONE turn scope, not two", () => {
  // Once `readTimeline` became turn-scoped, `--view tool-durations` folded the latest turn while
  // tools/questions/dispatches still folded EVERY turn — two views of one run dir describing different
  // scopes, in the command docs/debugging.md tells users to trust for "how many sub-agents REALLY
  // dispatched?". This series introduced that inconsistency; these pin the fix.
  it("scopes the tools view to the latest turn", () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, [toolUse("Bash", "t1"), marker, toolUse("Read", "t2")].join("\n") + "\n");
    const rows = buildTrace(file, { tools: true });
    const names = JSON.stringify(rows);
    expect(names).toContain("Read");
    expect(names, "the prior turn's tool calls are still in the trace").not.toContain("Bash");
  });

  it("is unchanged on a single-turn dir", () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, [toolUse("Bash", "t1"), toolUse("Read", "t2")].join("\n") + "\n");
    expect(JSON.stringify(buildTrace(file, { tools: true }))).toContain("Bash");
  });

  it("SAYS the earlier turns exist rather than silently hiding them", () => {
    // Scoping without saying so would trade a mixed-scope bug for an invisible-evidence one.
    const file = join(dir, "events.jsonl");
    writeFileSync(file, [toolUse("Bash", "t1"), marker, toolUse("Read", "t2")].join("\n") + "\n");
    expect(noteIfMultiTurn(file)).toMatch(/more than one turn/i);
  });

  it("stays quiet on a single-turn dir", () => {
    const file = join(dir, "events.jsonl");
    writeFileSync(file, toolUse("Bash", "t1") + "\n");
    expect(noteIfMultiTurn(file)).toBeUndefined();
  });
});

describe("verify-run refuses a multi-turn dir", () => {
  // Root result.json is the LATEST turn. On a `critique` dir that is the REFLECTION turn while the
  // scenario describes the GRADED one — so certifying it would vouch for the wrong turn. The rejected
  // alternative (scope this command to "the latest turn") would have turned today's LOUD false-fail into
  // a SILENT false-green, which is the one direction this project must never move in.
  const FULL = readFileSyncSafe("src/cli.ts");
  // Scope to cmdVerifyRun's body: `parseGatesFromEvents`'s DEFINITION sits earlier in the file than the
  // guard, so a whole-file position check compares against the wrong occurrence (it did, first run).
  const SRC = FULL.slice(FULL.indexOf("async function cmdVerifyRun"));

  it("has a turn>1 refusal at all", () => {
    expect(SRC, "the multi-turn refusal is gone").toMatch(/result\.turn === "number" && result\.turn > 1/);
  });

  it("refuses BEFORE evaluating anything (fail-closed, like the partial/replay/chat guards)", () => {
    const guard = SRC.indexOf('result.turn === "number" && result.turn > 1');
    const gates = SRC.indexOf("parseGatesFromEvents");
    expect(guard).toBeGreaterThan(-1);
    expect(gates, "parseGatesFromEvents moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(guard, "the refusal must precede any gate/assert evaluation").toBeLessThan(gates);
  });

  it("names how to reach the graded turn, so the caller is not stuck", () => {
    const slice = SRC.slice(
      SRC.indexOf('result.turn === "number" && result.turn > 1'),
      SRC.indexOf('result.turn === "number" && result.turn > 1') + 1200,
    );
    expect(slice).toContain("result.graded.json");
  });
});

function readFileSyncSafe(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(join(process.cwd(), rel), "utf8");
}
