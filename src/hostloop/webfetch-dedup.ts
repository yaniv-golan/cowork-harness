/**
 * `coworkWebFetchDedup` — a per-Cowork-session NEGATIVE-WORK cache for hostloop `web_fetch` (binary-verified
 * port of Claude Desktop 1.22209.3's `Ne` write/evict + the lookup in `.vite/build/index.chunk-CYQPQGee.js`).
 *
 * It stores only `{ts, size, hits}` (never content). A repeat fetch of the same normalized URL within the
 * TTL is a HIT: real Cowork skips the network entirely and returns a marker telling the model to re-use the
 * earlier result. See the workspace-handler seam for the marker + the no-egress semantics.
 *
 * Faithful details (do NOT "improve"): FIFO (insertion-order) eviction — NOT LRU; a hit does NOT refresh the
 * entry's `ts`/recency (`hits` is incremented but is behaviorally inert), so an entry hard-expires exactly
 * `ttlMs` after the fetch that created it. Hit boundary is INCLUSIVE (`now - ts <= ttlMs`); the write-time
 * TTL sweep is STRICT (`now - ts > ttlMs`). Clock is injected (`nowMs`) — no `Date.now()` here, so tests
 * pin the boundaries deterministically.
 */

export interface WebFetchDedupCache {
  /** Hit iff a non-expired entry exists (`nowMs - ts <= ttlMs`); returns its age in whole seconds
   *  (`Math.round`). An expired entry is deleted and this returns `null` (a miss). */
  lookup(normUrl: string, nowMs: number): { ageS: number } | null;
  /** Record a successful fetch (the caller gates on 2xx + trimmed-nonempty). TTL-sweeps then FIFO-evicts to
   *  `maxEntries` on every write; re-recording an existing key moves it to the tail (delete-then-set). */
  record(normUrl: string, size: number, nowMs: number): void;
  /** `Math.round(ttlMs / 1000)` — for the marker's "deduplicated for up to {ttl}s" text. */
  ttlSeconds(): number;
}

interface Entry {
  ts: number;
  size: number;
  hits: number;
}

export function makeWebFetchDedupCache(opts: { ttlMs: number; maxEntries: number }): WebFetchDedupCache {
  const { ttlMs, maxEntries } = opts;
  const map = new Map<string, Entry>();
  return {
    lookup(normUrl, nowMs) {
      const e = map.get(normUrl);
      if (e === undefined) return null;
      if (nowMs - e.ts <= ttlMs) {
        e.hits += 1; // structural parity only — does NOT refresh recency/ts (hard-expiry stands)
        return { ageS: Math.round((nowMs - e.ts) / 1000) };
      }
      map.delete(normUrl); // expired → delete + miss
      return null;
    },
    record(normUrl, size, nowMs) {
      // 1) TTL sweep (STRICT >), deleting entries older than the window. Deleting during Map iteration is safe.
      for (const [k, v] of map) if (nowMs - v.ts > ttlMs) map.delete(k);
      // 2) delete-then-set moves the key to the tail so recency == insertion/re-insertion order (FIFO).
      map.delete(normUrl);
      map.set(normUrl, { ts: nowMs, size, hits: 0 });
      // 3) FIFO-evict the oldest-inserted entries until at the cap.
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    ttlSeconds() {
      return Math.round(ttlMs / 1000);
    },
  };
}
