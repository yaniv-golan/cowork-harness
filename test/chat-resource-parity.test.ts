import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ResourceSampler } from "../src/runtime/resource-sampler.js";
import { buildChatResult } from "../src/run/chat-result.js";
import { turnWriteDir } from "../src/run/turn-layout.js";
import type { RunRecord } from "../src/run/run.js";

// F44: chat.ts's container/hostloop branches now drive a real ResourceSampler (mirroring execute.ts),
// so buildChatResult's foldResources() call has something to fold. Before the fix, no chat branch ever
// started a sampler, so `resources.jsonl` never existed and buildChatResult's `resources` field was
// always undefined regardless of fidelity — contradicting its doc-comment's parity claim.
//
// These tests exercise the same ResourceSampler + buildChatResult pairing chat.ts now wires up, without
// spawning a real docker/ps process: a fixed `sampleOnce` thunk stands in for `makeSampleOnce`'s real
// container/hostloop probes (which chat.ts itself now calls, per the source diff).

function minimalChatRecord(): RunRecord {
  return {
    runId: "chat",
    result: "success",
    initTools: [],
    transcript: "hi",
    toolsCalled: new Set(["Bash"]),
    toolCounts: { Bash: 1 },
    filesRead: [],
    subagentTools: new Set(),
    subagents: [],
    questions: [],
    decisions: [],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    skillsInvoked: [],
    models: ["claude-x"],
    thinking: [],
    thinkingElided: 0,
    toolErrors: {},
    redundantToolCalls: [],
    tasks: new Map(),
    context: { tools: [], mcpServers: [] },
    contextEvents: [],
    mcpErrors: [],
    hookEvents: [],
    fileToolAttempts: [],
    pathDenials: [],
    presentedFiles: [],
    webSearches: [],
    infraErrors: [],
    evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0 },
  } as RunRecord;
}

let outDir: string;
afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("chat resource-sampling parity (F44)", () => {
  it("a container/hostloop chat that ran a ResourceSampler folds real samples into the chat result", async () => {
    outDir = mkdtempSync(join(tmpdir(), "cowork-chat-resources-"));
    // Mirrors chat.ts's ACTUAL startup ordering: `beginTurn` (here, its own turnWriteDir call — chat is
    // always turn 1) creates turns/1/ BEFORE the sampler starts. Deliberately no manual mkdir of turns/1
    // as a fixture shortcut: if a future edit drops chat.ts's real beginTurn call, this test should fail
    // via ENOENT (a swallowed "sample failed" warning, `resources` never populated), not silently pass
    // because the fixture built the directory itself.
    turnWriteDir(outDir, 1);
    // Mirrors chat.ts's container-branch wiring: construct, start() before the run, await stop() after
    // (stop() is async) so the immediate sample lands before buildChatResult folds resources.jsonl.
    const sampler = new ResourceSampler(outDir, "container", async () => ({ ts: Date.now(), rssBytes: 123456, cpuPct: 4.2 }), 1000, 1);
    sampler.start();
    await sampler.stop();

    const r = buildChatResult(minimalChatRecord(), {
      scenario: "(chat)",
      prompt: "hi",
      fidelity: "container",
      baseline: "1.0",
      outDir,
      workRoot: join(outDir, "work"),
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      egress: [],
      durationMs: 5,
      turn: 1,
    });

    expect(r.resources).toBeDefined();
    expect(r.resources?.tier).toBe("container");
    expect(r.resources?.sampleCount).toBe(1);
    expect(r.resources?.peakRssBytes).toBe(123456);
  });

  it("a protocol chat (no sampler, no resources.jsonl) leaves resources undefined — matches the corrected doc-comment", () => {
    outDir = mkdtempSync(join(tmpdir(), "cowork-chat-resources-"));
    // No ResourceSampler is constructed here — the protocol branch legitimately has no container/process
    // id to probe (chat.ts never starts one for it), so resources.jsonl is never written.

    const r = buildChatResult(minimalChatRecord(), {
      scenario: "(chat)",
      prompt: "hi",
      fidelity: "protocol",
      baseline: "1.0",
      outDir,
      workRoot: join(outDir, "work"),
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      egress: [],
      durationMs: 5,
      turn: 1,
    });

    expect(r.resources).toBeUndefined();
  });
});

// `cmdChat` itself is not realistically drivable end-to-end in this lane: it reads turns from a readline
// loop over stdin and calls `process.exit` on a parse failure (chat.ts), so there is no in-process way to
// run it to completion the way turn-layout-e2e.test.ts drives `executeScenario`. This is the position
// check that stands in for that — the same pattern events-turn-scoping.test.ts uses to pin beginTurn's
// ordering in execute.ts, applied to chat.ts's own call. A fabricated-dir unit test (the describe block
// above) cannot catch chat.ts itself failing to call beginTurn, or calling it too late — this can.
describe("chat.ts is actually WIRED to call beginTurn before it can matter", () => {
  const SRC = readFileSync(resolve("src/run/chat.ts"), "utf8");

  it("calls beginTurn(outDir) — not merely present in a comment", () => {
    expect(
      /^\s*const \w+ = beginTurn\(outDir\);\s*$/m.test(SRC),
      "chat.ts's beginTurn call is gone or commented out — turns/1/ is never created at startup",
    ).toBe(true);
  });

  it("calls it BEFORE mkdir'ing outDir is not enough on its own — it must precede buildLaunchPlan", () => {
    // buildLaunchPlan is what starts staging the session; nothing about the turn dir may still be pending
    // when that happens, or the ENOENT-into-swallowed-warning defect this whole layout exists to catch
    // (turn-layout-e2e.test.ts's own header comment) reproduces for chat specifically.
    const call = SRC.search(/^\s*const \w+ = beginTurn\(outDir\);\s*$/m);
    const plan = SRC.indexOf("const plan = buildLaunchPlan(");
    expect(call, "beginTurn call site not found").toBeGreaterThan(-1);
    expect(plan, "buildLaunchPlan moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(call, "beginTurn must precede buildLaunchPlan").toBeLessThan(plan);
  });

  it("both ResourceSampler constructions (hostloop + container) pass the SAME turn number beginTurn returned", () => {
    // Not a hardcoded `1`: threading the real variable through (rather than a literal) means a future
    // multi-turn chat can't silently keep reading turn 1's samples forever.
    const varMatch = /^\s*const (\w+) = beginTurn\(outDir\);\s*$/m.exec(SRC);
    expect(varMatch, "could not extract the variable name beginTurn's return is bound to").not.toBeNull();
    const turnVar = varMatch![1];
    const samplerCalls = [...SRC.matchAll(/new ResourceSampler\(([\s\S]*?)\);/g)];
    expect(samplerCalls.length, "chat.ts's ResourceSampler construction sites moved — re-anchor this guard").toBeGreaterThanOrEqual(2);
    for (const m of samplerCalls) {
      expect(m[1], `a ResourceSampler construction in chat.ts does not pass ${turnVar} as its turn argument`).toContain(turnVar);
    }
  });
});
