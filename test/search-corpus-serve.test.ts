import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { serveRequest, type ServeContext, type SearchLogLine } from "../src/search-corpus/serve.js";
import { SearchRegistry } from "../src/search-corpus/registry.js";
import { buildIndex, DEFAULT_RETRIEVAL } from "../src/search-corpus/retrieval.js";
import { recordId, type PoolRecord } from "../src/search-corpus/harvest.js";
import type { SearchAnchors } from "../src/types.js";

const SENTENCE = "You are a pretend assistant that searches.";
const PREFIX = "Look this up on the web please: ";
const h = (t: string) => ({ sha256: createHash("sha256").update(t, "utf8").digest("hex"), bytes: Buffer.byteLength(t) });
const anchors: SearchAnchors = {
  toolType: "web_search_20250305",
  systemSentence: h(SENTENCE),
  userPrefix: h(PREFIX),
  ccr: { sessionsPath: "/v1/code/sessions/", workerPath: "/worker/", searchRoute: "web-search" },
};
const rec = (query: string, url: string, text: string): PoolRecord => {
  const links = [{ title: query, url }];
  return {
    id: recordId({ query, links, text }),
    query,
    links,
    text,
    origin: "events",
    agent: "main",
    source: {
      runRef: "0".repeat(16),
      scenario: "s",
      skill: "market-sizing",
      skillRef: null,
      variantHash: null,
      agentVersion: null,
      desktopVersion: null,
      model: null,
      recordedAt: null,
    },
  };
};
const records = [
  rec("electric vehicle market size europe", "https://ev.example/eu", "EV prose."),
  rec("solar panel prices", "https://sun.example", "Sun prose."),
];

