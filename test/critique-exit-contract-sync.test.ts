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

  // Every ENUMERATION of the instrument-failure causes must be complete. Presence-matching a good phrase
  // anywhere in a file is not enough — that is how `usage()` sat desynced inside the very file this guard
  // reads: the corrected phrase existed at the top of command.ts while line 88 still named a subset.
  // So: anchor on the enumeration's own opening ("reflection protocol broke") and require "or threw"
  // to follow it, at EVERY site, in every surface.
  const SURFACES = [
    ["command.ts", SRC],
    ["SPEC.md", SPEC],
    ["docs/critique.md", DOC],
  ] as const;

  it("EVERY instrument-failure enumeration names the evaluator-threw cause", () => {
    for (const [name, text] of SURFACES) {
      const sites = [...text.matchAll(/reflection protocol broke[\s\S]{0,100}/g)].map((m) => m[0]);
      expect(sites.length, `${name} has no instrument-failure enumeration to check`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(/or threw/.test(site), `${name}: an enumeration omits "or threw" -> ${site.replace(/\s+/g, " ").slice(0, 110)}`).toBe(true);
      }
    }
  });

  it("the code really does exit non-zero on an evaluator throw (the claim above is not just prose)", () => {
    expect(SRC).toMatch(/state\.infraFailure \|\| state\.evaluatorError\) process\.exit\(EXIT_INSTRUMENT_FAILURE\)/);
  });
});
