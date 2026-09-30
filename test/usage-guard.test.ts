import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { USAGE_GUARD_REGISTRY, type UsageGuardEntry, RECORD_USAGE, REPLAY_USAGE, VERIFY_CASSETTES_USAGE } from "../src/run/cassette.js";

// `record --help` (P3) had two hand-maintained strings that drifted; P9 generalizes the guard P3 built for
// `record` alone to `replay` and `verify-cassettes` too — both had the SAME two-hand-maintained-strings
// problem (src/cli.ts's SUBCOMMAND_USAGE.<cmd> vs. src/run/cassette.ts's own no-target usage error) and
// neither had a coverage guard at all. `--best-effort-future-cassette` (accepted by `replay`, functional —
// it gates the future-cassette-version refusal — but absent from `replay --help`) is the concrete bug this
// generalization exists to catch; the mutation tests below pin that specific regression by name, not just
// the aggregate.
//
// Entirely token-free / spawn-free (pure string checks over USAGE_GUARD_REGISTRY) so this half runs on
// every CI lane, not just the dist-build-dependent `--help` smoke test at the bottom of this file.

/** Word-boundary match so `--out` doesn't false-positive against `--output-format` (a naive
 *  `.includes("--out")` would silently pass even if the literal `--out` flag were removed from the text,
 *  as long as `--output-format` was still there — defeating the whole point of the guard). */
