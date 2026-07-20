import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// critique's exit contract is stated in FOUR places: the code, `usage()`, SPEC.md's per-command
// exceptions, and docs/critique.md's exit table. A round-9 fix corrected SPEC and did not propagate to
// critique.md — nothing failed, because no guard covered that pair. This is that guard.
//
// It checks the CLAIM, not prose: every surface that enumerates the instrument-failure causes must name
// the same set, and none may still assert the retired "always exits 0" contract.
const SRC = readFileSync(resolve("src/critique/command.ts"), "utf8");
const SPEC = readFileSync(resolve("SPEC.md"), "utf8");
const DOC = readFileSync(resolve("docs/critique.md"), "utf8");

describe("critique exit contract is stated consistently everywhere", () => {
  it("no surface still claims critique always exits 0", () => {
    for (const [name, text] of [
      ["command.ts", SRC],
      ["SPEC.md", SPEC],
      ["docs/critique.md", DOC],
    ] as const) {
      expect(/always exits 0|still exits 0/i.test(text), `${name} still asserts the retired always-exits-0 contract`).toBe(false);
    }
  });

  it("SPEC.md and docs/critique.md enumerate the SAME instrument-failure causes", () => {
    // "…never invoked or threw" is the full set; a surface naming a strict subset is the round-9 desync.
    for (const [name, text] of [
      ["SPEC.md", SPEC],
      ["docs/critique.md", DOC],
    ] as const) {
      expect(/never invoked \*?or threw\*?/.test(text), `${name} omits the "evaluator threw" instrument-failure cause`).toBe(true);
    }
  });

  it("the code really does exit non-zero on an evaluator throw (the claim above is not just prose)", () => {
    expect(SRC).toMatch(/state\.infraFailure \|\| state\.evaluatorError\) process\.exit\(EXIT_INSTRUMENT_FAILURE\)/);
  });
});
