import { spawn } from "node:child_process";
import { warn } from "../io.js";
import type { Complete, CompleteResult } from "./decider.js";

/** A spawn rejection the retry wrapper may re-attempt: a TRANSIENT non-zero exit. Timeout / maxBytes /
 *  spawn-ENOENT failures leave this false so they fail loud on the first attempt (see claudeCliComplete). */
class TransportExit extends Error {
  retryable = true;
}

/** Tail of a captured stream for an error message — keep the END (where the diagnosis is), bounded. */
function tail(s: string, n = 500): string {
  const t = s.trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

/** Strict parse of one `claude -p --output-format json` envelope: requires a string `result` AND exactly
 *  one `modelUsage` key. Throws on either violation — a malformed/ambiguous envelope on a CLEAN exit is a
 *  genuine transport-contract break worth failing loud on, never masked or guessed past. `result` is the
 *  model's raw reply text (identical content to what `-p` without `--output-format` prints); the single
 *  `modelUsage` key is the CONCRETE model the (possibly aliased, e.g. "sonnet") `--model` request actually
 *  resolved to — this is what callers record for provenance, never the alias they requested. */
function parseEnvelope(raw: string): CompleteResult {
  const parsed = JSON.parse(raw) as { result?: string; modelUsage?: Record<string, unknown> };
  if (typeof parsed.result !== "string") throw new Error(`envelope missing "result": ${tail(raw)}`);
  const models = Object.keys(parsed.modelUsage ?? {});
  if (models.length !== 1) throw new Error(`envelope's modelUsage has ${models.length} keys (expected exactly 1): ${tail(raw)}`);
  return { text: parsed.result, model: models[0]! };
}

/** Lenient, best-effort extraction of JUST the `result` field for a FAILURE diagnosis message — unlike
 *  `parseEnvelope`, this does not require `modelUsage` to resolve (an operational failure legitimately
 *  reports zero resolved models), so it never throws; returns null if `result` isn't a string or the JSON
 *  itself doesn't parse. */
function tryExtractResultText(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { result?: string };
    return typeof parsed.result === "string" ? parsed.result : null;
  } catch {
    return null;
  }
}

/**
 * One `claude -p --output-format json` spawn. Resolves `{text, model}` on a clean exit; rejects loud
 * otherwise. stdout AND stderr are captured: a `claude -p` operational failure (bad model, auth,
 * rate-limit) prints its human-readable diagnosis to STDOUT and exits 1 (verified) — stderr is usually
 * empty — so a non-zero exit MUST surface the captured output or the failure is undiagnosable ("exited 1"
 * with no WHY). The CLI still emits a well-formed JSON envelope on an operational failure (`is_error:true`,
 * verified), so the diagnosis prefers its `result` field and only falls back to the raw tail if the
 * envelope itself doesn't parse (e.g. a failure that never reached the CLI's own JSON emitter).
 */
function spawnOnce(bin: string, prompt: string, model: string, timeoutMs: number, maxBytes: number): Promise<CompleteResult> {
  return new Promise<CompleteResult>((resolve, reject) => {
    // bound the `claude -p` spawn — a hung-but-alive child would otherwise block the harness forever.
    // On expiry SIGKILL the child and reject LOUD; clear the timer on close/error so a fast call never leaks it.
    // stderr is PIPED (not "ignore") so the close handler can fold it into the diagnosis.
    const child = spawn(bin, ["-p", prompt, "--model", model, "--output-format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // NOT a TransportExit → not retried: a child that ate the whole timeout budget is not a quick transient.
      reject(
        new Error(
          `LLM decider transport (${bin} -p) timed out after ${timeoutMs}ms — raise COWORK_HARNESS_LLM_TIMEOUT_MS to allow a longer gate`,
        ),
      );
    }, timeoutMs);
    // Bound stdout too — the wall-clock timeout above caps a fully-hung child, but not one that is
    // actively spewing. Past the cap, SIGKILL and reject loud rather than growing the buffer unbounded.
    // collect raw Buffer chunks and decode ONCE at close. The old `out += d` coerced each chunk to
    // a string independently, so a UTF-8 sequence straddling a chunk boundary (em-dash, accent, emoji)
    // decoded as U+FFFD in both halves — corrupting the verification-critical decider answer. Byte-identical
    // for ASCII/single-chunk. The byte cap still sums `d.length` (raw bytes), unaffected by decoding.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        clearTimeout(timer);
        // NOT a TransportExit → not retried: a spewing child would just spew again.
        reject(
          new Error(
            `LLM decider transport (${bin} -p) exceeded ${maxBytes} bytes — aborting; raise COWORK_HARNESS_LLM_MAX_BYTES if this output is legitimately large`,
          ),
        );
        return;
      }
      chunks.push(d);
    });
    // Capture stderr, bounded (claude's stderr is small; cap so a pathological spew can't grow unbounded).
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 64 * 1024) err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      // NOT a TransportExit → not retried: a spawn failure (e.g. ENOENT — `claude` not on PATH) is deterministic.
      reject(
        new Error(
          `LLM decider transport (${bin} -p) failed to spawn: ${e.message} — ensure 'claude' is installed and on PATH, or set COWORK_HARNESS_CLAUDE_BIN to its path`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Decode once at close — see chunks comment above.
      const raw = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        try {
          resolve(parseEnvelope(raw));
        } catch (e) {
          // NOT a TransportExit → not retried: a malformed/ambiguous envelope on a CLEAN exit is a
          // deterministic contract break (the CLI / its --output-format shape), not a transient hiccup.
          reject(new Error(`LLM decider transport (${bin} -p --output-format json) returned an unparseable envelope: ${(e as Error).message}`));
        }
        return;
      }
      // Non-zero exit: fold the captured output into the message (the diagnosis lives in stdout, not stderr —
      // verified) and mark RETRYABLE so a transient hiccup gets a bounded re-attempt before failing loud.
      const o = tail(tryExtractResultText(raw) ?? raw);
      const e = tail(err);
      const diag = [o && `stdout: ${o}`, e && `stderr: ${e}`].filter(Boolean).join(" | ");
      reject(new TransportExit(`LLM decider transport (${bin} -p) exited ${code}${diag ? ` — ${diag}` : " (no output captured)"}`));
    });
  });
}

