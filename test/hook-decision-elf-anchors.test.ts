/**
 * The hook keys read a hook's decision by rules copied from the agent. Each rule in `HOOK_DECISION_RULES` names a literal
 * that marks it in the agent binary. This test fails when one of those literals is missing from the staged agent, which
 * means the rule may have moved and its code needs re-reading before the keys are trusted on that build.
 *
 * There is no staged Desktop on CI, so this test SKIPS there. A green CI says nothing about it; only a local run on a
 * machine with Cowork installed does.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOK_DECISION_RULES } from "../src/assert.js";

/** `.../claude-code-vm/<ver>/claude`, resolved through the staged `.sdk-version` marker; undefined when none is staged. */
function stagedAgentElf(): string | undefined {
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-vm");
  const marker = join(root, ".sdk-version");
  if (!existsSync(marker)) return undefined;
  const elf = join(root, readFileSync(marker, "utf8").trim(), "claude");
  return existsSync(elf) ? elf : undefined;
}

const elf = stagedAgentElf();

describe.skipIf(elf === undefined)("the hook-decision rules' anchors in the staged agent", () => {
  it("every anchor is present", () => {
    const bin = readFileSync(elf!);
    const missing = HOOK_DECISION_RULES.filter((r) => bin.indexOf(r.anchor, 0, "utf8") === -1).map((r) => `${r.rule} (${r.anchor})`);
    expect(missing, `missing from ${elf}: re-read the agent's hook-output code for each rule`).toEqual([]);
  });
});

describe.skipIf(elf === undefined)("events whose hooks stream no frame (FRAMELESS_HOOK_EVENTS)", () => {
  // The agent's outside-REPL hook runner (the one that logs "Policy disableAllHooks: skipping configured hooks for")
  // never calls the function that emits `hook_response`, so a block there is invisible. Minified names change every
  // build: both functions are found by a literal they contain, and the runner's body must not name the emitter.
  it("the outside-REPL runner does not call the hook_response emitter", () => {
    const text = readFileSync(elf!).toString("latin1");
    const emitAt = text.indexOf('subtype:"hook_response"');
    expect(emitAt, "the hook_response emitter").toBeGreaterThan(-1);
    const emitter = /function ([\w$]+)\([\w$]+\)\{[^]*$/.exec(text.slice(text.lastIndexOf("function ", emitAt), emitAt))?.[1];
    expect(emitter, "the emitter's name").toBeDefined();
    const runners = [...text.matchAll(/Policy disableAllHooks: skipping configured hooks for/g)].map((m) => m.index!);
    const bodies = runners
      .map((at) => text.lastIndexOf("async function ", at))
      .filter((start) => start !== -1 && /^async function [\w$]+\(e\)\{let\{session:/.test(text.slice(start, start + 60)))
      .map((start) => {
        const ends = [text.indexOf("}async function ", start + 100), text.indexOf("}function ", start + 100)].filter((x) => x !== -1);
        return text.slice(start, Math.min(...ends));
      });
    expect(bodies.length, "the outside-REPL runner").toBe(1);
    expect(bodies[0]!.includes(`${emitter}(`), `the runner calls ${emitter}: re-read FRAMELESS_HOOK_EVENTS`).toBe(false);
    // and it is the runner the frameless events go through
    expect(bodies[0]!).toContain("hook_event_name");
  });
});

describe("HOOK_DECISION_RULES", () => {
  it("has distinct, non-empty anchors", () => {
    const anchors = HOOK_DECISION_RULES.map((r) => r.anchor);
    expect(anchors.every((a) => a.length >= 8)).toBe(true);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
