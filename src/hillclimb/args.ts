// `hillclimb run` argument parsing. The surface is runner-scaffold.mjs's (bundle 2.1.285, S l.180-214) —
// same flags, same defaults, same refusals — because /claude-api hillclimb drives this command exactly as
// it would drive the scaffold. Every refusal is a UsageError (exit 2, S's code for a refusal before spend).
//
// Two refusals are stricter than S, both still exit 2: a flag-looking value is refused (S's val() would take
// `--flow --variant` as a flow named "--variant"), and any decider with --concurrency > 1 is refused (the
// decider channel is shared across jobs — eval's rule, src/eval/command.ts:192).

import { UsageError } from "../errors.js";
import { isConcreteModelId } from "../run/model-provenance.js";
import { envOutputFormat, parseOutputFormat } from "../run/envelope.js";
import { VARIANT_DIR_RE } from "./schema-check.js";
import { HILLCLIMB_RUN_BOOLEAN_FLAGS, HILLCLIMB_RUN_REPEATED_FLAGS, HILLCLIMB_RUN_VALUE_FLAGS } from "./usage.js";

/** S's defaults (S l.181-183). `--reps 1` is a covered default from 4.3.0. */
export const HILLCLIMB_RUN_DEFAULTS = {
  flow: ".claude/hillclimb/flow",
  variant: "baseline",
  reps: 1,
  concurrency: 4,
  timeoutS: 1800,
} as const;

export interface HillclimbRunArgs {
  help: false;
  target: string;
  flow: string;
  variant: string;
  model?: string;
  reps: number;
  concurrency: number;
  /** Seconds; 0 = no ceiling. */
  timeoutS: number;
  approveHarness: boolean;
  cases: string[];
  ablate: boolean;
  dryRun: boolean;
  noCopyInputs: boolean;
  judgeModel?: string;
  deciderCmd?: string;
  deciderDir?: string;
  deciderLlm: boolean;
  outputFormat: "text" | "json";
  globals: Array<{ flag: "--dotenv" | "--run-dir"; value: string }>;
}

const VALUE = new Set<string>(HILLCLIMB_RUN_VALUE_FLAGS);
const REPEATED = new Set<string>(HILLCLIMB_RUN_REPEATED_FLAGS);
const BOOLEAN = new Set<string>(HILLCLIMB_RUN_BOOLEAN_FLAGS);

// setTimeout clamps a delay above 2^31-1 ms to 1 ms, so a larger ceiling would fire at once (S l.207).
const MAX_TIMEOUT_MS = 2147483647;

const int1 = (flag: string, v: string): number => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isInteger(n) || n < 1) throw new UsageError(`${flag} requires an integer >= 1 (got "${v}")`);
  return n;
};

