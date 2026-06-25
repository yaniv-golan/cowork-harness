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
