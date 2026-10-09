import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_ID, composeJudgedDocument, evaluate, runSemanticJudges, type AssertContext } from "../src/assert.js";
import { captureAuthoredFilesWithHealth } from "../src/run/artifacts.js";
import { makeSemanticJudge } from "../src/decide/semantic-judge.js";
import { pairwiseComposeKey } from "../src/run/pairwise-prepass.js";
import { composeKey } from "../src/refs/store.js";
import { LANE_REMOTE_INCOMPATIBLE } from "../src/run/lane-notice.js";
import { loadScenarioPure } from "../src/run/execute.js";
import { preSpendVerdicts, replayCassette } from "../src/run/cassette.js";
import type { Assertion } from "../src/types.js";

// `lane: remote` still EXECUTES locally, so every key below reads a local tree that exists and can pass. The contract
// it models is a remote container whose filesystem is not observable from outside it: a check that depends on files
// inside that container is evidence-unavailable there. Each case first PASSES on `lane: local` over the same context,
// so the remote failure can only come from the lane branch.

const SID = "11111111-1111-4111-8111-111111111111";

function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-remote-sib-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
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
    slashInvokedSkills: [],
    ...over,
  };
}

const LANE = /cannot be verified on `lane: remote`/;

const cases: Array<[string, Assertion, (root: string) => Partial<AssertContext>]> = [
  ["no_unexpected_files (a clean walk)", { no_unexpected_files: ["outputs/report.md"] }, () => ({ preRunPaths: [] })],
  [
    "computer_links_resolve (a link that resolves)",
    { computer_links_resolve: true },
    () => ({ transcript: `[r](computer:///sessions/${SID}/mnt/outputs/report.md)`, linkResolution: { mode: "live" } }),
  ],
  [
    "computer_links_resolve_if_present (zero links: the vacuous pass)",
    { computer_links_resolve_if_present: true },
    () => ({ transcript: "no links", linkResolution: { mode: "live" } }),
  ],
  ["no_lost_write_back (a clean authored set)", { no_lost_write_back: true }, () => ({ preRunHashes: {}, authoredFiles: [] })],
];

describe("lane: remote — keys that read the container's files refuse", () => {
  for (const [name, a, over] of cases) {
    it(`${name}: passes on lane: local, refused on lane: remote`, () => {
      const root = tree({ "outputs/report.md": "hi" });
      const local = evaluate([a], ctx(root, over(root)));
      expect(
        local.every((r) => r.pass),
        JSON.stringify(local),
      ).toBe(true);
      const [remote] = evaluate([a], ctx(root, { ...over(root), lane: "remote" }));
      expect(remote.pass).toBe(false);
      expect(remote.message).toMatch(LANE);
    });
  }
});

