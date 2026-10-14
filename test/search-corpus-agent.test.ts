import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tlsServer } from "node:tls";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { startInterceptor } from "../src/search-corpus/interceptor.js";
import { mintCertificates } from "../src/search-corpus/x509.js";
import { SearchRegistry } from "../src/search-corpus/registry.js";
import { buildIndex, DEFAULT_RETRIEVAL } from "../src/search-corpus/retrieval.js";
import { recordId, type PoolRecord } from "../src/search-corpus/harvest.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";
import { extractSearchAnchors } from "../src/sync/search-anchors.js";
import { ServeFrames } from "../src/search-corpus/frames.js";
import { frozenPromiseError } from "../src/search-corpus/run.js";
import { noRequestKind } from "../src/search-corpus/no-request.js";
import { classifyRequest } from "../src/search-corpus/predicate.js";
import type { SynthHttp } from "../src/search-corpus/synth.js";
import type { ServeContext } from "../src/search-corpus/serve.js";

// The interceptor against the REAL agent, $0. The native 2.1.295 agent runs with HTTPS_PROXY at the interceptor and only
// NODE_EXTRA_CA_CERTS trusting the run's CA; the interceptor's upstream is a local stub that scripts the main loop
// (one WebSearch, then end_turn). No request leaves the machine: every other host's CONNECT is refused, and the
// credential is a dummy. Local only: skipped unless COWORK_SEARCH_CORPUS_AGENT=1 and the backed-up agent exists.
const AGENT = process.env.COWORK_SEARCH_CORPUS_AGENT_BIN ?? join(homedir(), "cowork-agent-backup/2.1.295/claude.app/Contents/MacOS/claude");
const run = process.env.COWORK_SEARCH_CORPUS_AGENT === "1" && existsSync(AGENT);

const QUERY = "electric vehicle market size europe";
const links = [{ title: "EV market", url: "https://ev.example/eu" }];
const record: PoolRecord = {
  id: recordId({ query: QUERY, links, text: "Invented pool prose about EVs." }),
  query: QUERY,
  links,
  text: "Invented pool prose about EVs.",
  origin: "events",
  agent: "main",
  source: {
    runRef: "0".repeat(16),
    scenario: "s",
    skill: "ms",
    skillRef: null,
    variantHash: null,
    agentVersion: null,
    desktopVersion: null,
    model: null,
    recordedAt: null,
  },
};

