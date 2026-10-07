// The lane notice: which conditions print it, and the one environment-shaped key list it shares with the
// `lane: remote` degradations.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENVIRONMENT_SHAPED_ASSERT_KEYS,
  LANE_NOTICE,
  LANE_NOTICE_ENV,
  laneNoticeApplies,
  maybePrintLaneNotice,
  maybePrintChatLaneNotice,
  resetLaneNoticeForTest,
} from "../src/run/lane-notice.js";

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });
const sc = (assert: object[], lane?: "local" | "remote") => ({ assert: assert as Record<string, unknown>[], ...(lane ? { lane } : {}) });

describe("laneNoticeApplies — the matrix", () => {
  it("a default run with a file_exists assert → yes", () => {
    expect(laneNoticeApplies(sc([{ file_exists: "outputs/a.md" }]), { env: env() })).toBe(true);
  });
  it("expect_denied alone (egress, expanded after the notice) → yes", () => {
    expect(laneNoticeApplies({ ...sc([{ transcript_contains: "x" }]), expect_denied: ["example.com"] }, { env: env() })).toBe(true);
    expect(laneNoticeApplies({ ...sc([{ transcript_contains: "x" }]), expect_denied: [] }, { env: env() })).toBe(false);
  });
  it("only behaviour-shaped asserts (transcript_contains) → no", () => {
    expect(laneNoticeApplies(sc([{ transcript_contains: "x" }]), { env: env() })).toBe(false);
  });
  it("lane: remote → no (the run already holds itself to the cloud contract)", () => {
    expect(laneNoticeApplies(sc([{ file_exists: "a" }], "remote"), { env: env() })).toBe(false);
  });
  it("--compact (and so --demo) → no", () => {
    expect(laneNoticeApplies(sc([{ file_exists: "a" }]), { env: env(), compact: true })).toBe(false);
  });
  it("CI set → no", () => {
    expect(laneNoticeApplies(sc([{ file_exists: "a" }]), { env: env({ CI: "true" }) })).toBe(false);
  });
  it(`${LANE_NOTICE_ENV} set → no`, () => {
    expect(laneNoticeApplies(sc([{ file_exists: "a" }]), { env: env({ [LANE_NOTICE_ENV]: "1" }) })).toBe(false);
  });
  it("every environment-shaped key triggers it on its own", () => {
    for (const k of ENVIRONMENT_SHAPED_ASSERT_KEYS) expect(laneNoticeApplies(sc([{ [k]: true }]), { env: env() }), k).toBe(true);
  });
});

describe("once per process", () => {
  beforeEach(() => resetLaneNoticeForTest());
  it("a batch prints one line", () => {
    const out: string[] = [];
    for (let i = 0; i < 3; i++) maybePrintLaneNotice(sc([{ file_exists: "a" }]), { env: env(), write: (s) => out.push(s) });
    expect(out).toEqual([LANE_NOTICE]);
  });
  it("chat prints it once at start, whatever it asserts, and honours the same silencers", () => {
    const out: string[] = [];
    maybePrintChatLaneNotice({ env: env(), write: (s) => out.push(s) });
    maybePrintChatLaneNotice({ env: env(), write: (s) => out.push(s) });
    expect(out).toEqual([LANE_NOTICE]);
    resetLaneNoticeForTest();
    const quiet: string[] = [];
    maybePrintChatLaneNotice({ env: env({ CI: "1" }), write: (s) => quiet.push(s) });
    maybePrintChatLaneNotice({ env: env({ [LANE_NOTICE_ENV]: "1" }), write: (s) => quiet.push(s) });
    expect(quiet).toEqual([]);
  });
  it("the text uses the date and a qualified brand name, and names the silencer", () => {
    expect(LANE_NOTICE).toContain("from 2026-10-06");
    expect(LANE_NOTICE).toContain("Cowork's local lane");
    expect(LANE_NOTICE).toContain(`${LANE_NOTICE_ENV}=1`);
  });
});

describe("one list: every `lane: remote` degradation in assert.ts is an environment-shaped key", () => {
  it('each key whose evaluator branches on lane === "remote" is in ENVIRONMENT_SHAPED_ASSERT_KEYS', () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "assert.ts"), "utf8");
    const found = new Set<string>();
    for (const m of src.matchAll(/ctx\.lane === "remote"/g)) {
      // the evaluator a branch belongs to: the nearest `a.<key> !== undefined` guard above it
      const before = src.slice(Math.max(0, m.index! - 4000), m.index!);
      const guards = [...before.matchAll(/if \(a\.([a-z_]+) !== undefined/g)];
      expect(guards.length, `no evaluator guard found above offset ${m.index}`).toBeGreaterThan(0);
      found.add(guards.at(-1)![1]);
    }
    expect(found.size).toBeGreaterThan(0);
    for (const k of found) expect(ENVIRONMENT_SHAPED_ASSERT_KEYS as readonly string[], k).toContain(k);
  });
});