describe("file_absent on lane: remote names a remedy that leads somewhere", () => {
  it("points at transcript_not_matches or lane: local, not at a delivered artifact", () => {
    const [r] = evaluate([{ file_absent: "outputs/debug.log" }], ctx(tree(), { lane: "remote" }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/transcript_not_matches/);
    expect(r.message).toMatch(/lane: local/);
    expect(r.message).not.toMatch(/delivered artifact/);
  });
});

describe("input_unmodified keeps reading the local stand-in on lane: remote (user decision, unconfirmed)", () => {
  it("evaluates on remote exactly as on local", () => {
    const root = tree({ "uploads/in.csv": "a,b" });
    const sha = "a8d6c0a1cdb8fbe4b5fc9b1ff58e1ef6d03e2d28b7f8a6c1ad3c8cbe8bb41b9b"; // not the body's hash
    for (const lane of ["local", "remote"] as const) {
      const [r] = evaluate([{ input_unmodified: "uploads/**" }], ctx(root, { lane, preRunHashes: { "uploads/in.csv": sha } }));
      expect(r.pass, lane).toBe(false);
      expect(r.message, lane).not.toMatch(/lane: remote/);
    }
  });
});

describe("authored: true on lane: remote is undecidable; plain file_exists stays the remote-lane proxy", () => {
  // `authored` compares the post-run body's hash with the pre-run manifest: a read of the container's file. Plain
  // file_exists asserts a written PATH, which the docs prescribe (with transcript_matches) as the remote-lane proxy.
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  it("file_exists {authored: true} passes on local, fails on remote; plain file_exists passes on both", () => {
    const root = tree({ "outputs/report.md": "new body" });
    const over = { preRunHashes: { "outputs/report.md": sha("old body") }, preRunPaths: ["outputs/report.md"] };
    const authoredA: Assertion = { file_exists: { path: "outputs/report.md", authored: true } };
    expect(evaluate([authoredA], ctx(root, over))[0].pass).toBe(true);
    const [r] = evaluate([authoredA], ctx(root, { ...over, lane: "remote" }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/lane: remote/);
    for (const lane of ["local", "remote"] as const)
      expect(evaluate([{ file_exists: "outputs/report.md" }], ctx(root, { ...over, lane }))[0].pass, lane).toBe(true);
  });
});

// semantic_matches on `lane: remote` is judged on the transcript only. The oracle is the PROMPT the real
// request builder sends (makeSemanticJudge with an injected transport), over a context captured from a real tree —
// a marker planted in an authored file, a sub-agent's text and a dropped file's path must reach no field of it.
describe("semantic_matches on lane: remote — the judge sees the transcript only", () => {
  const MARK = "FILE-BODY-MARKER-7c1e";
  const SUB = "SUBAGENT-MARKER-91ad";
  // `dropped`: the capture budget is exhausted, so a file's PATH lands in the capture health. On lane: local that
  // refuses before judging (the evidence is incomplete); on lane: remote the local capture is not evidence at all.
  async function judged(lane: "local" | "remote", a: Assertion, dropped = false) {
    // Captured in name order: report.md fits, zz-a.md fills the budget, zz-b.md is dropped.
    const files: Record<string, string> = { "outputs/report.md": `report ${MARK}` };
    if (dropped) Object.assign(files, { "outputs/zz-a.md": "x".repeat(4096), "outputs/zz-b.md": "y".repeat(64) });
    const root = tree(files);
    const cap = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, { totalBytes: 2048 });
    expect(cap.files.some((f) => f.content.includes(MARK))).toBe(true); // the body IS captured
    if (dropped) expect(cap.health.omittedPaths).toContain("outputs/zz-b.md");
    const prompts: string[] = [];
    const judge = makeSemanticJudge({
      model: "m",
      complete: async (prompt) => {
        prompts.push(prompt);
        return { text: '{"results":[{"index":0,"pass":true}]}', model: "m" };
      },
    });
    const c = ctx(root, {
      lane,
      transcript: "the agent wrote the report",
      finalMessage: "done",
      authoredFiles: cap.files,
      authoredFilesHealth: cap.health,
      preRunHashes: {},
      subagents: [{ description: "helper", reasoning: [{ kind: "text", text: SUB }] }] as unknown as AssertContext["subagents"],
    });
    await runSemanticJudges([a], c, judge);
    const [r] = evaluate([a], c);
    return { r, prompts };
  }
  const rubric: Assertion = { semantic_matches: { rubric: ["the report was written"], include_subagent_text: true } } as Assertion;

  it("lane: local sends the file body and the sub-agent text (control)", async () => {
    const { prompts } = await judged("local", rubric);
    expect(prompts).toHaveLength(1);
    for (const m of [MARK, SUB]) expect(prompts[0]).toContain(m);
  });

  it("lane: remote sends none of them (nor a dropped path), says transcript-only, and records no graded paths", async () => {
    const { r, prompts } = await judged("remote", rubric, true);
    expect(prompts).toHaveLength(1);
    for (const m of [MARK, SUB, "outputs/report.md", "outputs/zz-a.md", "outputs/zz-b.md"]) expect(prompts[0]).not.toContain(m);
    expect(prompts[0]).toContain("the agent wrote the report");
    expect(prompts[0]).toMatch(/transcript only/i);
    expect(r.pass).toBe(true);
    expect(r.semanticEvidence).toEqual({ reason: "graded", paths: [] });
    expect(r.evidence).toMatch(/transcript only \(lane: remote\)/);
  });

  it("evidence_files on lane: remote is evidence-unavailable and the judge is not called", async () => {
    const scoped = { semantic_matches: { rubric: ["x"], evidence_files: ["outputs/report.md"] } } as Assertion;
    const { r, prompts } = await judged("remote", scoped);
    expect(prompts).toHaveLength(0);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
    expect(r.message).toMatch(/lane: remote/);
    expect(r.semanticEvidence?.reason).toBe("lane_remote_evidence_files");
  });
});

describe("semantic_pairwise references are stored per lane", () => {
  // A remote candidate is transcript-only; a reference frozen from a local run carries file bodies. They must never
  // meet, and a local key must be the hash it was before the lane existed (no local store is invalidated).
  const a = { semantic_pairwise: { refs: ["r"], rubric: ["x"] } } as unknown as Assertion;
  it("a remote key differs from the local one; the local key is unchanged", () => {
    const local = pairwiseComposeKey(a, "local");
    expect(pairwiseComposeKey(a, undefined)).toBe(local);
    expect(pairwiseComposeKey(a, "remote")).not.toBe(local);
    const o = { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined };
    expect(local).toBe(composeKey(COMPOSER_ID, o)); // the pre-lane formula
  });
});

// A key that can never pass on lane: remote is a LOAD error (before any spend), on every path that starts a run:
// the scenario loader, and the shared pre-spend list `record` runs — which `record --from-embedded` reaches without
// the loader.
describe("lane: remote refuses at load the keys that can never pass there", () => {
  const NEVER: Array<[string, string]> = [
    ["artifact_text", "artifact_text: {artifact: outputs/a.md, contains: [x]}"],
    ["artifact_json", "artifact_json: {artifact: outputs/a.json, path: a, equals: 1}"],
    ["file_absent", "file_absent: outputs/a.md"],
    ["no_unexpected_files", "no_unexpected_files: [outputs/a.md]"],
    ["computer_links_resolve", "computer_links_resolve: true"],
    ["computer_links_resolve_if_present", "computer_links_resolve_if_present: true"],
    ["no_lost_write_back", "no_lost_write_back: true"],
    ["user_visible_artifact", "user_visible_artifact: outputs/a.md"],
    ["present_files_called", "present_files_called: true"],
    ["no_scratchpad_leak", "no_scratchpad_leak: true"],
    ["semantic_matches", "semantic_matches: {rubric: [x], evidence_files: [outputs/a.md]}"],
    ["semantic_pairwise", "semantic_pairwise: {refs: [r], evidence_files: [outputs/a.md]}"],
    ["file_exists", "file_exists: {path: outputs/a.md, authored: true}"],
  ];
  const file = (lane: string, item: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-lane-load-"));
    const p = join(dir, "s.yaml");
    writeFileSync(
      p,
      ["baseline: latest", "fidelity: container", "prompt: hi", `lane: ${lane}`, "assert:", `  - ${item}`].join("\n") + "\n",
    );
    return p;
  };
  for (const [key, item] of NEVER) {
    it(`${key}: refused at load on remote, loads on local`, () => {
      expect(() => loadScenarioPure(file("remote", item))).toThrow(new RegExp(`\`${key}\` cannot pass on \`lane: remote\``));
      expect(() => loadScenarioPure(file("local", item))).not.toThrow();
      // The pre-spend list `record` runs refuses it too (record --from-embedded never reaches the loader).
      const sc = loadScenarioPure(file("local", item));
      const v = preSpendVerdicts({ ...sc, lane: "remote" }, join(tmpdir(), "x.cassette.json"), { force: true });
      expect(v.some((x) => x.kind === "refuse" && x.message.includes(`\`${key}\` cannot pass on \`lane: remote\``))).toBe(true);
    });
  }
  it("semantic_matches without evidence_files loads on remote (judged on the transcript only)", () => {
    expect(() => loadScenarioPure(file("remote", "semantic_matches: {rubric: [x]}"))).not.toThrow();
  });
  it("input_unmodified and file_exists load on remote", () => {
    expect(() => loadScenarioPure(file("remote", "input_unmodified: uploads/**"))).not.toThrow();
    expect(() => loadScenarioPure(file("remote", "file_exists: outputs/a.md"))).not.toThrow();
  });
});

describe("the transcript-only note survives the judge document's size cap", () => {
  it("is the first section, so a cut at the end never removes it", () => {
    const c = ctx(tree(), { lane: "remote", finalMessage: "done", transcript: "t".repeat(400_000) });
    const d = composeJudgedDocument(c, false, undefined, false);
    expect(d.doc.startsWith("## Evidence scope (transcript only)")).toBe(true);
    expect(d.fingerprint.sections[0]?.kind).toBe("health");
  });
});

// The other direction of the lane-notice cross-check: a key refused at load must also refuse when it reaches the
// evaluator another way (a replayed older cassette, verify-run of a kept run). A key added to the load list alone fails
// here until it has its assertion-time branch.
describe("every key refused at load on lane: remote also refuses at assertion time", () => {
  const SAMPLE: Record<keyof typeof LANE_REMOTE_INCOMPATIBLE, Assertion> = {
    present_files_called: { present_files_called: true },
    no_scratchpad_leak: { no_scratchpad_leak: true },
    user_visible_artifact: { user_visible_artifact: "outputs/report.md" },
    artifact_text: { artifact_text: { artifact: "outputs/report.md", contains: ["hi"] } },
    artifact_json: { artifact_json: { artifact: "outputs/report.json", path: "a", equals: 1 } },
    file_absent: { file_absent: "outputs/none.md" },
    no_unexpected_files: { no_unexpected_files: ["outputs/report.md"] },
    computer_links_resolve: { computer_links_resolve: true },
    computer_links_resolve_if_present: { computer_links_resolve_if_present: true },
    no_lost_write_back: { no_lost_write_back: true },
  } as Record<keyof typeof LANE_REMOTE_INCOMPATIBLE, Assertion>;
  it("covers the whole load list", () => expect(Object.keys(SAMPLE).sort()).toEqual(Object.keys(LANE_REMOTE_INCOMPATIBLE).sort()));
  for (const [key, a] of Object.entries(SAMPLE))
    it(key, () => {
      const root = tree({ "outputs/report.md": "hi", "outputs/report.json": '{"a":1}' });
      const [r] = evaluate(
        [a],
        ctx(root, {
          lane: "remote",
          effectiveFidelity: "container",
          preRunPaths: [],
          preRunHashes: {},
          authoredFiles: [],
          linkResolution: { mode: "live" },
          transcript: "no links",
        }),
      );
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/lane: remote/);
    });
});

