import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frozenPromiseError, searchCorpusLabel, searchCorpusRefusal, startRunSearchCorpus } from "../src/search-corpus/run.js";
import { SearchRegistry, type RegistryInput } from "../src/search-corpus/registry.js";
import { assemblePool, writePool, DEFAULT_RETRIEVAL } from "../src/search-corpus/pool.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";
import { loadBaseline } from "../src/baseline.js";
import { buildHostLoopNativeEnv } from "../src/runtime/hostloop.js";
import type { PlatformBaseline } from "../src/types.js";

const hh = (t: string) => ({ sha256: createHash("sha256").update(t, "utf8").digest("hex"), bytes: Buffer.byteLength(t) });
const MISSING = "Error: nothing to look up";
const noRequest = {
  missingQuery: hh(MISSING),
  bothDomainLists: hh("Error: both"),
  budgetPrefix: hh("Search skipped: this "),
  budgetFragment: hh(" is spent ("),
  inputValidationPrefix: hh("Bad tool input here: "),
};
const latest = loadBaseline("latest");
// The latest baseline may already carry noRequest; strip it, so `false` builds one that predates it either way.
const { noRequest: _latestNoRequest, ...latestAnchors } = latest.agentBinary!.searchAnchors!;
const withAnchors = (nr = true): PlatformBaseline =>
  ({
    ...latest,
    agentBinary: {
      ...latest.agentBinary!,
      searchAnchors: { ...latestAnchors, ...(nr ? { noRequest } : {}) },
    },
  }) as PlatformBaseline;
const ok = { fidelity: "hostloop", deviceBridge: false, baseline: withAnchors(), authEnv: { CLAUDE_CODE_OAUTH_TOKEN: "x" }, agentEnv: {} };

describe("searchCorpusRefusal: every refusal names what it refuses", () => {
  it("allows a hostloop run with anchors and an env credential", () => {
    expect(searchCorpusRefusal(ok)).toBeNull();
  });
  it.each([
    [{ fidelity: "protocol" }, /fidelity protocol/],
    [{ fidelity: "container" }, /fidelity container yet/],
    [{ fidelity: "microvm" }, /fidelity microvm yet/],
    [{ deviceBridge: true }, /device_bridge/],
    [{ deviceBridge: true, fidelity: "container" }, /device_bridge/], // named before the tier, which a later container slice may lift
    [
      { baseline: { ...latest, agentBinary: { ...latest.agentBinary!, searchAnchors: undefined } } },
      /has none: re-run `cowork-harness sync`/,
    ],
    [{ baseline: withAnchors(false) }, /searchAnchors\.noRequest.*predates them: open Cowork once/],
    [{ authEnv: {} }, /credential from the environment.*\.env/],
    [{ agentEnv: { HTTPS_PROXY: "http://corp:3128" } }, /cannot chain an existing proxy: HTTPS_PROXY/],
    [{ agentEnv: { ANTHROPIC_BASE_URL: "https://gateway.example" } }, /ANTHROPIC_BASE_URL points the agent elsewhere/],
    [{ agentEnv: { CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY: "1" } }, /CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY/],
    [{ agentEnv: { CLAUDE_CODE_SESSION_ID: "session_abc" } }, /CLAUDE_CODE_SESSION_ID/],
    [{ agentEnv: { CLAUDE_CODE_SESSION_ID: "cse_abc" } }, /CLAUDE_CODE_SESSION_ID/],
    [{ resume: true }, /--resume or --session-id/],
  ])("refuses %o", (over, why) => {
    expect(searchCorpusRefusal({ ...ok, ...(over as object) })).toMatch(why);
  });
  it("an ordinary session id does not reach the remote search route", () => {
    expect(searchCorpusRefusal({ ...ok, agentEnv: { CLAUDE_CODE_SESSION_ID: "2b1c-local-uuid" } })).toBeNull();
  });
  it("judges the env the agent will really get: a key the baseline's spawn env sets is refused like an operator export", () => {
    const b = withAnchors();
    const spawned = {
      ...b,
      spawn: { ...b.spawn!, env: { ...(b.spawn?.env ?? {}), CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY: "1" } },
    } as PlatformBaseline;
    const agentEnv = buildHostLoopNativeEnv(spawned, { configDir: "/x", folderHostPaths: [], extra: {}, operatorEnv: {} });
    expect(searchCorpusRefusal({ ...ok, baseline: spawned, agentEnv })).toMatch(/CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY/);
  });

  it("accepts ANTHROPIC_BASE_URL when it is the API host itself", () => {
    expect(searchCorpusRefusal({ ...ok, agentEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } })).toBeNull();
  });
});

