import { describe, it, expect, vi } from "vitest";
import { ProvenanceTracker, normalizeUrl, extractUrls } from "../src/hostloop/provenance.js";
import {
  makeWorkspaceHandler,
  isLocalOrPrivate,
  u1t,
  type WebFetchProvenance,
  type EgressEntry,
  type RawFetch,
  type Resolver,
} from "../src/hostloop/workspace-handler.js";
import { compile } from "../src/egress/proxy.js";
import { readGateFlag } from "../src/loop-decision.js";
import type { PlatformBaseline } from "../src/types.js";

describe("web_fetch provenance-unenforced warning is per-handler (not once-per-process)", () => {
  it("each freshly-built handler warns when provenance is unenforced", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // allow=[] → after the unenforced warning, the fetch hard-denies (no curl, no network call).
    const mk = () => makeWorkspaceHandler("c", "/mnt", "docker", []);
    const call = (h: ReturnType<typeof makeWorkspaceHandler>) =>
      h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url: "https://x.example/y" } } });
    await call(mk());
    await call(mk());
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes("provenance is NOT enforced"));
    spy.mockRestore();
    expect(warns.length).toBe(2); // two handlers → two warnings (a module latch would give 1)
  });
});

describe("#30 — normalizeUrl (zG port)", () => {
  it("drops the fragment and a single trailing slash; lowercases host (via URL)", () => {
    expect(normalizeUrl("https://Example.com/a/#frag")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/"); // root slash kept
    expect(normalizeUrl("http://example.com/p/")).toBe("http://example.com/p");
  });
  it("rejects non-http(s) and unparseable URLs", () => {
    expect(normalizeUrl("ftp://example.com")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
  it("membership is exact on the normalized form", () => {
    const t = new ProvenanceTracker();
    t.add("https://example.com/page#x");
    expect(t.has("https://example.com/page")).toBe(true); // fragment ignored
    expect(t.has("https://example.com/other")).toBe(false);
  });
});

describe("#30 — extractUrls (Ien port)", () => {
  it("extracts full URLs, www. hosts, and bare domains; ZHA-trims trailing punctuation", () => {
    const urls = extractUrls("see https://a.com/x, and www.b.com! also c.io.");
    expect(urls).toContain("https://a.com/x"); // trailing comma trimmed
    expect(urls).toContain("https://www.b.com/"); // www. → https://; root path keeps "/" (zG)
    expect(urls).toContain("https://c.io/"); // bare domain, trailing . trimmed; root "/" kept
  });
  it("seedFromText returns the count of NEW urls and dedupes", () => {
    const t = new ProvenanceTracker();
    expect(t.seedFromText("go to https://x.com/p")).toBe(1);
    expect(t.seedFromText("again https://x.com/p")).toBe(0); // already seen
    expect(t.has("https://x.com/p")).toBe(true);
  });
  it("snapshot/restore round-trips", () => {
    const t = new ProvenanceTracker();
    t.add("https://a.com");
    const r = ProvenanceTracker.restore(t.snapshot());
    expect(r.has("https://a.com")).toBe(true);
  });
});

describe("#30 — web_fetch provenance gate (G1t port, via the handler)", () => {
  // Drive the handler's web_fetch branch with a fake provenance bundle + an egress collector + a STUB
  // fetcher (spawn-free). On Path A a provenance pass now fetches DIRECTLY (decoupled from the hostname
  // allowlist), so the stub returns a `FETCHED <url>` marker; the allowlist (other.example) is irrelevant
  // on Path A — it only proves the host is NOT in the list, so a fetch means decoupling worked.
  const stubFetch: RawFetch = async (u: string) => ({ status: 200, text: async () => `FETCHED ${u}` });
  // Network-free DNS stub: every test host "resolves" to a public address so the SSRF backstop allows it
  // (the real lookup() would NXDOMAIN these synthetic `.example` names and fail closed).
  const publicResolver: Resolver = async () => [{ address: "203.0.113.10" }];
  const callWebFetch = async (
    prov: WebFetchProvenance,
    url: string,
    rawFetch: RawFetch = stubFetch,
    resolve: Resolver = publicResolver,
  ) => {
    const egress: EgressEntry[] = [];
    const ref = { current: prov };
    const h = makeWorkspaceHandler("c", "/mnt", "docker", ["other.example"], (e) => egress.push(e), undefined, ref, rawFetch, resolve);
    const out = (await h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url } } })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return { text: out.result.content[0].text, isError: out.result.isError, egress };
  };
  const fake = (over: Partial<WebFetchProvenance>): WebFetchProvenance => ({
    isAllowed: () => false,
    markAllowed: () => {},
    promptGateOn: false,
    ...over,
  });

  it("a provenance HIT fetches DIRECTLY — NO hostname allowlist (decoupled from egress)", async () => {
    // denied.example is NOT in the handler's allowlist, yet a provenance hit fetches it: Path A is gated by
    // the provenance set ONLY, not the egress domain list (the #30 conflation fix).
    const r = await callWebFetch(fake({ isAllowed: () => true }), "https://denied.example/x");
    expect(r.text).toMatch(/FETCHED https:\/\/denied\.example\/x/);
    expect(r.egress).toEqual([{ host: "denied.example", decision: "allow" }]);
  });

  it("a MISS with no approval (prompt gate off) is a hard deny with the verbatim provenance string", async () => {
    const r = await callWebFetch(fake({ isAllowed: () => false, promptGateOn: false }), "https://x.example/x");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/URL not in provenance set\. web_fetch can only retrieve URLs that appeared/);
    expect(r.egress).toEqual([{ host: "x.example", decision: "deny" }]);
  });

  it("a MISS + approval GRANTED marks the url allowed and fetches directly", async () => {
    let marked: string | undefined;
    const r = await callWebFetch(
      fake({ isAllowed: () => false, promptGateOn: true, requestApproval: async () => true, markAllowed: (u) => (marked = u) }),
      "https://denied.example/x",
    );
    expect(marked).toBe("https://denied.example/x");
    expect(r.text).toMatch(/FETCHED https:\/\/denied\.example\/x/); // approved → fetched (no allowlist on Path A)
  });

  it("a MISS + approval DECLINED is denied with the verbatim 'not allowed' string", async () => {
    const r = await callWebFetch(
      fake({ isAllowed: () => false, promptGateOn: true, requestApproval: async () => false }),
      "https://x.example/x",
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Web fetch was not allowed.");
    expect(r.egress).toEqual([{ host: "x.example", decision: "deny" }]);
  });

  it("permissiveMode (bypassPermissions) pre-adds and skips the check", async () => {
    // Stateful fake: markAllowed makes isAllowed true (as the real ProvenanceTracker does) — the
    // handler relies on that, mirroring Cowork's `cre(...) && e.add(n), !e.has(n)`.
    const allowed = new Set<string>();
    const r = await callWebFetch(
      fake({ isAllowed: (u) => allowed.has(u), markAllowed: (u) => void allowed.add(u), permissiveMode: true }),
      "https://denied.example/x",
    );
    expect(allowed.has("https://denied.example/x")).toBe(true);
    expect(r.text).toMatch(/FETCHED https:\/\/denied\.example\/x/); // bypass → fetched directly
  });

  it("#43 — Path A blocks a non-http scheme even when provenance-approved (no file:// reads)", async () => {
    const r = await callWebFetch(fake({ isAllowed: () => true }), "file:///etc/passwd");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scheme "file:" is not allowed/);
  });

  it("#44 — Path A blocks a redirect to a private address (SSRF), even from an approved URL", async () => {
    let n = 0;
    const rawFetch: RawFetch = async () =>
      n++ === 0
        ? { status: 302, location: "http://169.254.169.254/latest/meta-data", text: async () => "" }
        : { status: 200, text: async () => "SECRET" };
    const r = await callWebFetch(fake({ isAllowed: () => true }), "http://approved.example/x", rawFetch);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Redirect to .* blocked: Host "169\.254\.169\.254" is a local or private address/);
  });

  it("#38 — a redirect logs egress for EACH hop, not just the terminal host", async () => {
    let n = 0;
    const rawFetch: RawFetch = async () =>
      n++ === 0 ? { status: 302, location: "http://b.example/y", text: async () => "" } : { status: 200, text: async () => "FINAL" };
    const r = await callWebFetch(fake({ isAllowed: () => true }), "http://a.example/x", rawFetch);
    expect(r.text).toMatch(/FINAL/);
    // BOTH the intermediate (a.example) hop that redirected AND the terminal (b.example) host are
    // recorded — the per-hop onEgress emit, vs the old terminal-only logging.
    expect(r.egress).toEqual([
      { host: "a.example", decision: "allow" },
      { host: "b.example", decision: "allow" },
    ]);
  });
});

