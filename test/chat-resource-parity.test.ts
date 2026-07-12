import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceSampler } from "../src/runtime/resource-sampler.js";
import { buildChatResult } from "../src/run/chat-result.js";
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
    // Mirrors chat.ts's container-branch wiring: construct, start() before the run, await stop() after
    // (stop() is async) so the immediate sample lands before buildChatResult folds resources.jsonl.
    const sampler = new ResourceSampler(outDir, "container", async () => ({ ts: Date.now(), rssBytes: 123456, cpuPct: 4.2 }), 1000);
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
    });

    expect(r.resources).toBeUndefined();
  });
});
