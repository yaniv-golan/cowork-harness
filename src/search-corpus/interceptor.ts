/**
 * The frozen search corpus's interceptor: a loopback CONNECT proxy for one run. Every host but the API host is a blind
 * tunnel. For the API host it terminates TLS with the run's own leaf certificate, reads each request on the
 * connection in turn (keep-alive), and either answers it locally (`serveRequest`) or forwards the request's raw bytes
 * upstream over its own TLS connection and streams the response back unchanged, byte for byte, as it arrives. Nothing
 * is re-serialised, so header order, casing, framing and signed response headers pass through untouched.
 *
 * Secrets: requests carry the credential in cleartext here. Nothing but the per-query log line (no header, credential
 * or body) is written anywhere. The CA's private key never leaves `mintCertificates`; the leaf key stays in memory;
 * only the CA certificate (public) is written, to a 0600 file the agent trusts through `NODE_EXTRA_CA_CERTS`.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, TLSSocket, type ConnectionOptions } from "node:tls";
import type { Duplex } from "node:stream";
import { mintCertificates, SEARCH_CORPUS_HOST } from "./x509.js";
import { serveRequest, type ServeContext } from "./serve.js";
import type { SynthHttp } from "./synth.js";

/** Where the API host's forwarded requests go. Tests point it at a stub; a run uses the real host. */
export interface Upstream {
  host: string;
  port: number;
  /** Extra CA certificates to trust upstream (tests only); the system store otherwise. */
  ca?: string[];
}

export interface Interceptor {
  /** `http://127.0.0.1:<port>`, for `HTTPS_PROXY`. */
  readonly url: string;
  /** The run's CA certificate (PEM), for `NODE_EXTRA_CA_CERTS`. */
  readonly caPem: string;
  /** Stop accepting, let requests still classifying finish (bounded), then report how many were abandoned. */
  quiesce(timeoutMs?: number): Promise<{ abandoned: number }>;
  close(): Promise<void>;
}

const CRLF2 = Buffer.from("\r\n\r\n");

