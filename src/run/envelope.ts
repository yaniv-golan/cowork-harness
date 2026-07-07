import { readFileSync, writeSync } from "node:fs";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import { rollupPasses, type RepeatRollup } from "./repeat.js";
import type { MatrixRollup, MatrixRepeatRollup } from "./matrix.js";

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

export interface JsonEnvelopeOpts {
  /** `--repeat` additions. */
  rollups?: RepeatRollup[];
  minPassRate?: number;
  /** `--allow-budget-stop`: opt out of the default-fail for a budget-stopped repeat batch. */
  allowBudgetStop?: boolean;
  /** `--matrix` addition. */
  matrix?: MatrixRollup;
  /** `--matrix` + `--repeat` composed: each cell is its own repeat batch. */
  matrixRepeat?: MatrixRepeatRollup;
  /** Command-specific metadata merged into the envelope alongside `results` (e.g. `record`'s
   *  `artifacts`/`cassette`). Kept separate from `results` so the per-result verdict/`ok` computation
   *  is unaffected. */
  extra?: Record<string, unknown>;
}

/** The standardized machine envelope object (internal: `jsonEnvelope` stringifies it). `ok` is the
 *  same SEAM-B verdict as the process exit code / footer (it cannot diverge). `replay` uses the replay
 *  lane (a cassette can't reproduce the scan/permissive signals); every other command is the live lane.
 *
 *  Each emitted result carries its own `verdict` ({pass, exitCode, signals[], guards[]}) — a NON-MUTATING
 *  projection (computeVerdict is pure; RunResult the type stays clean). This lets a consumer read per-result
 *  pass/fail AND why (the `signals[]` — e.g. an all-green-assertions run that is `pass:false` purely on a
 *  `stalled` signal) without recomputing from the sibling booleans. NOTE: this publishes the
 *  VerdictSignal.code taxonomy as a de-facto wire contract.
 *
 *  `ok` — for a NON-repeat, NON-matrix call, `ok` is derived from the SAME per-result verdicts as
 *  always (`results.every(pass)`) — unchanged, so it cannot diverge from them or from the exit code/footer.
 *  For a `--repeat` batch, `ok` is redefined DIRECTLY for that mode — computed from `rollups`/
 *  `rollupPasses`. For a `--matrix` run, `ok` is `!matrix.anyFail` — a matrix is a compatibility gate,
 *  not a survey (any cell failing, an assertion OR an infra error, fails the whole batch). For `--matrix`
 *  + `--repeat` composed, `ok` is `!matrixRepeat.anyFail` — each cell's own repeat batch judged by
 *  `rollupPasses`. Checked in this order (matrixRepeat, then matrix, then rollups, then the default) — the
 *  three batch modes are mutually exclusive at the CLI layer (only one of `rollups`/`matrix`/`matrixRepeat`
 *  is ever actually passed), this function just needs a deterministic order if a caller somehow passed more
 *  than one. One field, one meaning per mode — no parallel `batchVerdict` field, by design (there's no
 *  backward-compat constraint to preserve). `results[]` still holds every raw RunResult either way — across every cell
 *  and every one of its repeat iterations for the composed mode — nothing is hidden from any caller. */
function jsonEnvelopeObj(command: string, results: RunResult[], opts: JsonEnvelopeOpts = {}): Record<string, unknown> {
  const { rollups, minPassRate, allowBudgetStop, matrix, matrixRepeat, extra } = opts;
  const lane = command === "replay" ? "replay" : "live";
  const withVerdict = results.map((r) => ({ ...r, verdict: computeVerdict(r, lane) }));
  const ok = matrixRepeat
    ? !matrixRepeat.anyFail
    : matrix
      ? !matrix.anyFail
      : rollups
        ? rollups.every((ru) => rollupPasses(ru, minPassRate, allowBudgetStop))
        : withVerdict.length > 0 && withVerdict.every((r) => r.verdict.pass);
  return { tool: "cowork-harness", version: pkgVersion(), command, ok, results: withVerdict, rollups, matrix, matrixRepeat, ...extra, error: null };
}

/** Machine envelope for commands whose payload is NOT a `RunResult[]` — `record --dry-run` (discovery),
 *  `verify-cassettes` (coverage), `rehash` (migration). Shares the `{tool, version, command, ok, error}`
 *  frame with `jsonEnvelope` but carries a command-specific `payload` and NEVER calls `computeVerdict`
 *  (there is no `RunResult` to judge — `ok` is the caller's own success criterion, e.g. rehash `ok` =
 *  zero migration errors). Keeps a single machine-readable envelope shape across every command. */
export function jsonPayloadEnvelope(command: string, ok: boolean, payload: Record<string, unknown>): string {
  return JSON.stringify({ tool: "cowork-harness", version: pkgVersion(), command, ok, ...payload, error: null });
}

/** The standardized machine envelope emitted by every `--output-format json` command. COMPACT
 *  single-line JSON (machine output → trivially parseable; the pretty form lives in result.json).
 *  `opts.rollups`/`opts.minPassRate`/`opts.matrix` are additive (`--repeat`, `--matrix`) —
 *  omitted (undefined) for every other command, which is why they don't appear in a plain envelope
 *  (JSON.stringify drops `undefined` properties) rather than showing up as spurious `null`s. */
export function jsonEnvelope(command: string, results: RunResult[], opts: JsonEnvelopeOpts = {}): string {
  return JSON.stringify(jsonEnvelopeObj(command, results, opts));
}

/** The error envelope (compact, single line). */
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
