/** Escape every RegExp metacharacter in `s` (backslash included), so it matches itself literally inside a pattern. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