describe("the label", () => {
  it("names the pool and the first 8 of its hash, says not live and not a research-quality signal", () => {
    const l = searchCorpusLabel("ms-pool", "abcdef0123456789");
    expect(l).toMatch(/^frozen search corpus ms-pool@abcdef01 — /);
    expect(l).toMatch(/not live search/);
    expect(l).toMatch(/not a research-quality signal/);
    expect(l).toMatch(/not billed/);
  });
});

// The frozen-promise check over a constructed run dir.
const use = (id: string, q: string, parent?: string) =>
  JSON.stringify({
    type: "assistant",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query: q } }] },
  });
const res = (id: string, content: unknown, parent?: string, isError = false) =>
  JSON.stringify({
    type: "user",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  });
const ok200 = (q: string) => renderWebSearchResult({ query: q, entries: [{ kind: "links", links: [] }], reminder: "REMINDER: x" });
const entry = (agentId: string | null, verdict: RegistryInput["verdict"] = "served", query = "q"): RegistryInput => ({
  agentId,
  route: "messages",
  verdict,
  query,
  rounds: [],
  retryKey: null,
});

function runDir(events: string[], subagents: Record<string, string[]> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-b3-"));
  writeFileSync(join(d, "events.jsonl"), events.join("\n"));
  for (const [id, lines] of Object.entries(subagents)) {
    const dir = join(d, "claude-config", "projects", "p", "s", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join("\n"));
  }
  return d;
}
const check = (outDir: string, registry: SearchRegistry, o: { passed?: number; denied?: string[] } = {}) =>
  frozenPromiseError({
    outDir,
    registry,
    ctx: { passedThroughWithSearchTool: o.passed ?? 0 },
    frames: { deniedIds: () => new Set(o.denied ?? []) },
    noRequest,
  });

describe("frozenPromiseError: the agent's own count against the interceptor's, per agent", () => {
  it("holds when every main-loop search was intercepted (served, miss or refused)", () => {
    const r = new SearchRegistry();
    for (const v of ["served", "miss", "refused"] as const) r.record(entry(null, v));
    expect(
      check(runDir([use("a", "q"), res("a", ok200("q")), use("b", "q"), res("b", ok200("q")), use("c", "q"), res("c", ok200("q"))]), r),
    ).toBeNull();
  });

  it("goes red when a search slipped past the interceptor (a tool_use with no request seen)", () => {
    const r = new SearchRegistry();
    r.record(entry(null));
    expect(check(runDir([use("a", "q"), res("a", ok200("q")), use("b", "q2"), res("b", ok200("q2"))]), r)).toMatch(
      /the main agent made 2 search request\(s\).*interceptor saw 1/,
    );
  });

  it("does not expect a request for a validation refusal or a harness denial", () => {
    const r = new SearchRegistry();
    r.record(entry(null));
    const events = [
      use("a", "q"),
      res("a", ok200("q")),
      use("v", ""),
      res("v", `<tool_use_error>${MISSING}</tool_use_error>`, undefined, true),
      use("d", "q"),
      res("d", "<tool_use_error>The user declined.</tool_use_error>", undefined, true),
    ];
    expect(check(runDir(events), r, { denied: ["d"] })).toBeNull();
    // the same denial without the harness's decision is not recognised: a false red, never a false green
    expect(check(runDir(events), r, { denied: [] })).toMatch(/made 2 search request/);
  });

  it("counts each sub-agent from its own transcript, never from the parented frames in events.jsonl", () => {
    const r = new SearchRegistry();
    r.record(entry("ag1"));
    r.record(entry("ag1"));
    const events = [use("p1", "q", "task1"), res("p1", ok200("q"), "task1")]; // parented: not counted for main
    const sub = { ag1: [use("c1", "q"), res("c1", ok200("q")), use("c2", "q"), res("c2", ok200("q"))] };
    expect(check(runDir(events, sub), r)).toBeNull();
    const r2 = new SearchRegistry();
    r2.record(entry("ag1"));
    expect(check(runDir(events, sub), r2)).toMatch(/sub-agent ag1 made 2 search request\(s\).*interceptor saw 1/);
  });

  it("goes red when sub-agents searched in the main stream but no transcript holds those searches (a moved transcript dir)", () => {
    const r = new SearchRegistry();
    const events = [use("p1", "q", "task1"), res("p1", ok200("q"), "task1")];
    expect(check(runDir(events), r)).toMatch(/sub-agents made 1 search request\(s\) in the main stream, and their transcripts hold 0/);
    // a parented no-request result is not expected in a transcript either
    const denied = [use("p2", "q", "task1"), res("p2", "<tool_use_error>no</tool_use_error>", "task1", true)];
    expect(check(runDir(denied), new SearchRegistry(), { denied: ["p2"] })).toBeNull();
  });

  it("fails closed if a fork stopped sending its agent id: the search is keyed to main but counted in the fork's transcript", () => {
    // Today a fork (Agent(fork), a context: fork skill) sends x-claude-code-agent-id and B3 counts it per agent. If a
    // future agent dropped the header, its search would be intercepted under null: that must be an error, never a pass.
    const r = new SearchRegistry();
    r.record(entry(null));
    const events = [use("w1", "q", "toolu_skill1"), res("w1", ok200("q"), "toolu_skill1")];
    const err = check(runDir(events, { fork1: [use("w1", "q"), res("w1", ok200("q"))] }), r);
    expect(err).toMatch(/the main agent made 0 search request\(s\).*interceptor saw 1/);
    expect(err).toMatch(/sub-agent fork1 made 1 search request\(s\).*interceptor saw 0/);
    // and with the header, as measured, it holds
    const r2 = new SearchRegistry();
    r2.record(entry("fork1"));
    expect(check(runDir(events, { fork1: [use("w1", "q"), res("w1", ok200("q"))] }), r2)).toBeNull();
  });

  it("fails closed the other way too: an inline skill whose search started carrying an agent id turns red, never green", () => {
    // An inline skill's search is unparented in events.jsonl and keyed null today. Keyed by an id with no transcript,
    // the main loop's count and that agent's no longer balance.
    const r = new SearchRegistry();
    r.record(entry("x"));
    const err = check(runDir([use("w1", "q"), res("w1", ok200("q"))]), r);
    expect(err).toMatch(/the main agent made 1 search request\(s\).*interceptor saw 0/);
    expect(err).toMatch(/sub-agent x made 0 search request\(s\).*interceptor saw 1/);
  });

  it("goes red when the interceptor saw a request no agent record carries", () => {
    const r = new SearchRegistry();
    r.record(entry("ghost"));
    expect(check(runDir([]), r)).toMatch(/sub-agent ghost made 0 search request\(s\).*interceptor saw 1/);
  });

  it("goes red on a forwarded search tool, and on a request still classifying at close", () => {
    expect(check(runDir([]), new SearchRegistry(), { passed: 1 })).toMatch(/1 request\(s\) carrying a server search tool were forwarded/);
    const r = new SearchRegistry();
    r.begin();
    r.abandonPending();
    expect(check(runDir([]), r)).toMatch(/still being classified/);
  });
});

