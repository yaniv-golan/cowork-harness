import { describe, it, expect } from "vitest";
import { makeWebFetchDedupCache } from "../src/hostloop/webfetch-dedup.js";
import {
  makeWorkspaceHandler,
  type McpHandler,
  type RawFetch,
  type Resolver,
  type EgressEntry,
  type WebFetchProvenance,
} from "../src/hostloop/workspace-handler.js";

describe("makeWebFetchDedupCache — coworkWebFetchDedup port", () => {
  it("hit within TTL (inclusive boundary); miss just past it, deleting the entry", () => {
    const c = makeWebFetchDedupCache({ ttlMs: 1000, maxEntries: 100 });
    c.record("a", 10, 0);
    expect(c.lookup("a", 1000)).toEqual({ ageS: 1 }); // now - ts == ttlMs is a HIT (inclusive)
    // still hit at the boundary; the just-past lookup expires + deletes it
    expect(c.lookup("a", 1001)).toBeNull(); // strict miss
    expect(c.lookup("a", 500)).toBeNull(); // gone — the miss above deleted it
  });

  it("ageS uses Math.round (not floor)", () => {
    const c = makeWebFetchDedupCache({ ttlMs: 100000, maxEntries: 100 });
    c.record("x", 10, 0);
    expect(c.lookup("x", 1400)).toEqual({ ageS: 1 }); // round(1.4) = 1
    expect(c.lookup("x", 1500)).toEqual({ ageS: 2 }); // round(1.5) = 2
    expect(c.lookup("x", 1600)).toEqual({ ageS: 2 }); // round(1.6) = 2
  });

  it("a hit does NOT refresh recency — the entry hard-expires at creation + TTL", () => {
    const c = makeWebFetchDedupCache({ ttlMs: 1000, maxEntries: 100 });
    c.record("b", 10, 0);
    expect(c.lookup("b", 500)).toEqual({ ageS: 1 }); // round(0.5)=1; a mid-window hit
    expect(c.lookup("b", 1000)).toEqual({ ageS: 1 }); // still within window
    expect(c.lookup("b", 1001)).toBeNull(); // expired at 0+1000 despite the earlier hits (no refresh)
  });

  it("FIFO (insertion-order) eviction at maxEntries — NOT LRU", () => {
    const c = makeWebFetchDedupCache({ ttlMs: 100000, maxEntries: 3 });
    c.record("a", 1, 0);
    c.record("b", 1, 0);
    c.record("c", 1, 0);
    c.record("d", 1, 0); // size 4 > 3 → evict the oldest-inserted ("a")
    expect(c.lookup("a", 0)).toBeNull(); // evicted (LRU would have kept it — it was just written)
    expect(c.lookup("b", 0)).toEqual({ ageS: 0 });
    expect(c.lookup("d", 0)).toEqual({ ageS: 0 });
  });

  it("re-recording an existing key moves it to the tail (delete-then-set)", () => {
    const c = makeWebFetchDedupCache({ ttlMs: 100000, maxEntries: 3 });
    c.record("a", 1, 0);
    c.record("b", 1, 0);
    c.record("c", 1, 0);
    c.record("a", 1, 0); // re-record → order is now b, c, a
    c.record("d", 1, 0); // evict oldest → "b"
    expect(c.lookup("b", 0)).toBeNull();
    expect(c.lookup("a", 0)).toEqual({ ageS: 0 }); // survived (moved to tail)
  });

  it("the TTL sweep on write drops expired entries before eviction", () => {
    const c = makeWebFetchDedupCache({ ttlMs: 1000, maxEntries: 100 });
    c.record("old", 1, 0);
    c.record("new", 1, 2000); // this write sweeps "old" (2000 - 0 > 1000)
    expect(c.lookup("old", 2000)).toBeNull();
    expect(c.lookup("new", 2000)).toEqual({ ageS: 0 });
  });

  it("ttlSeconds() = Math.round(ttlMs/1000)", () => {
    expect(makeWebFetchDedupCache({ ttlMs: 900000, maxEntries: 100 }).ttlSeconds()).toBe(900);
    expect(makeWebFetchDedupCache({ ttlMs: 1500, maxEntries: 100 }).ttlSeconds()).toBe(2); // round(1.5)
  });
});

