// The frozen-corpus label, apart from the corpus's runtime so a report renderer can print it without loading the
// interceptor.

/** The label every verdict surface prints for a run served from a pool. */
export function searchCorpusLabel(poolId: string, sha256: string): string {
  return `frozen search corpus ${poolId}@${sha256.slice(0, 8)} — recorded results, harness ranking, searches not billed; not live search; for steps around research, not a research-quality signal`;
}
