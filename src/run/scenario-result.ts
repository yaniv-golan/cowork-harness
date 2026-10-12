// `scenario-result.json`: the scenario-level result of a multi-leg run, at the scenario root. Written once, after
// the last leg (or after the leg that stopped the scenario). Its presence marks the run COMPLETE; the run dir's
// SHAPE comes from the `legs/<id>/leg.json` markers (see turn-layout.ts), so an unfinished root is still `legs`.
//
// A LEAF module beside turn-layout.ts: readers that branch on the `legs` shape (prune, the index, `status
// --latest-for`, labels) read this file, so it must not import back into them.

import { readFileSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Verdict, VerdictSignal } from "./verdict.js";
import { SCENARIO_RESULT } from "./turn-layout.js";
import type { RunIndexRow } from "./run-index.js";

export const SCENARIO_RESULT_SCHEMA = "cowork-harness/scenario-result";

/** The scenario-level signals only a multi-leg run raises, beside the legs' own (each prefixed with its leg). */
export interface MultiLegSignal {
  code: "vacuous_positive_assertion" | "plugin_identity_changed" | "expect_denied";
  severity: "fail";
  message: string;
}

/** A RunResult `verdict`'s shape, so `.verdict.pass` reads the same; its signals may also be multi-leg ones. */
export type ScenarioVerdict = Omit<Verdict, "signals"> & { signals: Array<VerdictSignal | MultiLegSignal> };

export interface ScenarioLegEntry {
  id: string;
  kind: "prompt" | "action";
  /** The leg's agent session id (prompt legs). */
  agentSessionId?: string;
  /** `passed` / `failed`; `skipped` for a leg after the one that failed (never run on bad state). */
  status: "passed" | "failed" | "skipped";
  /** The leg's own verdict, as in its `turns/1/result.json` (prompt) or `action.json` (action). Absent when skipped. */
  verdict?: ScenarioVerdict;
}

export interface ScenarioResult {
  schema: typeof SCENARIO_RESULT_SCHEMA;
  version: 1;
  scenario: string;
  /** Same shape as a RunResult's `verdict`, so a consumer reading `.verdict.pass` works unchanged. */
  verdict: ScenarioVerdict;
  legs: ScenarioLegEntry[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runLabel?: string;
  /** The ONE index row the live path appended for this run. `--reindex` re-emits it, so the two cannot drift. */
  indexRow: RunIndexRow;
}

/** Cap on a scenario-result read: it holds verdicts and one index row, never transcripts. */
const MAX_BYTES = 4 * 1024 * 1024;

/** The parsed scenario result, or undefined when absent, not a regular file, too large, or not this schema. Never
 *  throws: prune and the index call it on dirs that may be half-written or damaged. */
export function readScenarioResult(outDir: string): ScenarioResult | undefined {
  const p = join(outDir, SCENARIO_RESULT);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<ScenarioResult>;
    if (o.schema !== SCENARIO_RESULT_SCHEMA || o.version !== 1) return undefined;
    if (!o.verdict || typeof o.verdict.pass !== "boolean" || !Array.isArray(o.legs) || !o.indexRow) return undefined;
    return o as ScenarioResult;
  } catch {
    return undefined;
  }
}

/** The scenario result file's mtime (run END), for recency ranking against a single run's result.json mtime. */
export function scenarioResultMtime(outDir: string): string | undefined {
  try {
    const st = statSync(join(outDir, SCENARIO_RESULT));
    return st.isFile() ? st.mtime.toISOString() : undefined;
  } catch {
    return undefined;
  }
}