// ── Integration: dedup wired through makeWorkspaceHandler → fetchViaHost (PATH A) ──────────────
const allowAllProv: WebFetchProvenance = { isAllowed: () => true, markAllowed: () => {}, promptGateOn: false };
const publicResolve: Resolver = async () => [{ address: "203.0.113.7" }];

function callWebFetch(h: McpHandler, url: string) {
  return h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url } } }) as Promise<{
    result: { isError?: boolean; content: { text: string }[] };
  }>;
}

/** PATH A handler (provenance engaged) with an injectable dedup cache + a call-counting rawFetch. */
function pathAHandler(opts: { dedup?: ReturnType<typeof makeWebFetchDedupCache>; rawFetch: RawFetch }) {
  const egress: EgressEntry[] = [];
  const h = makeWorkspaceHandler({
    containerName: "c",
    vmMnt: "/mnt",
    runner: "docker",
    webFetchAllow: ["*"],
    onEgress: (e) => egress.push(e),
    rawFetch: opts.rawFetch,
    resolve: publicResolve,
    provenanceRef: { current: allowAllProv },
    dedup: opts.dedup,
  });
  return { h, egress };
}

describe("coworkWebFetchDedup wired into fetchViaHost (PATH A)", () => {
  it("2nd fetch of the same URL within TTL → marker, NO network, NO egress event", async () => {
    let fetches = 0;
    const rawFetch: RawFetch = async () => {
      fetches++;
      return { status: 200, text: async () => "THE PAGE BODY" };
    };
    const { h, egress } = pathAHandler({ dedup: makeWebFetchDedupCache({ ttlMs: 900000, maxEntries: 100 }), rawFetch });

    const first = await callWebFetch(h, "http://example.com/x");
    expect(first.result.content[0].text).toBe("THE PAGE BODY");
    expect(fetches).toBe(1);
    expect(egress.filter((e) => e.decision === "allow").length).toBe(1);

    const second = await callWebFetch(h, "http://example.com/x");
    expect(second.result.isError).toBeFalsy();
    // Full VERBATIM marker (age is the only volatile token) — pins the fidelity-critical string end to end.
    expect(second.result.content[0].text).toMatch(
      /^Already fetched http:\/\/example\.com\/x \d+s ago in this session\. Re-use the content from that earlier web_fetch result instead of re-reading it\. Fetch again only if the page is likely to have changed \(deduplicated for up to 900s\)\.$/,
    );
    expect(fetches).toBe(1); // no second network call
    expect(egress.length).toBe(1); // no new egress event on a hit
  });

  it("a dedup HIT never bypasses the provenance gate — a denied URL is denied even when cached (security order)", async () => {
    // Seed the cache as if the URL were fetched earlier, then deny it. The provenance gate must win: the
    // response is the provenance denial, NOT the dedup marker, and no network happens. Pins that the lookup
    // stays AFTER the gate (a refactor inverting the order would otherwise pass every other test).
    const cache = makeWebFetchDedupCache({ ttlMs: 900000, maxEntries: 100 });
    cache.record("http://example.com/x", 10, Date.now());
    let fetches = 0;
    const rawFetch: RawFetch = async () => {
      fetches++;
      return { status: 200, text: async () => "BODY" };
    };
    const denyingProv: WebFetchProvenance = { isAllowed: () => false, markAllowed: () => {}, promptGateOn: false };
    const h = makeWorkspaceHandler({
      containerName: "c",
      vmMnt: "/mnt",
      runner: "docker",
      webFetchAllow: ["*"],
      rawFetch,
      resolve: publicResolve,
      provenanceRef: { current: denyingProv },
      dedup: cache,
    });
    const out = await callWebFetch(h, "http://example.com/x");
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/not in provenance set/);
    expect(out.result.content[0].text).not.toMatch(/Already fetched/); // the cache did NOT short-circuit the gate
    expect(fetches).toBe(0);
  });

  it("keys under the terminal destination_url — a direct fetch of the redirect target is a hit", async () => {
    let bFetches = 0;
    const rawFetch: RawFetch = async (url) => {
      if (url.startsWith("http://a.example")) return { status: 302, location: "http://b.example/y", text: async () => "" };
      bFetches++;
      return { status: 200, text: async () => "B BODY" };
    };
    const { h } = pathAHandler({ dedup: makeWebFetchDedupCache({ ttlMs: 900000, maxEntries: 100 }), rawFetch });
    await callWebFetch(h, "http://a.example/x"); // A → redirects → B, records both keys
    const direct = await callWebFetch(h, "http://b.example/y"); // hits under the destination_url key
    expect(direct.result.content[0].text).toMatch(/^Already fetched http:\/\/b\.example\/y/);
    expect(bFetches).toBe(1); // B was fetched once (during the redirect), the direct call is a dedup hit
  });

  it("non-2xx and empty responses are NEVER cached (a retry re-hits the network)", async () => {
    for (const resp of [
      { status: 404, text: async () => "not found" },
      { status: 200, text: async () => "   " }, // whitespace-only → trimmed empty
    ]) {
      let fetches = 0;
      const rawFetch: RawFetch = async () => {
        fetches++;
        return resp;
      };
      const { h } = pathAHandler({ dedup: makeWebFetchDedupCache({ ttlMs: 900000, maxEntries: 100 }), rawFetch });
      await callWebFetch(h, "http://example.com/x");
      await callWebFetch(h, "http://example.com/x");
      expect(fetches).toBe(2); // not cached → both calls hit the network
    }
  });

  it("no dedup cache (gate off / older baseline) → every repeat fetch hits the network", async () => {
    let fetches = 0;
    const rawFetch: RawFetch = async () => {
      fetches++;
      return { status: 200, text: async () => "BODY" };
    };
    const { h } = pathAHandler({ dedup: undefined, rawFetch });
    await callWebFetch(h, "http://example.com/x");
    await callWebFetch(h, "http://example.com/x");
    expect(fetches).toBe(2);
  });
});

