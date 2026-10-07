import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CATALOG_FILES } from "./helpers/assertion-catalog.js";

// Anti-drift guard, REVERSE DIRECTION. `test/scenario-docs-sync.test.ts` asserts
// `real assertion key ⇒ has a doc table row`. Nothing asserted the converse, so a key-shaped token in
// PROSE was invisible to every guard: `subagent_dispatch` (no trailing `ed`) sat in the semantic_matches
// row of docs/scenario.md, references/scenario-schema.md AND references/task-recipes.md, telling readers
// to reach for a key that does not exist. `lint` reports it (unknown-assert-key, WARN, exit 0) and `run`
// rejects the scenario at load — so the advice fails, loudly, only after someone follows it.
//
// WHY NEAR-MISS AND NOT AN ALLOWLIST UNION. The obvious design — permit assertion keys ∪ verdict signal
// codes ∪ scenario fields ∪ tool names, flag the residue — does not work here:
//   · The residue is large and legitimate. These files name ~180 non-key snake_case tokens (verdict signal
//     codes, composite-assertion sub-fields, wire/event names, capability names, the pytest API). An
//     allowlist that big gets rubber-stamped on every unrelated doc edit.
//   · Half of it isn't derivable. `VerdictSignal` and `AgentEvent` are TYPE-ONLY unions
//     (src/run/verdict.ts, src/agent/session.ts) — no runtime value enumerates them, so a test cannot
//     import them. Deriving them means parsing source text.
//   · It would miss THIS bug anyway. `subagent_dispatch` is a real `AgentEvent`/timeline type name, so a
//     union permitting event names permits it — exactly where an assertion key was required.
// A typo is a NEAR-MISS of a real key by construction; unrelated vocabulary is not. Distance ≤2 from an
// assertion key, and not itself a key or a scenario field, is the whole rule. Measured on the three files:
// 3 flags, all 3 the real defect, 0 false positives, 0 allowlist entries.
//
// Legitimate event-name uses need no exemption: the token must fill a WHOLE backtick span, and
// references/task-recipes.md:70's correct use is inside a slash-separated list
// (`tool_use/tool_result/subagent_dispatch/thinking/…`) that is never extracted.
//
// SCOPE = every surface that tells a reader WHICH ASSERTION KEY TO WRITE. That deliberately includes
// CHANGELOG.md: the typo had a FIFTH site there, inside the very bullet announcing the fix for the other
// four — found only because this guard's scope was widened past the obvious reference docs. Measured at
// time of writing: 8 files, ~470 unique tokens, 0 false positives.
//
// WRITING ABOUT A WRONG KEY (the changelog case). This guard fired a second time on the bullet describing
// the fix, because explaining a typo means naming it. The fix is not an exemption — it is to NOT BACKTICK
// the wrong spelling. Backticks mean "copy this"; a key that does not exist has no business wearing them.
// Name it in prose ("written without its trailing ed") and the guard stays strict for free.
//
// OUT of scope, deliberately: SPEC.md and docs/subagents.md. Both discuss the truncated spelling as a real
// AgentEvent type — a wire/architecture fact, correctly backticked — and would be this guard's only false
// positives. Neither file recommends assertion keys, so excluding them costs no coverage. Do not add them
// without an exemption mechanism.
const SCANNED = [
  "docs/scenario.md",
  "docs/cassette.md",
  "README.md",
  "CHANGELOG.md",
  "llms.txt",
  ".claude/skills/cowork-harness/references/scenario-schema.md",
  ...CATALOG_FILES,
  ".claude/skills/cowork-harness/references/task-recipes.md",
  ".claude/skills/cowork-harness/references/fidelity-and-answers.md",
];

// `keys` is a FLAT ARRAY of key names, not an object. `Object.keys(raw.keys)` yields "0".."70" — a set of
// numeric strings against which every real token looks unknown and every edit distance is 99, so the guard
// silently reports NOTHING while still passing. A prototype of this very test had that bug. The canary
// below exists to make that failure mode impossible rather than merely documented.
const catalog = JSON.parse(readFileSync(resolve(".claude/skills/cowork-harness/scripts/assertion-keys.json"), "utf8")) as {
  keys: string[];
  topLevelKeys: string[];
};
const ASSERTION_KEYS: string[] = catalog.keys;
const SCENARIO_FIELDS = new Set<string>(catalog.topLevelKeys);
const KEY_SET = new Set<string>(ASSERTION_KEYS);

