/**
 * web_fetch URL provenance. Faithful port of Cowork's per-session `webFetchAllowedUrls` set
 * + URL extractors (binary-verified, app.asar 1.12603.1):
 *   - normalize:  `zG(A){ new URL(A); http/https only; hash=""; strip one trailing slash; → .href }`
 *   - extract:    `Ien` over gen=/https?:\/\/…/ , len=/www\.…/ , uen=/bare domain.tld/, each ZHA-trimmed
 *   - membership: `set.has(zG(url))` (exact, normalized)
 *
 * WebSearch results are NOT given a dedicated seed path — Desktop's structured extractor over the
 * search-result objects themselves (`Een`) is not ported. Instead, WebSearch tool-call results fall
 * through the same generic `seedFromToolResult` → `extractUrls` text-regex path as every other tool
 * result (see src/run/run.ts, which does invoke this for WebSearch results — WebSearch IS a pinned
 * spawn tool, real-SDK-executed). This is a faithful-but-less-precise subset: URLs embedded in
 * WebSearch's rendered text are still seeded, just via regex-over-text rather than Een's structured
 * per-result extraction.
 */

/** Port of `zG`: parse + http/https-only + drop fragment + strip one trailing slash → normalized href. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

const GEN = /https?:\/\/[^\s<>"'`]+/g; // full URLs
const LEN = /www\.[^\s<>"'`]+/g; // www.-prefixed bare hosts
// bare `domain.tld(/path)?` at a token boundary (conservative port of `uen`)
const UEN = /(?<![\w@.])(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:\/[^\s<>"'`]*)?/g;

const TRAIL = new Set([".", ",", ";", ":", "!", "?", "'", '"', "`"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Port of `ZHA`: strip trailing punctuation; drop an unbalanced trailing closing bracket. */
function trimMatch(m: string): string {
  let e = m.length;
  while (e > 0) {
    const ch = m[e - 1];
    if (TRAIL.has(ch)) {
      e--;
      continue;
    }
    const open = CLOSERS[ch];
    if (open) {
      const seg = m.slice(0, e);
      const closes = seg.split(ch).length - 1;
      const opens = seg.split(open).length - 1;
      if (closes > opens) {
        e--;
        continue;
      }
    }
    break;
  }
  return m.slice(0, e);
}

/** Port of `Ien`: extract+normalize all URL-shaped tokens from free text. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const push = (s: string | null) => {
    if (s) out.push(s);
  };
  for (const m of text.matchAll(GEN)) push(normalizeUrl(trimMatch(m[0])));
  for (const m of text.matchAll(LEN)) push(normalizeUrl(`https://${trimMatch(m[0])}`));
  for (const m of text.matchAll(UEN)) push(normalizeUrl(`https://${trimMatch(m[0])}`));
  return out;
}

/** Per-session provenance set (mirrors Cowork's `session.webFetchAllowedUrls`). */
export class ProvenanceTracker {
  private seen = new Set<string>();

  /** Membership on the normalized URL (the `set.has(zG(url))` check). */
  has(url: string): boolean {
    const n = normalizeUrl(url);
    return n !== null && this.seen.has(n);
  }

  /** Add the normalized URL (after approval, or when seeded). */
  add(url: string): void {
    const n = normalizeUrl(url);
    if (n) this.seen.add(n);
  }

  /** Seed from user-turn / tool-result text; returns how many NEW URLs were added. */
  seedFromText(text: string): number {
    let added = 0;
    for (const u of extractUrls(text)) {
      if (!this.seen.has(u)) {
        this.seen.add(u);
        added++;
      }
    }
    return added;
  }

  /** Tool results are seeded the same way (the harness has no structured WebSearch results). */
  seedFromToolResult(text: string): number {
    return this.seedFromText(text);
  }

  /** Serialize for session persistence (mirrors Cowork's save/load), if ever needed. */
  snapshot(): string[] {
    return [...this.seen];
  }

  static restore(urls: string[]): ProvenanceTracker {
    const t = new ProvenanceTracker();
    for (const u of urls) t.add(u);
    return t;
  }
}
