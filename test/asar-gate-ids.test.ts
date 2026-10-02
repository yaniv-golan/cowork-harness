import { describe, it, expect } from "vitest";
import { extractAsarGateIds } from "../src/sync/cowork-sync.js";
import { diffBaselines, formatDiffLines, renderChangelog } from "../src/sync/baseline-diff.js";

/**
 * `provenance.asarGateIds` — the field that makes a gate-membership change NAMEABLE.
 *
 * `provenance.fcache` carries two aggregates and a timestamp, so `featureCount: 271 → 278` says seven
 * arrived and nothing says which; a count-neutral swap says nothing at all; and because the fcache
 * refetches on its own schedule (3.7–20.8 min observed) a delta between two baselines is a net over days
 * of server rollout rather than a fact about the Desktop release. This list is a pure function of the
 * shipped bundle, so its diff is attributable, reproducible by anyone, and directly readable.
 *
 * The cases below are written so each CAN fail. Two of them exist because an earlier draft of this test
 * plan could not:
 *   - the filtering case: an implementation that keeps only "interesting" entries passes every
 *     naive case, and the risk was named in the plan with no test behind it.
 *   - the sortedness case: the collector is a `Set<string>`, which preserves INSERTION order for every
 *     key, so the only variation that can catch a deleted `.sort()` is input whose appearance order
 *     differs from its numeric order. (The canonical-array-index rule — numeric enumeration regardless of
 *     insertion order — governs plain OBJECTS, not this collector. An earlier draft cited it here and
 *     drew the wrong conclusion, which is why the 2^32 case below no longer claims to prove the sort.)
 */

const filesOf = (...texts: string[]) => new Map(texts.map((t, i) => [`chunk-${i}.js`, t]));

describe("extractAsarGateIds — the gate-DEFAULTS map's bare-numeric keys", () => {
  // Regression for a defect that shipped TWICE. The defaults map keys entries on bare numerics
  // (`{748063099:bw,3586389629:tvt(6e4)}`), so a quoted-literal-only scan misses any gate that is only
  // ever defaulted. It under-reported 1.30096.1's new gates 3 -> 1; that was recorded as a maintainer
  // note rather than as a test, so it recurred unchanged at 1.40609.0 (+27 extracted vs +30 real). These
  // cases exist so the third recurrence is impossible.
  it("captures a bare-numeric defaults-map key that no quoted literal mentions", () => {
    const ids = extractAsarGateIds(filesOf("var m={748063099:bw,3586389629:tvt(6e4),3927880029:Sw({value:3})};"));
    expect(ids).toEqual(["748063099", "3586389629", "3927880029"].sort((a, b) => Number(a) - Number(b)));
  });

  // The adjacency trap, and the reason the scanner uses a LOOKBEHIND rather than consuming `[{,]`.
  // Entries abut, so a delimiter-consuming match eats the comma the next entry needs as its own
  // delimiter and silently drops every other one — a half-length list that looks like a working scan.
  it("captures ADJACENT entries — a delimiter-consuming scan would drop every other one", () => {
    const ids = extractAsarGateIds(filesOf("var m={111111111:a,222222222:b,333333333:c,444444444:d};"));
    expect(ids).toEqual(["111111111", "222222222", "333333333", "444444444"]);
  });

  // The narrowness that distinguishes this from the bare-NUMBER scan the header rejects (which adds 1687
  // ids over the real bundle). A bare numeric that is not a defaults-map ENTRY must stay out: the id-space
  // filter alone does not carry this, since these are all in range.
  it("does NOT admit bare numerics that are not `<id>:<identifier>` entries", () => {
    const ids = extractAsarGateIds(filesOf("var n=123456789;f(987654321);const t=[135792468];x.y=246813579;"));
    expect(ids).toEqual([]);
  });

  // 2^22 — a real false positive from the hand-verification pass (a zlib table bound and a JSON read cap).
  // It is excluded by the id-space filter, not by the shape rule, so this pins the two working together.
  it("still excludes a sub-8-digit constant that happens to sit in an object literal", () => {
    expect(extractAsarGateIds(filesOf("var z={4194304:bw,748063099:bw};"))).toEqual(["748063099"]);
  });

  // Desktop 2.19675.0 rewrote the defaults map as a declarative RULE TABLE —
  // `pWt={147471044:{rule:"always",value:!0},…,4055864154:{rule:"remote"},…}` — whose values open with `{`,
  // not an identifier. The identifier-only lookahead missed every entry: on the real bundle that read as
  // 57 removed gate ids where 2 were really removed, and hid 2 real additions only the table names.
  it("captures rule-table entries `<id>:{rule:…}` (the 2.19675.0 defaults shape), adjacent ones included", () => {
    const ids = extractAsarGateIds(
      filesOf(
        'var pWt={147471044:{rule:"always",value:!0},151700879:{rule:"always",value:"inherit"},4055864154:{rule:"remote"},' +
          '1263782781:{rule:"forcedFor",group:"sessionHostDevice",value:{s:1}},2464296336:{rule:"when",condition:"selfHostedSessions",value:!0}};',
      ),
    );
    expect(ids).toEqual(["147471044", "151700879", "1263782781", "2464296336", "4055864154"]);
  });

  it("reads both shapes in one bundle (old `<id>:<ctor>` entries keep working)", () => {
    const ids = extractAsarGateIds(filesOf("var a={505512513:QC(!0),3559681707:$C(`off`)};", 'var b={3310072118:{rule:"remote"}};'));
    expect(ids).toEqual(["505512513", "3310072118", "3559681707"]);
  });

  // The widening is the rule shape ONLY: any other object-valued numeric key is still noise.
  it("does NOT admit a numeric key whose object value is not a rule entry", () => {
    expect(extractAsarGateIds(filesOf("var o={123456789:{foo:1},234567891:{ rule:1}};"))).toEqual([]);
  });

  it("applies the id-space filter to rule entries too", () => {
    expect(extractAsarGateIds(filesOf('var o={1234567:{rule:"remote"},4294967296:{rule:"remote"},17519066:{rule:"remote"}};'))).toEqual([
      "17519066",
    ]);
  });
});