/** Parse `hillclimb run` arguments (argv after `hillclimb run`). Throws UsageError; never exits. */
export function parseHillclimbRunArgs(argv: readonly string[]): HillclimbRunArgs | { help: true } {
  const positionals: string[] = [];
  const values: Record<string, string> = {};
  const cases: string[] = [];
  const booleans = new Set<string>();
  const globals: HillclimbRunArgs["globals"] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (BOOLEAN.has(name)) {
      if (eq > 0) throw new UsageError(`${name} takes no value`);
      booleans.add(name);
      continue;
    }
    if (!VALUE.has(name) && !REPEATED.has(name)) throw new UsageError(`unknown flag: ${a}`);
    let v: string | undefined;
    if (eq > 0) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v === undefined) throw new UsageError(`${name} requires a value (none provided)`);
      if (v.startsWith("-") && !/^-\d/.test(v)) throw new UsageError(`${name}: missing value (got flag-looking "${v}")`);
      i++;
    }
    if (v.trim() === "") throw new UsageError(`${name} requires a non-empty value`);
    if (name === "--dotenv" || name === "--run-dir") {
      if (globals.some((g) => g.flag === name)) throw new UsageError(`${name} given more than once`);
      globals.push({ flag: name, value: v });
    } else if (REPEATED.has(name)) cases.push(v);
    else {
      if (name in values) throw new UsageError(`${name} given more than once`);
      values[name] = v;
    }
  }
  if (positionals.length !== 1)
    throw new UsageError(
      `hillclimb run takes exactly one scenario file or directory (got ${positionals.length ? positionals.join(" ") : "none"})`,
    );

  const variant = values["--variant"] ?? HILLCLIMB_RUN_DEFAULTS.variant;
  if (!VARIANT_DIR_RE.test(variant))
    // The report only reads `baseline` / `v<N>` directories: any other name would spend a whole pass into a
    // directory the summary, trajectory and budget arithmetic never see (S l.199-204).
    throw new UsageError(`--variant must be 'baseline' or 'v<N>' (N >= 1, no leading zero), got '${variant}'`);

  let timeoutS: number = HILLCLIMB_RUN_DEFAULTS.timeoutS;
  if (values["--timeout-s"] !== undefined) {
    const v = values["--timeout-s"];
    const n = Number(v);
    if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n * 1000 > MAX_TIMEOUT_MS)
      throw new UsageError(
        `--timeout-s requires seconds >= 0 and at most ${Math.floor(MAX_TIMEOUT_MS / 1000)} (got "${v}"; 0 = no ceiling)`,
      );
    timeoutS = n;
  }
  const reps = values["--reps"] !== undefined ? int1("--reps", values["--reps"]) : HILLCLIMB_RUN_DEFAULTS.reps;
  const explicitConcurrency = values["--concurrency"] !== undefined;
  const concurrency = explicitConcurrency ? int1("--concurrency", values["--concurrency"]) : HILLCLIMB_RUN_DEFAULTS.concurrency;

  for (const flag of ["--model", "--judge-model"] as const) {
    const v = values[flag];
    if (v !== undefined && !isConcreteModelId(v))
      throw new UsageError(`${flag} must be a concrete model id (e.g. claude-sonnet-4-6), not an alias: got "${v}"`);
  }

  let outputFormat: "text" | "json";
  try {
    outputFormat = "--output-format" in values ? parseOutputFormat([...argv]) : envOutputFormat();
  } catch (e) {
    throw new UsageError((e as Error).message);
  }

  const deciderCmd = values["--decider-cmd"];
  const deciderDir = values["--decider-dir"];
  const deciderLlm = booleans.has("--decider-llm");
  if (deciderCmd !== undefined && deciderDir !== undefined)
    throw new UsageError("--decider-cmd and --decider-dir are mutually exclusive (one answer channel).");
  if ((deciderCmd !== undefined || deciderDir !== undefined || deciderLlm) && concurrency > 1)
    throw new UsageError(
      `--concurrency ${concurrency}${explicitConcurrency ? "" : " (the default)"} cannot be combined with a decider: the answer channel is shared across jobs and is not safe for concurrent gate answers; pass --concurrency 1.`,
    );

  return {
    help: false,
    target: positionals[0],
    flow: values["--flow"] ?? HILLCLIMB_RUN_DEFAULTS.flow,
    variant,
    ...(values["--model"] !== undefined ? { model: values["--model"] } : {}),
    reps,
    concurrency,
    timeoutS,
    approveHarness: booleans.has("--approve-harness"),
    cases,
    ablate: booleans.has("--ablate"),
    dryRun: booleans.has("--dry-run"),
    noCopyInputs: booleans.has("--no-copy-inputs"),
    ...(values["--judge-model"] !== undefined ? { judgeModel: values["--judge-model"] } : {}),
    ...(deciderCmd !== undefined ? { deciderCmd } : {}),
    ...(deciderDir !== undefined ? { deciderDir } : {}),
    deciderLlm,
    outputFormat,
    globals,
  };
}