/**
 * The default `LlmDecider` transport: shell out to the host `claude -p` (one-shot, headless). Chosen
 * over a direct `POST /v1/messages`: the harness PROCESS is not behind the egress proxy
 * (only the spawned agent child is), so a direct API call would bypass the very allowlist the harness
 * enforces. `claude -p` reuses the run's own auth path and is dogfood-consistent. Requests
 * `--output-format json` so the resolved model (`modelUsage`) can be recorded for provenance
 * even when `model` is a floating alias like `"sonnet"`. One short, tool-less
 * call per gate (one call, no recursion into the harness; model is the decider default or --decider-model).
 *
 * Non-zero-exit retry: a single `claude -p` spawn can exit non-zero on a TRANSIENT upstream hiccup
 * (rate-limit/overload/network) during a long back-to-back batch — observed live, not reproducible on demand.
 * Bounded-retry the non-zero-exit class (small linear backoff) so a transient exit doesn't kill a 10-minute
 * paid run at the final gate. NOTE: exit-code is NOT a clean transient/permanent discriminator — a
 * DETERMINISTIC failure (bad `--decider-model`, auth) also exits non-zero and so is retried the full count
 * before failing loud; the cost is bounded (each bad spawn exits fast, before any model call) and the
 * captured stdout names the cause, so we accept it rather than brittle stdout pattern-matching.
 *
 * Retry never double-answers: this transport has NO harness side effects (it returns a string; the gate is
 * answered exactly once, downstream of a SUCCESSFUL call — a non-zero exit delivers no string), and `claude
 * -p` runs headless with no tool approval, so the model call itself is read-only in practice. Only the
 * non-zero-exit class retries; timeout / maxBytes-overflow / spawn-ENOENT are not transient and fail loud on
 * the first attempt. Set `COWORK_HARNESS_LLM_RETRIES=0` to disable (e.g. deterministic CI).
 */
export const claudeCliComplete: Complete = async (prompt, model) => {
  const bin = process.env.COWORK_HARNESS_CLAUDE_BIN || "claude";
  const timeoutMs = Number(process.env.COWORK_HARNESS_LLM_TIMEOUT_MS) || 600_000;
  const maxBytes = Number(process.env.COWORK_HARNESS_LLM_MAX_BYTES) || 8 * 1024 * 1024;
  // Parse the retry count defensively: unset/blank/unparseable → the default 2 (NOT 0 — a typo must not
  // silently disable retries); a valid number is floored and clamped to [0, 10] (so "2.9"→2, "-1"→0, "0"
  // disables, and a fat-fingered "1e2"/"100" can't spin up a multi-minute backoff against a hard failure).
  const retriesRaw = process.env.COWORK_HARNESS_LLM_RETRIES;
  let retries = 2;
  if (retriesRaw !== undefined && retriesRaw.trim() !== "") {
    const n = Number(retriesRaw);
    retries = Number.isFinite(n) ? Math.min(10, Math.max(0, Math.floor(n))) : 2;
  }
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await spawnOnce(bin, prompt, model, timeoutMs, maxBytes);
    } catch (e) {
      const err = e as Error & { retryable?: boolean };
      lastErr = err;
      if (!err.retryable || attempt === retries) throw err;
      warn(`${err.message} — retrying (attempt ${attempt + 2}/${retries + 1})`);
      // Small linear backoff (250ms, 500ms, …) — enough to ride a brief rate-limit/overload window.
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr; // unreachable (the loop returns or throws on the last attempt), but satisfies the type checker.
};
