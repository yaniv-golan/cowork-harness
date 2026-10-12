import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { globSync } from "node:fs";
import { parseWebSearchResult, renderWebSearchResult, splitSearches } from "../src/search-corpus/render.js";

// Synthetic results in the agent's format. The prose is invented.
const REM = "REMINDER: cite the sources above.";
const H = (q: string) => `Web search results for query: "${q}"\n\n`;
const L = (links: object[]) => `Links: ${JSON.stringify(links)}\n\n`;
const one =
  H("widget market size 2026") +
  L([{ title: "A ] title", url: "https://a.example/x" }]) +
  "Widgets are big.\n\nMore prose.\n\n" +
  "\n" +
  REM;
const multi =
  H("q") +
  "Lead text.\n\n" +
  L([{ title: "t1", url: "u1" }]) +
  "After one.\n\n" +
  "No links found.\n\n" +
  L([{ title: "t2", url: "u2" }]) +
  "\n" +
  REM;

describe("parseWebSearchResult / renderWebSearchResult", () => {
  it("round-trips a single search byte-for-byte", () => {
    const p = parseWebSearchResult(one);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.result.query).toBe("widget market size 2026");
    expect(p.result.reminder).toBe(REM);
    expect(p.result.entries).toEqual([
      { kind: "links", links: [{ title: "A ] title", url: "https://a.example/x" }] },
      { kind: "text", text: "Widgets are big.\n\nMore prose." },
    ]);
    expect(renderWebSearchResult(p.result)).toBe(one);
  });

  it("round-trips several link sets, an empty set and leading text", () => {
    const p = parseWebSearchResult(multi);
    expect(p.ok && renderWebSearchResult(p.result)).toBe(multi);
  });

  it("names a text the renderer could not have produced, never guesses", () => {
    expect(parseWebSearchResult("something else")).toEqual({ ok: false, why: "no-header" });
    expect(parseWebSearchResult('Web search results for query: "q')).toEqual({ ok: false, why: "header-unterminated" });
    expect(parseWebSearchResult(H("q") + L([]))).toEqual({ ok: false, why: "no-reminder" });
    expect(parseWebSearchResult(H("q") + "text without terminator\nREMINDER: x")).toEqual({ ok: false, why: "no-entry-terminator" });
  });

  it("treats a Links line with extra keys or bad JSON as text, so the re-render stays exact", () => {
    const odd = H("q") + `Links: [{"title":"t","url":"u","extra":1}]\n\n` + "\n" + REM;
    const p = parseWebSearchResult(odd);
    expect(p.ok && p.result.entries[0]!.kind).toBe("text");
    expect(p.ok && renderWebSearchResult(p.result)).toBe(odd);
  });

  it("splits one search per link set, keeping leading text with the first", () => {
    const p = parseWebSearchResult(multi);
    if (!p.ok) throw new Error(p.why);
    expect(splitSearches(p.result)).toEqual([
      { links: [{ title: "t1", url: "u1" }], text: "Lead text.\n\nAfter one." },
      { links: [], text: "" },
      { links: [{ title: "t2", url: "u2" }], text: "" },
    ]);
  });
  it("a result with no link set is one search with its text", () => {
    const p = parseWebSearchResult(H("q") + "Only prose.\n\n" + "\n" + REM);
    if (!p.ok) throw new Error(p.why);
    expect(splitSearches(p.result)).toEqual([{ links: [], text: "Only prose." }]);
  });
});

// Local only (never CI): every WebSearch tool_result in the operator's kept runs re-renders byte-exactly. Prints
// counts only; no web text.
const RUNS = join(homedir(), ".cowork-harness");
const kept = existsSync(RUNS) ? globSync(join(RUNS, "runs*/**/events.jsonl")) : [];
describe.skipIf(!process.env.COWORK_SEARCH_CORPUS_P2 || kept.length === 0)(
  "round-trip over kept runs (local, COWORK_SEARCH_CORPUS_P2=1)",
  () => {
    it("re-renders every non-error WebSearch tool_result exactly", () => {
      let ok = 0;
      const bad: string[] = [];
      for (const f of kept) {
        const ids = new Set<string>();
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.includes("WebSearch") && !line.includes("tool_result")) continue;
          let o: { message?: { content?: unknown } };
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          const c = o.message?.content;
          if (!Array.isArray(c)) continue;
          for (const b of c as {
            type?: string;
            name?: string;
            id?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }[]) {
            if (b.type === "tool_use" && b.name === "WebSearch" && b.id) ids.add(b.id);
            if (b.type === "tool_result" && b.tool_use_id && ids.has(b.tool_use_id) && !b.is_error && typeof b.content === "string") {
              const p = parseWebSearchResult(b.content);
              if (p.ok && renderWebSearchResult(p.result) === b.content) ok++;
              else bad.push(`${f}:${b.tool_use_id}`);
            }
          }
        }
      }
      expect(bad.length, `${bad.length} mismatches (first: ${bad[0]})`).toBe(0);
      expect(ok).toBeGreaterThan(0);
    });
  },
);
