import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeVerdict } from "../src/run/verdict.js";
import type { Assertion, RunResult } from "../src/types.js";

// `verdict.failures[]` is the machine-readable answer to "did MY assertions fail, or did something
// else?" — a consumer resorted to scraping stderr for it. The old answer was "look at whether
// `assertion` is set", which is wrong in BOTH directions: verify-run's answer-coverage misses inject a
// key and read as authored asserts, while guard / staleness / cassette-format failures all arrive
// key-less and indistinguishable. `kind` is the discriminator; these tests pin each value.

function res(assertions: RunResult["assertions"], over: Partial<RunResult> = {}): RunResult {
  return {
    scenario: "s",
    result: "success",
    assertions,
    durationMs: 1,
    outDir: "/tmp/x",
    fidelity: "container",
    baseline: "desktop-1.14271.0",
    ...over,
  } as unknown as RunResult;
}

const A = (a: Assertion, message: string, source?: "staleness" | "cassette-format" | "coverage") => ({
  assertion: a,
  pass: false,
  message,
  ...(source ? { source } : {}),
});

describe("verdict.failures[].kind", () => {
  it("an authored assert is kind: assertion, with its key", () => {
    const v = computeVerdict(res([A({ tool_called: "Bash" }, "expected Bash")]), "live");
    expect(v.failures).toEqual([{ assertion: "tool_called", message: "expected Bash", kind: "assertion" }]);
  });

  it("an injected staleness pseudo-assertion is kind: staleness, and carries no key", () => {
    const v = computeVerdict(res([A({} as Assertion, "skill-source drift (--fail-on-skill-drift): x", "staleness")]), "replay");
    expect(v.failures).toEqual([{ message: "skill-source drift (--fail-on-skill-drift): x", kind: "staleness" }]);
  });

  it("a too-new cassette is kind: cassette-format — distinct from staleness, which it used to be indistinguishable from", () => {
    const v = computeVerdict(res([A({} as Assertion, "cassette format too new: v12", "cassette-format")]), "replay");
    expect(v.failures[0].kind).toBe("cassette-format");
  });

  // The direction the old rule got backwards. verify-run injects `{ answer_coverage: q }`, which is not
  // an Assertion key — so `Object.keys(...)[0]` yields "answer_coverage" and the entry looked authored.
  it("an answer-coverage miss is kind: coverage even though it DOES carry a key", () => {
    const v = computeVerdict(
      res([A({ answer_coverage: "Which stage?" } as unknown as Assertion, "no answer rule matched", "coverage")]),
      "live",
    );
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].assertion).toBe("answer_coverage");
    expect(v.failures[0].kind).toBe("coverage");
    // The regression: filtering on key-presence would count this as one of the author's own asserts.
    expect(v.failures.filter((f) => f.kind === "assertion")).toHaveLength(0);
  });

  it("a guard signal the author never wrote is kind: guard", () => {
    const v = computeVerdict(
      res([], { result: "error", infraErrors: [{ source: "sidecar", message: "sidecar exited 1" }] } as unknown as Partial<RunResult>),
      "live",
    );
    expect(v.failures.length).toBeGreaterThan(0);
    expect(v.failures.every((f) => f.kind === "guard")).toBe(true);
  });

  it("a mixed run separates cleanly — the whole point of the field", () => {
    const v = computeVerdict(
      res([A({ tool_called: "Bash" }, "expected Bash"), A({} as Assertion, "cassette stale (--strict): skill files changed", "staleness")]),
      "replay",
    );
    expect(v.failures.filter((f) => f.kind === "assertion").map((f) => f.assertion)).toEqual(["tool_called"]);
    expect(v.failures.filter((f) => f.kind === "staleness")).toHaveLength(1);
  });

  it("every entry carries a kind — no undefined slips through either loop", () => {
    const v = computeVerdict(
      res([A({ tool_called: "Bash" }, "x")], { result: "error", unansweredGate: { message: "gate blew up" } } as Partial<RunResult>),
      "live",
    );
    expect(v.failures.length).toBeGreaterThan(1);
    expect(v.failures.every((f) => typeof f.kind === "string")).toBe(true);
  });
});

