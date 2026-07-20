import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The integrity canary shipped INERT: the ReportState field, the renderer, the local variable and the
// callback all existed, and nothing ever put the value into the state literal main() builds — so the
// warning could not print in either format. Unit tests missed it because they hand the builders a state
// directly, testing the renderer rather than the assembly.
//
// This is a source-level guard, the same shape as run-result-schema-sync: every optional ReportState field
// must actually be assembled somewhere in main(), or it is decoration.
const SRC = readFileSync(resolve("src/critique/command.ts"), "utf8");

function reportStateFields(): string[] {
  const block = SRC.slice(SRC.indexOf("interface ReportState"));
  const body = block.slice(0, block.indexOf("\n}"));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
}

describe("ReportState fields are actually assembled, not just declared", () => {
  const assembly = SRC.slice(SRC.indexOf("async function main("));
  for (const field of reportStateFields()) {
    it(`\`${field}\` is populated somewhere in main()`, () => {
      // shorthand (`field,`) or explicit (`field:`) — either counts as assembled
      const populated = new RegExp(`^\\s+${field}[,:]`, "m").test(assembly);
      expect(populated, `ReportState.${field} is declared and rendered but never assembled into a state literal`).toBe(true);
    });
  }
});