describe("#30 — readGateFlag (prefixed key + prose/structured shapes)", () => {
  const withGates = (gates: Record<string, unknown>) => ({ provenance: { gates } }) as unknown as PlatformBaseline;

  it("reads a sub-flag from the committed PROSE string under the prefixed key", () => {
    const b = withGates({ "coworkRuntimeConfig:1978029737": "on(force) coworkWebFetchViaApi=true coworkWebFetchPrompt=true" });
    expect(readGateFlag(b, "1978029737", "coworkWebFetchPrompt")).toBe(true);
    expect(readGateFlag(b, "1978029737", "coworkWebFetchViaApi")).toBe(true);
  });
  it("reads a sub-flag from a #39-decoded STRUCTURED entry", () => {
    const b = withGates({ "coworkRuntimeConfig:1978029737": { on: true, source: "force", value: { coworkWebFetchPrompt: true } } });
    expect(readGateFlag(b, "1978029737", "coworkWebFetchPrompt")).toBe(true);
    expect(readGateFlag(b, "1978029737", "coworkWebFetchViaApi")).toBe(false); // absent sub-flag
  });
  it("returns false for a missing gate (no silent true)", () => {
    expect(readGateFlag(withGates({}), "1978029737", "coworkWebFetchPrompt")).toBe(false);
  });
  it("also resolves a bare-id key (no prefix)", () => {
    const b = withGates({ "1978029737": "coworkWebFetchPrompt=true" });
    expect(readGateFlag(b, "1978029737", "coworkWebFetchPrompt")).toBe(true);
  });
});

