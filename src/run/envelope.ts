import { readFileSync, writeSync } from "node:fs";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";

// Synchronous fd writes (match cli.ts / doctor.ts). writeSync flushes before process.exit on a pipe.
const out = (s: string) => writeSync(1, s + "\n");
const log = (s: string) => writeSync(2, s + "\n");

/** Package version (for the json envelope + `--version`). Resolved package-relative. */
export function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type ErrCategory = "usage" | "unanswered" | "boundary" | "runtime" | "internal";

/** Validate `--output-format <v>` is text|json (shared by every command). Returns the resolved format;
 *  THROWS on an invalid value so the caller renders a usage error instead of silently treating an
 *  unrecognized value (e.g. `--output-format xml`) as text. */
export function parseOutputFormat(args: string[]): "text" | "json" {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-format") {
      const v = args[i + 1];
      if (v !== "text" && v !== "json")
        throw new Error(`--output-format must be "text" or "json" (got ${v === undefined ? "nothing" : `"${v}"`})`);
      return v;
    }
    // Equals form: validate the value rather than silently degrading any `--output-format=<x>` to text.
    if (args[i].startsWith("--output-format=")) {
      const v = args[i].slice("--output-format=".length);
      if (v !== "text" && v !== "json") throw new Error(`--output-format must be "text" or "json" (got "${v}")`);
      return v;
    }
  }
  return "text";
}

/** §5a — the standardized machine envelope object (internal: `jsonEnvelope` stringifies it). `ok` is the
 *  same SEAM-B verdict as the process exit code / footer (it cannot diverge). `replay` uses the replay
 *  lane (a cassette can't reproduce the scan/permissive signals); every other command is the live lane.
 *
 *  Each emitted result carries its own `verdict` ({pass, exitCode, signals[], guards[]}) — a NON-MUTATING
 *  projection (computeVerdict is pure; RunResult the type stays clean). This lets a consumer read per-result
 *  pass/fail AND why (the `signals[]` — e.g. an all-green-assertions run that is `pass:false` purely on a
 *  `stalled` signal) without recomputing from the sibling booleans. The top-level `ok` is derived from the
 *  SAME per-result verdicts, so it cannot diverge from them (or from the exit code / footer — all route
 *  computeVerdict). NOTE: this publishes the VerdictSignal.code taxonomy as a de-facto wire contract. */
function jsonEnvelopeObj(command: string, results: RunResult[]): Record<string, unknown> {
  const lane = command === "replay" ? "replay" : "live";
  const withVerdict = results.map((r) => ({ ...r, verdict: computeVerdict(r, lane) }));
  const ok = withVerdict.length > 0 && withVerdict.every((r) => r.verdict.pass);
  return { tool: "cowork-harness", version: pkgVersion(), command, ok, results: withVerdict, error: null };
}

/** §5a — the standardized machine envelope emitted by every `--output-format json` command. COMPACT
 *  single-line JSON (machine output → trivially parseable; the pretty form lives in result.json). */
export function jsonEnvelope(command: string, results: RunResult[]): string {
  return JSON.stringify(jsonEnvelopeObj(command, results));
}

/** §5c — the error envelope (compact, single line). */
export function jsonError(command: string, category: ErrCategory, message: string, hint?: string): string {
  return JSON.stringify({
    tool: "cowork-harness",
    version: pkgVersion(),
    command,
    ok: false,
    results: [],
    error: { category, message, ...(hint ? { hint } : {}) },
  });
}

/** Shared json-output predicate so the parser and the top-level catch can never drift. An explicit
 *  `--output-format text|json` flag (first occurrence wins, matching parseOutputFormat's
 *  first-occurrence-authoritative semantics) takes precedence; absent any flag, fall back to the
 *  documented COWORK_HARNESS_OUTPUT_FORMAT env var so an env-only JSON consumer still gets an envelope
 *  from the top-level catch. */
export function isJsonOutput(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-format" && args[i + 1] === "json") return true;
    if (args[i] === "--output-format=json") return true;
    if (args[i] === "--output-format" && args[i + 1] === "text") return false;
    if (args[i] === "--output-format=text") return false;
  }
  return process.env.COWORK_HARNESS_OUTPUT_FORMAT === "json";
}

/** The single error exit used by every command + the top-level catch, in both `cli.ts` and `doctor.ts`.
 *  boundary → exit 3, every other category → exit 2, UNLESS `exitCode` overrides it — SPEC.md's exit-code
 *  contract names two exceptions that exit `1` instead of the general `2`: `sync` hard-failures (missing
 *  baseline version fields, a refused empty allowlist, unknown deltas) and a `status`/`verify-run` runtime
 *  failure reading a prior run's output (SPEC.md:428-436). Every EXISTING call site omits `exitCode` and
 *  keeps its current behavior exactly. */
export function fail(
  command: string,
  category: ErrCategory,
  message: string,
  hint: string | undefined,
  json: boolean,
  exitCode?: 1 | 2 | 3,
): never {
  if (json) out(jsonError(command, category, message, hint));
  else {
    log(message);
    if (hint) log(hint);
  }
  process.exit(exitCode ?? (category === "boundary" ? 3 : 2));
}