const sse = (events: [string, unknown][]) =>
  events.map(([t, d]) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...(d as object) })}\n\n`).join("");
const usage = { input_tokens: 1, output_tokens: 1 };
const start = (model: string) =>
  [
    "message_start",
    { message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } },
  ] as [string, unknown];
const toolTurn = (model: string) =>
  sse([
    start(model),
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_stub1", name: "WebSearch", input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: QUERY }) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
const searchTurn = (model: string, input: Record<string, unknown>, id: string) =>
  sse([
    start(model),
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id, name: "WebSearch", input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
const taskTurn = (model: string) =>
  sse([
    start(model),
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_task1", name: "Task", input: {} } }],
    [
      "content_block_delta",
      {
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            description: "research",
            subagent_type: "general-purpose",
            prompt: `Search the web for: ${QUERY}`,
          }),
        },
      },
    ],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
const endTurn = (model: string, text: string) =>
  sse([
    start(model),
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);

interface Seen {
  agentId?: string;
  path: string;
  raw: Buffer;
  body: Record<string, any> | null;
}

/** A stub API host: scripts the main loop; answers a nested search itself only when one reaches it (the mutation). */
type Turn = (model: string) => string;
/** Scripts every non-search API call: the model, the request's messages as JSON, and its agent id header. */
type Route = (model: string, messages: string, agentId: string | undefined) => string;
async function stub(opts: { task?: boolean; turns?: Turn[]; route?: Route } = {}) {
  let mainCalls = 0;
  const gzipped: string[] = [];
  const c = mintCertificates();
  const seen: Seen[] = [];
  const srv = tlsServer({ key: c.leafKeyPem, cert: c.leafPem, ALPNProtocols: ["http/1.1"] }, (s) => {
    let buf = Buffer.alloc(0);
    s.on("error", () => {});
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buf.subarray(0, end).toString("latin1");
        const n = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? "0");
        if (buf.length < end + 4 + n) return;
        const raw = buf.subarray(0, end + 4 + n);
        const bodyBuf = buf.subarray(end + 4, end + 4 + n);
        buf = buf.subarray(end + 4 + n);
        const [method, path = ""] = head.split(" ");
        const agentId = /x-claude-code-agent-id: *([^\r\n]+)/i.exec(head)?.[1]?.trim();
        let body: Record<string, any> | null = null;
        try {
          const gz = /content-encoding: *gzip/i.test(head);
          body = JSON.parse((gz ? gunzipSync(bodyBuf) : bodyBuf).toString("utf8"));
          if (gz) gzipped.push(path);
        } catch {
          /* not JSON */
        }
        seen.push({ path, raw, body, ...(agentId ? { agentId } : {}) });
        let out: { status: number; type: string; text: string };
        if (method === "POST" && path.startsWith("/v1/messages") && !path.includes("count_tokens") && body) {
          const model = String(body.model ?? "claude-sonnet-4-6");
          const tools: { type?: string }[] = body.tools ?? [];
          const msgs: { content?: unknown }[] = body.messages ?? [];
          const hasResult = msgs.some(
            (m) => Array.isArray(m.content) && (m.content as { type?: string }[]).some((b) => b.type === "tool_result"),
          );
          if (opts.route && !tools.some((t) => t.type?.startsWith("web_search_")))
            out = { status: 200, type: "text/event-stream", text: opts.route(model, JSON.stringify(msgs), agentId) };
          else if (tools.some((t) => t.type?.startsWith("web_search_")))
            out = { status: 200, type: "text/event-stream", text: endTurn(model, "Live search answer from the stub.") };
          else if (opts.turns && !agentId && tools.length > 0)
            out = { status: 200, type: "text/event-stream", text: (opts.turns[mainCalls++] ?? ((m: string) => endTurn(m, "done")))(model) };
          else if (opts.task && !agentId)
            out = { status: 200, type: "text/event-stream", text: hasResult ? endTurn(model, "done") : taskTurn(model) };
          else out = { status: 200, type: "text/event-stream", text: hasResult ? endTurn(model, "done") : toolTurn(model) };
        } else
          out = {
            status: 404,
            type: "application/json",
            text: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }),
          };
        s.write(
          `HTTP/1.1 ${out.status} X\r\ncontent-type: ${out.type}\r\nx-claude-code-signature: eyJ.stub.sig\r\ncontent-length: ${Buffer.byteLength(out.text)}\r\n\r\n${out.text}`,
        );
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as AddressInfo).port, ca: c.caPem, seen, gzipped, close: () => srv.close() };
}

async function runAgent(o: {
  pool?: PoolRecord[];
  miss?: "empty" | "error";
  transform?: (http: SynthHttp, req: { method: string; path: string; body: Buffer }) => SynthHttp;
  /** Record each classified request's content-encoding. */
  encodings?: string[];
  mutate?: boolean;
  withCa?: boolean;
  task?: boolean;
  turns?: Turn[];
  route?: Route;
  prompt?: string;
  /** Write into the agent's config dir before it starts (a user skill). */
  setup?: (config: string) => void;
  allowedTools?: string;
  env?: Record<string, string>;
  deny?: boolean;
}) {
  const anchors = (() => {
    const r = extractSearchAnchors(readFileSync(AGENT));
    if (!r.ok) throw new Error(r.defects.join("; "));
    return r.anchors;
  })();
  const up = await stub({ task: o.task, ...(o.turns ? { turns: o.turns } : {}), ...(o.route ? { route: o.route } : {}) });
  const registry = new SearchRegistry();
  const ctx: ServeContext = {
    index: buildIndex(o.pool ?? [record], DEFAULT_RETRIEVAL),
    anchors,
    registry,
    miss: o.miss ?? "empty",
    log: () => {},
    ...(o.mutate
      ? { classify: () => ({ kind: "pass" as const }) }
      : o.encodings
        ? {
            classify: (req: Parameters<typeof classifyRequest>[0], a: Parameters<typeof classifyRequest>[1]) => {
              const enc = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "content-encoding")?.[1];
              const c = classifyRequest(req, a);
              if (c.kind !== "pass") o.encodings!.push(enc ?? "identity");
              return c;
            },
          }
        : {}),
  };
  const ic = await startInterceptor({
    ctx,
    upstream: { host: "127.0.0.1", port: up.port, ca: [up.ca] },
    tunnelAllowed: () => false,
    ...(o.transform ? { transformResponse: o.transform } : {}),
  });
  const dir = mkdtempSync(join(tmpdir(), "cwh-agent-"));
  const config = join(dir, "config");
  mkdirSync(config);
  o.setup?.(config);
  const caFile = join(dir, "ca.pem");
  writeFileSync(caFile, ic.caPem, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-credential",
    HTTPS_PROXY: ic.url,
    https_proxy: ic.url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    ENABLE_TOOL_SEARCH: "false",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(o.withCa === false ? {} : { NODE_EXTRA_CA_CERTS: caFile }),
    ...(o.env ?? {}),
  };
  const child = spawn(
    AGENT,
    [
      "-p",
      ...(o.deny ? ["--input-format", "stream-json", "--permission-prompt-tool", "stdio"] : [o.prompt ?? `Search the web for: ${QUERY}`]),
      "--output-format",
      "stream-json",
      "--verbose",
      // Pre-approved except in the deny case, where the permission must reach the stdio channel.
      ...(o.deny ? [] : ["--allowedTools", o.allowedTools ?? "WebSearch"]),
      "--model",
      "claude-sonnet-4-6",
      // No permission classifier: the stub cannot answer its request. The deny case answers on the stdio channel.
      "--permission-mode",
      o.deny ? "default" : "bypassPermissions",
    ],
    {
      env,
      cwd: dir,
      stdio: [o.deny ? "pipe" : "ignore", "pipe", "pipe"],
    },
  );
  if (o.deny) {
    // The harness's own decision: deny every permission the agent asks for, as `respond()` would.
    child.stdin!.write(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `Search the web for: ${QUERY}` }] } }) + "\n",
    );
    let pending = "";
    child.stdout!.on("data", (b: Buffer) => {
      pending += b.toString();
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === "control_request" && m.request?.subtype === "can_use_tool")
            child.stdin!.write(
              JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id: m.request_id, response: { behavior: "deny", message: "The user declined." } },
              }) + "\n",
            );
          if (m.type === "result") child.stdin!.end();
        } catch {
          /* partial or non-JSON line */
        }
      }
    });
  }
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (b) => (stdout += b));
  child.stderr!.on("data", (b) => (stderr += b));
  const code = await new Promise<number | null>((res) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("exit", (c) => (clearTimeout(t), res(c)));
  });
  await ic.close();
  up.close();
  const lines = stdout.split("\n").filter(Boolean);
  writeFileSync(join(dir, "events.jsonl"), lines.join("\n"));
  const frames = new ServeFrames({
    registry,
    noRequest: anchors.noRequest,
    pool: { poolId: "p", sha256: "a".repeat(64) },
    quiesce: async () => ({ abandoned: 0 }),
  });
  const frameLines = lines.flatMap((l) => {
    try {
      return frames.observe(JSON.parse(l));
    } catch {
      return [];
    }
  });
  // Every intercepted request gets exactly one frame: streamed after its result, or at close.
  const allFrames = frameLines.length + (await frames.finish()).length;
  const fc = registry.counts();
  expect(allFrames, "frames == served + miss + refused").toBe(fc.served + fc.miss + fc.refused);
  return { code, stderr, lines, seen: up.seen, gzipped: up.gzipped, registry, ctx, dir, config, frameLines, anchors, frames };
}

const toolUse = (model: string, id: string, name: string, input: unknown) =>
  sse([
    start(model),
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
const searched = (messages: string) => messages.includes('"tool_use_id":"toolu_ws1"');
const skillDir = (config: string, name: string, frontmatter: string) => {
  mkdirSync(join(config, "skills", name), { recursive: true });
  writeFileSync(
    join(config, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: looks one thing up\n${frontmatter}---\nSearch the web once, then stop.\n`,
  );
};
type Ran = Awaited<ReturnType<typeof runAgent>>;
/** A fork, as measured on 2.1.295: its search carries the agent id header, the dispatch's result envelope names the
 *  same id, its own transcript is agent-<that id>.jsonl, and the frozen promise holds per agent. */