// ── Baseline-gating: readGateFlag/readGateNumber over the real synced baselines ────────────────
import { readFileSync } from "node:fs";
import { readGateFlag, readGateNumber } from "../src/loop-decision.js";
import type { PlatformBaseline } from "../src/types.js";

const loadBaseline = (v: string) => JSON.parse(readFileSync(`baselines/desktop-${v}.json`, "utf8")) as PlatformBaseline;
const GID = "1978029737";

describe("coworkWebFetchDedup baseline-gating", () => {
  it("1.22209.3 carries the gate: flag on, TtlMs=900000, MaxEntries=100", () => {
    const b = loadBaseline("1.22209.3");
    expect(readGateFlag(b, GID, "coworkWebFetchDedup")).toBe(true);
    expect(readGateNumber(b, GID, "coworkWebFetchDedupTtlMs")).toBe(900000);
    expect(readGateNumber(b, GID, "coworkWebFetchDedupMaxEntries")).toBe(100);
  });

  it("1.21459.0 (older) lacks the gate: flag off, numbers undefined → dedup stays off", () => {
    const b = loadBaseline("1.21459.0");
    expect(readGateFlag(b, GID, "coworkWebFetchDedup")).toBe(false);
    expect(readGateNumber(b, GID, "coworkWebFetchDedupTtlMs")).toBeUndefined();
    // the callers gate on `viaApiOn && readGateFlag(...)`, so an off flag ⇒ no cache ⇒ no behavior change
  });
});