function usageDocuments(usage: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\b`).test(usage);
}

function allAcceptedFlags(entry: UsageGuardEntry): readonly string[] {
  return [...entry.booleanFlags, ...entry.valueFlags, ...entry.repeatedFlags];
}

/** Every `--flag`-shaped token that appears in a usage string, deduped. Used for the PHANTOM-FLAG reverse
 *  check (item 5): nothing before this generalization caught a flag DOCUMENTED in usage text but not
 *  accepted by the parser — exactly the mirror image of the coverage check above, and exactly the shape of
 *  bug that motivated it (a doc telling a user to pass a flag a command rejects — well, would reject, if
 *  the flag were misspelled or belonged to a different command). */
function flagTokensIn(usage: string): string[] {
  const found = usage.match(/--[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  return [...new Set(found)];
}

// A `--flag` token that legitimately appears in a command's usage text without being one of ITS OWN
// accepted flags — because it names another command's flag, or (like `<scenario.yaml>`/enum choices) isn't
// a flag at all. Inspected by hand against the three current usage strings below; empty today because none
// of the three actually needs an exception (verified by running the reverse check with this list empty —
// see the "phantom check has zero exceptions today" test). Kept as a real, per-command, commented mechanism
// rather than a blanket exemption so a FUTURE cross-reference (e.g. replay's usage mentioning a
// verify-cassettes-only flag by name) has somewhere honest to go instead of silently passing or silently
// failing the guard.
const PHANTOM_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  record: [],
  replay: [],
  "verify-cassettes": [],
  regrade: [],
};

describe("usage-guard registry shape", () => {
  it("every command's booleanFlags/valueFlags/repeatedFlags are pairwise disjoint (each flag classified exactly once)", () => {
    for (const entry of USAGE_GUARD_REGISTRY) {
      const sets = [
        ["booleanFlags", entry.booleanFlags],
        ["valueFlags", entry.valueFlags],
        ["repeatedFlags", entry.repeatedFlags],
      ] as const;
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const [nameA, flagsA] = sets[i];
          const [nameB, flagsB] = sets[j];
          const overlap = flagsA.filter((f) => (flagsB as readonly string[]).includes(f));
          expect(overlap, `${entry.command}: ${nameA} and ${nameB} overlap on ${overlap.join(", ")}`).toEqual([]);
        }
      }
    }
  });

  it("RECORD_USAGE/REPLAY_USAGE/VERIFY_CASSETTES_USAGE are wired into the registry (not re-typed copies)", () => {
    const byCommand = Object.fromEntries(USAGE_GUARD_REGISTRY.map((e) => [e.command, e.usage]));
    expect(byCommand["record"]).toBe(RECORD_USAGE);
    expect(byCommand["replay"]).toBe(REPLAY_USAGE);
    expect(byCommand["verify-cassettes"]).toBe(VERIFY_CASSETTES_USAGE);
  });
});

describe("flag-coverage guard — every accepted flag is documented or explicitly allowlisted (per command)", () => {
  for (const entry of USAGE_GUARD_REGISTRY) {
    describe(entry.command, () => {
      it("every allowlist entry is actually an accepted flag of this command (catches a stale allowlist)", () => {
        const accepted = allAcceptedFlags(entry);
        for (const { flag } of entry.allowlist) {
          expect(accepted, `${entry.command}: ${flag} must be a real accepted flag to belong in its allowlist`).toContain(flag);
        }
      });

      it("every accepted flag NOT in the allowlist is documented in this command's usage text", () => {
        const allowlisted = new Set(entry.allowlist.map((a) => a.flag));
        const undocumented = allAcceptedFlags(entry).filter((flag) => !allowlisted.has(flag) && !usageDocuments(entry.usage, flag));
        expect(undocumented, `${entry.command}: flag(s) missing from usage text: ${undocumented.join(", ")}`).toEqual([]);
      });
    });
  }

  // The specific drift case this generalization was written to fix (P9), pinned individually so a
  // regression names itself instead of failing only the aggregate check above.
  it("replay's --best-effort-future-cassette is documented (was accepted but absent from replay --help)", () => {
    expect(usageDocuments(REPLAY_USAGE, "--best-effort-future-cassette")).toBe(true);
  });
  it("replay's --best-effort-future-cassette documentation states its cost, not just its existence", () => {
    // Our own error message tells users to pass this flag; the usage text must also say what it costs
    // (an older CLI can silently misread a scenario key it doesn't know), not just that the flag exists.
    expect(REPLAY_USAGE).toMatch(/silently misread/i);
  });
  it("verify-cassettes' usage text does NOT mention --best-effort-future-cassette (it deliberately does not accept it)", () => {
    expect(usageDocuments(VERIFY_CASSETTES_USAGE, "--best-effort-future-cassette")).toBe(false);
  });

  // record's previously-reported drift cases (P3), carried over from the pre-generalization test.
  it("record: --max-budget-usd is documented (was missing from cli.ts's --help string)", () => {
    expect(usageDocuments(RECORD_USAGE, "--max-budget-usd")).toBe(true);
  });
  it("record: --decider-model is documented (was missing from cli.ts's --help string)", () => {
    expect(usageDocuments(RECORD_USAGE, "--decider-model")).toBe(true);
  });
  it("record: --dry-run is documented (was missing from cassette.ts's usage-error string)", () => {
    expect(usageDocuments(RECORD_USAGE, "--dry-run")).toBe(true);
  });
});

describe("phantom-flag reverse guard — every --flag token IN a command's usage text is a real accepted flag (or a declared exception)", () => {
  for (const entry of USAGE_GUARD_REGISTRY) {
    it(`${entry.command}: no phantom flags in usage text`, () => {
      const accepted = new Set(allAcceptedFlags(entry));
      const exceptions = new Set(PHANTOM_EXCEPTIONS[entry.command] ?? []);
      const phantoms = flagTokensIn(entry.usage).filter((tok) => !accepted.has(tok) && !exceptions.has(tok));
      expect(phantoms, `${entry.command}: usage text mentions flag(s) it does not accept: ${phantoms.join(", ")}`).toEqual([]);
    });
  }

  it("PHANTOM_EXCEPTIONS is empty for all three commands today (a non-empty entry must be inspected, not assumed)", () => {
    for (const [command, exceptions] of Object.entries(PHANTOM_EXCEPTIONS)) {
      expect(exceptions, `${command}`).toEqual([]);
    }
  });
});

describe("word-boundary matching (regression guard on the matcher itself)", () => {
  it("a usage text containing only --output-format does NOT satisfy a check for --out", () => {
    expect(usageDocuments("usage: cmd [--output-format text|json]", "--out")).toBe(false);
  });
  it("a usage text containing the literal --out flag DOES satisfy a check for --out", () => {
    expect(usageDocuments("usage: cmd [--out <file>]", "--out")).toBe(true);
  });
});

// --- Mutation tests --------------------------------------------------------------------------------
// Each of these constructs a MUTATED copy of a registry entry in-memory (never touches the real exports)
// and asserts the guard logic reds on it — proving the guard actually fires rather than being vacuously
// green. Run once per PR by CI; see the task report for the manual "run it, confirm red, then revert to
// this file's committed state" pass done while authoring this guard.
describe("mutation tests — each of these MUST fail if the corresponding guard logic is deleted or weakened", () => {
  const replayEntry = USAGE_GUARD_REGISTRY.find((e) => e.command === "replay")!;

  it("mutation: removing --best-effort-future-cassette from replay's usage text reds the coverage check", () => {
    const strippedUsage = replayEntry.usage.replace(/\[?--best-effort-future-cassette\]?/g, "").replace(/silently misread[^.]*\./gi, "");
    const stillAccepted = allAcceptedFlags(replayEntry);
    const allowlisted = new Set(replayEntry.allowlist.map((a) => a.flag));
    const undocumented = stillAccepted.filter((flag) => !allowlisted.has(flag) && !usageDocuments(strippedUsage, flag));
    expect(undocumented).toContain("--best-effort-future-cassette");
  });

  it("mutation: removing the --quiet allowlist entry reds the coverage check (the allowlist is load-bearing, not decorative)", () => {
    const mutatedAllowlist = replayEntry.allowlist.filter((a) => a.flag !== "--quiet");
    const allowlisted = new Set(mutatedAllowlist.map((a) => a.flag));
    const undocumented = allAcceptedFlags(replayEntry).filter((flag) => !allowlisted.has(flag) && !usageDocuments(replayEntry.usage, flag));
    expect(undocumented).toContain("--quiet");
  });

  it("mutation: adding a bogus flag to an allowlist reds the allowlist-membership check", () => {
    const mutatedAllowlist = [...replayEntry.allowlist, { flag: "--not-a-real-flag", reason: "bogus, for the mutation test" }];
    const accepted = allAcceptedFlags(replayEntry);
    const bogus = mutatedAllowlist.filter((a) => !accepted.includes(a.flag));
    expect(bogus.map((a) => a.flag)).toContain("--not-a-real-flag");
  });

  it("mutation: adding a phantom flag to a usage string reds the reverse (phantom-flag) check", () => {
    const mutatedUsage = replayEntry.usage + " [--not-a-real-flag]";
    const accepted = new Set(allAcceptedFlags(replayEntry));
    const exceptions = new Set(PHANTOM_EXCEPTIONS[replayEntry.command] ?? []);
    const phantoms = flagTokensIn(mutatedUsage).filter((tok) => !accepted.has(tok) && !exceptions.has(tok));
    expect(phantoms).toContain("--not-a-real-flag");
  });
});

// Integration half: proves src/cli.ts's SUBCOMMAND_USAGE.<cmd> is the SAME string object as each command's
// exported USAGE const (imported, not re-typed), by checking the actually-built CLI's `<cmd> --help`
// output against it. Needs dist/cli.js (the `ci` script builds first); skips cleanly otherwise — the unit
// tests above already cover the guard's substance without a build.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

describe.skipIf(!can)("<cmd> --help prints the single-sourced usage text", () => {
  for (const [cmd, usage, noTargetExit] of [
    ["record", RECORD_USAGE, 2],
    ["replay", REPLAY_USAGE, 2],
    ["verify-cassettes", VERIFY_CASSETTES_USAGE, 2],
  ] as const) {
    it(`\`${cmd} --help\` output equals the exported usage text (stderr)`, () => {
      const r = spawnSync("node", [CLI, cmd, "--help"], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stderr.trimEnd()).toBe(usage);
    });

    it(`\`${cmd}\` with no target (usage error) also prints the exported usage text`, () => {
      const r = spawnSync("node", [CLI, cmd], { encoding: "utf8" });
      expect(r.status).toBe(noTargetExit);
      expect(r.stderr).toContain(usage);
    });
  }
});