function expectForkAttributed(r: Ran, dispatchId: string) {
  const entries = r.registry.all();
  expect(entries).toHaveLength(1);
  const header = entries[0]!.agentId;
  expect(header, "the fork's search carries x-claude-code-agent-id").toEqual(expect.any(String));
  const msgs = r.lines.map((l) => JSON.parse(l));
  const envelope = msgs.find(
    (m) => m.type === "user" && m.message?.content?.some?.((b: { tool_use_id?: string }) => b.tool_use_id === dispatchId),
  )?.tool_use_result?.agentId;
  expect(envelope, "envelope agentId == header").toBe(header);
  const transcripts = readdirSync(r.config, { recursive: true, encoding: "utf8" }).filter((p) => /subagents\/agent-[^/]+\.jsonl$/.test(p));
  expect(
    transcripts.map((p) => /agent-([^/]+)\.jsonl$/.exec(p)![1]),
    "transcript stem == header",
  ).toEqual([header]);
  const search = msgs.find((m) => m.type === "assistant" && m.message?.content?.some?.((b: { name?: string }) => b.name === "WebSearch"));
  expect(search?.parent_tool_use_id, "the fork's search is parented to its dispatch").toBe(dispatchId);
  expect(
    frozenPromiseError({
      outDir: r.dir,
      configDir: r.config,
      registry: r.registry,
      ctx: r.ctx,
      frames: r.frames,
      noRequest: r.anchors.noRequest,
    }),
  ).toBeNull();
}