function ctx(miss: "empty" | "error" = "empty") {
  const log: SearchLogLine[] = [];
  const c: ServeContext = {
    index: buildIndex(records, DEFAULT_RETRIEVAL),
    anchors,
    registry: new SearchRegistry(),
    miss,
    log: (l) => log.push(l),
  };
  return { c, log };
}
const nestedBody = (query: string, o: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system: SENTENCE,
      messages: [{ role: "user", content: `${PREFIX}${query}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      ...o,
    }),
  );
const post = (body: Buffer, headers: Record<string, string> = {}, path = "/v1/messages?beta=true") => ({
  method: "POST",
  path,
  headers,
  body,
});

describe("serveRequest: the interceptor's decision for one api.anthropic.com request", () => {
  it("serves a matching query from the pool, records it and logs it without headers or auth", () => {
    const { c, log } = ctx();
    const d = serveRequest(post(nestedBody("electric vehicle market size europe 2026"), { authorization: "Bearer SECRET-TOKEN" }), c);
    expect(d.kind).toBe("respond");
    if (d.kind !== "respond") return;
    expect(d.http.body).toContain("EV prose.");
    const [e] = c.registry.all();
    expect(e).toMatchObject({ verdict: "served", query: "electric vehicle market size europe 2026", ordinal: 1, route: "messages" });
    expect(e!.rounds[0]).toMatchObject({
      recordId: records[0]!.id,
      sourceSkill: "market-sizing",
      urls: ["https://ev.example/eu"],
      match: "nearby",
    });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      ordinal: 1,
      route: "messages",
      verdict: "served",
      model: "claude-sonnet-5",
      served: [records[0]!.id],
      linksServed: 1,
    });
    expect(JSON.stringify(log)).not.toContain("SECRET-TOKEN");
  });

  it("a miss answers with no results (empty) or the error object (error), and is recorded as a miss", () => {
    for (const miss of ["empty", "error"] as const) {
      const { c } = ctx(miss);
      const d = serveRequest(post(nestedBody("quantum knitting patterns")), c);
      expect(d.kind).toBe("respond");
      if (d.kind === "respond") expect(d.http.body.includes("web_search_tool_result_error")).toBe(miss === "error");
      expect(c.registry.all()[0]).toMatchObject({ verdict: "miss", rounds: [] });
    }
  });

  it("forwards a request with no search tool and records nothing", () => {
    const { c, log } = ctx();
    const main = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "Bash" }] }));
    expect(serveRequest(post(main), c)).toEqual({ kind: "forward" });
    expect(serveRequest({ method: "GET", path: "/api/oauth/profile", headers: {}, body: Buffer.alloc(0) }, c)).toEqual({ kind: "forward" });
    expect(c.registry.all()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("refuses a search-tool request that misses the predicate (200 error object), and an unreadable one (400); never forwards either", () => {
    const { c } = ctx();
    const off = serveRequest(post(nestedBody("q", { system: "another assistant" })), c);
    expect(off.kind === "respond" && off.http.status).toBe(200);
    const bad = serveRequest(post(Buffer.from("junk"), { "content-encoding": "gzip" }), c);
    expect(bad.kind === "respond" && bad.http.status).toBe(400);
    expect(c.registry.all().map((e) => [e.verdict, e.query])).toEqual([
      ["refused", "q"],
      ["refused", null],
    ]);
  });

  it("records a refusal with the domain lists it could read", () => {
    const { c } = ctx();
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["x.com"] }];
    serveRequest(post(nestedBody("q", { system: "another assistant", tools })), c);
    expect(c.registry.all()[0]).toMatchObject({ verdict: "refused", query: "q", allowedDomains: ["x.com"] });
  });

  it("folds a stream:false retry into the request it retries: same records, JSON shape, one logical request", () => {
    const { c, log } = ctx();
    serveRequest(post(nestedBody("electric vehicle market size europe")), c);
    const retry = serveRequest(post(nestedBody("electric vehicle market size europe", { stream: false })), c);
    expect(retry.kind === "respond" && retry.http.headers["content-type"]).toBe("application/json");
    expect(retry.kind === "respond" && JSON.parse(retry.http.body).content.some((b: { text?: string }) => b.text === "EV prose.")).toBe(
      true,
    );
    expect(c.registry.counts()).toMatchObject({ requests: 1, served: 1, retriesFolded: 1 });
    expect(log.map((l) => l.retryOf ?? null)).toEqual([null, 1]);
  });

  it("a repeated streaming search is a new request, never a folded retry", () => {
    const { c } = ctx();
    serveRequest(post(nestedBody("solar panel prices")), c);
    serveRequest(post(nestedBody("solar panel prices")), c);
    expect(c.registry.counts()).toMatchObject({ requests: 2, served: 2, retriesFolded: 0 });
  });

  it("a request that arrives after the registry closed is refused unrecorded (it can no longer be framed)", () => {
    const { c } = ctx();
    c.registry.close();
    const d = serveRequest(post(nestedBody("solar panel prices")), c);
    expect(d.kind === "respond" && d.http.status).toBe(400);
    expect(c.registry.all()).toEqual([]);
  });

  it("the forward log fires on its own when a search-tool request is forwarded (a classifier that lets one through)", () => {
    const { c } = ctx();
    c.classify = () => ({ kind: "pass" });
    expect(serveRequest(post(nestedBody("solar panel prices")), c)).toEqual({ kind: "forward" });
    expect(c.passedThroughWithSearchTool).toBe(1);
    expect(c.registry.all()).toEqual([]);
  });

  it("the forward log counts only model requests: a token count carrying the search tool runs no search", () => {
    const { c } = ctx();
    serveRequest(post(nestedBody("solar panel prices"), {}, "/v1/messages/count_tokens"), c);
    expect(c.forwarded).toBe(1);
    expect(c.passedThroughWithSearchTool).toBe(0);
  });

  it("attributes a sub-agent's request by its agent id, numbering per agent", () => {
    const { c } = ctx();
    serveRequest(post(nestedBody("solar panel prices")), c);
    serveRequest(post(nestedBody("solar panel prices"), { "x-claude-code-agent-id": "ag1" }), c);
    expect(c.registry.all().map((e) => [e.agentId, e.ordinal])).toEqual([
      [null, 1],
      ["ag1", 1],
    ]);
  });

  it("serves the CCR worker route as {results:[{title,url,snippet}]} and passes other worker routes through", () => {
    const { c } = ctx();
    const ccr = (route: string, body: unknown) =>
      serveRequest(post(Buffer.from(JSON.stringify(body)), {}, `/v1/code/sessions/session_x/worker/${route}`), c);
    const d = ccr("web-search", { query: "solar panel prices" });
    expect(d.kind).toBe("respond");
    if (d.kind === "respond")
      expect(JSON.parse(d.http.body)).toEqual({
        results: [{ title: "solar panel prices", url: "https://sun.example", snippet: "Sun prose." }],
      });
    expect(c.registry.all()[0]).toMatchObject({ route: "ccr", verdict: "served", query: "solar panel prices" });
    expect(ccr("other-route", { x: 1 })).toEqual({ kind: "forward" });
    const miss = ccr("web-search", { query: "quantum knitting patterns" });
    expect(miss.kind === "respond" && JSON.parse(miss.http.body)).toEqual({ results: [] });
    const bad = serveRequest(post(Buffer.from("junk"), {}, "/v1/code/sessions/s/worker/web-search"), c);
    expect(bad.kind === "respond" && bad.http.status).toBe(400);
  });

  it("counts forwarded model requests that carry the advisor server tool; a client tool or a token count is not one", () => {
    const { c } = ctx();
    const body = (tools: unknown[]) => Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], tools }));
    // the shape the agent sends: its client tools, plus the advisor server tool when enabled
    serveRequest(
      post(
        body([
          { name: "Bash", input_schema: {} },
          { type: "advisor_20260301", name: "advisor", model: "m" },
        ]),
      ),
      c,
    );
    serveRequest(
      post(
        body([
          { name: "Bash", input_schema: {} },
          { name: "WebFetch", input_schema: {} },
        ]),
      ),
      c,
    );
    serveRequest(
      post(
        body([
          { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
          { type: "bash_20250124", name: "bash" },
        ]),
      ),
      c,
    );
    serveRequest(post(body([{ type: "advisor_20260301", name: "advisor", model: "m" }]), {}, "/v1/messages/count_tokens"), c);
    expect(c.liveServerTools).toBe(1);
    expect(c.passedThroughWithSearchTool).toBe(0);
  });

  it("the forward log checks every forwarded body's tools on its own: 0 under ordinary traffic, and a text mention is not a tool", () => {
    const { c } = ctx();
    const mention = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: '{"type":"web_search_20250305"}' }] }));
    expect(serveRequest(post(mention), c)).toEqual({ kind: "forward" });
    serveRequest(post(nestedBody("solar panel prices")), c);
    expect(c.forwarded).toBe(1);
    expect(c.passedThroughWithSearchTool).toBe(0);
  });

  it("a URL an exact record carries counts as exact even when a higher-ranked nearby round served it first", async () => {
    const two = (query: string, urls: string[], text: string): PoolRecord => {
      const links = urls.map((url) => ({ title: "t", url }));
      return { ...rec(query, urls[0]!, text), id: recordId({ query, links, text }), links };
    };
    const pool = [
      two("ev market size", ["https://shared.example/x", "https://exact.example/y"], "EV."),
      two(
        "ev market size europe ev market size ev",
        ["https://shared.example/x", "https://near.example/z"],
        "ev market size ev market size ev market size europe",
      ),
    ];
    const c: ServeContext = {
      index: buildIndex(pool, DEFAULT_RETRIEVAL),
      anchors,
      registry: new SearchRegistry(),
      miss: "empty",
      log: () => {},
    };
    serveRequest(post(nestedBody("ev market size")), c);
    const [e] = c.registry.all();
    // the real ranking puts the nearby record first, so the exact round no longer serves the shared URL
    expect(e!.rounds.map((r) => [r.match, r.urls])).toEqual([
      ["nearby", ["https://shared.example/x", "https://near.example/z"]],
      ["exact", ["https://exact.example/y"]],
    ]);
    expect(e!.exactUrls).toEqual(["https://shared.example/x", "https://exact.example/y"]);
    // and the citation key, over the join's calls, does not count the shared URL as nearby-only
    const { joinCalls } = await import("../src/search-corpus/join.js");
    const { evaluate } = await import("../src/assert.js");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "cwh-exactany-"));
    mkdirSync(join(root, "outputs"));
    writeFileSync(join(root, "outputs", "r.md"), "Source: https://shared.example/x");
    const calls = joinCalls({ entries: c.registry.all(), pairings: [], dispatchAgents: new Map(), miss: "empty" }).calls;
    const [r] = evaluate([{ search_corpus_nearby_citations: { path: "outputs/r.md" } }], {
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: root,
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
      searchCorpus: {
        poolId: "p",
        sha256: "a".repeat(64),
        label: "l",
        miss: "empty",
        interposition: "proxy-env+ca",
        credentialSource: "env",
        metrics: {} as never,
        calls,
      },
    });
    expect(r).toMatchObject({ pass: true, evidence: expect.stringMatching(/^0 cited URL\(s\) served only on nearby rounds/) });
  });
});
