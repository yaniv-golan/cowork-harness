// Freezing a hillclimb flow's pairwise reference: `<flow>/<variant>/ref/<case>` from the variant's lowest-rep good
// row. ONE selector and ONE freeze, shared by a baseline pass's post-pass sweep and `hillclimb freeze-ref`, so the
// reference a flow judges against never depends on which of them wrote it.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { join, resolve } from "node:path";
import { UsageError } from "../errors.js";
import { loadCases, selectCases } from "./cases.js";
import { FlowWriter } from "./flow.js";
import { lexists } from "./fs.js";
import { readVariantFileIfPresent } from "./runner.js";
import { VARIANT_DIR_RE } from "./schema-check.js";
import { expandHome } from "../session.js";
import { runOutDir } from "../run/execute.js";
import { composeFromRunDir } from "../refs/compose.js";
import { freezeFromRun, type FreezeOutcome } from "../refs/cli.js";
import { readRefEntry, readRefDoc } from "../refs/store.js";
import { pairwiseComposeKey } from "../run/pairwise-prepass.js";
import type { Assertion } from "../types.js";

/** A results.jsonl row a reference may be frozen from: status `ok` (not truncated), not an agent failure, its
 *  verdict measured, and its pairwise evidence not refused (`win_present: 1`). A truncated, failed or refused
 *  run's output would make every later variant "win" against it. */
export function isGoodRefRow(row: Record<string, unknown>): boolean {
  const grade = row.grade as Record<string, unknown> | undefined;
  const meta = row.meta as Record<string, unknown> | undefined;
  return (
    row.status === "ok" &&
    meta?.failure_class === undefined &&
    grade?.pass_present === 1 &&
    grade?.win_present === 1 &&
    typeof meta?.run_id === "string"
  );
}

/** The case's good rows in a variant's results.jsonl, lowest rep first. */
export function goodRefRows(resultsText: string | null | undefined, caseId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of (resultsText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // schema-check reports malformed lines
    }
    if (r && typeof r === "object" && (r as Record<string, unknown>).prompt_id === caseId && isGoodRefRow(r as Record<string, unknown>))
      out.push(r as Record<string, unknown>);
  }
  return out.sort((a, b) => Number(a.rep) - Number(b.rep));
}

/** The kept run dir a row points at: its recorded `meta.run_dir` when it still exists (a `~/` path expanded), else
 *  the run id under the CURRENT runs root (`--run-dir` / `COWORK_HARNESS_RUNS_DIR`). Undefined when neither has a
 *  result.json — the run was pruned or the runs root moved. */
export function rowRunDir(row: Record<string, unknown>): string | undefined {
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const candidates: string[] = [];
  if (typeof meta.run_dir === "string" && !meta.run_dir.includes("<")) candidates.push(expandHome(meta.run_dir));
  if (typeof meta.run_id === "string" && typeof meta.scenario_name === "string")
    candidates.push(runOutDir(meta.scenario_name, meta.run_id));
  return candidates.find((d) => existsSync(join(d, "turns")));
}

export interface FreezeCaseInput {
  flowAbs: string;
  variant: string;
  caseId: string;
  /** The case's scenario file (what the run answered). */
  scenarioFile: string;
  assertions: readonly Assertion[];
  /** The scenario's prompt (the task the reference answers). */
  prompt: string;
  /** The variant's results.jsonl text. */
  results: string | null;
  secrets: string[];
  command: "hillclimb run" | "hillclimb freeze-ref";
}

export type FreezeCaseOutcome =
  | { status: "frozen" | "added"; caseId: string; rep: number; message: string }
  | { status: "exists"; caseId: string; message: string }
  /** `restart`: no freeze can repair it (a damaged entry, one for another prompt, its recorded run gone) — the flow restarts. */
  | { status: "refused"; caseId: string; message: string; restart?: true };

/** Freeze one case's reference into `<flow>/<variant>/ref`. An entry already holding every compose key the case's
 *  pairwise asserts need is `exists` (benign). An entry missing a key (an assert added, a scope changed) gains it
 *  from the run it was frozen from — a store never mixes runs — and is refused when that run is gone. */