describe.runIf(run)("the real agent through the interceptor (local, $0, COWORK_SEARCH_CORPUS_AGENT=1)", () => {
  it("serves the nested search from the pool; the main loop reaches upstream unchanged; frame and frozen promise hold", async () => {
    const r = await runAgent({});
    const diag = `exit ${r.code}; stub saw ${r.seen.map((s) => s.path).join(", ")}; stderr tail: ${r.stderr.slice(-400)}`;
    expect(r.registry.counts(), diag).toMatchObject({ served: 1, miss: 0, refused: 0 });
    // no request carrying a server search tool reached the stub
    expect(r.seen.filter((s) => (s.body?.tools ?? []).some((t: { type?: string }) => t.type?.startsWith("web_search_")))).toEqual([]);
    expect(r.ctx.passedThroughWithSearchTool ?? 0).toBe(0);
    // the tool_result the main loop sent back renders the pool record exactly
    const second = r.seen.filter((s) => s.path.startsWith("/v1/messages") && s.body?.messages).at(-1)!;
    const tr = (second.body!.messages as { content?: unknown }[])
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type?: string; content?: unknown }[]) : []))
      .find((b) => b.type === "tool_result")!;
    const text = typeof tr.content === "string" ? tr.content : (tr.content as { text: string }[]).map((b) => b.text).join("");
    expect(
      text.startsWith(
        renderWebSearchResult({
          query: QUERY,
          entries: [
            { kind: "links", links },
            { kind: "text", text: record.text },
          ],
          reminder: "",
        })
          .split("\n\nREMINDER")[0]!
          .trimEnd(),
      ),
    ).toBe(true);
    // one streamed frame, right after the tool_result
    expect(r.frameLines.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ streamed: true, verdict: "served", query: QUERY })]);
    // the agent's own count matches the interceptor's
    expect(
      frozenPromiseError({ outDir: r.dir, registry: r.registry, ctx: r.ctx, frames: r.frames, noRequest: r.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("a sub-agent's search is attributed to its agent id, which names its own transcript; the frozen promise holds per agent", async () => {
    const r = await runAgent({ task: true });
    const diag = `exit ${r.code}; stub saw ${r.seen.map((s) => `${s.path}${s.agentId ? `@${s.agentId}` : ""}`).join(", ")}`;
    const entries = r.registry.all();
    expect(entries, diag).toHaveLength(1);
    expect(entries[0]!.agentId, diag).toBeTruthy();
    // the child transcript is named for the same id the request carried
    const transcripts = readdirSync(join(r.config, "projects"), { recursive: true })
      .map(String)
      .filter((p) => /subagents\/agent-.+\.jsonl$/.test(p));
    expect(
      transcripts.map((p) => /(?:^|\/)agent-([^/]+)\.jsonl$/.exec(p)![1]),
      `${diag}; transcripts ${transcripts.join(", ")}`,
    ).toContain(entries[0]!.agentId);
    expect(
      frozenPromiseError({
        outDir: r.dir,
        configDir: r.config,
        registry: r.registry,
        ctx: r.ctx,
        frames: r.frames,
        noRequest: r.anchors.noRequest,
      }),
      diag,
    ).toBeNull();
  }, 180_000);

  // The no-request result shapes, confirmed on the real agent at $0: the agent answers each WebSearch itself, no request made.
  const resultOf = (lines: string[], id: string) => {
    for (const l of lines) {
      try {
        const m = JSON.parse(l);
        for (const b of m?.message?.content ?? []) if (b.type === "tool_result" && b.tool_use_id === id) return b;
      } catch {
        /* skip */
      }
    }
    return undefined;
  };

  it("no request: both domain lists at once is a validateInput refusal the recogniser matches; no request is made", async () => {
    const r = await runAgent({
      turns: [(m) => searchTurn(m, { query: QUERY, allowed_domains: ["a.com"], blocked_domains: ["b.com"] }, "toolu_v")],
    });
    const tr = resultOf(r.lines, "toolu_v");
    expect(tr, `stderr: ${r.stderr.slice(-300)}`).toBeDefined();
    expect(tr.is_error).toBe(true);
    expect(noRequestKind(tr, r.anchors.noRequest, { deniedByHarness: false })).toBe("validation");
    expect(r.registry.counts().requests).toBe(0);
    expect(
      frozenPromiseError({ outDir: r.dir, registry: r.registry, ctx: r.ctx, frames: r.frames, noRequest: r.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("no request: a query too short for the input schema makes no request, recognised by the runner's schema-failure prefix", async () => {
    const r = await runAgent({ turns: [(m) => searchTurn(m, { query: "a" }, "toolu_s")] });
    const tr = resultOf(r.lines, "toolu_s");
    expect(tr).toBeDefined();
    expect(tr.is_error).toBe(true);
    expect(r.registry.counts().requests).toBe(0);
    expect(noRequestKind(tr, r.anchors.noRequest, { deniedByHarness: false })).toBe("validation");
    expect(
      frozenPromiseError({ outDir: r.dir, registry: r.registry, ctx: r.ctx, frames: r.frames, noRequest: r.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("no request: the session budget's text is matched by the budget anchors; only the first search made a request", async () => {
    const r = await runAgent({
      env: { CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION: "1" },
      turns: [(m) => searchTurn(m, { query: QUERY }, "toolu_b1"), (m) => searchTurn(m, { query: `${QUERY} 2026` }, "toolu_b2")],
    });
    const second = resultOf(r.lines, "toolu_b2");
    expect(second, `stderr: ${r.stderr.slice(-300)}`).toBeDefined();
    expect(noRequestKind(second, r.anchors.noRequest, { deniedByHarness: false })).toBe("budget");
    expect(r.registry.counts()).toMatchObject({ requests: 1, served: 1 });
    expect(
      frozenPromiseError({ outDir: r.dir, registry: r.registry, ctx: r.ctx, frames: r.frames, noRequest: r.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("no request: a harness deny on the permission channel makes no request; recognised from the decision, not the text", async () => {
    const r = await runAgent({ deny: true, turns: [(m) => searchTurn(m, { query: QUERY }, "toolu_d")] });
    const tr = resultOf(r.lines, "toolu_d");
    expect(tr, `stderr: ${r.stderr.slice(-300)}; lines ${r.lines.length}`).toBeDefined();
    expect(r.registry.counts().requests).toBe(0);
    expect(noRequestKind(tr, r.anchors.noRequest, { deniedByHarness: false })).toBeNull();
    expect(noRequestKind(tr, r.anchors.noRequest, { deniedByHarness: true })).toBe("permission");
  }, 120_000);

  // The agent's own rendering of what the interceptor answered, and that the main loop went on to its final turn.
  const finished = (rr: Awaited<ReturnType<typeof runAgent>>) =>
    rr.seen.some((x) =>
      (x.body?.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result")),
    );
  const mainResult = (rr: Awaited<ReturnType<typeof runAgent>>) => {
    const tr = resultOf(rr.lines, "toolu_stub1");
    return typeof tr?.content === "string" ? tr.content : (tr?.content ?? []).map((b: any) => b.text).join("");
  };
  const unrelated: PoolRecord = {
    ...record,
    query: "solar panel prices",
    id: "f".repeat(64),
    links: [{ title: "Sun", url: "https://sun.example" }],
    text: "Sun.",
  };

  it("a miss answers 'No links found.' by default and 'Web search error: unavailable' under miss=error; the main loop continues either way", async () => {
    const empty = await runAgent({ pool: [unrelated] });
    expect(mainResult(empty)).toContain("No links found.");
    expect(empty.registry.counts()).toMatchObject({ miss: 1 });
    expect(finished(empty)).toBe(true);
    const err = await runAgent({ pool: [unrelated], miss: "error" });
    expect(mainResult(err)).toContain("Web search error: unavailable");
    expect(finished(err)).toBe(true);
    for (const rr of [empty, err])
      expect(
        frozenPromiseError({ outDir: rr.dir, registry: rr.registry, ctx: rr.ctx, frames: rr.frames, noRequest: rr.anchors.noRequest }),
      ).toBeNull();
  }, 240_000);

  it("a stream that ends before message_start makes the agent retry without streaming; the retry is folded into one request", async () => {
    let first = true;
    const rr = await runAgent({
      transform: (http) => {
        if (first && http.headers["content-type"] === "text/event-stream") {
          first = false;
          return { ...http, body: "" };
        }
        return http;
      },
    });
    expect(rr.registry.counts(), `stderr ${rr.stderr.slice(-300)}`).toMatchObject({ requests: 1, served: 1, retriesFolded: 1 });
    expect(mainResult(rr)).toContain(record.text);
    expect(
      frozenPromiseError({ outDir: rr.dir, registry: rr.registry, ctx: rr.ctx, frames: rr.frames, noRequest: rr.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("a stream cut after a completed block gives the agent's cut-off result, still one intercepted request", async () => {
    const rr = await runAgent({
      transform: (http) => {
        if (http.headers["content-type"] !== "text/event-stream") return http;
        const cut = http.body.indexOf("event: content_block_start", http.body.indexOf("event: content_block_stop"));
        return { ...http, body: http.body.slice(0, cut) };
      },
    });
    expect(rr.registry.counts().requests).toBe(1);
    expect(mainResult(rr)).not.toContain(record.text);
    expect(finished(rr)).toBe(true);
    expect(
      frozenPromiseError({ outDir: rr.dir, registry: rr.registry, ctx: rr.ctx, frames: rr.frames, noRequest: rr.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("gzip: with request compression forced and a nested body over 4096 bytes, the gzipped search is inflated, classified and answered locally", async () => {
    const encodings: string[] = [];
    const long = `${QUERY} ${"europe ".repeat(700)}`.trim();
    const rr = await runAgent({
      encodings,
      env: { CLAUDE_CODE_GZIP_REQUEST_BODIES: "1" },
      turns: [(m) => searchTurn(m, { query: long }, "toolu_stub1")],
    });
    // served, not merely intercepted: a refusal would also count as a request
    expect(rr.registry.counts(), `stderr ${rr.stderr.slice(-300)}`).toMatchObject({ requests: 1, served: 1 });
    // record what the agent actually sent: under the proxy env it may still not compress (then this run covers identity only)
    expect(encodings).toHaveLength(1);
    // Measured on 2.1.295: the forced compression reaches the main loop through the proxy (the stub inflates it) and the
    // nested search alike.
    expect(rr.gzipped.length, "main-loop bodies arrived gzipped").toBeGreaterThan(0);
    expect(encodings).toEqual(["gzip"]);
    expect(rr.seen.filter((x) => (x.body?.tools ?? []).some((t: any) => t.type?.startsWith("web_search_")))).toEqual([]);
    expect(
      frozenPromiseError({ outDir: rr.dir, registry: rr.registry, ctx: rr.ctx, frames: rr.frames, noRequest: rr.anchors.noRequest }),
    ).toBeNull();
  }, 120_000);

  it("with the classifier mutated, the search reaches upstream and the agent-side count goes red", async () => {
    const r = await runAgent({ mutate: true });
    expect(r.registry.counts().requests).toBe(0);
    // the search did reach upstream (the channel was armed), and the forward log's own check saw it
    expect(r.seen.filter((x) => (x.body?.tools ?? []).some((t: { type?: string }) => t.type?.startsWith("web_search_")))).toHaveLength(1);
    expect(r.ctx.passedThroughWithSearchTool).toBe(1);
    // the agent-side count goes red on its own, with the forward log blinded
    expect(
      frozenPromiseError({
        outDir: r.dir,
        registry: r.registry,
        ctx: { passedThroughWithSearchTool: 0 },
        frames: r.frames,
        noRequest: r.anchors.noRequest,
      }),
    ).toMatch(/the main agent made 1 search request\(s\) by its own record, and the interceptor saw 0/);
    // and with both checks live, both are named
    expect(
      frozenPromiseError({ outDir: r.dir, registry: r.registry, ctx: r.ctx, frames: r.frames, noRequest: r.anchors.noRequest }),
    ).toMatch(/1 request\(s\) carrying a server search tool were forwarded upstream; the main agent made 1/);
  }, 120_000);

  it("negative control: without the CA the agent cannot reach the API through the interceptor", async () => {
    const r = await runAgent({ withCa: false });
    expect(r.registry.counts().requests).toBe(0);
    expect(r.seen.filter((s) => s.path.startsWith("/v1/messages"))).toEqual([]);
    // and it failed for the reason under test: the run's CA was not trusted
    expect(r.lines.join("\n")).toMatch(/certificate verification failed/i);
  }, 120_000);
  it("an Agent(fork)'s search carries its agent id, which names its envelope and its own transcript; the frozen promise holds", async () => {
    const r = await runAgent({
      prompt: "Research this in a fork.",
      allowedTools: "WebSearch,Agent",
      env: { CLAUDE_CODE_FORK_SUBAGENT: "1" },
      route: (m, msgs, agentId) =>
        agentId
          ? searched(msgs)
            ? endTurn(m, "fork done")
            : toolUse(m, "toolu_ws1", "WebSearch", { query: QUERY })
          : msgs.includes('"tool_use_id":"toolu_fork1"')
            ? endTurn(m, "main done")
            : toolUse(m, "toolu_fork1", "Agent", { description: "fork research", subagent_type: "fork", prompt: "Search the web once." }),
    });
    expect(r.code).toBe(0);
    expectForkAttributed(r, "toolu_fork1");
  }, 120_000);

  it("a context: fork skill's search carries its agent id too; an inline skill's is keyed to main with no parent", async () => {
    const fork = await runAgent({
      prompt: "Use the forkskill skill.",
      allowedTools: "WebSearch,Skill",
      setup: (config) => skillDir(config, "forkskill", "context: fork\n"),
      route: (m, msgs, agentId) =>
        agentId
          ? searched(msgs)
            ? endTurn(m, "fork done")
            : toolUse(m, "toolu_ws1", "WebSearch", { query: QUERY })
          : msgs.includes('"tool_use_id":"toolu_skill1"')
            ? endTurn(m, "main done")
            : toolUse(m, "toolu_skill1", "Skill", { skill: "forkskill" }),
    });
    expect(fork.code).toBe(0);
    expectForkAttributed(fork, "toolu_skill1");

    const inline = await runAgent({
      prompt: "Use the inlineskill skill.",
      allowedTools: "WebSearch,Skill",
      setup: (config) => skillDir(config, "inlineskill", ""),
      route: (m, msgs) =>
        searched(msgs)
          ? endTurn(m, "main done")
          : msgs.includes('"tool_use_id":"toolu_skill1"')
            ? toolUse(m, "toolu_ws1", "WebSearch", { query: QUERY })
            : toolUse(m, "toolu_skill1", "Skill", { skill: "inlineskill" }),
    });
    expect(inline.code).toBe(0);
    expect(inline.registry.all().map((e) => e.agentId)).toEqual([null]);
    const search = inline.lines
      .map((l) => JSON.parse(l))
      .find((m) => m.type === "assistant" && m.message?.content?.some?.((b: { name?: string }) => b.name === "WebSearch"));
    expect(search?.parent_tool_use_id ?? null).toBeNull();
    expect(readdirSync(inline.config, { recursive: true, encoding: "utf8" }).filter((p) => /subagents\//.test(p))).toEqual([]);
    expect(
      frozenPromiseError({
        outDir: inline.dir,
        configDir: inline.config,
        registry: inline.registry,
        ctx: inline.ctx,
        frames: inline.frames,
        noRequest: inline.anchors.noRequest,
      }),
    ).toBeNull();
  }, 240_000);
});
