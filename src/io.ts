/**
 * Emit a structured warning to stderr with the GitHub-actions `::warning::` annotation prefix — the one
 * place warning formatting/severity lives, so call sites pass only the message body. Accepts a string
 * that already carries the prefix (written as-is) so migrating existing `::warning:: …` writes is a
 * no-op on content. Uses `process.stderr.write` (the mechanism the warnings always used) so test spies
 * on it still observe warnings and the output is byte-identical.
 */
export function warn(message: string): void {
  const line = message.startsWith("::warning::") ? message : `::warning:: ${message}`;
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
}
