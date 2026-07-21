import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentTurnEventLines } from "../src/run/turn-events.js";
import { beginTurn, scanEvents, findUngatedPathToolCalls } from "../src/run/execute.js";
import { detectCapabilityUse } from "../src/runtime/image-capabilities.js";

// `events.jsonl` is append-only across turns with no per-turn header, so every whole-file scanner also
// saw the PRIOR turn's events. Three of those scanners decide the run's OUTCOME:
//   * scanEvents        -> outputsDeletes / hostPathLeaked  -> severity:"fail" verdict signals
//   * findUngatedPathToolCalls -> record.result = "error"
//   * detectCapabilityUse      -> missing_capability, a fail signal
// So on any --resume — every `critique` reflection turn — turn 1's evidence FAILED turn 2. These are
// false-FAILs (wrong red), the mirror of the timeline fix's false-PASS.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "events-turns-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bash = (cmd: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } });
const DELETE = bash("rm -rf /sessions/x/mnt/outputs/report.md");
const write = (...lines: string[]) => writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
/** Makes `currentTurn()` return 2, so `beginTurn` treats this as a resumed turn. */
/** Make the dir look like a completed turn 1, so the next `beginTurn` is turn 2.
 *
 *  This used to write a ROOT `run.jsonl`, which counted as a turn only through `currentTurn`'s legacy
 *  union — deleted with the legacy layer. The union is gone, so a completed turn is now what the writer
 *  actually produces: `turns/1/run.jsonl`. Same intent (these tests are about SCOPING, not layout), only
 *  the way a turn is spelled has changed. */
const asResumedTurn = () => {
  mkdirSync(join(dir, "turns", "1"), { recursive: true });
  writeFileSync(join(dir, "turns", "1", "run.jsonl"), "{}\n");
};

describe("beginTurn scopes the append-through-the-turn streams", () => {
  it("a turn-1 outputs-delete no longer fails turn 2", () => {
    write(DELETE);
    asResumedTurn();
    expect(scanEvents(join(dir, "events.jsonl")).outputsDeletes, "precondition: the delete is detectable").toHaveLength(1);
    beginTurn(dir);
    expect(scanEvents(join(dir, "events.jsonl")).outputsDeletes, "turn 1's delete still fails turn 2").toHaveLength(0);
  });

  it("a turn-2 delete DOES still fail turn 2", () => {
    // Without this, the test above passes by simply breaking detection.
    write(DELETE);
    asResumedTurn();
    beginTurn(dir);
    writeFileSync(join(dir, "events.jsonl"), readFileSync(join(dir, "events.jsonl"), "utf8") + DELETE + "\n");
    expect(scanEvents(join(dir, "events.jsonl")).outputsDeletes).toHaveLength(1);
  });

  it("does nothing on turn 1 — events.jsonl stays BYTE-IDENTICAL", () => {
    // The containment claim that keeps cassettes unaffected (cassette.events is this file verbatim).
    write(DELETE);
    const before = readFileSync(join(dir, "events.jsonl"), "utf8");
    beginTurn(dir); // no run.jsonl => turn 1
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toBe(before);
  });
});

describe("all THREE outcome-bearing scanners are scoped, not just one", () => {
  it("findUngatedPathToolCalls ignores the prior turn's gated calls", () => {
    // Hostloop: turn 1's own successfully-gated Read errored turn 2, because the gate-fired set holds
    // only THIS process's hook callbacks.
    // Needs an `id`: the scanner maps tool_use id -> name, then checks which ids the gate fired for.
    const read = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/tmp/x" } }] },
    });
    // The scanner only flags a gated tool whose RESULT came back non-error, so the pair is required.
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false }] },
    });
    write(read, result);
    asResumedTurn();
    expect(findUngatedPathToolCalls(join(dir, "events.jsonl"), new Set()).length, "precondition").toBeGreaterThan(0);
    beginTurn(dir);
    expect(findUngatedPathToolCalls(join(dir, "events.jsonl"), new Set()), "turn 1's gated calls still error turn 2").toHaveLength(0);
  });

  it("detectCapabilityUse ignores the prior turn's capability use", () => {
    write(bash("tesseract in.png out"));
    asResumedTurn();
    expect(detectCapabilityUse(join(dir, "events.jsonl"), ["ocr"]).used.length, "precondition").toBeGreaterThan(0);
    beginTurn(dir);
    expect(detectCapabilityUse(join(dir, "events.jsonl"), ["ocr"]).used, "turn 1's capability use still fails turn 2").toHaveLength(0);
  });
});

