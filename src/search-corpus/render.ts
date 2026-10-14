/**
 * The agent's WebSearch tool_result text, and its inverse.
 *
 * Read from the agent's own renderer (`mapToolResultToToolResultBlockParam` of the WebSearch tool, 2.1.295): a
 * header line naming the query, then one entry per result followed by a blank line (a text result verbatim, a link
 * set as `Links: <compact JSON>`, or a fixed line for an empty link set), then a newline and a closing reminder,
 * with the whole string trimmed.
 *
 * `parseWebSearchResult(renderWebSearchResult(x))` round-trips, and so does the other direction for every result
 * the agent produced: measured byte-exact over 1554 main-loop and 917 sub-agent tool_results from kept runs. Two
 * consecutive text results are indistinguishable from one text containing a blank line, and both re-render to
 * the same bytes, so the parser joins them. The reminder is kept as read, never hard-coded.
 */

import { createHash } from "node:crypto";

export interface SearchLink {
  title: string;
  url: string;
}

export type SearchEntry = { kind: "text"; text: string } | { kind: "links"; links: SearchLink[] };

export interface ParsedWebSearchResult {
  query: string;
  entries: SearchEntry[];
  /** The closing reminder line, as the agent wrote it. */
  reminder: string;
}

const HEADER = 'Web search results for query: "';
const HEADER_END = '"\n\n';
const LINKS = "Links: ";
const NO_LINKS = "No links found.";
const REMINDER_TAG = "\nREMINDER: ";
const SEP = "\n\n";

export function renderWebSearchResult(r: ParsedWebSearchResult): string {
  let y = `${HEADER}${r.query}${HEADER_END}`;
  for (const e of r.entries) {
    if (e.kind === "text") y += e.text + SEP;
    else if (e.links.length > 0) y += LINKS + JSON.stringify(e.links.map((l) => ({ title: l.title, url: l.url }))) + SEP;
    else y += NO_LINKS + SEP;
  }
  y += "\n" + r.reminder;
  return y.trim();
}

function linksOf(seg: string): SearchLink[] | undefined {
  if (!seg.startsWith(LINKS + "[")) return undefined;
  try {
    const v: unknown = JSON.parse(seg.slice(LINKS.length));
    if (!Array.isArray(v)) return undefined;
    const out: SearchLink[] = [];
    for (const x of v) {
      if (!x || typeof x !== "object") return undefined;
      const o = x as Record<string, unknown>;
      // Exactly {title, url}: anything else would not re-render to the same bytes.
      if (Object.keys(o).join(",") !== "title,url" || typeof o.title !== "string" || typeof o.url !== "string") return undefined;
      out.push({ title: o.title, url: o.url });
    }
    // Only the agent's own rendering (compact JSON, at least one link) is a link entry; anything else stays text, so
    // the re-render is exact.
    return out.length > 0 && seg === LINKS + JSON.stringify(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

export type ParseFailure = "no-header" | "header-unterminated" | "no-reminder" | "no-entry-terminator";

/** Parse a WebSearch tool_result's text. Never throws; a text the agent's renderer could not have produced is a
 *  named failure, never a guess. */
export function parseWebSearchResult(t: string): { ok: true; result: ParsedWebSearchResult } | { ok: false; why: ParseFailure } {
  if (!t.startsWith(HEADER)) return { ok: false, why: "no-header" };
  const h = t.indexOf(HEADER_END, HEADER.length);
  if (h < 0) return { ok: false, why: "header-unterminated" };
  const query = t.slice(HEADER.length, h);
  let body = t.slice(h + HEADER_END.length);
  const r = body.lastIndexOf(REMINDER_TAG);
  if (r < 0) return { ok: false, why: "no-reminder" };
  const reminder = body.slice(r + 1);
  body = body.slice(0, r);
  if (body.endsWith(SEP)) body = body.slice(0, -SEP.length);
  else if (body) return { ok: false, why: "no-entry-terminator" };
  const entries: SearchEntry[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) entries.push({ kind: "text", text: text.join(SEP) });
    text = [];
  };
  for (const seg of body ? body.split(SEP) : []) {
    const links = linksOf(seg);
    if (links) {
      flush();
      entries.push({ kind: "links", links });
    } else if (seg === NO_LINKS) {
      flush();
      entries.push({ kind: "links", links: [] });
    } else text.push(seg);
  }
  flush();
  return { ok: true, result: { query, entries, reminder } };
}

/** One search = one link entry plus the text that follows it, up to the next link entry. Text before the first link
 *  entry is kept with the first search, so no prose is dropped. A result with no link entry yields one search with
 *  no links. */
export function splitSearches(r: ParsedWebSearchResult): { links: SearchLink[]; text: string }[] {
  const out: { links: SearchLink[]; text: string[] }[] = [];
  const lead: string[] = [];
  for (const e of r.entries) {
    if (e.kind === "links") out.push({ links: e.links, text: out.length === 0 ? lead : [] });
    else if (out.length === 0) lead.push(e.text);
    else out[out.length - 1]!.text.push(e.text);
  }
  if (out.length === 0) out.push({ links: [], text: lead });
  return out.map((s) => ({ links: s.links, text: s.text.join(SEP) }));
}

/** The agent's rendering of the harness's error answer (`error_code: "unavailable"`, a miss under
 *  `--search-corpus-miss error` or a refusal), as sha256 + byte length: it is the agent's text, never stored verbatim.
 *  Measured on 2.1.295 and pinned by the local real-agent test. A different rendering only makes such a result
 *  `unfenced` (counted), never another verdict. */
export const SEARCH_ERROR_ANCHOR = {
  sha256: "8a485fdcc27d67c9b82abdfcbb6d62b75aedb7a1c91aff730142548cdf610a8c",
  bytes: 29,
} as const;

/** The kind of answer a WebSearch tool_result shows: a served link set, the no-links answer, the harness's error
 *  answer, or `unfenced` when it cannot be read as one of them. Read only after the header for the tool_use's own
 *  query, so a query that carries the separator or the error text can neither forge nor hide an entry. */
export type ResultShape = "served" | "empty" | "error" | "unfenced";

export function resultShape(content: unknown, query: string): ResultShape {
  const t =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1 && (content[0] as { type?: unknown })?.type === "text"
        ? (content[0] as { text?: unknown }).text
        : undefined;
  if (typeof t !== "string") return "unfenced";
  const head = `${HEADER}${query}${HEADER_END}`;
  if (!t.startsWith(head)) return "unfenced";
  // The rest is the result as the agent renders it for any query: re-parse it under a query-free header.
  const parsed = parseWebSearchResult(`${HEADER}${HEADER_END}${t.slice(head.length)}`);
  if (!parsed.ok) return "unfenced";
  const es = parsed.result.entries;
  if (es.some((e) => e.kind === "links" && e.links.length > 0)) return "served";
  if (es.length !== 1) return "unfenced";
  const e = es[0]!;
  if (e.kind === "links") return "empty";
  const b = Buffer.from(e.text, "utf8");
  return b.length === SEARCH_ERROR_ANCHOR.bytes && createHash("sha256").update(b).digest("hex") === SEARCH_ERROR_ANCHOR.sha256
    ? "error"
    : "unfenced";
}