describe("extractAsarGateIds — what it keeps", () => {
  it("extracts quoted gate ids across every quote style the bundle emits", () => {
    // Minifiers emit all three; anchoring on backticks alone under-reported a real gate delta before.
    const ids = extractAsarGateIds(filesOf('a("66187241")', "b('123929380')", "c(`1143815894`)"));
    expect(ids).toEqual(["66187241", "123929380", "1143815894"]);
  });

  it("sorts NUMERICALLY, and the input order is deliberately the reverse", () => {
    // The ids appear in the bundle in DESCENDING order, so appearance order and sorted order differ.
    // Written the other way round the case passes with `.sort()` deleted — the collector is a Set of
    // strings, which preserves insertion order — and the assertion measures nothing. Mutation-verified:
    // removing the sort fails this case and only this case.
    const ids = extractAsarGateIds(filesOf('y("1000000000");x("999999999")'));
    expect(ids).toEqual(["999999999", "1000000000"]);
  });

  it("keeps an id regardless of gate state — the filtering mutation", () => {
    // An implementation that narrowed to on/served/pinned entries would still pass every case above.
    // These three ids are indistinguishable in the bundle; nothing here says on/off/pinned, and that is
    // precisely the point: the bundle records a REFERENCE, and the field must not editorialise.
    // 1129419822 is `enableToolSearchAuto`, DARK — absent from a standard fcache by design. Dropping
    // ids the local fcache lacks is the specific mistake that would make this list account-shaped.
    const ids = extractAsarGateIds(filesOf('gate("1129419822");gate("2614807392");gate("66187241")'));
    expect(ids).toContain("1129419822");
    expect(ids).toContain("2614807392");
    expect(ids).toHaveLength(3);
  });
});

