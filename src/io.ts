import { writeFileSync, renameSync, writeSync } from "node:fs";
import { collectSecrets, scrub } from "./secrets.js";

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
 * Write pre-serialized text atomically — a mid-write crash must never leave a partial/corrupt file at
 * the real path. Write to a same-dir temp (pid-suffixed so two concurrent writers can't collide) then
 * `renameSync` over the target (atomic on POSIX). Mirrors the existing temp+rename idiom already used
 * independently in `src/run/cassette.ts` (`writeFileAtomic`) and `src/decide/external-channel.ts` — this
 * is the first SHARED copy; the two existing call sites are left as-is (out of scope for this change).
 *
 * String-accepting sibling of {@link writeJsonAtomic}: callers that already have a scrubbed/serialized
 * string (e.g. `scrub(JSON.stringify(result, null, 2), secrets)`) shouldn't have to re-serialize an
 * object just to get atomicity.
 */
export function writeTextAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Write JSON atomically — see {@link writeTextAtomic}, which this delegates to. */
export function writeJsonAtomic(path: string, data: unknown): void {
  writeTextAtomic(path, JSON.stringify(data));
}

/**
 * Write a whole string to a raw fd, synchronously, guaranteeing every byte lands — the safe
 * replacement for the bare `writeSync(fd, s + "\n")` idiom scattered across the CLI's stdout/stderr
 * sinks. That idiom's comments claimed "writeSync blocks until drained", which is only true while the
 * fd is in blocking mode; the moment fd 1/2 is a PIPE (any `| something`) rather than a TTY, Node puts
 * it in non-blocking mode, and two things the bare call ignores become real:
 *
 *   1. EAGAIN: a full pipe with a slow reader makes `writeSync` throw `EAGAIN: resource temporarily
 *      unavailable` instead of blocking — e.g. `cowork-harness verify-cassettes … | tail -20` dying
 *      mid-verdict with a stack trace.
 *   2. Short writes: even when it does NOT throw, `writeSync` returns the number of bytes actually
 *      written, which can be less than requested on a pipe. Ignoring the return silently drops the
 *      remainder — not a crash, a corrupted envelope (e.g. truncated JSON).
 *
 * Converts to a `Buffer` FIRST and loops on the byte offset — never re-slices the source *string* by
 * a returned byte count, which would split a multi-byte UTF-8 character mid-sequence and corrupt it.
 * A stall (EAGAIN, or defensively a zero-length write with no error) backs off via `Atomics.wait`
 * (the only synchronous sleep Node has) starting at 1ms and doubling to a 50ms per-attempt cap —
 * short enough to stay responsive, never a busy-loop. The backoff/deadline pair resets on every
 * write that makes real progress, so a slow-but-alive reader is never penalized; a stall with NO
 * progress for 2s straight rethrows (the last EAGAIN, or a synthesized stall error for the zero-length
 * case) rather than hanging the process forever on a truly dead reader.
 *
 * fd 1 and 2 are secret-scrubbed first (see {@link scrubForTerminal}): every stdout printer in the CLI —
 * each command's `out`, the json envelopes, the text renderer and footer on stderr — writes through here,
 * which makes this the one seam where the terminal gets the redaction result.json already gets.
 */
export function writeAllSync(fd: number, s: string): void {
  const buf = Buffer.from(fd === 1 || fd === 2 ? scrubForTerminal(s) : s, "utf8");
  let offset = 0;
  let waitMs = 1;
  const MAX_WAIT_MS = 50;
  const STALL_BUDGET_MS = 2000; // no-progress budget; renewed on every write that advances offset
  let deadline = Date.now() + STALL_BUDGET_MS;
  let lastEagain: unknown;

  while (offset < buf.length) {
    let n = 0;
    try {
      n = writeSync(fd, buf, offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      lastEagain = err;
      n = 0;
    }

    if (n > 0) {
      offset += n;
      waitMs = 1;
      deadline = Date.now() + STALL_BUDGET_MS;
      continue;
    }

    // EAGAIN or a zero-length write: stalled. Retry with bounded backoff, bounded total no-progress time.
    if (Date.now() >= deadline) {
      throw lastEagain ?? new Error(`writeAllSync: stalled at ${offset}/${buf.length} bytes on fd ${fd}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    waitMs = Math.min(waitMs * 2, MAX_WAIT_MS);
  }
}

/**
 * Scrub text bound for the terminal with the same secret set the run's artifacts are scrubbed with.
 *
 * `executeScenario` scrubs the TEXT it writes to result.json but returns the raw in-memory `RunResult`, and
 * every printer formats that object (or re-grades a scenario whose assertion literals may carry a value) —
 * so without this, a value result.json shows as `[REDACTED]` went to stdout/stderr verbatim, which is
 * usually a CI log. Same text-level `scrub` as result.json: `collectSecrets` includes the JSON-escaped form
 * (replaced longest-first) and `[REDACTED]` holds no JSON-structural character, so a json envelope stays
 * parseable for secrets of realistic length. It is TEXT replacement, though: a very short or common value,
 * or one equal to a JSON token (`e`, `1`, `true`), is replaced wherever it appears — help text, JSON syntax
 * and `\u` escapes included — and can make the output unparseable (documented in docs/cli.md).
 *
 * Also called BEFORE a display slice (renderer, trace rows, stderr tail, tool-call messages): a secret
 * straddling the cut leaves a prefix this scrub can no longer match once the text reaches a sink.
 *
 * `collectSecrets()` is read per call, from `process.env`: the set `executeScenario` snapshots is taken from
 * the same env after every `.env`/`--dotenv` source has loaded, so at print time this is the same set (or a
 * superset, never a subset).
 */
export function scrubForTerminal(s: string): string {
  const secrets = collectSecrets();
  return secrets.length ? scrub(s, secrets) : s;
}

const TERMINAL_SCRUB_INSTALLED = Symbol.for("cowork-harness.terminalScrub");

/**
 * Route `process.stdout.write` / `process.stderr.write` through {@link scrubForTerminal} — the second seam,
 * for the printers that don't use `writeAllSync`: `warn()`, `console.*`, and the direct
 * `process.stderr.write` callers (e.g. the LLM decider echoing a question's text, `chat`'s log). Called once
 * at the top of the CLI's `main()` — never at module load, so an in-process test that spies on
 * `process.stderr.write` sees the stream it replaced. Idempotent. A Buffer chunk is re-encoded only when
 * the scrub changed its text, so binary output is otherwise passed through byte-identical. A child process
 * spawned with `stdio: "inherit"` writes the fd directly and is out of this seam's reach.
 */
export function installTerminalScrub(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const tagged = stream as unknown as Record<symbol, boolean>;
    if (tagged[TERMINAL_SCRUB_INSTALLED]) continue;
    const orig = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") {
        const enc = rest[0];
        if (typeof enc !== "string" || enc === "utf8" || enc === "utf-8") chunk = scrubForTerminal(chunk);
      } else if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
        const clean = scrubForTerminal(text);
        if (clean !== text) chunk = Buffer.from(clean, "utf8");
      }
      return orig(chunk, ...rest);
    }) as typeof stream.write;
    tagged[TERMINAL_SCRUB_INSTALLED] = true;
  }
}
