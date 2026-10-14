// The assertion keys that read a frozen search corpus's record, kept apart from the corpus's runtime so the
// load-time and re-grade refusals can name them without loading the interceptor.

/** They need `--search-corpus`. */
export const SEARCH_CORPUS_ASSERT_KEYS = ["search_corpus_max_miss_rate", "search_corpus_nearby_citations"] as const;

/** The first `search_corpus_*` key an assert block carries, or undefined. */
export function searchCorpusAssertKey(assert: readonly object[] | undefined): string | undefined {
  for (const a of assert ?? []) for (const k of SEARCH_CORPUS_ASSERT_KEYS) if ((a as Record<string, unknown>)[k] !== undefined) return k;
  return undefined;
}
