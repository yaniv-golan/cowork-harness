import { readFileSync } from "node:fs";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import { runProvenance } from "./provenance.js";
import { rollupPasses, type RepeatRollup } from "./repeat.js";
import type { MatrixRollup, MatrixRepeatRollup } from "./matrix.js";
import { deriveOutcome } from "./outcome.js";
import { writeAllSync } from "../io.js";
import { budgetStatus, type BudgetStatus } from "./budget-status.js";

/** The `--max-budget-usd` marker as a frame fragment: `{budget}` when a pre-flight recorded a status, `{}`
 *  otherwise — so a command payload that ever carries its own `budget` key is not overwritten with
 *  `undefined` on an invocation that passed no cap. Spread AFTER a payload: when a status exists it is a
 *  frame key, like `ok`, and wins. */
function budgetFrame(): { budget?: BudgetStatus } {
  const b = budgetStatus();
  return b === undefined ? {} : { budget: b };
}

// Synchronous fd writes (match cli.ts / doctor.ts). writeAllSync retries EAGAIN and loops on short
// writes so the whole payload lands before process.exit on a pipe (see src/io.ts).
const out = (s: string) => writeAllSync(1, s + "\n");
const log = (s: string) => writeAllSync(2, s + "\n");

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

/** The published projection of one RunResult: the result plus its derived `verdict`, `provenance` and
 *  `outcome`. Every envelope that publishes a RunResult goes through this one function, so a consumer
 *  reading `.verdict.pass` gets the same shape from `run`, `replay`, single-file `record` and each item of
 *  a `record` batch. */
export function publishedResult(r: RunResult, lane: "live" | "replay" = "live") {
  // `provenance` is a DERIVED projection published beside the verdict — "which experiment actually
  // ran": the marker-filtered model, the four-state skill-offered/invoked answer, and `ablated`.
  // Every input is already in the result; publishing the derivation means a consumer never re-does
  // the `<synthetic>`-filter or the evidence-unavailable states, which is where the misreadings came
  // from. Non-mutating, same as `verdict`/`outcome`.
  const withV = { ...r, verdict: computeVerdict(r, lane), provenance: runProvenance(r) };
  return { ...withV, outcome: deriveOutcome(withV) };
}

/** The standardized machine envelope object (internal: `jsonEnvelope` stringifies it). `ok` is the
 *  same SEAM-B verdict as the process exit code / footer (it cannot diverge). (`record` does not use this
 *  function's `ok`: a recording's `ok` is "exited 0" — a cassette was written — and its verdict is in
 *  `results[].verdict.pass`, because `--allow-failing` deliberately records a failing run with exit 0;
 *  see `cmdRecord`.) `replay` uses the replay
 *  lane (a cassette can't reproduce the scan/permissive signals); every other command is the live lane.
 *
 *  Each emitted result carries its own `verdict` ({pass, exitCode, signals[], guards[], failures[]}) — a
 *  NON-MUTATING re-derivation (computeVerdict is pure; the RunResult on disk stays untouched by this
 *  spread) via the SAME `computeVerdict` call that already persisted `result.verdict` into `result.json`
 *  at the execute.ts persist point — so this recomputation is provably identical in shape AND value to
 *  what's on disk; the two channels (a kept run's `result.json` and this stdout envelope) can never
 *  diverge. This lets a consumer read per-result pass/fail AND why (the `signals[]` — e.g. an
 *  all-green-assertions run that is `pass:false` purely on a `stalled` signal — or the flat `failures[]`
 *  for a jq-friendly summary) without recomputing from the sibling booleans. NOTE: this publishes the
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
  const withVerdict = results.map((r) => publishedResult(r, lane));
  const ok = matrixRepeat
    ? !matrixRepeat.anyFail
    : matrix
      ? !matrix.anyFail
      : rollups
        ? rollups.every((ru) => rollupPasses(ru, minPassRate, allowBudgetStop))
        : withVerdict.length > 0 && withVerdict.every((r) => r.verdict.pass);
  return {
    tool: "cowork-harness",
    version: pkgVersion(),
    command,
    ok,
    results: withVerdict,
    rollups,
    matrix,
    matrixRepeat,
    ...extra,
    ...budgetFrame(),
    error: null,
  };
}

/** Machine envelope for commands whose payload is NOT a `RunResult[]` — `record --dry-run` (discovery),
 *  `verify-cassettes` (coverage), `rehash` (migration). Shares the `{tool, version, command, ok, error}`
 *  frame with `jsonEnvelope` but carries a command-specific `payload` and NEVER calls `computeVerdict`
 *  (there is no `RunResult` to judge — `ok` is the caller's own success criterion, e.g. rehash `ok` =
 *  zero migration errors). Keeps a single machine-readable envelope shape across every command. */
