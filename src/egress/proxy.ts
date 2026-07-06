import http from "node:http";
import net from "node:net";
import { appendFileSync } from "node:fs";
import { validateBareDomain, normalizeHost } from "../boundary-paths.js";

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

/** The proxy server plus a `ready` handshake: resolves once it is accepting connections, rejects
 *  on a listen error (e.g. EADDRINUSE) instead of crashing the process via an uncaught server error. */
export interface EgressProxy extends http.Server {
  ready: Promise<void>;
  actualPort: number;
}

/** Bind an ephemeral port, read it back, and immediately close — returns a port number that was
 *  free at that instant. Useful in tests to get a "dead" upstream port (nothing listening) so the
 *  proxy can be driven to a 502. NOT used in production proxy startup (use port:0 → actualPort). */
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
  const log = (
    host: string,
    decision: "allow" | "deny",
    detail?: { method?: string; path?: string; port?: number; bytes?: number; reason?: string },
  ) => {
    opts.onDecision?.(host, decision);
    if (opts.logPath) appendFileSync(opts.logPath, JSON.stringify({ ts: Date.now(), host, decision, ...detail }) + "\n");
  };

  const server = http.createServer((req, res) => {
    const host = normalizeHost(hostOf(req.url ?? "", req.headers.host));
    if (!allow(host)) {
      log(host, "deny", { method: req.method, reason: "not on allowlist" });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`egress denied: ${host} not on allowlist`);
      return;
    }
    // Minimal HTTP forward (CONNECT covers HTTPS below; this handles plain HTTP).
    // `hostOf` falls back to the Host header for a relative/malformed req.url, so the
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
    // Log `allow` only once the upstream actually responds — not merely because the host
    // passed the allowlist. Logging here (before the request reaches an upstream) would false-pass
    // an `egress_allowed` assertion even when DNS/connect/request failed and nothing reached the
    // host. An upstream error logs nothing (the deny path is unaffected: it still logs above).
    const proxyReq = http.request(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (proxyRes) => {
        const clen = Number(proxyRes.headers["content-length"]);
        log(host, "allow", {
          method: req.method,
          path: target.pathname,
          port: Number(target.port) || 80,
          bytes: Number.isFinite(clen) ? clen : undefined,
        });
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.on("error", () => res.end());
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("upstream error");
      } else {
        res.end();
      }
    });
    res.on("error", () => {});
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
    const normalizedHost = normalizeHost(host);
    if (!allow(normalizedHost)) {
      log(normalizedHost, "deny", { port, reason: "not on allowlist" });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    // Log `allow` only once the upstream socket actually connects, not merely because the
    // host passed the allowlist — otherwise `egress_allowed` false-passes when the connect fails
    // and nothing reached the host. The deny path above is unchanged.
    const upstream = net.connect(port, host, () => {
      log(normalizedHost, "allow", { port });
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      clientSocket.on("close", () => upstream.destroy());
      upstream.on("close", () => clientSocket.destroy());
    });
    // covers client close during the connect handshake (before the callback fires); destroy is idempotent
    clientSocket.on("close", () => upstream.destroy());
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
  // Swallow benign ECONNRESET/EPIPE on the server itself (e.g. a client that disconnects before the
  // response is fully sent). These are normal socket-teardown events and must not crash the proxy.
  // Using a direct `.on("error", …)` handler here — rather than a process-wide `uncaughtException`
  // hook — keeps the suppression scoped exactly to this server object and never masks unrelated errors.
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "ECONNRESET" || e.code === "EPIPE") return; // benign socket teardown — ignore
    // All other server errors (e.g. EADDRINUSE before `listening`) are captured via the `ready`
    // rejection path below; re-throwing here would crash the process with no context.
  });

  // readiness/error handshake. With an `error` listener a bind failure (EADDRINUSE) is a rejected
  // `ready` rather than an uncaught server error that crashes the process; callers `await proxy.ready`
  // before routing traffic so the agent never starts before the socket is accepting.
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      (server as EgressProxy).actualPort = (server.address() as net.AddressInfo).port;
      resolve();
    });
    server.once("error", reject);
  });
  // port 0 → OS assigns an ephemeral port; actualPort is populated on "listening" above.
  // Dockerfile.proxy passes an explicit port via PORT env; execute.ts passes 0 for the microVM path.
  server.listen(opts.port ?? 0);
  (server as EgressProxy).ready = ready;
  return server as EgressProxy;
}

export function compile(patterns: string[]): (host: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  // DNS hostnames are case-insensitive: store patterns lowercased and lowercase the candidate
  // host in the matcher, so `API.ANTHROPIC.COM` matches an `api.anthropic.com` allow.
  //
  // The per-entry policy lives in the shared `validateBareDomain` so this proxy and the
  // run-side `seedApprovedDomains` cannot fork. It rejects scheme/path/port/whitespace entries (which
  // could never match a bare host — a silent always-deny) AND, as the intended fail-loud hardening,
  // empty/whitespace-only entries that `compile()` used to store as an unmatchable exact "".
  for (const p0 of patterns) {
    const v = validateBareDomain(p0);
    if (v.kind === "all") return () => true; // unrestricted
    if (v.kind === "suffix")
      suffixes.push(normalizeHost(v.value)); // ".claude.ai" — normalizeHost strips trailing dot
    else exact.add(normalizeHost(v.value));
  }
  return (host: string) => {
    const h = normalizeHost(host);
    return exact.has(h) || suffixes.some((s) => h.endsWith(s));
  };
}

function hostOf(url: string, hostHeader?: string): string {
  // A bracketed IPv6 `Host` (e.g. `[2001:db8::1]:80`) must not be split on the first ":",
  // which would read `[` as the host. Route the Host header through the same bracket-aware
  // authority parser used for CONNECT so plain-HTTP requests resolve the same bare host.
  const fromHeader = () => (hostHeader ? parseAuthority(hostHeader).host : "");
  try {
    return new URL(url).hostname || fromHeader();
  } catch {
    return fromHeader();
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
    const host = normalizeHost(u.hostname.replace(/^\[|\]$/g, ""));
    return { host, port: u.port ? Number(u.port) : 443 };
  } catch {
    return { host: normalizeHost(authority.split(":")[0]), port: 443 };
  }
}
