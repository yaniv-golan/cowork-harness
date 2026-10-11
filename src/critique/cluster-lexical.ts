// `critique --compare --cluster lexical`: candidate groups of findings that read alike. A JUDGEMENT from word overlap,
// never a match: two findings that say the same thing in different words fall in different groups, and two that share
// a template can fall in one. So a candidate group carries no k/N, an ungrouped finding is not "once", and nothing here
// says "reproduced" or "not seen after".
//
// Similarity: char_wb 3–5-gram TF-IDF over `norm(idea) + " || " + norm(recommendedAction)`, sublinear tf, smoothed IDF
// fitted over the compared items only, rows l2-normalised, cosine. The same numbers as scikit-learn's
// TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True) (test/critique-cluster-lexical.test.ts
// pins them). Groups: complete-linkage agglomeration down to LEXICAL_GROUP_THRESHOLD, so every pair inside a group
// clears it and a group never chains A~B~C through a weak A–C.
//
// A model-judged mode exists in the design but is held: it would need a validated gold set before it may say more than
// "candidate". Until then `--cluster judge` is refused.

/** The validated judge gate. Null: no gold set has been labelled, so no output may say "reproduced". */
export const CLUSTER_GATE: null = null;
/** Whether `--cluster judge` is offered to users. Held: lexical candidate groups only. */
export const USER_FACING_CLUSTER_JUDGE = false;
/** Complete-linkage cut: every pair inside a candidate group has similarity ≥ this. */
export const LEXICAL_GROUP_THRESHOLD = 0.2;
export const LEXICAL_SCHEME = "char_wb-3-5-tfidf/1";
export const LEXICAL_BASIS = "lexical-similarity (a judgement, not a match)";

export type ClusterMode = "none" | "lexical";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** scikit-learn's char_wb analyzer: lowercase, collapse runs of whitespace, then per whitespace-split word padded with
 *  one space each side, every 3-, 4- and 5-gram; a padded word shorter than n contributes itself once and stops. Code
 *  points, as Python indexes strings. */
function charWbNgrams(text: string): string[] {
  const out: string[] = [];
  for (const word of text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")) {
    const w = Array.from(` ${word} `);
    for (let n = 3; n <= 5; n++) {
      let offset = 0;
      out.push(w.slice(offset, offset + n).join(""));
      while (offset + n < w.length) {
        offset++;
        out.push(w.slice(offset, offset + n).join(""));
      }
      if (offset === 0) break;
    }
  }
  return out;
}

/** The pairwise cosine matrix of the items' TF-IDF vectors. A pure function of the item list (IDF is fitted over it). */
export function lexicalSimilarity(items: ReadonlyArray<{ idea?: string; recommendedAction?: string }>): number[][] {
  const counts = items.map((it) => {
    const c = new Map<string, number>();
    for (const g of charWbNgrams(`${norm(it.idea ?? "")} || ${norm(it.recommendedAction ?? "")}`)) c.set(g, (c.get(g) ?? 0) + 1);
    return c;
  });
  const df = new Map<string, number>();
  for (const c of counts) for (const g of c.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  const n = items.length;
  const vecs = counts.map((c) => {
    const v = new Map<string, number>();
    let sq = 0;
    // Sorted keys: the float sums are then the same whatever order the n-grams were met in.
    for (const g of [...c.keys()].sort()) {
      const w = (1 + Math.log(c.get(g)!)) * (Math.log((1 + n) / (1 + df.get(g)!)) + 1);
      v.set(g, w);
      sq += w * w;
    }
    const len = Math.sqrt(sq);
    if (len > 0) for (const [g, w] of v) v.set(g, w / len);
    return v;
  });
  const S = vecs.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    S[i]![i] = vecs[i]!.size ? 1 : 0;
    for (let j = i + 1; j < n; j++) {
      const [a, b] = vecs[i]!.size <= vecs[j]!.size ? [vecs[i]!, vecs[j]!] : [vecs[j]!, vecs[i]!];
      let dot = 0;
      for (const g of [...a.keys()].sort()) {
        const w = b.get(g);
        if (w !== undefined) dot += a.get(g)! * w;
      }
      S[i]![j] = dot;
      S[j]![i] = dot;
    }
  }
  return S;
}

/** Complete-linkage agglomeration: repeatedly merge the two groups whose WEAKEST cross pair is strongest, while that
 *  pair clears `threshold`. Ties go to the pair of groups that comes first in input order. Returns the groups of two or
 *  more, each in input order, listed by their first member; an item left alone is not listed. */
export function candidateGroupsOf(S: number[][], threshold: number = LEXICAL_GROUP_THRESHOLD): number[][] {
  let groups: number[][] = S.map((_, i) => [i]);
  const link = (a: number[], b: number[]): number => {
    let m = Infinity;
    for (const i of a) for (const j of b) m = Math.min(m, S[i]![j]!);
    return m;
  };
  for (;;) {
    let best = -Infinity;
    let at: [number, number] | undefined;
    for (let x = 0; x < groups.length; x++)
      for (let y = x + 1; y < groups.length; y++) {
        const l = link(groups[x]!, groups[y]!);
        if (l >= threshold && l > best) {
          best = l;
          at = [x, y];
        }
      }
    if (!at) break;
    const [x, y] = at;
    const merged = [...groups[x]!, ...groups[y]!].sort((p, q) => p - q);
    groups = groups.filter((_, i) => i !== x && i !== y);
    groups.push(merged);
    groups.sort((p, q) => p[0]! - q[0]!);
  }
  return groups.filter((g) => g.length >= 2);
}