describe("extractAsarGateIds — what it rejects, and why", () => {
  it("rejects bare (unquoted) numbers", () => {
    // Gate ids are passed as STRING literals. Over the same require-graph input the extractor reads,
    // scanning bare numbers instead yields 1953 numeric tokens on the 1.34493.1 bundle — of which only
    // 8 are live gate ids. (An earlier draft said 2205; that was measured over ALL of `.vite`, a
    // different population than the extractor actually walks.)
    expect(extractAsarGateIds(filesOf("const t=1755123456; setTimeout(f,66187241)"))).toEqual([]);
  });

  it("rejects leading-zero strings and out-of-range lengths, at BOTH bounds", () => {
    // Every one of the 278 live fcache ids is 8-10 digits with no leading zero, so this is the id space
    // rather than a taste call. `0123456789` and `00000000` are real literals in the shipped bundle.
    const ids = extractAsarGateIds(filesOf('a("0123456789");b("00000000");c("10000");d("12345678901234")'));
    expect(ids).toEqual([]);
    // The lower bound needs its OWN adjacent case: with only a 5-digit and a 14-digit sample above,
    // relaxing `< 8` to `< 7` passed every case while admitting a 7-digit token (208 -> 209 on the real
    // bundle). Mutation-verified — an off-by-one at a bound is invisible unless something sits on it.
    expect(extractAsarGateIds(filesOf('a("1234567")'))).toEqual([]); // 7 digits — just below the space
    expect(extractAsarGateIds(filesOf('a("17519066")'))).toEqual(["17519066"]); // 8 — min live id, kept
  });

  it("rejects an id at or above 2^32", () => {
    // Range check ONLY. This case does not prove the sort — mutation-verified, it kills the range check
    // and nothing else. The descending-input case above is what a deleted `.sort()` fails.
    expect(extractAsarGateIds(filesOf('a("4294967296")'))).toEqual([]);
    expect(extractAsarGateIds(filesOf('a("4293378213")'))).toEqual(["4293378213"]); // max live id, kept
  });

  it("requires a CLOSING quote, not just an opening one", () => {
    // Uncovered until an adversarial pass found it: deleting the closing character class from the regex
    // passed all ten cases while inflating the real 1.34493.1 bundle 208 -> 216, admitting numbers out of
    // unterminated or differently-delimited contexts. An id is only an id when its literal is closed.
    expect(extractAsarGateIds(filesOf("a(\"66187241);b('123929380"))).toEqual([]);
    expect(extractAsarGateIds(filesOf('a("66187241")'))).toEqual(["66187241"]);
  });

  it("dedupes across chunks and returns a stable order", () => {
    const a = extractAsarGateIds(filesOf('x("66187241")', 'y("1143815894")', 'z("66187241")'));
    const b = extractAsarGateIds(filesOf('z("66187241")', 'y("1143815894")', 'x("66187241")'));
    expect(a).toEqual(["66187241", "1143815894"]);
    expect(a).toEqual(b);
  });

  it("returns [] on an empty bundle rather than throwing", () => {
    expect(extractAsarGateIds(new Map())).toEqual([]);
  });
});

describe("the diff names the delta", () => {
  const withIds = (ids: string[]) => ({ provenance: { asarGateIds: ids } });

  it("renders added and removed ids by name, not as a count", () => {
    // Through renderChangelog — that is what reaches the per-field renderer. Asserting through
    // formatDiffLines instead only exercises the pre-existing generic `+[…] -[…]` formatter: measured,
    // deleting the entire renderer block left this file and baseline-diff green at 38/38.
    const out = renderChangelog(diffBaselines(withIds(["66187241", "235864698"]) as never, withIds(["66187241", "40173473"]) as never));
    expect(out).toContain("gate ids referenced by the bundle");
    expect(out).toContain("40173473");
    expect(out).toContain("235864698");
  });

  it("`sync --diff` uses the GENERIC formatter, so the field must read sanely there too", () => {
    // The per-field renderer above is reachable only from `diff --changelog` (cli.ts:4915).
    // `sync --diff` calls formatDiffLines (cli.ts:2958), whose docstring says it carries no known-field
    // prose. Pinning both so a future reader does not assume the nice line appears during a sync.
    const lines = formatDiffLines(diffBaselines(withIds(["66187241"]) as never, withIds(["66187241", "40173473"]) as never));
    expect(lines.join("\n")).toContain("40173473");
  });

  it("renders the FIRST introduction — the differ recurses to the leaf", () => {
    // Verified by execution, not assumed: `provenance` exists in every base, so diffBaselines recurses
    // and emits a per-leaf `added` here. An earlier draft asserted the opposite and would have shipped a
    // renderer that never fired.
    const d = diffBaselines(
      { provenance: { asarFingerprint: "x" } } as never,
      { provenance: { asarFingerprint: "x", asarGateIds: ["66187241"] } } as never,
    );
    expect(d.some((e) => e.path === "provenance.asarGateIds" && e.kind === "added")).toBe(true);
  });
});

describe("the field actually reaches the committed artifact", () => {
  it("the newest baseline carries a well-formed asarGateIds", async () => {
    // The consumer contract. An adversarial pass showed that deleting the write in `src/cli.ts` left all
    // 5,749 tests byte-identical — nothing observed whether `sync` emitted the field at all. This closes
    // the artifact half of that: shape, sortedness and id-space are asserted on what actually shipped.
    // Honest limit: it catches a deleted write only AFTER the next sync regenerates a baseline without
    // it. The record-time half is covered by the empty-extraction flag in `extractFromAsar`.
    const { loadBaseline } = await import("../src/baseline.js");
    const ids = (loadBaseline("latest") as unknown as { provenance?: { asarGateIds?: unknown } }).provenance?.asarGateIds;
    expect(Array.isArray(ids)).toBe(true);
    const list = ids as string[];
    expect(list.length).toBeGreaterThan(100);
    expect(list.every((i) => /^[1-9]\d{7,9}$/.test(i) && Number(i) < 2 ** 32)).toBe(true);
    expect([...list].sort((a, b) => Number(a) - Number(b))).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });
});
