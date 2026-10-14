import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgentSession } from "../src/agent/session.js";
import { ServeFrames } from "../src/search-corpus/frames.js";
import { SearchRegistry } from "../src/search-corpus/registry.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";

// The session seam: the session stream is the one writer of serve frames (after the matching tool_result, or at close).
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = 0;
  proc.signalCode = null;
  return proc;
}
const pool = { poolId: "p", sha256: "a".repeat(64) };
const round = { match: "nearby" as const, nscore: 0.7, sourceQuery: "s", recordId: "r1", sourceSkill: null, urls: ["https://a"] };
const use = (id: string, query: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query } }] },
});
const result = (id: string, content: unknown, isError = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
});
const served = (q: string) =>
  renderWebSearchResult({ query: q, entries: [{ kind: "links", links: [{ title: "t", url: "https://a" }] }], reminder: "REMINDER: x" });

async function run(frames: ServeFrames | undefined, script: (proc: any, session: LiveAgentSession) => Promise<void>) {
  const proc = fakeProc();
  const outDir = mkdtempSync(join(tmpdir(), "sc-session-"));
  const session = new LiveAgentSession(proc, outDir);
  const done = (async () => {
    for await (const _ of session.start(frames ? { searchCorpus: frames } : {})) void _;
  })();
  await script(proc, session);
  proc.stdout.end();
  await done;
  return readFileSync(join(outDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}
const send = (proc: any, msg: unknown) => proc.stdout.write(JSON.stringify(msg) + "\n");
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("LiveAgentSession with a search corpus", () => {
  it("writes the serve frame directly after the WebSearch tool_result line", async () => {
    const registry = new SearchRegistry();
    const frames = new ServeFrames({ registry, noRequest: undefined, pool, quiesce: async () => ({ abandoned: 0 }) });
    const lines = await run(frames, async (proc) => {
      send(proc, use("t1", "q"));
      registry.record({ agentId: null, route: "messages", verdict: "served", query: "q", rounds: [round], retryKey: "k" });
      send(proc, result("t1", served("q")));
      send(proc, { type: "result", subtype: "success" });
      await tick();
    });
    expect(lines.map((l) => l._emu ?? l.type)).toEqual(["assistant", "user", "search_corpus_serve", "result"]);
    expect(lines[2]).toMatchObject({ streamed: true, toolUseId: "t1", verdict: "served" });
  });

  it("frames an intercepted request whose result never streamed at close, before the stream ends (the killed-agent case)", async () => {
    const registry = new SearchRegistry();
    let quiesced = false;
    const frames = new ServeFrames({ registry, noRequest: undefined, pool, quiesce: async () => ((quiesced = true), { abandoned: 0 }) });
    const lines = await run(frames, async (proc) => {
      send(proc, use("t1", "q"));
      // the interceptor served it, but the agent dies before the tool_result
      registry.record({ agentId: "ag2", route: "messages", verdict: "served", query: "q", rounds: [round], retryKey: "k" });
      await tick();
    });
    expect(quiesced).toBe(true);
    expect(lines.at(-1)).toMatchObject({ _emu: "search_corpus_serve", streamed: false, agentId: "ag2", query: "q" });
  });

  it("a harness denial of a WebSearch permission marks the tool_use: its result takes no entry", async () => {
    const registry = new SearchRegistry();
    const frames = new ServeFrames({ registry, noRequest: undefined, pool, quiesce: async () => ({ abandoned: 0 }) });
    const lines = await run(frames, async (proc, session) => {
      send(proc, use("t1", "q"));
      send(proc, {
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "can_use_tool", tool_name: "WebSearch", input: { query: "q" }, tool_use_id: "t1" },
      });
      await tick();
      session.respond("req-1", { kind: "permission", behavior: "deny", message: "no" });
      // an unrelated same-key request the interceptor did see must NOT be consumed by the denied result
      registry.record({ agentId: null, route: "messages", verdict: "served", query: "q", rounds: [round], retryKey: "k" });
      send(proc, result("t1", "<tool_use_error>no</tool_use_error>", true));
      await tick();
    });
    expect(lines.filter((l) => l._emu === "search_corpus_serve").map((l) => l.streamed)).toEqual([false]);
    expect(frames.counts()).toMatchObject({ toolUses: 1, noRequest: 1 });
  });

  it("without a corpus the stream is unchanged: no frame, no quiesce", async () => {
    const lines = await run(undefined, async (proc) => {
      send(proc, use("t1", "q"));
      send(proc, result("t1", served("q")));
      await tick();
    });
    expect(lines.some((l) => l._emu)).toBe(false);
  });
});