/** A pull reader over a socket: buffered bytes, waiting for more as needed. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private ended = false;
  private wake: (() => void) | null = null;
  constructor(private readonly s: Duplex) {
    s.on("data", (d: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.wake?.();
    });
    const end = () => {
      this.ended = true;
      this.wake?.();
    };
    s.on("end", end);
    s.on("close", end);
    s.on("error", end);
  }
  private async more(): Promise<boolean> {
    if (this.ended) return false;
    await new Promise<void>((r) => (this.wake = r));
    this.wake = null;
    return true;
  }
  /** Everything through the next CRLFCRLF, or null at a clean end of stream. */
  async head(limit = 1 << 20): Promise<Buffer | null> {
    for (;;) {
      const i = this.buf.indexOf(CRLF2);
      if (i !== -1) return this.take(i + 4);
      if (this.buf.length > limit) throw new Error("header too large");
      if (!(await this.more())) {
        if (this.buf.length) throw new Error("truncated header");
        return null;
      }
    }
  }
  async exactly(n: number): Promise<Buffer> {
    while (this.buf.length < n) if (!(await this.more())) throw new Error("truncated body");
    return this.take(n);
  }
  async line(): Promise<Buffer> {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i !== -1) return this.take(i + 2);
      if (!(await this.more())) throw new Error("truncated chunk");
    }
  }
  /** Whatever is buffered now, or the next arrival; null at end of stream. */
  async some(): Promise<Buffer | null> {
    if (!this.buf.length && !(await this.more()) && !this.buf.length) return null;
    return this.take(this.buf.length);
  }
  private take(n: number): Buffer {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

interface Head {
  raw: Buffer;
  start: string;
  headers: [string, string][];
}

function parseHead(raw: Buffer): Head {
  const lines = raw
    .subarray(0, raw.length - 4)
    .toString("latin1")
    .split("\r\n");
  const start = lines.shift() ?? "";
  const headers: [string, string][] = [];
  for (const l of lines) {
    const c = l.indexOf(":");
    if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
  }
  return { raw, start, headers };
}
const get = (h: Head, name: string) => h.headers.find(([k]) => k.toLowerCase() === name)?.[1];
const chunked = (h: Head) =>
  (get(h, "transfer-encoding") ?? "")
    .toLowerCase()
    .split(",")
    .map((x) => x.trim())
    .includes("chunked");

/** A message body. Without `sink`: its raw bytes as they arrived, and the decoded payload (a request, read whole to be
 *  classified). With `sink`: each raw piece is handed on as it arrives and nothing is kept (a relayed response). Bad
 *  framing throws, which tears the connection down; nothing is guessed. */
async function readBody(r: Reader, h: Head, sink?: (b: Buffer) => Promise<void>): Promise<{ raw: Buffer[]; payload: Buffer }> {
  const raw: Buffer[] = [];
  const payload: Buffer[] = [];
  const emit = async (b: Buffer) => {
    if (sink) await sink(b);
    else raw.push(b);
  };
  if (chunked(h)) {
    for (;;) {
      const sizeLine = await r.line();
      await emit(sizeLine);
      const sizeText = sizeLine.toString("latin1").split(";")[0]!.trim();
      if (!/^[0-9a-fA-F]{1,16}$/.test(sizeText)) throw new Error("bad chunk size");
      const size = parseInt(sizeText, 16);
      if (size === 0) {
        // trailers, then the final CRLF
        for (;;) {
          const t = await r.line();
          await emit(t);
          if (t.length === 2) break;
        }
        break;
      }
      const data = await r.exactly(size + 2);
      if (data[size] !== 0x0d || data[size + 1] !== 0x0a) throw new Error("chunk not terminated by CRLF");
      await emit(data);
      if (!sink) payload.push(data.subarray(0, size));
    }
  } else {
    const cl = get(h, "content-length");
    if (cl !== undefined && !/^\d{1,15}$/.test(cl.trim())) throw new Error("bad content-length");
    const n = Number(cl ?? "0");
    if (n > 0) {
      const data = await r.exactly(n);
      await emit(data);
      if (!sink) payload.push(data);
    }
  }
  return { raw, payload: Buffer.concat(payload) };
}

/** Write with backpressure: wait for drain when the client's buffer is full. */
function writeDrained(s: Duplex, b: Buffer): Promise<void> {
  if (s.write(b)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      s.off("drain", done);
      s.off("close", done);
      resolve();
    };
    s.once("drain", done);
    s.once("close", done);
  });
}

/** Stream one upstream response to the client as it arrives; resolves when it ends. Returns whether the upstream
 *  connection can be reused. */
async function relayResponse(up: Reader, client: Duplex, method: string): Promise<boolean> {
  const rawHead = await up.head();
  if (!rawHead) throw new Error("upstream closed");
  const h = parseHead(rawHead);
  client.write(rawHead);
  const status = Number(h.start.split(" ")[1]);
  const noBody = method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200);
  if (status >= 100 && status < 200 && status !== 101) return relayResponse(up, client, method);
  const keepAlive = (get(h, "connection") ?? "").toLowerCase() !== "close";
  if (noBody) return keepAlive;
  if (chunked(h) || get(h, "content-length") !== undefined) {
    await readBody(up, h, (b) => writeDrained(client, b));
    return keepAlive;
  }
  // Delimited by close: relay until the upstream ends.
  for (let b = await up.some(); b; b = await up.some()) await writeDrained(client, b);
  return false;
}