describe("web_fetch Path B — U1t + manual redirect re-check (provenance off)", () => {
  const publicResolver: Resolver = async () => [{ address: "203.0.113.10" }];
  const callB = async (url: string, allow: string[], rawFetch: RawFetch, resolve: Resolver = publicResolver) => {
    const egress: EgressEntry[] = [];
    // provenanceRef + fetchImpl undefined → Path B; inject rawFetch for the redirect loop (spawn-free).
    // A network-free DNS stub keeps the SSRF backstop from NXDOMAIN-denying the synthetic test hosts.
    const h = makeWorkspaceHandler("c", "/mnt", "docker", allow, (e) => egress.push(e), undefined, undefined, rawFetch, resolve);
    const out = (await h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url } } })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return { text: out.result.content[0].text, isError: out.result.isError, egress };
  };
  const ok =
    (body: string): RawFetch =>
    async () => ({ status: 200, text: async () => body });

  it("u1t: scheme / private-address / wen-allowlist / '*' gates", () => {
    const m = compile(["example.com"]);
    expect(u1t(new URL("ftp://example.com/"), ["example.com"], m)).toMatch(/scheme/);
    expect(u1t(new URL("http://127.0.0.1/x"), ["*"], compile(["*"]))).toMatch(/private/);
    expect(u1t(new URL("http://other.com/"), ["example.com"], m)).toMatch(/not in the session/);
    expect(u1t(new URL("http://sub.example.com/"), ["example.com"], m)).toMatch(/not in the session/); // exact-for-bare: subdomain NOT matched
    expect(u1t(new URL("http://example.com/x"), ["example.com"], m)).toBeNull();
    expect(u1t(new URL("http://anything.com/"), ["*"], compile(["*"]))).toBeNull();
  });

  it("isLocalOrPrivate flags loopback/private/link-local, not public", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1"]) expect(isLocalOrPrivate(h)).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "203.0.113.5"]) expect(isLocalOrPrivate(h)).toBe(false);
  });

  it("#36 isLocalOrPrivate normalizes IPv4-mapped IPv6 + numeric/hex/octal/short IPv4 forms", () => {
    const local = [
      "::ffff:127.0.0.1", // IPv4-mapped IPv6 loopback
      "[::ffff:127.0.0.1]", // …with brackets (as a URL hostname carries it)
      "::ffff:169.254.169.254", // IPv4-mapped link-local metadata
      "::ffff:7f00:1", // IPv4-mapped written as hex groups (= 127.0.0.1)
      "2130706433", // integer form of 127.0.0.1
      "0x7f000001", // hex integer form of 127.0.0.1
      "017700000001", // octal integer form of 127.0.0.1
      "0177.0.0.1", // octal first octet
      "0x7f.0.0.1", // hex first octet
      "127.1", // short form (last part fills low bytes) = 127.0.0.1
      "10.0.0.1", // sanity: plain private still caught
    ];
    for (const h of local) expect(isLocalOrPrivate(h), h).toBe(true);

    const publicHosts = [
      "::ffff:8.8.8.8", // IPv4-mapped public
      "134744072", // integer form of 8.8.8.8
      "0x08080808", // hex form of 8.8.8.8
      "8.8.8.8",
    ];
    for (const h of publicHosts) expect(isLocalOrPrivate(h), h).toBe(false);
  });

  it("BLOCKS a redirect to a private address (SSRF) even when the initial host is allowed", async () => {
    let n = 0;
    const rawFetch: RawFetch = async () =>
      n++ === 0
        ? { status: 302, location: "http://169.254.169.254/latest/meta-data", text: async () => "" }
        : { status: 200, text: async () => "SECRET" };
    const r = await callB("http://example.com/x", ["example.com"], rawFetch);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Redirect to .* blocked: Host "169\.254\.169\.254" is a local or private address/);
  });

  it("an allowlisted host fetches (happy path)", async () => {
    const r = await callB("http://example.com/x", ["example.com"], ok("HELLO"));
    expect(r.text).toBe("HELLO");
    expect(r.egress).toEqual([{ host: "example.com", decision: "allow" }]);
  });

  it("denies a host not in the allowlist", async () => {
    const r = await callB("http://evil.com/x", ["example.com"], ok("X"));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not in the session web-fetch allowlist/);
    expect(r.egress).toEqual([{ host: "evil.com", decision: "deny" }]);
  });

  it("DENIES a host whose name RESOLVES to a private/loopback address (DNS-rebind SSRF)", async () => {
    // The host passes the literal private-address check (it is a name, not an IP) and the allowlist, but
    // its DNS resolution points at a loopback address → the async backstop denies it before any fetch.
    const toLoopback: Resolver = async () => [{ address: "127.0.0.1" }];
    const r = await callB("http://example.com/x", ["example.com"], ok("SECRET"), toLoopback);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resolves to a local or private address \(127\.0\.0\.1\)/);
    expect(r.egress).toEqual([{ host: "example.com", decision: "deny" }]);
  });

  it("ALLOWS a host that resolves entirely to public addresses", async () => {
    const toPublic: Resolver = async () => [{ address: "203.0.113.10" }];
    const r = await callB("http://example.com/x", ["example.com"], ok("HELLO"), toPublic);
    expect(r.text).toBe("HELLO");
    expect(r.egress).toEqual([{ host: "example.com", decision: "allow" }]);
  });

  it("DENIES (fail-closed) a host whose DNS resolution FAILS", async () => {
    const nxdomain: Resolver = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    const r = await callB("http://example.com/x", ["example.com"], ok("X"), nxdomain);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could not be resolved/);
    expect(r.egress).toEqual([{ host: "example.com", decision: "deny" }]);
  });

  it("DENIES if ANY of multiple resolved addresses is private (a public+private mix)", async () => {
    const mixed: Resolver = async () => [{ address: "203.0.113.10" }, { address: "10.0.0.5" }];
    const r = await callB("http://example.com/x", ["example.com"], ok("X"), mixed);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resolves to a local or private address \(10\.0\.0\.5\)/);
  });
});

