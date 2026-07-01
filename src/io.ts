import { writeFileSync, renameSync } from "node:fs";

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
 * Collapse a leading `$HOME` to `~` for DISPLAY only. Human-facing output should never print a
 * user's absolute home path — it leaks the username + filesystem layout into screenshots / pasted logs /
 * bug reports. `~` re-expands when pasted unquoted into a shell; it does NOT re-expand when quoted or fed
 * to a Node path API, so this is for display strings, not for paths handed back to the tool. A path not
 * under `$HOME` (and a missing/odd `$HOME`) is returned unchanged.
 */
export function tildeify(p: string): string {
  const home = process.env.HOME;
  if (!home || home === "/" || !p) return p;
  if (p === home) return "~";
  const prefix = home.endsWith("/") ? home : home + "/";
  return p.startsWith(prefix) ? "~/" + p.slice(prefix.length) : p;
}

/**
 * Parse a positive-number env knob, replacing the `Number(process.env.X) || dflt` idiom whose
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

/**
 * Write JSON atomically — a mid-write crash must never leave a partial/corrupt file at the real path.
 * Write to a same-dir temp (pid-suffixed so two concurrent writers can't collide) then `renameSync` over
 * the target (atomic on POSIX). Mirrors the existing temp+rename idiom already used independently in
 * `src/run/cassette.ts` (`writeFileAtomic`) and `src/decide/external-channel.ts` — this is the first
 * SHARED copy; the two existing call sites are left as-is (see the plan's Non-Goals).
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}