export async function startInterceptor(o: {
  ctx: ServeContext;
  upstream?: Upstream;
  /** Extra PEM to append to the trust file (the operator's own NODE_EXTRA_CA_CERTS). */
  extraCaPem?: string;
  /** Test seam: rewrite a local answer before it is sent (the agent-level test truncates one to force the agent's
   *  non-streaming fallback or its cut-off path). */
  transformResponse?: (http: SynthHttp, req: { method: string; path: string; body: Buffer }) => SynthHttp;
  /** Test seam: which other hosts may be tunnelled (default: all, as a run needs). A refused CONNECT gets a 403. */
  tunnelAllowed?: (host: string, port: number) => boolean;
}): Promise<Interceptor> {
  const certs = mintCertificates();
  const upstream: Upstream = o.upstream ?? { host: SEARCH_CORPUS_HOST, port: 443 };
  const registry = o.ctx.registry;
  const sockets = new Set<Duplex>();
  const track = (s: Duplex) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    s.on("error", () => {});
  };

  const openUpstream = () =>
    new Promise<TLSSocket>((resolve, reject) => {
      const opts: ConnectionOptions = {
        host: upstream.host,
        port: upstream.port,
        servername: SEARCH_CORPUS_HOST,
        ALPNProtocols: ["http/1.1"],
      };
      if (upstream.ca) opts.ca = upstream.ca;
      const s = tlsConnect(opts, () => resolve(s));
      track(s);
      s.once("error", reject);
    });

  async function handleApi(client: TLSSocket): Promise<void> {
    const r = new Reader(client);
    let up: TLSSocket | null = null;
    let upReader: Reader | null = null;
    try {
      for (;;) {
        const rawHead = await r.head();
        if (!rawHead) break;
        const h = parseHead(rawHead);
        const token = registry.begin();
        let decided = false;
        try {
          const body = await readBody(r, h);
          const [method = "", path = ""] = h.start.split(" ");
          const headers: Record<string, string> = {};
          for (const [k, v] of h.headers) headers[k] = v;
          const d = serveRequest({ method, path, headers, body: body.payload }, o.ctx);
          registry.end(token);
          decided = true;
          if (d.kind === "respond") {
            if (o.transformResponse) d.http = o.transformResponse(d.http, { method, path, body: body.payload });
            const lines = [`HTTP/1.1 ${d.http.status} ${d.http.status === 200 ? "OK" : "Bad Request"}`];
            for (const [k, v] of Object.entries(d.http.headers)) lines.push(`${k}: ${v}`);
            const payload = Buffer.from(d.http.body, "utf8");
            lines.push(`content-length: ${payload.length}`, "connection: keep-alive");
            client.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), payload]));
            continue;
          }
          if (!up || up.destroyed) {
            up = await openUpstream();
            upReader = new Reader(up);
          }
          up.write(rawHead);
          for (const b of body.raw) up.write(b);
          const reusable = await relayResponse(upReader!, client, method.toUpperCase());
          if (!reusable) {
            up.destroy();
            up = null;
          }
        } finally {
          if (!decided) registry.end(token);
        }
      }
    } finally {
      up?.destroy();
      client.end();
    }
  }

  function tunnel(client: Duplex, host: string, port: number, head: Buffer) {
    const target: Socket = netConnect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      client.pipe(target);
      target.pipe(client);
    });
    track(target);
    target.on("error", () => client.destroy());
    client.on("error", () => target.destroy());
  }

  const server: Server = createServer((_req, res) => {
    res.writeHead(405, { connection: "close" }).end();
  });
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const [host = "", portStr = "443"] = (req.url ?? "").split(/:(?=\d+$)/);
    const port = Number(portStr);
    if (host.toLowerCase() !== SEARCH_CORPUS_HOST || port !== 443) {
      if (o.tunnelAllowed && !o.tunnelAllowed(host, port)) {
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      return tunnel(client, host, port, head);
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client sent after the CONNECT header (the start of its TLS handshake) belong to the TLS layer.
    if (head.length) (client as Socket).unshift(head);
    const tls = new TLSSocket(client as Socket, {
      isServer: true,
      key: certs.leafKeyPem,
      cert: certs.leafPem,
      ALPNProtocols: ["http/1.1"],
    });
    track(tls);
    handleApi(tls).catch(() => tls.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    caPem: o.extraCaPem ? `${certs.caPem}${o.extraCaPem.endsWith("\n") ? o.extraCaPem : `${o.extraCaPem}\n`}` : certs.caPem,
    async quiesce(timeoutMs = 5000) {
      server.close();
      const deadline = Date.now() + timeoutMs;
      while (registry.pending() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      const abandoned = registry.abandonPending();
      // From here no request can be recorded (the session frames what was) and none is classified.
      registry.close();
      for (const s of sockets) s.destroy();
      return { abandoned };
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      return closing;
    },
  };
}