export function freezeCaseRef(i: FreezeCaseInput): FreezeCaseOutcome {
  const store = join(i.flowAbs, i.variant, "ref");
  const keys = [...new Set(i.assertions.filter((a) => a.semantic_pairwise !== undefined).map(pairwiseComposeKey))];
  const existing = readRefEntry(store, i.caseId);
  if (existing.status === "integrity")
    return {
      status: "refused",
      caseId: i.caseId,
      restart: true,
      message: `the reference for case ${i.caseId} in ${store} is damaged: ${existing.why}`,
    };
  if (existing.status === "ok") {
    // A reference for another task is not this case's answer: never compared, never extended — the flow must restart.
    if (existing.taskSha256 !== createHash("sha256").update(i.prompt, "utf8").digest("hex"))
      return {
        status: "refused",
        caseId: i.caseId,
        restart: true,
        message: `case ${i.caseId}: its reference in ${store} was frozen for a different prompt — start a fresh flow dir for the changed scenario`,
      };
    const lacking = keys.filter((k) => readRefDoc(store, i.caseId, k).status !== "ok");
    if (!lacking.length) return { status: "exists", caseId: i.caseId, message: `case ${i.caseId}: already frozen in ${store}` };
    // Add the lacking keys from the entry's own run: a store entry never mixes documents of two runs. Its recorded
    // path may be redacted; the run id under the current runs root finds it then.
    const recorded = expandHome(existing.source.runDir);
    const runDir =
      existsSync(join(recorded, "turns")) || existing.source.sessionId === undefined
        ? recorded
        : runOutDir(existing.scenario, existing.source.sessionId);
    const rep = existing.source.rep ?? 0;
    if (!existsSync(join(runDir, "turns")))
      return {
        status: "refused",
        caseId: i.caseId,
        restart: true,
        message:
          `case ${i.caseId}: its reference lacks compose key(s) ${lacking.join(", ")} and the run it was frozen from (${existing.source.runDir}) is gone — ` +
          `a reference never mixes runs, so start a fresh flow dir for the changed assertions`,
      };
    // The run never composed the new key, so no live fingerprint can check it: it is added marked `unchecked`, which
    // every later comparison against it shows (`pairwise[].unchecked`).
    return run(i, runDir, rep, store, true);
  }
  const rows = goodRefRows(i.results, i.caseId);
  if (!rows.length)
    return {
      status: "refused",
      caseId: i.caseId,
      message: `case ${i.caseId}: no good row in ${i.variant}/results.jsonl to freeze from (status ok, not an agent failure, verdict and pairwise evidence measured)`,
    };
  // The lowest-rep row whose run is still here and DELIVERED its output: a stalled or deliverable-less run would make
  // every later variant "win" against nothing. The row says neither, so the run's own result.json decides.
  const skipped: string[] = [];
  for (const row of rows) {
    const runId = String((row.meta as Record<string, unknown>).run_id);
    const runDir = rowRunDir(row);
    if (runDir === undefined) {
      skipped.push(`rep ${String(row.rep)}: its run ${runId} is not under the runs root (pass the --run-dir it was written to)`);
      continue;
    }
    const outcome = runOutcome(runDir);
    if (outcome === undefined || !outcome.startsWith("delivered_")) {
      skipped.push(`rep ${String(row.rep)}: its run did not deliver an output (${outcome ?? "no recorded outcome"})`);
      continue;
    }
    return run(i, runDir, Number(row.rep), store);
  }
  return { status: "refused", caseId: i.caseId, message: `case ${i.caseId}: no good row's run can be frozen — ${skipped.join("; ")}` };
}

/** The run's recorded `outcome`, from its latest turn's result.json. */
function runOutcome(runDir: string): string | undefined {
  try {
    const turn = latestTurn(runDir);
    if (turn === undefined) return undefined;
    const r = JSON.parse(readFileSync(turnArtifactPath(runDir, turn, "result.json"), "utf8")) as { outcome?: unknown };
    return typeof r.outcome === "string" ? r.outcome : undefined;
  } catch {
    return undefined;
  }
}

