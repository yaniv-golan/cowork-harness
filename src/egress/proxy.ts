import http from "node:http";
import net from "node:net";
import { appendFileSync } from "node:fs";

/**
 * Default-deny forward proxy reproducing Cowork's compiled allowlist behavior.
 * Only hosts in `allow` get CONNECT-through (HTTPS) or forwarded GET/POST (HTTP);
 * everything else is refused and logged. This is a TEST FIXTURE, not a security
 * boundary — see DESIGN.md §5.
 *
 * Run as a sidecar (docker/Dockerfile.proxy) on the cowork-net network, or
 * in-process for L0+manual testing.
 */
export interface ProxyOptions {
  allow: string[]; // exact hostnames or "*.suffix"
  logPath?: string;
  port?: number;
  onDecision?: (host: string, decision: "allow" | "deny") => void;
}

/** The proxy server plus a `ready` handshake (#42): resolves once it is accepting connections, rejects
 *  on a listen error (e.g. EADDRINUSE) instead of crashing the process via an uncaught server error. */
export interface EgressProxy extends http.Server {
  ready: Promise<void>;
}

/** Allocate a free TCP port by binding an ephemeral listener and releasing it. Used to give each microVM
 *  run its own host proxy port so concurrent runs can't collide on a fixed default (#41). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export function startEgressProxy(opts: ProxyOptions): EgressProxy {
  const allow = compile(opts.allow);
  const log = (host: string, decision: "allow" | "deny") => {
    opts.onDecision?.(host, decision);
    if (opts.logPath) appendFileSync(opts.logPath, JSON.stringify({ ts: Date.now(), host, decision }) + "\n");
  };

  const server = http.createServer((req, res) => {
    const host = hostOf(req.url ?? "", req.headers.host).toLowerCase();
    if (!allow(host)) {
      log(host, "deny");
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`egress denied: ${host} not on allowlist`);
      return;
    }
    // Minimal HTTP forward (CONNECT covers HTTPS below; this handles plain HTTP).
    // #33: `hostOf` falls back to the Host header for a relative/malformed req.url, so the
    // allow check can pass while `new URL(req.url)` still throws. Fail loud with a clean 400
    // instead of letting the uncaught throw take the callback (and the proxy) down.
    let target: URL;
    try {
      target = new URL(req.url!);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request: malformed proxy URL");
      return;
    }
    // Log `allow` only once the request is valid and we're about to forward. Logging before
    // the parse would record an `allow` for a malformed URL that never reached an upstream,
    // false-passing `egress_allowed` assertions.
    log(host, "allow");
    const proxyReq = http.request(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      res.writeHead(502);
      res.end("upstream error");
    });
    req.pipe(proxyReq);
  });

  // HTTPS via CONNECT tunneling — allow/deny by SNI host, then blind-pipe.
  server.on("connect", (req, clientSocket, head) => {
    // A reset on either side must never crash the proxy (ECONNRESET is normal at
    // connection teardown). Attach error handlers before any I/O.
    clientSocket.on("error", () => clientSocket.destroy());
    // Parse the CONNECT authority bracket-aware so `[2001:db8::1]:443` yields the right
    // host/port — a bare `split(":")` reads `[` as the host and `2001` as the port. The
    // matcher lowercases, so DNS-case variants of the SNI host match the allowlist too.
    const { host, port } = parseAuthority(req.url ?? "");
    if (!allow(host)) {
      log(host, "deny");
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    log(host, "allow");
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });

  // Last-resort guards so a single bad socket can never take the proxy down.
  server.on("clientError", (_e, sock) => {
    try {
      sock.destroy();
    } catch {
      /* already gone */
    }
  });
  // #50: store the handler so it can be removed when the server is closed — otherwise each
  // startEgressProxy() call in one process stacks another uncaughtException handler, causing
  // benign ECONNRESET/EPIPE to be swallowed N times by stale handlers after their server is gone.
  const uncaughtHandler = (e: NodeJS.ErrnoException) => {
    if (e?.code === "ECONNRESET" || e?.code === "EPIPE") return; // benign socket teardown
    throw e;
  };
  process.on("uncaughtException", uncaughtHandler);

  // #42: readiness/error handshake. With an `error` listener a bind failure (EADDRINUSE) is a rejected
  // `ready` rather than an uncaught server error that crashes the process; callers `await proxy.ready`
  // before routing traffic so the agent never starts before the socket is accepting.
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(opts.port ?? 8080);
  // Wrap close() so the uncaughtException handler is cleaned up when the server stops.
  const origClose = server.close.bind(server);
  server.close = (cb?: (err?: Error) => void) => {
    process.removeListener("uncaughtException", uncaughtHandler);
    return origClose(cb);
  };
  (server as EgressProxy).ready = ready;
  return server as EgressProxy;
}

export function compile(patterns: string[]): (host: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  // DNS hostnames are case-insensitive: store patterns lowercased and lowercase the candidate
  // host in the matcher, so `API.ANTHROPIC.COM` matches an `api.anthropic.com` allow.
  for (const p0 of patterns) {
    const p = p0.toLowerCase();
    if (p === "*") return () => true; // unrestricted
    // An egress entry is a bare host or a `*.suffix` wildcard. A scheme / path / port / whitespace entry
    // (e.g. `https://api.anthropic.com`) used to be stored verbatim as an exact pattern that could never
    // match a bare hostname — a silent, confusing always-deny. Reject it loudly instead.
    if (p.includes("://") || p.includes("/") || p.includes(":") || /\s/.test(p))
      throw new Error(
        `invalid egress allow entry "${p0}" — use a bare host (api.anthropic.com) or a wildcard (*.claude.ai), not a URL / scheme / path / port`,
      );
    if (p.startsWith("*."))
      suffixes.push(p.slice(1)); // ".claude.ai"
    else exact.add(p);
  }
  return (host: string) => {
    const h = host.toLowerCase();
    return exact.has(h) || suffixes.some((s) => h.endsWith(s));
  };
}

function hostOf(url: string, hostHeader?: string): string {
  try {
    return new URL(url).hostname || (hostHeader ?? "").split(":")[0];
  } catch {
    return (hostHeader ?? "").split(":")[0];
  }
}

/**
 * Parse a CONNECT authority (`host:port`, or `[ipv6]:port`) into a bare host (IPv6 brackets
 * stripped, lowercased) and a numeric port (default 443). Uses the WHATWG URL parser so
 * bracketed IPv6 literals are handled correctly; falls back to a best-effort split.
 */
function parseAuthority(authority: string): { host: string; port: number } {
  try {
    const u = new URL("http://" + authority);
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return { host, port: u.port ? Number(u.port) : 443 };
  } catch {
    return { host: authority.split(":")[0].toLowerCase(), port: 443 };
  }
}
