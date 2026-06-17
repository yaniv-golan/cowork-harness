import { describe, it, expect } from "vitest";
import net from "node:net";
import { compile, startEgressProxy, freePort } from "../src/egress/proxy.js";
import { parseEgressLine } from "../src/egress/sidecar.js";

describe("egress allowlist validation + proxy readiness", () => {
  it("rejects a scheme / path / port entry (would silently never match a bare host)", () => {
    expect(() => compile(["https://api.anthropic.com"])).toThrow(/invalid egress allow entry/);
    expect(() => compile(["api.anthropic.com/v1"])).toThrow(/invalid egress allow entry/);
    expect(() => compile(["api.anthropic.com:443"])).toThrow(/invalid egress allow entry/);
    // bare hosts and wildcards are still fine
    expect(compile(["api.anthropic.com"])("api.anthropic.com")).toBe(true);
    expect(compile(["*.claude.ai"])("assets.claude.ai")).toBe(true);
    expect(compile(["*"])("anything.example")).toBe(true);
  });

  it("freePort returns a bindable port; startEgressProxy exposes a ready handshake", async () => {
    const p = await freePort();
    expect(p).toBeGreaterThan(0);
    const server = startEgressProxy({ allow: ["example.com"], port: 0 });
    await server.ready; // resolves once listening (would reject on a bind error)
    expect((server.address() as net.AddressInfo).port).toBeGreaterThan(0);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("egress allowlist", () => {
  it("matches exact hosts", () => {
    const allow = compile(["api.anthropic.com"]);
    expect(allow("api.anthropic.com")).toBe(true);
    expect(allow("evil.com")).toBe(false);
  });

  it("matches *.suffix wildcards", () => {
    const allow = compile(["*.claude.ai"]);
    expect(allow("assets.claude.ai")).toBe(true);
    expect(allow("downloads.claude.ai")).toBe(true);
    expect(allow("claude.ai.evil.com")).toBe(false);
  });

  it("is default-deny", () => {
    const allow = compile([]);
    expect(allow("api.anthropic.com")).toBe(false);
  });

  it('honors "*" as unrestricted', () => {
    const allow = compile(["*"]);
    expect(allow("anything.example.com")).toBe(true);
  });

  it("does not let a suffix match a bare different domain", () => {
    const allow = compile(["*.anthropic.com"]);
    expect(allow("notanthropic.com")).toBe(false);
  });

  it("#40 — matching is case-insensitive (DNS hostnames)", () => {
    const exact = compile(["api.anthropic.com"]);
    expect(exact("API.ANTHROPIC.COM")).toBe(true); // candidate upper-cased
    const mixedPattern = compile(["API.Anthropic.com"]);
    expect(mixedPattern("api.anthropic.com")).toBe(true); // pattern upper-cased
    const sfx = compile(["*.Claude.AI"]);
    expect(sfx("Assets.CLAUDE.ai")).toBe(true);
  });
});

describe("#40/#41/#42 — proxy routing fixes", () => {
  const listen = async (opts: Parameters<typeof startEgressProxy>[0]) => {
    const server = startEgressProxy({ ...opts, port: 0 });
    await new Promise<void>((r) => server.on("listening", () => r()));
    return { server, port: (server.address() as net.AddressInfo).port };
  };
  const send = (port: number, raw: string): Promise<string> =>
    new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => sock.write(raw));
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => resolve(buf));
      sock.on("error", () => resolve(buf)); // tolerate reset after the proxy responds
    });

  it("#41 — does not log `allow` for a malformed URL (no false egress_allowed)", async () => {
    const decisions: Array<{ host: string; decision: string }> = [];
    const { server, port } = await listen({ allow: ["example.com"], onDecision: (host, decision) => decisions.push({ host, decision }) });
    try {
      // Relative URL on an allowed Host: passes the allow check, then `new URL` throws → 400. With the
      // fix, `allow` is logged only AFTER the parse succeeds, so this request logs nothing.
      const resp = await send(port, "GET /foo HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
      expect(resp).toMatch(/^HTTP\/1\.1 400 /);
      expect(decisions.filter((d) => d.decision === "allow")).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it("#42 — CONNECT parses a bracketed IPv6 authority (host is not `[`)", async () => {
    const decisions: Array<{ host: string; decision: string }> = [];
    const { server, port } = await listen({ allow: ["example.com"], onDecision: (host, decision) => decisions.push({ host, decision }) });
    try {
      const resp = await send(port, "CONNECT [2001:db8::1]:443 HTTP/1.1\r\nHost: [2001:db8::1]:443\r\n\r\n");
      expect(resp).toMatch(/403 Forbidden/);
      // The denied host is the bare IPv6 literal, not `[` (the old `split(":")[0]` bug).
      expect(decisions).toContainEqual({ host: "2001:db8::1", decision: "deny" });
    } finally {
      server.close();
    }
  });

  it("#38 — plain-HTTP Host header with a bracketed IPv6 authority parses to the bare host", async () => {
    const decisions: Array<{ host: string; decision: string }> = [];
    const { server, port } = await listen({ allow: ["example.com"], onDecision: (host, decision) => decisions.push({ host, decision }) });
    try {
      // Relative req.url → hostOf falls back to the Host header. A bracketed IPv6 Host must parse to
      // the bare literal, not `[` (the old `(hostHeader ?? "").split(":")[0]` bug).
      const resp = await send(port, "GET /foo HTTP/1.1\r\nHost: [2001:db8::1]:80\r\nConnection: close\r\n\r\n");
      expect(resp).toMatch(/403 /);
      expect(decisions).toContainEqual({ host: "2001:db8::1", decision: "deny" });
      // and never `[`
      expect(decisions.some((d) => d.host === "[")).toBe(false);
    } finally {
      server.close();
    }
  });

  it("#39 — logs `allow` only after the upstream actually connects, not on allowlist pass", async () => {
    // Start an upstream that immediately accepts a connection and replies, so the proxy can forward.
    const upstream = net.createServer((sock) => {
      sock.on("data", () => sock.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi"));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upPort = (upstream.address() as net.AddressInfo).port;

    const okDecisions: Array<{ host: string; decision: string }> = [];
    const ok = await listen({ allow: ["127.0.0.1"], onDecision: (host, decision) => okDecisions.push({ host, decision }) });

    const failDecisions: Array<{ host: string; decision: string }> = [];
    const failProxy = await listen({ allow: ["127.0.0.1"], onDecision: (host, decision) => failDecisions.push({ host, decision }) });
    try {
      // Allowed host that answers → `allow` is logged once the upstream responds.
      const good = await send(ok.port, `GET http://127.0.0.1:${upPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      expect(good).toMatch(/200 OK/);
      expect(okDecisions).toContainEqual({ host: "127.0.0.1", decision: "allow" });

      // Allowed host with NO listener on the target port → connect fails (ECONNREFUSED). The host
      // passed the allowlist, but nothing reached upstream, so NO `allow` may be logged (#39).
      const dead = await freePort();
      const bad = await send(failProxy.port, `GET http://127.0.0.1:${dead}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      expect(bad).toMatch(/502/);
      expect(failDecisions.filter((d) => d.decision === "allow")).toHaveLength(0);
    } finally {
      ok.server.close();
      failProxy.server.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});

describe("#33 — proxy returns 400 on a malformed proxy URL instead of crashing", () => {
  // Send a raw request with a relative path (`GET /foo`) on an allowed host: `hostOf` falls
  // back to the Host header and passes the allow check, but `new URL("/foo")` throws — the
  // callback must respond 400 and the proxy must survive to serve the next request.
  const send = (port: number, raw: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => sock.write(raw));
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });

  it("answers 400 for a relative req.url and keeps serving", async () => {
    const server = startEgressProxy({ allow: ["example.com"], port: 0 });
    await new Promise<void>((r) => server.on("listening", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const first = await send(port, "GET /foo HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
      expect(first).toMatch(/^HTTP\/1\.1 400 /);
      expect(first).toContain("bad request: malformed proxy URL");

      // The proxy must still be alive: a second malformed request gets the same clean 400.
      const second = await send(port, "GET /bar HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n");
      expect(second).toMatch(/^HTTP\/1\.1 400 /);
    } finally {
      server.close();
    }
  });
});

describe("#43 — parseEgressLine validates and never coerces unknown decisions to allow", () => {
  it("returns one entry for valid lines and warns+drops the rest", () => {
    const warnings: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      warnings.push(String(s));
      return true;
    };
    try {
      const valid = parseEgressLine(JSON.stringify({ host: "example.com", decision: "deny" }));
      const nonJson = parseEgressLine("not json at all");
      const unknown = parseEgressLine(JSON.stringify({ host: "evil.com", decision: "maybe" }));
      // valid JSON that is NOT a non-null object must drop loudly, not throw (would crash collect())
      const jsonNull = parseEgressLine("null");
      const jsonArr = parseEgressLine("[1,2]");

      expect(valid).toEqual({ host: "example.com", decision: "deny" });
      expect(nonJson).toBeNull();
      expect(unknown).toBeNull();
      expect(jsonNull).toBeNull();
      expect(jsonArr).toBeNull();
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(warnings.filter((w) => w.startsWith("::warning::"))).toHaveLength(4);
    // The unknown decision must NOT have been silently coerced to "allow".
    expect(warnings.some((w) => w.includes("not coercing to allow"))).toBe(true);
  });
});
