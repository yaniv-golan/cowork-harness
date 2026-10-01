// Which `_present` companion licenses omitting a grade key from a scored row. Dependency-free: the row
// writer (grade-keys.ts) and the flow checker (schema-check.ts) both apply it, and they must agree.

/** The `_present` companion that licenses omitting `key` from a scored row, or undefined when `key` is
 *  always graded. Explicit, not "`K` exempt when `K_present` is 0": a claim key is covered by its
 *  ASSERTION's companion (`a1_c0` → `a1_present`). Pairwise win keys (H8) map to `a<i>_win_present`. */
export function presentCompanionOf(key: string): string | undefined {
  if (key.endsWith("_present") || /^a\d+$/.test(key)) return undefined;
  const claim = /^(a\d+)_c\d+$/.exec(key);
  if (claim) return `${claim[1]}_present`;
  const win = /^(a\d+)_win(_v[1-9]\d*)?$/.exec(key);
  if (win) return `${win[1]}_win_present`;
  return `${key}_present`;
}
