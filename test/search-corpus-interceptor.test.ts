import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { connect as tlsConnect, createServer as tlsServer, type TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";
import { startInterceptor, type Interceptor } from "../src/search-corpus/interceptor.js";
import { mintCertificates } from "../src/search-corpus/x509.js";
import { SearchRegistry } from "../src/search-corpus/registry.js";
import { buildIndex, DEFAULT_RETRIEVAL } from "../src/search-corpus/retrieval.js";
import { recordId, type PoolRecord } from "../src/search-corpus/harvest.js";
import type { ServeContext, SearchLogLine } from "../src/search-corpus/serve.js";
import type { SearchAnchors } from "../src/types.js";

// The interceptor at the network layer, $0: a stub upstream with its own CA stands in for the API host; a raw TLS client stands in
// for the agent. The real-agent version is a separate, local-only test.
const SENTENCE = "You are a pretend assistant that searches.";
const PREFIX = "Look this up on the web please: ";
const TOKEN = "sk-ant-DUMMY-TRIPWIRE-7f3e9c";
const hsh = (t: string) => ({ sha256: createHash("sha256").update(t, "utf8").digest("hex"), bytes: Buffer.byteLength(t) });
const anchors: SearchAnchors = {
  toolType: "web_search_20250305",
  systemSentence: hsh(SENTENCE),
  userPrefix: hsh(PREFIX),
  ccr: { sessionsPath: "/v1/code/sessions/", workerPath: "/worker/", searchRoute: "web-search" },
};
const links = [{ title: "EV", url: "https://ev.example/eu" }];
const record: PoolRecord = {
  id: recordId({ query: "electric vehicle market europe", links, text: "EV prose." }),
  query: "electric vehicle market europe",
  links,
  text: "EV prose.",
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

interface Stub {
  port: number;
  ca: string;
  seen: Buffer[];
  close: () => void;
}
/** An HTTPS stub that records each connection's raw request bytes and answers a fixed SSE-ish body per request. */
async function stub(): Promise<Stub> {
  const c = mintCertificates();
  const seen: Buffer[] = [];
  const srv = tlsServer({ key: c.leafKeyPem, cert: c.leafPem }, (s) => {
    let buf = Buffer.alloc(0);
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buf.subarray(0, end + 4).toString("latin1");
        const chunkedReq = /transfer-encoding: *chunked/i.test(head);
        let total: number;
        if (chunkedReq) {
          const term = buf.indexOf("0\r\n\r\n", end + 4);
          if (term === -1) return;
          total = term + 5;
        } else {
          const n = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? "0");
          if (buf.length < end + 4 + n) return;
          total = end + 4 + n;
        }
        seen.push(buf.subarray(0, total));
        buf = buf.subarray(total);
        const body = "data: upstream\n\n";
        s.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Claude-Code-Signature: eyJ.sig.value\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as AddressInfo).port, ca: c.caPem, seen, close: () => srv.close() };
}

/** CONNECT through the interceptor, then TLS trusting only its CA. */
function connectVia(proxyUrl: string, caPem: string, host = "api.anthropic.com", port = 443): Promise<TLSSocket> {
  const u = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: u.hostname, port: Number(u.port), method: "CONNECT", path: `${host}:${port}` });
    req.on("connect", (_res, socket) => {
      const t = tlsConnect({ socket, servername: host, ca: [caPem], ALPNProtocols: ["http/1.1"] }, () => resolve(t));
      t.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Send one raw request and read one response (content-length framed). */
function exchange(t: TLSSocket, raw: Buffer): Promise<{ head: string; body: string }> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.subarray(0, end).toString("latin1");
      const n = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? "0");
      if (buf.length < end + 4 + n) return;
      t.off("data", onData);
      resolve({ head, body: buf.subarray(end + 4, end + 4 + n).toString("utf8") });
    };
    t.on("data", onData);
    t.write(raw);
  });
}

const rawPost = (path: string, body: Buffer, extra: string[] = []) =>
  Buffer.concat([
    Buffer.from(
      [
        `POST ${path} HTTP/1.1`,
        "Host: api.anthropic.com",
        `Authorization: Bearer ${TOKEN}`,
        "X-Api-Key: dummy-key",
        ...extra,
        `Content-Length: ${body.length}`,
        "",
        "",
      ].join("\r\n"),
      "latin1",
    ),
    body,
  ]);