describe("currentTurnEventLines degrades fail-CLOSED", () => {
  it("no marker => the whole file (older run dirs, or a crash before the marker)", () => {
    // Over-strict, never permissive: a missing marker must not turn a real turn-2 delete into a pass.
    expect(currentTurnEventLines(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("a marker with ZERO events after it yields a clean EMPTY scan, not evidence-unavailable", () => {
    // `readFileSync().trim().split("\n")` on an empty segment used to yield [""] => one malformed line
    // => evidence-unavailable => FAILS an authored no_delete_in_outputs, for a turn that simply had not
    // produced events yet.
    write(DELETE);
    asResumedTurn();
    beginTurn(dir);
    const r = scanEvents(join(dir, "events.jsonl"));
    expect(r.malformedLines, "an empty segment was reported as corrupt evidence").toBe(0);
    expect(r.sidecarMissing).toBe(false);
    expect(r.outputsDeletes).toHaveLength(0);
  });

  it("a corrupt line in an EARLIER turn does not make this turn's scan untrustworthy", () => {
    write("{corrupt", DELETE);
    asResumedTurn();
    beginTurn(dir);
    expect(scanEvents(join(dir, "events.jsonl")).malformedLines).toBe(0);
  });

  it("takes the LAST marker across three turns", () => {
    const m = (t: number) => JSON.stringify({ _emu: "turn_start", turn: t });
    expect(currentTurnEventLines(["t1", m(2), "t2", m(3), "t3"])).toEqual(["t3"]);
  });

  it("a corrupt line that merely CONTAINS the marker text is not treated as a marker", () => {
    // The fast substring pre-check must not be the decision — the line still has to parse as a marker.
    expect(currentTurnEventLines(['{"_emu":"turn_start" TRUNCATED', "a"])).toEqual(['{"_emu":"turn_start" TRUNCATED', "a"]);
  });
});

describe("beginTurn is actually WIRED at turn start", () => {
  // Caught by mutation testing: deleting the `beginTurn(outDir)` CALL from executeScenario left all the
  // tests above green, because they invoke beginTurn directly. Testing a function is not testing that
  // anything calls it — the recurring shape in this repo.
  //
  // A position check, and named as one: driving executeScenario would need a real spawn. It pins the two
  // orderings that make the fix work at all.
  const SRC = readFileSync(join(process.cwd(), "src/run/execute.ts"), "utf8");

  it("is called from executeScenario — and not merely present in a comment", () => {
    // The first version used a bare substring search, so `// beginTurn(outDir);` passed it: the guard
    // defeated exactly the one mutation I happened to run and nothing else. Anchor to a statement at the
    // start of a line instead.
    expect(
      /^\s*(?:const \w+ = )?beginTurn\(outDir\);\s*$/m.test(SRC),
      "the beginTurn call site is gone or commented out — the fix is inert",
    ).toBe(true);
  });

  it("runs BEFORE the resource sampler opens resources.jsonl", () => {
    // Otherwise the rename races the sampler and this turn's samples land in the archived file.
    const call = SRC.search(/^\s*(?:const \w+ = )?beginTurn\(outDir\);\s*$/m);
    const sampler = SRC.indexOf("new ResourceSampler(");
    expect(sampler, "the sampler construction moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(call, "beginTurn must precede the resource sampler").toBeLessThan(sampler);
  });

  it("runs BEFORE the launch plan is built (i.e. before the agent can emit any event)", () => {
    // The marker must precede every event of this turn, or turn-2 events land above their own marker and
    // get attributed to turn 1.
    const call = SRC.search(/^\s*(?:const \w+ = )?beginTurn\(outDir\);\s*$/m);
    const plan = SRC.indexOf("const plan = buildLaunchPlan(");
    expect(plan, "buildLaunchPlan moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(call, "beginTurn must precede the launch plan / session start").toBeLessThan(plan);
  });
});

describe("regressions the implementation review found", () => {
  it("an EMPTY completed events.jsonl still fails closed (single-turn behaviour is untouched)", () => {
    // An earlier version of this fix special-cased the empty file to [], flipping evidence-unavailable
    // into a clean PASS on single-turn runs — while the commit claimed turn 1 was unaffected.
    // `scanEvents` runs POST-run, so an empty stream is evidence LOSS, not "no events yet".
    writeFileSync(join(dir, "events.jsonl"), "");
    expect(scanEvents(join(dir, "events.jsonl")).malformedLines, "the empty-file fail-closed guard was weakened").toBeGreaterThan(0);
  });
});