describe("web_fetch DNS-rebind SSRF backstop — Path A (provenance), and literal-IP fast path", () => {
  const ok =
    (body: string): RawFetch =>
    async () => ({ status: 200, text: async () => body });
  const fake = (over: Partial<WebFetchProvenance>): WebFetchProvenance => ({
    isAllowed: () => true, // provenance HIT so Path A reaches the fetch/SSRF gate
    markAllowed: () => {},
    promptGateOn: false,
    ...over,
  });
  const run = async (url: string, resolve: Resolver, rawFetch: RawFetch = ok("BODY")) => {
    const egress: EgressEntry[] = [];
    const ref = { current: fake({}) };
    const h = makeWorkspaceHandler("c", "/mnt", "docker", ["other.example"], (e) => egress.push(e), undefined, ref, rawFetch, resolve);
    const out = (await h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url } } })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return { text: out.result.content[0].text, isError: out.result.isError, egress };
  };

  it("Path A denies a provenance-approved host that resolves to a private address", async () => {
    const toLoopback: Resolver = async () => [{ address: "127.0.0.1" }];
    const r = await run("http://approved.example/x", toLoopback);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/resolves to a local or private address \(127\.0\.0\.1\)/);
  });

  it("a LITERAL public IP host skips DNS and is allowed (resolver never consulted)", async () => {
    let called = false;
    const tripwire: Resolver = async () => {
      called = true;
      return [{ address: "10.0.0.1" }];
    };
    const r = await run("http://8.8.8.8/x", tripwire);
    expect(r.text).toBe("BODY"); // public literal passes; DNS short-circuited
    expect(called).toBe(false); // literal IP never hits the resolver
  });
});