// Every INJECTION SITE must stamp `source`, or its failure silently renders as one of the author's own
// asserts. A unit test can only cover the sites it happens to construct; this scans for the pattern
// itself, so a NEW pseudo-assertion added anywhere reds until it is classified. (Mutation-found: the
// first version of this PR could lose a `source: "coverage"` stamp in cli.ts with every test green.)
//
// The scan keys on `assertions.push(` — NOT on the `{} as Assertion` cast the first version looked for.
// That cast-shaped pattern was blind to seven `replay_protocol_fidelity` injections, which pass a REAL
// assertion key (`{ replay_protocol_fidelity: true }`) and so never matched, and shipped unstamped:
// `computeVerdict` labelled cassette-corruption failures `kind: "assertion"`, i.e. as if the author had
// written them, which is exactly what the contract in types.ts forbids. In these files every
// `assertions.push` IS an injection — an author's own `assert:` items are evaluated elsewhere and never
// reach this call — so requiring the stamp on all of them is both sound and shape-independent.
describe("every pseudo-assertion injection site stamps `source`", () => {
  // verify-context.ts is the shared kept-run re-evaluation (`verify-run`, `hillclimb regrade`): the list it builds,
  // `deterministic`, is the authored entries it hands back, so a push onto it is scanned like any other.
  const files = ["src/run/cassette.ts", "src/cli.ts", "src/run/verify-context.ts"];
  const PUSH = /\b(assertions|deterministic)\.push\(/g;
  /** The one push that is NOT an injection: the author's own `expect_denied`, expanded into one `egress_denied` entry
   *  per host by the live run's helper — authored, so it carries no `source` (a stamp would hide the author's own
   *  failure as a harness signal). Matched by its exact shape, so any other push in these files is held to the rule. */
  const AUTHORED_EXPANSION = /^deterministic\.push\(\.\.\.expandExpectDenied\(/;

  /** Every `assertions.push(` / `deterministic.push(` in these files, as `{ file, line, literal }`. */
  const injectionSites = () =>
    files.flatMap((f) => {
      const src = readFileSync(resolve(f), "utf8");
      return [...src.matchAll(PUSH)].map((m) => {
        const end = src.indexOf("});", m.index);
        return {
          file: f,
          line: src.slice(0, m.index).split("\n").length,
          literal: src.slice(m.index!, end === -1 ? m.index! + 500 : end + 3),
        };
      });
    });

  it("finds the sites at all (guards against a refactor that changes the shape)", () => {
    // Counted, not inherited: 12 in cassette.ts (--strict staleness, --fail-on-skill-drift, the
    // explicit-override escalation, the 2.0.0
    // DEFAULT unverifiable-skill escalation,
    // future-version, and SEVEN replay_protocol_fidelity corruption paths) + 2 in cli.ts (both
    // answer-coverage) + 1 in verify-context.ts: verify-run's expect_denied expansion, moved there with the shared
    // kept-run re-evaluation — the author's own `expect_denied`, not an injection (`AUTHORED_EXPANSION`, exempt from
    // the stamp below). A refactor that moves or renames a call reds here rather than silently scanning nothing.
    expect(injectionSites().length).toBe(15);
    expect(injectionSites().filter((s) => AUTHORED_EXPANSION.test(s.literal))).toEqual([
      expect.objectContaining({ file: "src/run/verify-context.ts" }),
    ]);
  });

  it("each one stamps a `source:` within its object literal", () => {
    const unstamped = injectionSites()
      .filter((s) => !AUTHORED_EXPANSION.test(s.literal))
      .filter((s) => !/source:\s*"(staleness|cassette-format|coverage)"/.test(s.literal))
      .map((s) => `${s.file}:${s.line}`);
    expect(unstamped, "an injected pseudo-assertion with no `source` renders as one of the author's own asserts").toEqual([]);
  });

  it("the scan would CATCH an unstamped injection (mutation check)", () => {
    // The previous version of this guard passed while seven sites were unstamped, because it matched a
    // cast shape they did not use. Prove the current matcher actually rejects a bare push.
    const bare = "assertions.push({ assertion: { replay_protocol_fidelity: true }, pass: false, message: m });";
    expect(/source:\s*"(staleness|cassette-format|coverage)"/.test(bare)).toBe(false);
    expect(/assertions\.push\(/.test(bare)).toBe(true);
    // The authored-expansion exemption is exact: a bare push onto the re-evaluation's list is not exempt.
    const bareDet = "deterministic.push({ assertion: { result: 'success' }, pass: false, message: m });";
    expect(AUTHORED_EXPANSION.test(bareDet)).toBe(false);
    expect(/source:\s*"(staleness|cassette-format|coverage)"/.test(bareDet)).toBe(false);
  });
});
