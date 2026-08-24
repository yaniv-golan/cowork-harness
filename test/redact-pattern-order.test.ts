import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findShadowedPatterns, redactText } from "../src/redact.js";
import { normalizeHostShapedForReplay } from "../src/run/computer-links.js";

/**
 * Redaction pattern ORDER is load-bearing, and nothing said so until this file.
 *
 * `redactText` applies patterns sequentially over the accumulating output, so an earlier pattern can eat
 * the text a later pattern's lookahead exists to preserve. The shipped policy depends on it: the
 * `(?=/mnt/)`-anchored rules sit ahead of the bare catch-alls so a run-dir path redacts to
 * `[REDACTED:…]/mnt/outputs/f.md` and still resolves on replay. Reverse them and every `computer_links`
 * structural-marker resolution silently stops working — no error, no finding, just links that no longer
 * resolve.
 *
 * The behavioural case below is the one that matters: a syntactic detector that drifts from the runtime
 * consequence would be a guard in name only.
 */

const POLICY = JSON.parse(readFileSync(resolve(".cowork-redact.json"), "utf8"));
const SOURCES: string[] = POLICY.patterns.map((p: { regex: string }) => p.regex);
const mk = (regexes: string[]) => ({ patterns: regexes.map((r) => ({ re: new RegExp(r, "g"), label: "local-path" })), keyNames: [] });
const RUNDIR_LINK = "/Users/joe/.cowork-harness/runs/r1/work/session/mnt/outputs/report.md";

describe("the shipped policy", () => {
  it("parsed a sane policy (a detector fed an empty list passes everything)", () => {
    expect(SOURCES.length).toBeGreaterThan(3);
    expect(SOURCES.some((s) => s.includes("(?="))).toBe(true);
  });

  it("orders its lookahead-anchored patterns ahead of the bare catch-alls", () => {
    expect(findShadowedPatterns(SOURCES)).toEqual([]);
  });

  // The consequence, not the syntax. This is what a reorder actually costs.
  it("preserves the /mnt/ tail, so a host-shaped link still normalizes", () => {
    const redacted = redactText(RUNDIR_LINK, mk(SOURCES) as never);
    expect(redacted).toContain("/mnt/outputs/report.md");
    expect(normalizeHostShapedForReplay(redacted, undefined)).toBe("outputs/report.md");
  });

  it("MUTATION: moving the bare catch-alls first breaks resolution, and the detector sees it", () => {
    const bad = [SOURCES[3], SOURCES[4], SOURCES[5], SOURCES[0], SOURCES[1], SOURCES[2], ...SOURCES.slice(6)];
    // the runtime consequence
    const redacted = redactText(RUNDIR_LINK, mk(bad) as never);
    expect(redacted).not.toContain("/mnt/");
    expect(normalizeHostShapedForReplay(redacted, undefined)).toBeNull();
    // and the detector flags exactly the three shadowed pairs
    expect(findShadowedPatterns(bad)).toHaveLength(3);
  });
});

describe("findShadowedPatterns", () => {
  it("flags a bare pattern ordered ahead of its lookahead-anchored twin", () => {
    const f = findShadowedPatterns(["/Users/[^/]+", "/Users/[^/]+?(?=/mnt/)"]);
    expect(f).toEqual([{ shadowed: 1, by: 0, base: "/Users/[^/]+" }]);
  });

  it("accepts the safe order", () => {
    expect(findShadowedPatterns(["/Users/[^/]+?(?=/mnt/)", "/Users/[^/]+"])).toEqual([]);
  });

  it("normalizes lazy quantifiers, so `+?` and `+` are recognized as the same base", () => {
    expect(findShadowedPatterns(["/x/[a-z]+?", "/x/[a-z]+?(?=/mnt/)"])).toHaveLength(1);
  });

  it("does not fire on unrelated patterns, or on a policy with no lookaheads", () => {
    expect(findShadowedPatterns(["/Users/[^/]+", "/home/[^/]+"])).toEqual([]);
    expect(findShadowedPatterns(["a@b\\.com", "/Users/[^/]+"])).toEqual([]);
  });

  // Conservative by design: regex subsumption is undecidable, so a near-miss must NOT warn. A false
  // positive trains authors to ignore the warning, which costs more than the miss.
  it("stays silent when the bases merely overlap rather than match", () => {
    expect(findShadowedPatterns(["/Users/joe/[^/]+", "/Users/[^/]+?(?=/mnt/)"])).toEqual([]);
  });

  /**
   * REGRESSION — a real third-party policy the first version of this detector missed.
   *
   * It matched the lookahead as `\(\?=[^()]*\)`, and that `[^()]*` silently skipped every lookahead
   * containing a group. `(?=/mnt(?:/|$|[\s"'\\)\]]))` is the natural way to write "slash, end, or
   * delimiter" — arguably more correct than a bare `(?=/mnt/)`, since it also covers a path ending at
   * `/mnt` — so the guard missed the shape a careful author is MORE likely to write, and missed it on the
   * only outside policy available to test against.
   *
   * The remainder is now checked by SHAPE, never by parsing the body. That also sidesteps escape- and
   * char-class-awareness: this same policy carries an escaped `\)` inside a character class, so any
   * paren-balancing approach would have had to handle it.
   */
  const THIRD_PARTY_BARE = "/Users/[^\\s\"'\\\\)\\]`]+";
  const THIRD_PARTY_LOOKAHEAD = "/Users/[^\\s\"'\\\\)\\]`]+?(?=/mnt(?:/|$|[\\s\"'\\\\)\\]]))";

  it("flags a nested-group lookahead (the case the first version missed)", () => {
    const f = findShadowedPatterns([THIRD_PARTY_BARE, THIRD_PARTY_LOOKAHEAD]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ shadowed: 1, by: 0 });
  });

  it("stays silent on that same policy in its SAFE order", () => {
    expect(findShadowedPatterns([THIRD_PARTY_LOOKAHEAD, THIRD_PARTY_BARE])).toEqual([]);
  });

  it("the nested-group case is genuinely dangerous, not just detectable", () => {
    const mk = (rs: string[]) => ({ patterns: rs.map((r) => ({ re: new RegExp(r, "g"), label: "local-path" })), keyNames: [] });
    const link = "/Users/joe/.cowork-harness/runs/r1/work/session/mnt/outputs/report.md";
    expect(redactText(link, mk([THIRD_PARTY_LOOKAHEAD, THIRD_PARTY_BARE]) as never)).toContain("/mnt/outputs/report.md");
    expect(redactText(link, mk([THIRD_PARTY_BARE, THIRD_PARTY_LOOKAHEAD]) as never)).not.toContain("/mnt/");
  });
});
