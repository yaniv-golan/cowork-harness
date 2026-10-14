// The `--search-corpus*` flag values, checked one way for every command that takes them (`run`/`skill`, `eval`,
// `hillclimb run`): each returns the parsed value or the message to refuse it with.

export const SEARCH_CORPUS_VALUE_FLAGS = ["--search-corpus", "--search-corpus-miss", "--search-corpus-min-score"] as const;

export type SearchCorpusFlagValue = { ok: true; value: string | number } | { ok: false; message: string };

/** One `--search-corpus*` value. `spaced` is true when the value came as the next argv entry (not `--flag=v`). */
export function parseSearchCorpusFlag(name: string, v: string, spaced: boolean): SearchCorpusFlagValue {
  if (name === "--search-corpus") {
    if (spaced && v.startsWith("-")) return { ok: false, message: `--search-corpus: missing value (got flag-looking "${v}")` };
    return { ok: true, value: v };
  }
  if (name === "--search-corpus-miss") {
    if (v !== "empty" && v !== "error") return { ok: false, message: `--search-corpus-miss must be "empty" or "error" (got "${v}")` };
    return { ok: true, value: v };
  }
  const n = Number(v);
  if (!/^\d*\.?\d+$/.test(v) || !(n > 0 && n < 1))
    return { ok: false, message: `--search-corpus-min-score must be a number between 0 and 1, exclusive (got "${v}")` };
  return { ok: true, value: n };
}

/** The flags that only mean something beside `--search-corpus`. */
export function searchCorpusDependentFlagRefusal(has: {
  searchCorpus: boolean;
  miss: boolean;
  minScore: boolean;
  allow?: string[];
}): string | null {
  if (has.searchCorpus) return null;
  if (has.miss || has.minScore) return "--search-corpus-miss and --search-corpus-min-score need --search-corpus <pool>";
  if (has.allow?.length) return `${has.allow.join(" and ")} need${has.allow.length > 1 ? "" : "s"} --search-corpus <pool>`;
  return null;
}