describe("startRunSearchCorpus", () => {
  function pool(): string {
    const d = mkdtempSync(join(tmpdir(), "cwh-pool-run-"));
    const runD = join(d, "runs", "scn", "local_1");
    mkdirSync(join(runD, "turns", "1"), { recursive: true });
    writeFileSync(
      join(runD, "events.jsonl"),
      [
        use("t", "ev market"),
        res(
          "t",
          renderWebSearchResult({
            query: "ev market",
            entries: [
              { kind: "links", links: [{ title: "E", url: "https://e" }] },
              { kind: "text", text: "EV." },
            ],
            reminder: "REMINDER: x",
          }),
        ),
      ].join("\n"),
    );
    writeFileSync(join(runD, "turns", "1", "result.json"), JSON.stringify({ scenario: "s", skillsInvoked: ["p:ms"] }));
    const { manifest, records } = assemblePool({
      poolId: "pp",
      runDirs: [runD],
      mixed: false,
      exclude: new Set(),
      retrieval: DEFAULT_RETRIEVAL,
      harnessVersion: "0",
      now: new Date(0),
      secrets: [],
    });
    const out = join(d, "pool");
    writePool(out, manifest, records);
    return out;
  }

  it("gives the agent the proxy and the CA through env, keeps the CA file private, and removes it at finish", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-run-"));
    const sc = await startRunSearchCorpus({ option: { pool: pool(), miss: "empty" }, baseline: withAnchors(), outDir, agentEnv: {} });
    expect(Object.keys(sc.env).sort()).toEqual(["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NO_PROXY", "https_proxy", "no_proxy"]);
    expect(sc.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const ca = sc.env.NODE_EXTRA_CA_CERTS!;
    expect(statSync(ca).mode & 0o777).toBe(0o600);
    expect(statSync(join(ca, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(join(outDir, "search-corpus.jsonl")).mode & 0o777).toBe(0o600);
    expect(readFileSync(ca, "utf8")).toMatch(/BEGIN CERTIFICATE/);
    expect(sc.label).toMatch(/^frozen search corpus pp@/);
    expect(await sc.finish(outDir)).toBeNull();
    expect(existsSync(ca)).toBe(false);
  });

  it("the per-query log on disk carries the design's fields and no credential in any encoding; each unfinished request gets its own line", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-run-"));
    const sc = await startRunSearchCorpus({ option: { pool: pool(), miss: "empty" }, baseline: withAnchors(), outDir, agentEnv: {} });
    const TOKEN = "sk-ant-DUMMY-TRIPWIRE/+=9f";
    // A nested request through the real interceptor, carrying the dummy credential.
    const u = new URL(sc.env.HTTPS_PROXY!);
    const ca = readFileSync(sc.env.NODE_EXTRA_CA_CERTS!, "utf8");
    const { request } = await import("node:http");
    const { connect } = await import("node:tls");
    const t = await new Promise<import("node:tls").TLSSocket>((resolve, reject) => {
      const req = request({ host: u.hostname, port: Number(u.port), method: "CONNECT", path: "api.anthropic.com:443" });
      req.on("connect", (_r, socket) => {
        const s = connect({ socket, servername: "api.anthropic.com", ca: [ca] }, () => resolve(s));
        s.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    const body = Buffer.from(
      JSON.stringify({
        model: "m",
        stream: false,
        system: "x",
        messages: [{ role: "user", content: `q ${TOKEN}` }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    );
    t.write(
      Buffer.concat([
        Buffer.from(
          `POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nAuthorization: Bearer ${TOKEN}\r\nX-Api-Key: ${TOKEN}\r\nContent-Length: ${body.length}\r\n\r\n`,
        ),
        body,
      ]),
    );
    await new Promise<void>((r) => t.once("data", () => r()));
    t.destroy();
    sc.registry.begin(); // a request that never finishes classifying
    sc.registry.begin();
    expect(await sc.finish(outDir)).toMatch(/2 request\(s\) were still being classified/);
    const lines = readFileSync(join(outDir, "search-corpus.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // one refusal (the system prompt is not the search assistant's), then one line per unfinished request
    expect(lines.map((l) => l.verdict)).toEqual(["refused", "unfinished", "unfinished"]);
    expect(Object.keys(lines[0]).sort()).toEqual(
      ["candidates", "latencyMs", "linksServed", "model", "ordinal", "query", "route", "served", "ts", "verdict"].sort(),
    );
    // The query is agent text and is kept (the run's scrub covers it); the header credential never reaches the disk.
    const all = readFileSync(join(outDir, "search-corpus.jsonl"), "utf8").replace(`q ${TOKEN}`, "");
    for (const form of [TOKEN, Buffer.from(TOKEN).toString("base64"), encodeURIComponent(TOKEN), JSON.stringify(TOKEN).slice(1, -1)])
      expect(all).not.toContain(form);
  });

  it("keeps an operator's NODE_EXTRA_CA_CERTS, appended to the run's CA, and refuses one it cannot read", async () => {
    const p = pool();
    const outDir = mkdtempSync(join(tmpdir(), "cwh-run-"));
    const extraDir = mkdtempSync(join(tmpdir(), "cwh-extra-"));
    const extra = join(extraDir, "corp.pem");
    writeFileSync(extra, "-----BEGIN CERTIFICATE-----\nMIIBcorp\n-----END CERTIFICATE-----\n");
    const sc = await startRunSearchCorpus({
      option: { pool: p, miss: "empty" },
      baseline: withAnchors(),
      outDir,
      agentEnv: { NODE_EXTRA_CA_CERTS: extra },
    });
    const caText = readFileSync(sc.env.NODE_EXTRA_CA_CERTS!, "utf8");
    expect(caText.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(caText).toContain("MIIBcorp");
    await sc.finish(outDir);
    await expect(
      startRunSearchCorpus({
        option: { pool: p, miss: "empty" },
        baseline: withAnchors(),
        outDir,
        agentEnv: { NODE_EXTRA_CA_CERTS: join(extraDir, "missing.pem") },
      }),
    ).rejects.toThrow(/NODE_EXTRA_CA_CERTS.*cannot be read/);
  });

  it("--search-corpus-min-score changes the served hash", async () => {
    const p = pool();
    const outDir = mkdtempSync(join(tmpdir(), "cwh-run-"));
    const a = await startRunSearchCorpus({ option: { pool: p, miss: "empty" }, baseline: withAnchors(), outDir, agentEnv: {} });
    const b = await startRunSearchCorpus({
      option: { pool: p, miss: "empty", minScore: 0.9 },
      baseline: withAnchors(),
      outDir,
      agentEnv: {},
    });
    expect(b.sha256).not.toBe(a.sha256);
    await a.finish(outDir);
    await b.finish(outDir);
  });
});
