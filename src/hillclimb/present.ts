// Which `_present` companion licenses omitting a grade key from a scored row. Dependency-free: the row
// writer (grade-keys.ts) and the flow checker (schema-check.ts) both apply it, and they must agree.

/** The `_present` companion that licenses omitting `key` from a scored row, or undefined when `key` is
 *  always graded. Explicit, not "`K` exempt when `K_present` is 0": a claim key is covered by its
 *  ASSERTION's companion (`a1_c0` → `a1_present`). `both_bad` is covered by `win_present`. */
export function presentCompanionOf(key: string): string | undefined {
  if (key.endsWith("_present")) return undefined;
  // a<i>: only a single-key semantic_pairwise assert is ever omitted (a refusal); its companion is a<i>_present.
  if (/^a\d+$/.test(key)) return `${key}_present`;
  const claim = /^(a\d+)_c\d+$/.exec(key);
  if (claim) return `${claim[1]}_present`;
  // A per-assert win column has its own companion per reference: a later variant's reference can be missing while
  // the baseline was compared.
  if (/^a\d+_win(_v[1-9]\d*)?$/.test(key)) return `${key}_present`;
  // `both_bad` is measured exactly when `win` is.
  if (key === "both_bad") return "win_present";
  return `${key}_present`;
}