const nested = (query: string) =>
  Buffer.from(
    JSON.stringify({
      model: "claude-sonnet-5",
      stream: true,
      system: SENTENCE,
      messages: [{ role: "user", content: `${PREFIX}${query}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    }),
  );
const mainLoop = Buffer.from(
  JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ name: "Bash" }] }),
);

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function setup() {
  const up = await stub();
  const log: SearchLogLine[] = [];
  const ctx: ServeContext = {
    index: buildIndex([record], DEFAULT_RETRIEVAL),
    anchors,
    registry: new SearchRegistry(),
    miss: "empty",
    log: (l) => log.push(l),
  };
  const ic: Interceptor = await startInterceptor({ ctx, upstream: { host: "127.0.0.1", port: up.port, ca: [up.ca] } });
  cleanup.push(
    () => up.close(),
    () => ic.close(),
  );
  return { up, ic, ctx, log };
}

describe("the interceptor (network layer, $0)", () => {
  it("forwards main-loop requests byte for byte on one keep-alive tunnel, and serves the nested search locally", async () => {
    const { up, ic, ctx, log } = await setup();
    const t = await connectVia(ic.url, ic.caPem);
    cleanup.push(() => t.destroy());
    const r1 = rawPost("/v1/messages?beta=true", mainLoop, ["anthropic-beta: x,y", "X-Mixed-Case: Keep"]);
    const a = await exchange(t, r1);
    expect(a.body).toBe("data: upstream\n\n");
    expect(a.head).toContain("X-Claude-Code-Signature: eyJ.sig.value"); // a signed response header, unchanged
    const s = await exchange(t, rawPost("/v1/messages?beta=true", nested("electric vehicle market europe")));
    expect(s.body).toContain("EV prose.");
    expect(s.head).toMatch(/request-id: req_[0-9A-Za-z]{24}/);
    const r3 = rawPost("/v1/messages", gzipSync(mainLoop), ["Content-Encoding: gzip"]);
    await exchange(t, r3);
    // the stub saw exactly the two main-loop requests, identical to what the client sent; never the search
    expect(up.seen).toEqual([r1, r3]);
    expect(ctx.registry.counts()).toMatchObject({ served: 1, requests: 1 });
    expect(ctx.passedThroughWithSearchTool).toBe(0);
    expect(log.map((l) => l.verdict)).toEqual(["served"]);
  });

  it("forwards a chunked request with its raw chunk framing", async () => {
    const { up, ic } = await setup();
    const t = await connectVia(ic.url, ic.caPem);
    cleanup.push(() => t.destroy());
    const body = mainLoop.toString("latin1");
    const raw = Buffer.from(
      [
        "POST /v1/messages HTTP/1.1",
        "Host: api.anthropic.com",
        "Transfer-Encoding: chunked",
        "",
        `5;ext=1`,
        body.slice(0, 5),
        `${(body.length - 5).toString(16)}`,
        body.slice(5),
        "0",
        "",
        "",
      ].join("\r\n"),
      "latin1",
    );
    await exchange(t, raw);
    expect(up.seen).toEqual([raw]);
  });

  it("a nested search inside a chunked or gzipped body is still classified and served, never forwarded", async () => {
    const { up, ic, ctx } = await setup();
    const t = await connectVia(ic.url, ic.caPem);
    cleanup.push(() => t.destroy());
    const s = await exchange(t, rawPost("/v1/messages", gzipSync(nested("electric vehicle market europe")), ["Content-Encoding: gzip"]));
    expect(s.body).toContain("EV prose.");
    expect(up.seen).toEqual([]);
    expect(ctx.registry.counts().served).toBe(1);
  });

  it("tunnels any other host blind, with no TLS termination", async () => {
    const { ic } = await setup();
    const echo = netServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    cleanup.push(() => echo.close());
    const u = new URL(ic.url);
    const got = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: u.hostname,
        port: Number(u.port),
        method: "CONNECT",
        path: `127.0.0.1:${(echo.address() as AddressInfo).port}`,
      });
      req.on("connect", (_res, socket) => {
        socket.once("data", (d) => {
          resolve(d.toString());
          socket.destroy();
        });
        socket.write("raw bytes, not TLS");
      });
      req.on("error", reject);
      req.end();
    });
    expect(got).toBe("raw bytes, not TLS");
  });

  it("the credential appears in no log line and no registry entry", async () => {
    const { ic, ctx, log } = await setup();
    const t = await connectVia(ic.url, ic.caPem);
    cleanup.push(() => t.destroy());
    await exchange(t, rawPost("/v1/messages", nested("electric vehicle market europe")));
    await exchange(t, rawPost("/v1/messages", mainLoop));
    const all = JSON.stringify({ log, entries: ctx.registry.all() });
    for (const form of [TOKEN, Buffer.from(TOKEN).toString("base64"), encodeURIComponent(TOKEN), "dummy-key"])
      expect(all).not.toContain(form);
  });

  it("quiesce stops accepting and returns at once when nothing is classifying; it is bounded when something is", async () => {
    const { ic, ctx } = await setup();
    expect(await ic.quiesce(1000)).toEqual({ abandoned: 0 });
    ctx.registry.begin(); // a request that never finishes classifying
    const t0 = Date.now();
    expect(await ic.quiesce(200)).toEqual({ abandoned: 1 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(ctx.registry.counts().unfinished).toBe(1);
  });

  it("after quiesce, connections are closed, so a late request is never classified, recorded or framed", async () => {
    const { ic, ctx } = await setup();
    const t = await connectVia(ic.url, ic.caPem);
    await ic.quiesce(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.destroyed || t.readableEnded).toBe(true);
    expect(ctx.registry.all()).toEqual([]);
  });

  it("refuses malformed framing instead of guessing: a bad chunk size or Content-Length closes the connection unforwarded", async () => {
    const { up, ic } = await setup();
    for (const raw of [
      "POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nTransfer-Encoding: chunked\r\n\r\n1g\r\nx\r\n0\r\n\r\n",
      "POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: abc\r\n\r\n{}",
    ]) {
      const t = await connectVia(ic.url, ic.caPem);
      t.write(raw);
      await new Promise<void>((r) => t.once("close", () => r()));
    }
    expect(up.seen).toEqual([]);
  });

  it("appends the operator's own extra CA to the trust file", async () => {
    const up = await stub();
    cleanup.push(() => up.close());
    const ctx: ServeContext = {
      index: buildIndex([record], DEFAULT_RETRIEVAL),
      anchors,
      registry: new SearchRegistry(),
      miss: "empty",
      log: () => {},
    };
    const ic = await startInterceptor({ ctx, upstream: { host: "127.0.0.1", port: up.port, ca: [up.ca] }, extraCaPem: up.ca });
    cleanup.push(() => ic.close());
    expect(ic.caPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(ic.caPem.endsWith(up.ca)).toBe(true);
  });
});
