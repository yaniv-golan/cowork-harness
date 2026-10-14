/**
 * The URLs a deliverable cites, for `search_corpus_nearby_citations`. Built on the agent's own URL patterns (the port in
 * `hostloop/provenance.ts`, which this never changes), plus the markdown forms a model writes citations in:
 *  - a self-titled link `[url](url)` is split at `](`;
 *  - emphasis (`**`, `*`, `_`) and sentence punctuation after a URL are stripped, alternately, until neither is left;
 *  - a `www.` or bare-host match inside a full URL already read is skipped, so a scheme is never read as a host.
 * Not normalized: the caller keys them with the URL identity that keys served links.
 */

import { GEN, LEN, UEN, trimMatch } from "../hostloop/provenance.js";

/** Strip trailing emphasis and punctuation until neither is left (`**url**.` → `url`). */
function trimCitation(t: string): string {
  for (;;) {
    const next = trimMatch(t.replace(/[*_]+$/, ""));
    if (next === t) return t;
    t = next;
  }
}

export function citationUrls(text: string): string[] {
  const out: string[] = [];
  const spans: [number, number][] = [];
  for (const m of text.matchAll(GEN)) {
    spans.push([m.index!, m.index! + m[0].length]);
    for (const part of m[0].split("](")) {
      const t = trimCitation(part);
      if (t) out.push(t);
    }
  }
  const inFull = (at: number) => spans.some(([a, b]) => at >= a && at < b);
  for (const re of [LEN, UEN])
    for (const m of text.matchAll(re)) {
      if (inFull(m.index!)) continue;
      const t = trimCitation(m[0]);
      if (t) out.push(`https://${t}`);
    }
  return out;
}
