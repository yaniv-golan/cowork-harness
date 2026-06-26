/**
 * Emit a structured warning to stderr with the GitHub-actions `::warning::` annotation prefix — the one
 * place warning formatting/severity lives, so call sites pass only the message body. A message that ALREADY
 * carries a GitHub annotation prefix (`::warning::`, `::notice::`, or `::error::`) is written as-is, so a
 * call site that wants a softer/harder severity (e.g. `::notice:: …`) gets exactly that — NOT a doubled
 * `::warning:: ::notice:: …`. Uses `process.stderr.write` (the mechanism the warnings always used) so test
 * spies on it still observe warnings and the output is byte-identical for plain `::warning::` content.
 */
export function warn(message: string): void {
  const line = /^::(warning|notice|error)::/.test(message) ? message : `::warning:: ${message}`;
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
}

/**
 * Parse a positive-number env knob (#63), replacing the `Number(process.env.X) || dflt` idiom whose
 * falsy-coalescing silently reverted "0" / NaN to the default while a NEGATIVE slipped through truthy
 * (a past deadline → loop never runs, or setTimeout clamped to ~1ms → instant SIGKILL). Falls back to
 * `dflt` when the var is unset/blank/zero/negative/non-finite, and warns LOUD when it is SET but unusable
 * so a fat-fingered knob self-diagnoses instead of silently reverting.
 *
 * Decision: `Number.isFinite` rejects "Infinity" too. The prior `Number("Infinity")` value on
 * COWORK_HARNESS_LLM_MAX_BYTES disabled the byte cap (bytes > Infinity === false → unbounded); that
 * escape hatch is undocumented and intentionally dropped here (consistent, fail-loud handling for all
 * six knobs). The three timeout knobs never had a working "Infinity" path anyway (setTimeout(Infinity)
 * is clamped to ~1ms). Aside: COWORK_HARNESS_DIALOG_TIMEOUT_MS still accepts "inf"/"-1" via its own
 * parseDialogTimeout — that asymmetry is left as-is by design, noted so it isn't mistaken for a bug.
 */
export function envPositiveNumber(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  warn(`${name}=${JSON.stringify(raw)} is not a positive number — using default ${dflt}`);
  return dflt;
}