/** Levenshtein distance, short-circuited past `max` — only near-misses matter, so a long-vs-short pair
 *  never walks the full matrix. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length];
}

/** Every `` `snake_case` `` / `` `snake_case: …` `` token in the doc. The token must fill the whole backtick
 *  span (or be followed by `:`), which is what keeps slash-separated event lists out of scope. */
function tokensOf(text: string): Set<string> {
  return new Set([...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?::[^`]*)?`/g)].map((m) => m[1]));
}

const NEAR_MISS_MAX = 2;

describe("assertion-key vocabulary ↔ docs (reverse-direction guard)", () => {
  it("read a sane catalog", () => {
    // Both canaries target the array-vs-object misread: a numeric-key set would have length 71 too, so the
    // count alone is not enough — the membership check is the one that actually proves the shape.
    expect(ASSERTION_KEYS.length).toBeGreaterThan(60);
    expect(ASSERTION_KEYS).toContain("subagent_dispatched");
    expect(SCENARIO_FIELDS.size).toBeGreaterThan(10);
    expect([...SCENARIO_FIELDS]).toContain("expect_denied"); // a Scenario field, NOT an Assertion key
  });

  it("scraped a sane token set", () => {
    // AGGREGATE floor, not per-file: the scanned set spans a 1100-line reference guide and a 54-line
    // machine summary, so any per-file threshold high enough to be meaningful would false-fail on the
    // small ones. ~470 across the set at time of writing. The per-file assertion is only that the regex
    // matched SOMETHING everywhere — the failure this canary exists for is a regex that silently matches
    // nothing, which would make the whole guard pass vacuously.
    let total = 0;
    for (const f of SCANNED) {
      const n = tokensOf(readFileSync(resolve(f), "utf8")).size;
      expect(n, `${f} yielded no snake_case tokens at all — did the regex or the file shape change?`).toBeGreaterThan(0);
      total += n;
    }
    expect(total).toBeGreaterThan(400);
  });

  it("the rule flags a near-miss typo but not unrelated vocabulary", () => {
    const nearMisses = (tok: string) =>
      KEY_SET.has(tok) || SCENARIO_FIELDS.has(tok)
        ? []
        : ASSERTION_KEYS.filter((k) => editDistance(tok, k, NEAR_MISS_MAX) <= NEAR_MISS_MAX);
    // a one-character typo of a real key → caught
    expect(nearMisses("transcript_contain")).toContain("transcript_contains");
    // the exact bug this guard exists for → caught
    expect(nearMisses("subagent_dispatch")).toContain("subagent_dispatched");
    // a real TOOL name that merely shares a prefix with a key → NOT caught (distance 7)
    expect(nearMisses("present_files")).toEqual([]);
    // a real Scenario field → NOT caught (it is permitted vocabulary, not a typo)
    expect(nearMisses("expect_denied")).toEqual([]);
    // a real key → NOT caught
    expect(nearMisses("subagent_dispatched")).toEqual([]);
  });

  it("no doc offers a token that is a near-miss of a real assertion key", () => {
    const offenders: string[] = [];
    for (const f of SCANNED) {
      for (const tok of tokensOf(readFileSync(resolve(f), "utf8"))) {
        if (KEY_SET.has(tok) || SCENARIO_FIELDS.has(tok)) continue;
        const near = ASSERTION_KEYS.filter((k) => editDistance(tok, k, NEAR_MISS_MAX) <= NEAR_MISS_MAX);
        if (near.length) offenders.push(`${f}: \`${tok}\` — did you mean ${near.map((k) => `\`${k}\``).join(" / ")}?`);
      }
    }
    expect(offenders, `documented token(s) look like a misspelled assertion key:\n${offenders.join("\n")}`).toEqual([]);
  });
});