export function jsonPayloadEnvelope(command: string, ok: boolean, payload: Record<string, unknown>): string {
  return JSON.stringify({ tool: "cowork-harness", version: pkgVersion(), command, ok, ...payload, ...budgetFrame(), error: null });
}

/** The standardized machine envelope emitted by every `--output-format json` command. COMPACT
 *  single-line JSON (machine output → trivially parseable; the pretty form lives in result.json).
 *  `opts.rollups`/`opts.minPassRate`/`opts.matrix` are additive (`--repeat`, `--matrix`) —
 *  omitted (undefined) for every other command, which is why they don't appear in a plain envelope
 *  (JSON.stringify drops `undefined` properties) rather than showing up as spurious `null`s. */
export function jsonEnvelope(command: string, results: RunResult[], opts: JsonEnvelopeOpts = {}): string {
  return JSON.stringify(jsonEnvelopeObj(command, results, opts));
}

/** Stable machine codes on `error.code`. A code NARROWS a category, it never replaces one: `category` stays
 *  the covered coarse class (§11), and `code` is present only on the errors a consumer needs to tell apart
 *  within it. `budget_exceeded` is a `--max-budget-usd` pre-flight refusal — a `runtime` error whose exit
 *  code is shared with other refusals, so without it the only discriminator was the message prose. `doc_drift` and
 *  `unchecked_content` are `regrade`'s two evidence refusals (the kept evidence differs from what the live judge
 *  read; content the live judge never read would be graded), listed per run dir in the payload's `refusals[]`.
 *  `no_semantic_asserts` is `regrade`'s refusal of a scenario with neither a `semantic_matches` nor a `semantic_pairwise`
 *  assert (nothing to re-grade): a `usage` error a caller may treat as "nothing to do" rather than as a failure. */
export type ErrCode = "budget_exceeded" | "doc_drift" | "unchecked_content" | "no_semantic_asserts";

/** Additive extras for the error envelope. `error` fields merge into the `error` object beside the
 *  covered `category`/`message`/`hint` (typed so they cannot collide with them); `payload` keys sit at the top level
 *  beside `results`, so a refusal that REPLACES a payload envelope can keep the findings that payload would
 *  have carried (a directory `record --dry-run`'s `broken[]` / `inputErrors[]` / `refusals[]`). */
export interface JsonErrorExtras {
  error?: { code?: ErrCode; budget?: BudgetStatus };
  payload?: Record<string, unknown>;
}

/** The error envelope (compact, single line). `results` is `[]` unless a run completed before the refusal —
 *  `record` refusing to freeze a failing run passes that run, already projected by `publishedResult`, so the
 *  consumer still reads its verdict and cost. */
export function jsonError(
  command: string,
  category: ErrCategory,
  message: string,
  hint?: string,
  results: ReturnType<typeof publishedResult>[] = [],
  extras: JsonErrorExtras = {},
): string {
  return JSON.stringify({
    // Payload findings FIRST, so none of them can overwrite a frame key below.
    ...extras.payload,
    tool: "cowork-harness",
    version: pkgVersion(),
    command,
    ok: false,
    results,
    ...budgetFrame(),
    error: { category, message, ...(hint ? { hint } : {}), ...extras.error },
  });
}

/** The output format COWORK_HARNESS_OUTPUT_FORMAT selects when no `--output-format` flag is given: `json`
 *  only for exactly "json" (the value is validated at dispatch), otherwise `text`. The single reading of
 *  the variable — every default for the flag comes from here or from `isJsonOutput`. */
export function envOutputFormat(): "text" | "json" {
  return process.env.COWORK_HARNESS_OUTPUT_FORMAT === "json" ? "json" : "text";
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
  return envOutputFormat() === "json";
}

/** The single error exit used by every command + the top-level catch, in both `cli.ts` and `doctor.ts`.
 *  boundary → exit 3, every other category → exit 2, UNLESS `exitCode` overrides it — SPEC.md's exit-code
 *  contract names two exceptions that exit `1` instead of the general `2`: `sync` hard-failures (missing
 *  baseline version fields, a refused empty allowlist, unknown deltas) and a `status`/`verify-run` runtime
 *  failure reading a prior run's output (SPEC.md:428-436). Every EXISTING call site omits `exitCode` and
 *  keeps its current behavior exactly. `results` is for a refusal that comes after a completed run (see
 *  `jsonError`); every other call site omits it and prints `results: []`. */
export function fail(
  command: string,
  category: ErrCategory,
  message: string,
  hint: string | undefined,
  json: boolean,
  exitCode?: 1 | 2 | 3,
  results?: ReturnType<typeof publishedResult>[],
  extras?: JsonErrorExtras,
): never {
  if (json) out(jsonError(command, category, message, hint, results, extras));
  else {
    log(message);
    if (hint) log(hint);
  }
  process.exit(exitCode ?? (category === "boundary" ? 3 : 2));
}
