import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The integrity canary shipped INERT: the ReportState field, the renderer, the local variable and the
// callback all existed, and nothing ever put the value into a state literal — so the warning could not
// print in either format. Unit tests missed it because they hand the builders a state directly, testing
// the renderer rather than the assembly.
//
// Source-level guard, same shape as run-result-schema-sync. The FIRST version of this test grepped
// `^\s+field[,:]` anywhere after `async function main(`, which also matched main()'s own destructuring
// (`turn1ResultDegraded: trd,`) — deleting three fields from the real state literal left it green. It
// parses the actual ReportState object literals now.
const SRC = readFileSync(resolve("src/critique/command.ts"), "utf8");

function reportStateFields(): string[] {
  const block = SRC.slice(SRC.indexOf("interface ReportState"));
  const body = block.slice(0, block.indexOf("\n}"));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
}

/** Every `ReportState`-typed object literal in the file, as brace-balanced source text. */
function reportStateLiterals(): string[] {
  const out: string[] = [];
  const marker = ": ReportState = {";
  for (let i = SRC.indexOf(marker); i !== -1; i = SRC.indexOf(marker, i + 1)) {
    let depth = 0;
    const start = i + marker.length - 1;
    for (let j = start; j < SRC.length; j++) {
      if (SRC[j] === "{") depth++;
      else if (SRC[j] === "}" && --depth === 0) {
        out.push(SRC.slice(start, j + 1));
        break;
      }
    }
  }
  return out;
}

const LITERALS = reportStateLiterals();
const FIELDS = reportStateFields();
/** The success-path literal — the most complete one, and the only one that should carry everything. */
const FULL = LITERALS.reduce((a, b) => (b.length > a.length ? b : a), "");

describe("ReportState assembly", () => {
  it("finds the state literals to check (guards against the parser silently matching nothing)", () => {
    expect(LITERALS.length).toBeGreaterThanOrEqual(2);
    expect(FIELDS.length).toBeGreaterThan(8);
  });

  for (const field of FIELDS) {
    it(`\`${field}\` is assembled into the success-path state literal`, () => {
      const populated = new RegExp(`^\\s+${field}[,:]`, "m").test(FULL);
      expect(populated, `ReportState.${field} is declared and rendered but never assembled — the exact bug the canary shipped with`).toBe(
        true,
      );
    });
  }
});

// Early-return literals (task-infra failure, etc.) legitimately omit fields whose values do not exist yet
// — e.g. evaluatorIntegrity before the evaluator has run. In JSON an absent key and an `undefined` value
// are indistinguishable, and "absent = never checked" is the honest reading, so those omissions are
// correct rather than bugs. This test therefore pins the SUCCESS path only, deliberately.