function run(i: FreezeCaseInput, runDir: string, rep: number, store: string, allowUnchecked = false): FreezeCaseOutcome {
  const o: FreezeOutcome = freezeFromRun(
    { runDir, scenarioFile: i.scenarioFile, out: store, caseId: i.caseId, allowUnchecked },
    { compose: (d, f) => composeFromRunDir(d, f, i.secrets, { command: i.command, variant: i.variant, rep }) },
  );
  // freezeFromRun speaks as `ref freeze`; this is not it, and it takes no --allow-unchecked.
  const message = o.message
    .replace(/^ref freeze: /, "")
    .replace(/; pass --allow-unchecked to freeze it anyway, marked unchecked$/, " — re-run the variant to record one");
  if (o.status === "frozen" || o.status === "added") return { status: o.status, caseId: i.caseId, rep, message };
  if (o.status === "exists") return { status: "exists", caseId: i.caseId, message };
  return { status: "refused", caseId: i.caseId, message };
}

export interface FreezeRefReport {
  exitCode: 0 | 1;
  frozen: Array<{ case: string; rep: number }>;
  added: Array<{ case: string; rep: number }>;
  exists: string[];
  refused: Array<{ case: string; why: string }>;
}

/** `hillclimb freeze-ref <scenarios> --flow F --variant V [--case id]…`: freeze each selected pairwise case's
 *  reference from the variant's lowest-rep good row, under the variant's lock (so it cannot race a live `run` of
 *  that variant). Exit 0 when nothing was refused, 1 otherwise; an entry already complete is reported, not an error. */
export function freezeRefCommand(i: {
  target: string;
  flowArg: string;
  variant: string;
  caseIds: readonly string[];
  cwd: string;
  secrets: string[];
}): FreezeRefReport {
  if (!VARIANT_DIR_RE.test(i.variant)) throw new UsageError(`--variant must be 'baseline' or 'v<N>' (got ${JSON.stringify(i.variant)})`);
  const flowAbs = resolve(i.cwd, i.flowArg);
  if (!lexists(flowAbs)) throw new UsageError(`no flow dir at ${i.flowArg}`);
  // Read-only checks first: a variant with no rows has nothing to freeze, and opening its writer would create files.
  if (readVariantFileIfPresent(i.flowArg, i.variant, "results.jsonl", i.cwd) === null)
    throw new UsageError(`${join(i.flowArg, i.variant)} has no results.jsonl — run the variant first`);
  const { cases: all } = loadCases(resolve(i.cwd, i.target));
  const cases = selectCases(all, [...i.caseIds]).filter((c) => (c.scenario.assert ?? []).some((a) => a.semantic_pairwise !== undefined));
  if (!cases.length) throw new UsageError(`no selected case has a semantic_pairwise assert — nothing to freeze`);
  const release = FlowWriter.open(i.flowArg, i.variant, { cwd: i.cwd, secrets: i.secrets }).lock();
  const report: FreezeRefReport = { exitCode: 0, frozen: [], added: [], exists: [], refused: [] };
  try {
    // Read under the lock, so the rows are the ones no live run of the variant is still appending to.
    const results = readVariantFileIfPresent(i.flowArg, i.variant, "results.jsonl", i.cwd);
    for (const c of cases) {
      const o = freezeCaseRef({
        flowAbs,
        variant: i.variant,
        caseId: c.id,
        scenarioFile: c.file,
        assertions: c.scenario.assert,
        prompt: c.scenario.prompt,
        results,
        secrets: i.secrets,
        command: "hillclimb freeze-ref",
      });
      if (o.status === "frozen") report.frozen.push({ case: c.id, rep: o.rep });
      else if (o.status === "added") report.added.push({ case: c.id, rep: o.rep });
      else if (o.status === "exists") report.exists.push(c.id);
      else report.refused.push({ case: c.id, why: o.message });
    }
  } finally {
    release();
  }
  if (report.refused.length) report.exitCode = 1;
  return report;
}
