import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";

// `reference_read` / `no_observed_reference_access`. The negative key is the dangerous one: its detector
// under-approximates by design, and it sits over a field whose ABSENCE means "we could not look". A
// vacuous pass there reads as a clean result, which is the failure class this whole signal exists to end.

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}
const ACCESSED = [{ path: "references/env.md", via: ["bash"] }];

describe("reference_read", () => {
  it("passes on an access reached through a NON-Read channel, and names the channel", () => {
    // The whole point: `referencesRead` is empty here. A Bash `cat` is an access.
    const [r] = evaluate([{ reference_read: "env\\.md" }], ctx({ referencesAccessed: ACCESSED }));
    expect(r!.pass).toBe(true);
    expect(r!.message ?? r!.evidence ?? "").toMatch(/bash/);
  });

  it("fails when nothing matched, and says the detector under-approximates", () => {
    const [r] = evaluate([{ reference_read: "missing\\.md" }], ctx({ referencesAccessed: ACCESSED }));
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/under-approximates/);
  });

  it("is case-insensitive and unanchored — the shared helper's real semantics, not an invented convention", () => {
    expect(evaluate([{ reference_read: "ENV" }], ctx({ referencesAccessed: ACCESSED }))[0]!.pass).toBe(true);
  });
});

describe("no_observed_reference_access", () => {
  it("passes on an EMPTY list — the drive ran and observed nothing (a real negative)", () => {
    const [r] = evaluate([{ no_observed_reference_access: "dead-router" }], ctx({ referencesAccessed: [] }));
    expect(r!.pass).toBe(true);
  });

  it("fails when the path WAS accessed, naming how", () => {
    const [r] = evaluate([{ no_observed_reference_access: "env\\.md" }], ctx({ referencesAccessed: ACCESSED }));
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/references\/env\.md \(bash\)/);
  });

  it("FAILS evidence-unavailable when the field is absent — never a vacuous pass", () => {
    // An absent field means the run recorded no observable tool stream (a replay error result, a torn
    // partial result, an older result.json). Passing here would report "the reference was never reached"
    // on a run nobody could see — the false green in the direction that looks like success.
    const [r] = evaluate([{ no_observed_reference_access: "anything" }], ctx({ referencesAccessed: undefined }));
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/evidence unavailable/);
  });
});

describe("scope — the evaluator judges whatever population the builder hands it", () => {
  // NOTE what this can and cannot show. These inject the context directly, so they pin the EVALUATOR's
  // half only: a sub-agent-sourced access is judged like any other. They CANNOT detect a builder that
  // forgets to union sub-agents in — that wiring is pinned by the source-level guard below and by
  // `unionReferenceAccesses`'s own tests, and this comment exists so a reader does not mistake a green
  // here for proof the scope contract holds end to end.
  const SUB_ONLY = [{ path: "references/env.md", via: ["read"] }];

  it("reference_read matches an access made only by a sub-agent", () => {
    expect(evaluate([{ reference_read: "env\\.md" }], ctx({ referencesAccessed: SUB_ONLY }))[0]!.pass).toBe(true);
  });

  it("no_observed_reference_access FAILS on a sub-agent-only access", () => {
    const [r] = evaluate([{ no_observed_reference_access: "env\\.md" }], ctx({ referencesAccessed: SUB_ONLY }));
    expect(r!.pass).toBe(false);
  });
});

describe("every AssertContext builder unions sub-agent accesses in", () => {
  // Source-level, in the style of `critique-report-assembly-sync`. The gap this closes shipped as a
  // perfectly typed field that every builder populated from the MAIN-AGENT list — no type error, no
  // failing unit test, and `no_observed_reference_access` passing green on a run where a sub-agent read
  // the file cover to cover. A dispatcher-shaped skill does all its reading a level down, so that is the
  // common case, not the corner one.
  const SOURCES = ["src/run/execute.ts", "src/run/cassette.ts", "src/run/verify-context.ts"];

  /** Every `: AssertContext = { … }` literal, brace-balanced. An earlier version bounded the search by a
   *  character window and by the shared `toolsCalled` key instead: the window silently missed the
   *  verify-run builder (its field sits ~58 lines in) and the key matched a `RunRecord` factory. Both
   *  failure modes look like a passing test. */
  function assertContextLiterals(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/:\s*AssertContext\s*=\s*\{/g)) {
      let depth = 0;
      const start = src.indexOf("{", m.index!);
      for (let j = start; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) {
          out.push(src.slice(start, j + 1));
          break;
        }
      }
    }
    return out;
  }

  const literals = SOURCES.flatMap((f) =>
    assertContextLiterals(readFileSync(resolve(__dirname, "..", f), "utf8")).map((l) => [f, l] as const),
  );

  it("finds every builder it claims to check (a parser matching nothing passes vacuously)", () => {
    expect(literals.length).toBe(3);
    for (const [f, lit] of literals) expect(lit, f).toMatch(/\breferencesAccessed:/);
  });

  it("no builder assigns referencesAccessed from a bare main-agent list", () => {
    for (const [f, lit] of literals) {
      const assigned = /\breferencesAccessed:\s*([^,\n]+)/.exec(lit)![1]!;
      // `truncatedMsg ? undefined : union…` is the replay builder deliberately reporting cannot-verify
      // for a cassette that was never driven.
      expect(assigned, `${f}: AssertContext must union sub-agent accesses (got ${assigned})`).toMatch(
        /unionReferenceAccesses\(|truncatedMsg \?/,
      );
    }
  });
});

describe("both keys", () => {
  it("fail evidence-unavailable on an absent list rather than guessing in either direction", () => {
    for (const a of [{ reference_read: "x" }, { no_observed_reference_access: "x" }]) {
      const [r] = evaluate([a], ctx({ referencesAccessed: undefined }));
      expect(r!.pass, JSON.stringify(a)).toBe(false);
      expect(r!.message).toMatch(/evidence unavailable/);
    }
  });

  it("report a bad regex as a bad regex, not as a miss", () => {
    const [r] = evaluate([{ reference_read: "([" }], ctx({ referencesAccessed: ACCESSED }));
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/bad regex/);
  });

  it("evaluate independently across items — one key's verdict never leaks into the other's", () => {
    const rs = evaluate(
      [{ reference_read: "env\\.md" }, { no_observed_reference_access: "env\\.md" }],
      ctx({ referencesAccessed: ACCESSED }),
    );
    expect(rs.map((r) => r.pass)).toEqual([true, false]);
  });

  it("a SAME-ITEM contradiction fails the item rather than silently reporting one key's verdict", () => {
    // `reference_read: X` and `no_observed_reference_access: X` cannot both hold. evaluate() ANDs an
    // item's keys, so the item fails — and the linter rejects the pair outright before a run is paid for.
    const rs = evaluate([{ reference_read: "env\\.md", no_observed_reference_access: "env\\.md" }], ctx({ referencesAccessed: ACCESSED }));
    expect(rs).toHaveLength(1);
    expect(rs[0]!.pass).toBe(false);
  });
});
