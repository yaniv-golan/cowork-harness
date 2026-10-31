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
    const mk = () => makeWorkspaceHandler({ containerName: "c", vmMnt: "/mnt", webFetchAllow: [] });
    const call = (h: ReturnType<typeof makeWorkspaceHandler>) =>
      h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url: "https://x.example/y" } } });
    await call(mk());
    await call(mk());
    const warns = spy.mock.calls.filter((c) => String(c[0]).includes("provenance is NOT enforced"));
    spy.mockRestore();
    expect(warns.length).toBe(2); // two handlers → two warnings (a module latch would give 1)
  });
});

describe("normalizeUrl (zG port)", () => {
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

describe("extractUrls (Ien port)", () => {
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

describe("web_fetch provenance gate (G1t port, via the handler)", () => {
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
    const h = makeWorkspaceHandler({
      containerName: "c",
      vmMnt: "/mnt",
      webFetchAllow: ["other.example"],
      onEgress: (e) => egress.push(e),
      provenanceRef: ref,
      rawFetch,
      resolve,
    });
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
    // the provenance set ONLY, not the egress domain list (the conflation fix).
    const r = await callWebFetch(fake({ isAllowed: () => true }), "https://denied.example/x");
    expect(r.text).toMatch(/FETCHED https:\/\/denied\.example\/x/);
    expect(r.egress).toEqual([{ host: "denied.example", decision: "allow" }]);
  });

  it("a MISS with no approval (prompt gate off) is a hard deny with the verbatim provenance string", async () => {
    const r = await callWebFetch(fake({ isAllowed: () => false, promptGateOn: false }), "https://x.example/x");
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "URL not in provenance set. web_fetch can only retrieve URLs that appeared in a user message, a prior " +
        "web_fetch result, or a WebSearch result. Retries will fail. Ask the person to include the verbatim URL " +
        "in a message first. If you cannot ask (e.g. from a subagent), continue without this page and report the " +
        "blocked URL in your findings.",
    );
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

  it("Path A blocks a non-http scheme even when provenance-approved (no file:// reads)", async () => {
    const r = await callWebFetch(fake({ isAllowed: () => true }), "file:///etc/passwd");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scheme "file:" is not allowed/);
  });

  it("Path A blocks a redirect to a private address (SSRF), even from an approved URL", async () => {
    let n = 0;
    const rawFetch: RawFetch = async () =>
      n++ === 0
        ? { status: 302, location: "http://169.254.169.254/latest/meta-data", text: async () => "" }
        : { status: 200, text: async () => "SECRET" };
    const r = await callWebFetch(fake({ isAllowed: () => true }), "http://approved.example/x", rawFetch);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Redirect to .* blocked: Host "169\.254\.169\.254" is a local or private address/);
  });

  it("a redirect logs egress for EACH hop, not just the terminal host", async () => {
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

describe("readGateFlag (prefixed key + prose/structured shapes)", () => {
  const withGates = (gates: Record<string, unknown>) => ({ provenance: { gates } }) as unknown as PlatformBaseline;

  it("reads a sub-flag from the committed PROSE string under the prefixed key", () => {
    const b = withGates({ "coworkRuntimeConfig:1978029737": "on(force) coworkWebFetchViaApi=true coworkWebFetchPrompt=true" });
    expect(readGateFlag(b, "1978029737", "coworkWebFetchPrompt", false)).toBe(true);
    expect(readGateFlag(b, "1978029737", "coworkWebFetchViaApi", false)).toBe(true);
  });
  it("reads a sub-flag from a decoded STRUCTURED entry", () => {
    const b = withGates({ "coworkRuntimeConfig:1978029737": { on: true, source: "force", value: { coworkWebFetchPrompt: true } } });
    expect(readGateFlag(b, "1978029737", "coworkWebFetchPrompt", false)).toBe(true);
    expect(readGateFlag(b, "1978029737", "coworkWebFetchViaApi", false)).toBe(false); // absent sub-flag
  });
  it("returns false for a missing gate (no silent true)", () => {
    expect(readGateFlag(withGates({}), "1978029737", "coworkWebFetchPrompt", false)).toBe(false);
  });
  it("also resolves a bare-id key (no prefix)", () => {
    const b = withGates({ "1978029737": "coworkWebFetchPrompt=true" });
    expect(readGateFlag(b, "1978029737", "coworkWebFetchPrompt", false)).toBe(true);
  });

  // Production reads these through `Ea(id, key, default, …)`, so an UNSERVED key resolves to that call
  // site's default — which is `true` for two real keys on this very gate (`bashHostOnlyIntercept`,
  // `scheduledTaskStaleReapEnabled`). Returning false for them, as this reader used to unconditionally,
  // is wrong in the silent direction. These three pin the distinction the old signature could not make.
  it("an ABSENT gate resolves to the production default, including when that default is true", () => {
    expect(readGateFlag(withGates({}), "1978029737", "bashHostOnlyIntercept", true)).toBe(true);
  });
  it("an absent SUB-FLAG on a present gate resolves to the production default", () => {
    const b = withGates({ "coworkRuntimeConfig:1978029737": { on: true, source: "experiment", value: { coworkWebFetchViaApi: true } } });
    expect(readGateFlag(b, "1978029737", "bashHostOnlyIntercept", true)).toBe(true);
    // a SERVED false still beats the default — the default only fills genuine absence
    const served = withGates({ "coworkRuntimeConfig:1978029737": { on: true, value: { bashHostOnlyIntercept: false } } });
    expect(readGateFlag(served, "1978029737", "bashHostOnlyIntercept", true)).toBe(false);
  });
  it("prose: an explicit `flag=false` beats a true default", () => {
    const b = withGates({ "coworkRuntimeConfig:1978029737": "on(force) bashHostOnlyIntercept=false" });
    expect(readGateFlag(b, "1978029737", "bashHostOnlyIntercept", true)).toBe(false);
    // …while a flag the prose never mentions falls through to the default
    expect(readGateFlag(b, "1978029737", "scheduledTaskStaleReapEnabled", true)).toBe(true);
  });
});

describe("web_fetch Path B — U1t + manual redirect re-check (provenance off)", () => {
  const publicResolver: Resolver = async () => [{ address: "203.0.113.10" }];
  const callB = async (url: string, allow: string[], rawFetch: RawFetch, resolve: Resolver = publicResolver, vendorDeny?: string[]) => {
    const egress: EgressEntry[] = [];
    // provenanceRef + fetchImpl undefined → Path B; inject rawFetch for the redirect loop (spawn-free).
    // A network-free DNS stub keeps the SSRF backstop from NXDOMAIN-denying the synthetic test hosts.
    const h = makeWorkspaceHandler({
      containerName: "c",
      vmMnt: "/mnt",
      webFetchAllow: allow,
      webFetchVendorDeny: vendorDeny,
      onEgress: (e) => egress.push(e),
      rawFetch,
      resolve,
    });
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

  // Desktop 4.4212.0 added a vendor-host refusal to this function, after the `*` short-circuit and before the allowlist:
  // a listed host (or a subdomain of one) is refused even when the allowlist names it.
  it("u1t: a vendor-denied host is refused even when allowlisted, admitted only under '*'", () => {
    const vendor = ["a-cdn.anthropic.com", "s-cdn.anthropic.com"];
    const allow = ["a-cdn.anthropic.com", "*.s-cdn.anthropic.com", "example.com"];
    const m = compile(allow);
    expect(u1t(new URL("https://a-cdn.anthropic.com/x"), allow, m, vendor)).toMatch(/outside vendor.*retrying will not help/);
    expect(u1t(new URL("https://x.s-cdn.anthropic.com/"), allow, m, vendor)).toMatch(/outside vendor/);
    expect(u1t(new URL("https://example.com/"), allow, m, vendor)).toBeNull();
    expect(u1t(new URL("https://A-CDN.anthropic.com./x"), allow, m, vendor)).toMatch(/outside vendor/); // case + trailing dot, as Cowork
    expect(u1t(new URL("https://notanthropic-a-cdn.anthropic.com.evil/"), ["*"], compile(["*"]), vendor)).toBeNull();
    expect(u1t(new URL("https://a-cdn.anthropic.com/x"), ["*"], compile(["*"]), vendor)).toBeNull();
    // scheme and private-address checks still come first
    expect(u1t(new URL("ftp://a-cdn.anthropic.com/"), allow, m, vendor)).toMatch(/scheme/);
    // no vendor list (a baseline older than 4.4212.0): the allowlist decides, as before
    expect(u1t(new URL("https://a-cdn.anthropic.com/x"), allow, m)).toBeNull();
  });

  it("isLocalOrPrivate flags loopback/private/link-local, not public", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1"]) expect(isLocalOrPrivate(h)).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "203.0.113.5"]) expect(isLocalOrPrivate(h)).toBe(false);
  });

  it("isLocalOrPrivate normalizes IPv4-mapped IPv6 + numeric/hex/octal/short IPv4 forms", () => {
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

  it("refuses an allowlisted vendor host, and a redirect to one, when the baseline lists vendor hosts", async () => {
    const vendor = ["a-cdn.anthropic.com"];
    const direct = await callB("https://a-cdn.anthropic.com/x", ["a-cdn.anthropic.com"], ok("X"), publicResolver, vendor);
    expect(direct.isError).toBe(true);
    expect(direct.text).toMatch(/outside vendor/);
    expect(direct.egress).toEqual([{ host: "a-cdn.anthropic.com", decision: "deny" }]);
    let n = 0;
    const hop: RawFetch = async () =>
      n++ === 0 ? { status: 302, location: "https://a-cdn.anthropic.com/y", text: async () => "" } : { status: 200, text: async () => "Y" };
    const redirected = await callB("http://example.com/x", ["example.com", "a-cdn.anthropic.com"], hop, publicResolver, vendor);
    expect(redirected.isError).toBe(true);
    expect(redirected.text).toMatch(/Redirect to .* blocked: .*outside vendor/);
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
    const h = makeWorkspaceHandler({
      containerName: "c",
      vmMnt: "/mnt",
      webFetchAllow: ["other.example"],
      onEgress: (e) => egress.push(e),
      provenanceRef: ref,
      rawFetch,
      resolve,
    });
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

// ==========================================================================================
// DELIBERATE FIDELITY, NOT A BUG — but read the scope, which is narrower than it first looked.
//
// Production's `webFetchAllowedUrls` is a genuine per-session URL allowlist: measured across 439 live
// sessions, 21,316 entries, only 74 (0.35%) are over-matches. It is NOT "populated by scraping dotted
// tokens", which was an earlier characterisation drawn from a single session that happened to contain
// no real URLs — retracted at source, and corrected here rather than left to rot.
//
// What IS real is a small parser over-match: a dotted identifier or filename-shaped token
// (`os.unlink`, `offer.docx`, `26.xlsx`) parses as a hostname and is persisted. Nearly all are inert
// because those suffixes are not real TLDs. Our `uen` port reproduces that over-match, which is the
// faithful behaviour — this test exists so it does not get "fixed" into a divergence. If production
// ever narrows its extractor, this test should FAIL and be updated, not defended.
// ==========================================================================================
describe("webFetchAllowedUrls — the dotted-token over-match is reproduced faithfully", () => {
  it("over-matches dotted identifiers as hosts, exactly as production does", () => {
    const pySource = "import os, errno\nos.unlink(p)\nos.rmdir(d)\nerrno.errorcode.get(e)\ne.strerror";
    expect(extractUrls(pySource)).toEqual([
      "https://os.unlink/",
      "https://os.rmdir/",
      "https://errno.errorcode.get/",
      "https://e.strerror/",
    ]);
  });

  it("over-matches filename-shaped tokens too — the class actually observed in the corpus", () => {
    expect(extractUrls("attached offer.docx and 26.xlsx")).toEqual(["https://offer.docx/", "https://26.xlsx/"]);
  });

  it("the common case is still genuine URLs, and a trailing dot is trimmed rather than kept", () => {
    // The 99.65% case. Also pins ZHA-trimming: `example.com.` yields the host, NOT `example.com./`.
    // Deduped because the full-URL and bare-domain regexes both match a full URL — `Ien` concatenates
    // its three passes and dedup happens in the tracker, so the raw extractor legitimately repeats.
    const urls = [...new Set(extractUrls("see https://a.example/x and example.com. done"))];
    expect(urls).toEqual(["https://a.example/x", "https://example.com/"]);
    expect(new ProvenanceTracker().seedFromText("see https://a.example/x and example.com. done")).toBe(2);
  });
});
