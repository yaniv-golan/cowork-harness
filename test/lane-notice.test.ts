// The lane notice: which conditions print it, and the one environment-shaped key list it shares with the
// `lane: remote` degradations.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENVIRONMENT_SHAPED_ASSERT_KEYS,
  LANE_REMOTE_INCOMPATIBLE,
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
  // A branch inside a helper (not directly under an `if (a.<key> !== undefined` guard) is attributed through this
  // table. A helper missing from it fails the test, so a new site is classified rather than mis-attributed to
  // whichever key's guard happens to sit above it.
  const HELPERS: Record<string, string[]> = {
    // authored: true — file_exists / artifact_text / artifact_json / user_visible_artifact all take it
    authorshipOf: ["file_exists", "artifact_text", "artifact_json", "user_visible_artifact"],
    evalComputerLinks: ["computer_links_resolve", "computer_links_resolve_if_present"],
    // the judge's evidence: semantic keys are not environment-shaped (they load on remote), so they are checked
    // against the documented exemption below instead
    scopeAuthoredEvidence: [],
    allAuthoredPaths: [],
    semanticRefusal: [],
    composeJudgedDocument: [],
  };
  it('each key whose evaluator branches on lane === "remote" is in ENVIRONMENT_SHAPED_ASSERT_KEYS', () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "assert.ts"), "utf8");
    const found = new Set<string>();
    const helpersSeen = new Set<string>();
    for (const m of src.matchAll(/ctx\.lane [!=]== "remote"/g)) {
      const before = src.slice(0, m.index!);
      const anchors = [
        ...[...before.matchAll(/if \(a\.([a-z_]+) !== undefined/g)].map((g) => ({ at: g.index!, key: g[1]!, helper: false })),
        // top-level functions only (column 0), plus the one closure that owns a branch inside evaluate()
        ...[...before.matchAll(/^(?:export )?(?:async )?function ([A-Za-z]+)\(|const (evalComputerLinks) = \(/gm)].map((g) => ({
          at: g.index!,
          key: (g[1] ?? g[2])!,
          helper: true,
        })),
      ].sort((x, y) => x.at - y.at);
      const near = anchors.at(-1);
      expect(near, `no evaluator guard or helper found above offset ${m.index}`).toBeDefined();
      expect(!near!.helper || near!.key in HELPERS, `unclassified helper ${near!.key} at offset ${m.index}: add it to HELPERS`).toBe(true);
      if (near!.helper) {
        helpersSeen.add(near!.key);
        for (const k of HELPERS[near!.key]!) found.add(k);
      } else found.add(near!.key);
    }
    expect(found.size).toBeGreaterThan(0);
    // The judged keys load on lane: remote and are judged on the transcript only; they are not environment-shaped
    // (listing them would print the lane notice on every local semantic scenario).
    const TRANSCRIPT_ONLY = new Set(["semantic_matches", "semantic_pairwise"]);
    for (const k of found) if (!TRANSCRIPT_ONLY.has(k)) expect(ENVIRONMENT_SHAPED_ASSERT_KEYS as readonly string[], k).toContain(k);
    // every helper in the table still has a branch (a stale entry would hide a removed refusal)
    for (const h of Object.keys(HELPERS)) expect(helpersSeen, h).toContain(h);
  });

  it("every key refused at load on lane: remote is environment-shaped", () => {
    for (const k of Object.keys(LANE_REMOTE_INCOMPATIBLE)) expect(ENVIRONMENT_SHAPED_ASSERT_KEYS as readonly string[], k).toContain(k);
  });
});