describe("lane: remote — the paths that skip the load check still refuse", () => {
  it("a --resume turn (no pre-run manifest of its own) is still judged on the transcript, not refused for the baseline", async () => {
    const prompts: string[] = [];
    const judge = makeSemanticJudge({
      model: "m",
      complete: async (prompt) => {
        prompts.push(prompt);
        return { text: '{"results":[{"index":0,"pass":true}]}', model: "m" };
      },
    });
    const a = { semantic_matches: { rubric: ["x"] } } as Assertion;
    const c = ctx(tree(), {
      lane: "remote",
      transcript: "t",
      authoredFiles: [],
      authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [], noPreRunManifest: true } as never,
    });
    await runSemanticJudges([a], c, judge);
    const [r] = evaluate([a], c);
    expect(prompts).toHaveLength(1);
    expect(r.semanticEvidence?.reason).toBe("graded");
  });

  it("an older lane: remote cassette replays no_unexpected_files and computer_links_resolve as lane failures", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `[r](computer:///sessions/${SID}/mnt/outputs/r.md)` }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const body = "hi";
    const cassette = {
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        lane: "remote",
        assert: [{ no_unexpected_files: ["outputs/r.md"] }, { computer_links_resolve: true }, { result: "success" }],
      },
      events,
      preRunPaths: [],
      artifacts: [{ path: "outputs/r.md", bytes: 2, sha256: createHash("sha256").update(body).digest("hex"), body }],
    } as any;
    const r = await replayCassette(cassette);
    const failed = r.assertions.filter((x) => !x.pass);
    expect(failed.map((x) => Object.keys(x.assertion)[0]).sort()).toEqual(["computer_links_resolve", "no_unexpected_files"]);
    for (const f of failed) expect(f.message).toMatch(/lane: remote/);
  });
});
