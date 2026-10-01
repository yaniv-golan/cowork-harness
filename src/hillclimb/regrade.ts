// `hillclimb regrade`: re-grade a flow's scored rows in place, from their kept run dirs, without re-running the agent.
//
// Two modes:
//   full (default)  every judged assert of every scored row is graded again (a judge or rubric change), with the flow's
//                   references as they are now; `pass` is recomputed from the re-graded result.
//   --fill-refs     only the pairwise comparisons a row lacks are judged (a reference frozen after the row was
//                   written); every other outcome and every semantic_matches grade is the live one, so `pass` cannot
//                   move. Every scored row is re-graded through the same producer, so each carries every win column.
//
// A row is rewritten by the SAME producer `run` writes it with (`gradeFor` over the result with the re-graded entries
// substituted), never patched key by key. `result.json` is never touched (`regrade`'s own invariant). Everything that
// can refuse is decided before the first judge call, over every selected variant: the gate, the locks, and each
// batch's evidence preflight.

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { classifyRep } from "../eval/classify.js";
import { pkgVersion } from "../run/envelope.js";
import { runOutDir } from "../run/execute.js";
import { regradeRuns, type RegradeOptions, type RegradeOutcome, type RegradeRunReport } from "../run/regrade.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { computeVerdict } from "../run/verdict.js";
import type { RunResult } from "../types.js";
import { loadCases, selectCases, type HillclimbCase } from "./cases.js";
import { prepareCases } from "./command.js";
import { FlowWriter, redactDeep } from "./flow.js";
import { lexists, normalizeRootArg, NoFollowRoot } from "./fs.js";
import { gateDecision, harnessDigest } from "./gate.js";
import type { MetricDecl } from "./grade-keys.js";
import { discoverFlowRefs, flowPairwiseOptions, metricRefNames } from "./pairwise.js";
import { gradeFor, judgeFieldsOf, orderedGrade } from "./rows.js";
import { readStateIfPresent, readVariantFileIfPresent } from "./runner.js";
import { VARIANT_DIR_RE } from "./schema-check.js";

export interface HillclimbRegradeArgs {
  target: string;
  flow: string;
  /** A variant id, or `all` (the default): every variant with rows. */
  variant: string;
  cases: string[];
  judgeModel?: string;
  fillRefs: boolean;
  approveHarness: boolean;
  allowDocDrift: boolean;
  /** Forwarded to `regrade` only when the user passed it. */
  allowUnchecked: boolean;
}

export interface RegradeFlowDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
  stderr: (line: string) => void;
  harnessVersion?: string;
  /** Test seams, forwarded to `regradeRuns`. */
  regradeOptions?: Pick<RegradeOptions, "makeJudge" | "pairwiseComplete" | "now">;
}

export interface RegradeFlowVariant {
  variant: string;
  rewritten: number;
  /** Rows not re-graded, with why. Nothing was written for them. */
  listed: Array<{ prompt_id: string; rep: number; why: string }>;
  regradeFiles: string[];
  backup?: string;
}

export interface RegradeFlowOutcome {
  exitCode: 0 | 1 | 2;
  variants: RegradeFlowVariant[];
  error?: { category: "usage" | "runtime"; message: string };
}

/** The G9 seam: re-extracted metric floats (and their unavailable reasons) merge into a rewritten row here, after its
 *  grade is rebuilt and before its keys are ordered. A no-op until the metrics half fills it; mutates in place. */
export function mergeMetrics(
  row: { grade: Record<string, number>; meta: Record<string, unknown> },
  report: RegradeRunReport,
  decls: readonly MetricDecl[],
): void {
  void row;
  void report;
  void decls;
}

type Row = Record<string, unknown> & { prompt_id?: unknown; rep?: unknown; grade?: Record<string, number>; meta?: Record<string, unknown> };

interface Line {
  raw: string;
  row?: Row;
}

interface Target {
  variant: string;
  c: HillclimbCase;
  line: Line;
  runDir: string;
  result: RunResult;
  /** The references this row's comparisons lack (fill mode); empty when it needs no judge call. */
  missing: string[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A run dir as a flow may record it: relative to the runs root, else redacted. */
function shownRunPath(p: string, secrets: readonly string[]): string {
  const rel = relative(resolve(runsWriteRoot()), resolve(p));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return `<runs>/${rel.split(sep).join("/")}`;
  return redactDeep(tildeify(p), secrets);
}

function readResult(runDir: string): RunResult | undefined {
  try {
    const turn = latestTurn(runDir);
    if (turn === undefined) return undefined;
    return JSON.parse(NoFollowRoot.existing(runDir).readFile(turnArtifactPath(runDir, turn, "result.json"))) as RunResult;
  } catch {
    return undefined;
  }
}

/** The kept run dir of a row: its run id under the CURRENT runs root, named by the joined case's scenario (a row's
 *  recorded `meta.run_dir` is redacted outside the home dir, so it is not relied on). */
function runDirOf(row: Row, c: HillclimbCase): string | undefined {
  const id = row.meta?.run_id;
  if (typeof id !== "string" || id === "" || id.includes("/")) return undefined;
  const dir = runOutDir(c.scenario.name ?? c.id, id);
  return lexists(join(dir, "turns")) ? dir : undefined;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The result with the re-graded entries substituted by scenario index, and the verdict recomputed from them (a
 *  persisted verdict would otherwise win in `gradeFor` and hide every change). */
function regradedResult(live: RunResult, report: RegradeRunReport): RunResult {
  const byIndex = new Map(report.assertions.map((a) => [a.assertionIndex, a]));
  let k = 0;
  const assertions = (live.assertions ?? []).map((e) => {
    if (e.source !== undefined) return e;
    const g = byIndex.get(k++);
    if (!g) return e;
    const { assertionIndex: _i, docMatchesLive: _d, ...entry } = g as typeof g & { docMatchesLive?: unknown };
    void _i;
    void _d;
    return entry as unknown as typeof e;
  });
  const copy = { ...live, assertions } as RunResult;
  copy.verdict = computeVerdict(copy, "live") as RunResult["verdict"];
  return copy;
}

/** Rebuild one scored row from a result: grade, explanation, claim texts, reference shas and judge fields through the
 *  producer `run` uses; every other field kept as it was, and keys `gradeFor` no longer emits removed. */
function rebuiltRow(
  row: Row,
  result: RunResult,
  c: HillclimbCase,
  metricRefs: readonly string[],
  extraMeta: Record<string, unknown>,
  judgeFieldsFrom: RunResult | undefined,
  report: RegradeRunReport | undefined,
): { row: Row } | { why: string } {
  const rep = classifyRep({ result: result as never }, {});
  if (rep.bucket === "judge_invalid")
    return { why: `the re-grade is invalid (judge) on assertion(s) ${rep.judgeInvalidAssertions.join(", ")}` };
  const agentFailed = rep.bucket === "errored_agent";
  const ctx = { assertions: c.scenario.assert, pairwise: { metricRefs } };
  const g = gradeFor(result, ctx, rep, agentFailed);
  if ("misaligned" in g) return { why: `assertion ${g.misaligned} no longer lines up with the scenario (${g.excluded})` };
  const meta: Record<string, unknown> = { ...(row.meta ?? {}) };
  for (const k of [
    "claims",
    "pairwise_ref_sha256",
    "explanation_untrusted",
    "judge_models",
    "judge_transport",
    "judge_transports",
    "judge_retries_unrecorded",
  ])
    delete meta[k];
  const out: Row = { ...row };
  delete out.explanation;
  delete out.judge_model;
  delete out.judge_usage;
  const grade = { ...g.grade };
  if (report) mergeMetrics({ grade, meta }, report, []);
  out.grade = orderedGrade(grade, ctx);
  if (Object.keys(g.explanation).length) {
    const e: Record<string, string> = {};
    if ("claims" in g.explanation) e.claims = g.explanation.claims;
    for (const [k, v] of Object.entries(g.explanation)) if (k !== "claims") e[k] = v;
    out.explanation = e;
    meta.explanation_untrusted = true;
  }
  if (Object.keys(g.claims).length) meta.claims = g.claims;
  if (Object.keys(g.refShas).length) meta.pairwise_ref_sha256 = g.refShas;
  // Who judged: the re-graded result in a full re-grade; in a fill, the row's own judge fields stand (its grades are
  // the live ones) and the fill's spend is said beside them.
  if (judgeFieldsFrom) {
    const { judges, transports, jr } = judgeFieldsOf(judgeFieldsFrom);
    if (judges.judge_model !== undefined) out.judge_model = judges.judge_model;
    if (judges.judge_usage !== undefined) out.judge_usage = judges.judge_usage;
    if (judges.judge_models !== undefined) meta.judge_models = judges.judge_models;
    if (transports.length === 1) meta.judge_transport = transports[0];
    else if (transports.length > 1) meta.judge_transports = transports;
    meta.judge_retries = jr.judge_retries;
    if (jr.unrecorded) meta.judge_retries_unrecorded = true;
  } else
    for (const k of ["judge_models", "judge_transport", "judge_transports", "judge_retries_unrecorded"])
      if (row.meta && k in row.meta) meta[k] = row.meta[k];
  if (!judgeFieldsFrom && row.judge_model !== undefined) out.judge_model = row.judge_model;
  if (!judgeFieldsFrom && row.judge_usage !== undefined) out.judge_usage = row.judge_usage;
  Object.assign(meta, extraMeta);
  out.meta = meta;
  return { row: out };
}

/** The result with a neutral outcome added against the row's OWN variant's reference wherever it has none (that
 *  reference was frozen after the row; a run is never judged against its own variant's — neutral, 0.5, no judge
 *  call), in reference order. */
function withOwnNeutral(result: RunResult, c: HillclimbCase, variant: string, refNames: readonly string[]): RunResult {
  if (!refNames.includes(variant)) return result;
  let k = 0;
  const assertions = (result.assertions ?? []).map((e) => {
    if (e.source !== undefined) return e;
    const i = k++;
    if (c.scenario.assert[i]?.semantic_pairwise === undefined || !e.pairwise || e.pairwise.some((o) => o.ref === variant)) return e;
    const neutral = { ref: variant, ...(variant === "baseline" ? {} : { gate: false as const }), status: "neutral" as const, value: 0.5 };
    const order = (ref: string) => refNames.indexOf(ref);
    return { ...e, pairwise: [...e.pairwise, neutral].sort((a, b) => order(a.ref) - order(b.ref)) };
  });
  return { ...result, assertions };
}

/** The references a row's pairwise asserts have no live outcome against (its own variant's included: neutral, no
 *  judge call, but the column must be there). */
function missingRefs(result: RunResult, c: HillclimbCase, refNames: readonly string[]): string[] {
  const pairwiseIdx = c.scenario.assert.map((a, i) => (a.semantic_pairwise !== undefined ? i : -1)).filter((i) => i >= 0);
  if (!pairwiseIdx.length) return [];
  const authored = (result.assertions ?? []).filter((e) => e.source === undefined);
  return refNames.filter((ref) => pairwiseIdx.some((i) => !(authored[i]?.pairwise ?? []).some((o) => o.ref === ref)));
}

const changedKeys = (before: Record<string, number> | undefined, after: Record<string, number> | undefined): string[] => {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => /^(pass|claims|win|both_bad)/.test(k) && before?.[k] !== after?.[k]);
};

export async function regradeFlow(args: HillclimbRegradeArgs, deps: RegradeFlowDeps): Promise<RegradeFlowOutcome> {
  const say = (l: string) => deps.stderr(l);
  const refuse = (m: string): RegradeFlowOutcome => {
    const line = m.startsWith("refusing") ? m : `refusing to regrade: ${m}`;
    say(line);
    return { exitCode: 2, variants: [], error: { category: "usage", message: line } };
  };
  try {
    return await regradeFlowInner(args, deps, say, refuse);
  } catch (e) {
    if (e instanceof UsageError || e instanceof Error) return refuse(message(e));
    throw e;
  }
}

async function regradeFlowInner(
  args: HillclimbRegradeArgs,
  deps: RegradeFlowDeps,
  say: (l: string) => void,
  refuse: (m: string) => RegradeFlowOutcome,
): Promise<RegradeFlowOutcome> {
  const flowArg = normalizeRootArg(args.flow);
  const flowAbs = resolve(deps.cwd, flowArg);
  if (!lexists(flowAbs)) throw new UsageError(`no flow dir at ${flowArg}`);
  const { cases: all } = loadCases(resolve(deps.cwd, args.target));
  const cases = selectCases(all, args.cases);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const prep = prepareCases(all, { env: deps.env, ...(args.judgeModel !== undefined ? { judgeModelFlag: args.judgeModel } : {}) });

  // The variants: every one with rows, or the one named. Read-only checks first — opening a writer creates files.
  const variants =
    args.variant === "all"
      ? NoFollowRoot.existing(flowArg, { cwd: deps.cwd })
          .readdirNoFollow(flowAbs)
          .filter((d) => d.isDirectory() && VARIANT_DIR_RE.test(d.name))
          .map((d) => d.name)
          .filter((v) => readVariantFileIfPresent(flowArg, v, "results.jsonl", deps.cwd) !== null)
          .sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : Number(a.slice(1)) - Number(b.slice(1))))
      : [args.variant];
  if (args.variant !== "all" && !VARIANT_DIR_RE.test(args.variant))
    throw new UsageError(`--variant must be 'all', 'baseline' or 'v<N>' (got ${JSON.stringify(args.variant)})`);
  for (const v of variants)
    if (readVariantFileIfPresent(flowArg, v, "results.jsonl", deps.cwd) === null)
      throw new UsageError(`${join(flowArg, v)} has no results.jsonl`);
  if (!variants.length) throw new UsageError(`${flowArg} has no variant with rows to re-grade`);

  // The harness gate, exactly as `run` applies it: a rubric fix is a gated scenario edit.
  const state = readStateIfPresent(flowArg, deps.cwd);
  const baselineIds = [...new Set(all.map((c) => prep.baseline(c).appVersion))].sort();
  const digest = harnessDigest({
    cwd: deps.cwd,
    listed: Array.isArray(state.harness_paths) ? state.harness_paths.map(String) : [],
    derived: prep.derivedPaths(all),
    virtual: { ...prep.derivedValues(all), "cowork-harness-version": deps.harnessVersion ?? pkgVersion(), baseline: baselineIds.join(",") },
  });
  const decision = gateDecision(state, digest.sha, args.approveHarness);
  if (decision.kind === "absent")
    return refuse(
      `no approved harness sha in ${join(flowArg, "_state.json")} (computed ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")}). Review the harness, then run once with --approve-harness to record it.`,
    );
  if (decision.kind === "mismatch")
    return refuse(
      `harness changed since last approved run (files: ${digest.hashed.join(", ")}); approved ${String(state.harness_sha).slice(0, 12)}, now ${digest.sha.slice(0, 12)}. Re-run with --approve-harness after reviewing the diff.`,
    );

  // Lock every selected variant (sorted), all or nothing.
  const writers = new Map<string, FlowWriter>();
  const releases: Array<() => void> = [];
  try {
    for (const v of variants) {
      const w = FlowWriter.open(flowArg, v, { cwd: deps.cwd, secrets: deps.secrets });
      releases.push(w.lock());
      writers.set(v, w);
    }
    if (decision.kind === "approve") {
      writers.get(variants[0]!)!.approveHarness(digest.sha);
      say(
        `harness approved: sha256 ${digest.sha.slice(0, 12)} over ${digest.hashed.length} file(s) recorded in ${join(flowArg, "_state.json")}`,
      );
    }

    const refs = discoverFlowRefs(flowAbs);
    const refNames = refs.map((r) => r.name);
    const metricRefs = metricRefNames(refs);
    const outcome: RegradeFlowOutcome = { exitCode: 0, variants: [] };

    // Rows, grouped into batches: one regrade call per (variant, case, references to fill).
    interface Batch {
      variant: string;
      c: HillclimbCase;
      onlyRefs?: string[];
      targets: Target[];
    }
    const batches: Batch[] = [];
    const plain: Target[] = []; // rows re-graded with no judge call (fill mode: nothing missing, or an agent failure)
    const perVariant = new Map<string, { lines: Line[]; old: string; v: RegradeFlowVariant }>();
    for (const v of variants) {
      const old = writers.get(v)!.readVariantFile("results.jsonl") ?? "";
      const lines: Line[] = old
        .split("\n")
        .filter((l, i, a) => !(i === a.length - 1 && l === ""))
        .map((raw) => {
          try {
            const row = JSON.parse(raw) as Row;
            return row && typeof row === "object" ? { raw, row } : { raw };
          } catch {
            return { raw }; // a torn line is kept as it is
          }
        });
      const vr: RegradeFlowVariant = { variant: v, rewritten: 0, listed: [], regradeFiles: [] };
      perVariant.set(v, { lines, old, v: vr });
      outcome.variants.push(vr);
      const groups = new Map<string, Batch>();
      for (const line of lines) {
        const row = line.row;
        if (!row) continue;
        const id = String(row.prompt_id);
        const rep = Number(row.rep);
        const c = byId.get(id);
        if (!c) {
          if (!args.cases.length) vr.listed.push({ prompt_id: id, rep, why: "no scenario file for this case in the target" });
          continue;
        }
        const judged = c.scenario.assert.some((a) => a.semantic_matches !== undefined || a.semantic_pairwise !== undefined);
        if (!judged) continue; // nothing to re-grade: the row stands
        const runDir = runDirOf(row, c);
        const result = runDir ? readResult(runDir) : undefined;
        if (!runDir || !result) {
          vr.listed.push({ prompt_id: id, rep, why: "its kept run dir is gone (evidence unavailable)" });
          continue;
        }
        const agentFailed = classifyRep({ result: result as never }, {}).bucket === "errored_agent";
        const t: Target = { variant: v, c, line, runDir, result, missing: args.fillRefs ? missingRefs(result, c, refNames) : [] };
        if (args.fillRefs ? agentFailed || !t.missing.filter((r) => r !== v).length : agentFailed) {
          // No comparison to judge: an agent failure scores 0 whatever the judge says, and a row lacking only its own
          // variant's (neutral) outcome needs no judge call. A fill still rebuilds it, so it carries every column.
          if (args.fillRefs) plain.push(t);
          continue;
        }
        const key = `${id}\0${args.fillRefs ? t.missing.join(",") : ""}`;
        const b = groups.get(key) ?? { variant: v, c, ...(args.fillRefs ? { onlyRefs: t.missing } : {}), targets: [] };
        b.targets.push(t);
        groups.set(key, b);
      }
      batches.push(...groups.values());
      // An error row a judge outage wrote (judge_invalid) is not promoted into results.jsonl here: its slot is still
      // open, so the next `hillclimb run` pass of this variant re-runs it. Listed so the slot is not forgotten.
      const scored = new Set(lines.flatMap((l) => (l.row ? [`${String(l.row.prompt_id)}\0${String(l.row.rep)}`] : [])));
      for (const raw of (writers.get(v)!.readVariantFile("errors.jsonl") ?? "").split("\n")) {
        let e: Row | undefined;
        try {
          e = raw.trim() ? (JSON.parse(raw) as Row) : undefined;
        } catch {
          e = undefined;
        }
        if (!e || (e as { failure_class?: unknown }).failure_class !== "judge_invalid") continue;
        const id = String(e.prompt_id);
        if (args.cases.length && !byId.has(id)) continue;
        if (scored.has(`${id}\0${String(e.rep)}`)) continue;
        vr.listed.push({
          prompt_id: id,
          rep: Number(e.rep),
          why: `an errors.jsonl row (judge_invalid): its slot is open — \`hillclimb run ${args.target} --flow ${flowArg} --variant ${v}\` re-runs it (one agent run)`,
        });
      }
    }

    const optsFor = (b: Batch, checkOnly: boolean) => ({
      runDirs: b.targets.map((t) => t.runDir),
      scenarioFile: b.c.file,
      secrets: [...deps.secrets],
      ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
      ...(args.allowDocDrift ? { allowDocDrift: true } : {}),
      ...(args.allowUnchecked ? { allowUnchecked: true } : {}),
      pairwise: { ...flowPairwiseOptions(b.c.id, b.variant, refs), ...(b.onlyRefs ? { onlyRefs: b.onlyRefs } : {}) },
      ...(deps.regradeOptions ?? {}),
      ...(checkOnly ? { checkOnly: true as const } : {}),
    });

    // Before any spend, anywhere: every batch's evidence preflight. A drift or unchecked-content refusal lists every
    // run it names and rewrites nothing; a batch refused for another reason is listed and skipped.
    const skip = new Set<Batch>();
    const evidence: string[] = [];
    for (const b of batches) {
      const pre = (await regradeRuns(optsFor(b, true))) as RegradeOutcome | { ok: true };
      if (pre.ok) continue;
      const vr = perVariant.get(b.variant)!.v;
      if ("code" in pre && (pre.code === "doc_drift" || pre.code === "unchecked_content")) {
        for (const r of pre.refusals ?? []) {
          const t = b.targets.find((x) => real(x.runDir) === real(r.runDir));
          const where = t ? `${b.variant} ${b.c.id} rep${String(t.line.row?.rep)}` : `${b.variant} ${b.c.id}`;
          evidence.push(`${where}: ${r.code}${r.uncheckedCount ? ` (${r.uncheckedCount} unchecked section(s))` : ""}`);
        }
        continue;
      }
      if ("code" in pre && pre.code === "no_semantic_asserts") {
        skip.add(b);
        continue;
      }
      skip.add(b);
      for (const t of b.targets)
        vr.listed.push({ prompt_id: b.c.id, rep: Number(t.line.row?.rep), why: `refused: ${pre.message.split("\n")[0]}` });
    }
    if (evidence.length)
      return refuse(
        `the kept evidence cannot be re-graded as the live judge read it — nothing was re-graded or written:\n  ${evidence.join("\n  ")}\n  (--allow-doc-drift / --allow-unchecked accept it, after reading why)`,
      );

    // The spend.
    const rebuilt = new Map<Line, Row>();
    const before = new Map<Line, Record<string, number> | undefined>();
    const at = new Date().toISOString();
    for (const b of batches) {
      if (skip.has(b)) continue;
      const vr = perVariant.get(b.variant)!.v;
      const r = (await regradeRuns(optsFor(b, false) as RegradeOptions)) as RegradeOutcome;
      const reports = r.ok ? r.runs : "completed" in r && r.completed ? r.completed : [];
      if (!r.ok) say(`  [${b.variant}] ${b.c.id}: ${r.message.split("\n")[0]}`);
      for (const t of b.targets) {
        const rep = Number(t.line.row?.rep);
        const report = reports.find((x) => real(x.runDir) === real(t.runDir));
        if (!report) {
          vr.listed.push({ prompt_id: b.c.id, rep, why: r.ok ? "no report for its run dir" : `stopped: ${r.message.split("\n")[0]}` });
          continue;
        }
        vr.regradeFiles.push(shownRunPath(report.regradeFile, deps.secrets));
        const copy = regradedResult(t.result, report);
        const got = rebuiltRow(
          t.line.row!,
          copy,
          b.c,
          metricRefs,
          {
            regrade_doc_matches_live: report.docMatchesLive,
            regrade_unchecked: report.uncheckedCount,
            regrade_file: shownRunPath(report.regradeFile, deps.secrets),
            regraded_at: at,
            ...(args.fillRefs
              ? { regrade_fill: b.onlyRefs, ...(report.judgeCostUsd !== undefined ? { regrade_judge_usd: report.judgeCostUsd } : {}) }
              : {}),
          },
          args.fillRefs ? undefined : copy,
          report,
        );
        if ("why" in got) {
          vr.listed.push({ prompt_id: b.c.id, rep, why: got.why });
          continue;
        }
        before.set(t.line, t.line.row!.grade);
        rebuilt.set(t.line, got.row);
      }
    }
    for (const t of plain) {
      const got = rebuiltRow(
        t.line.row!,
        withOwnNeutral(t.result, t.c, t.variant, refNames),
        t.c,
        metricRefs,
        { regraded_at: at, regrade_fill: t.missing },
        undefined,
        undefined,
      );
      if ("why" in got) perVariant.get(t.variant)!.v.listed.push({ prompt_id: t.c.id, rep: Number(t.line.row?.rep), why: got.why });
      else {
        before.set(t.line, t.line.row!.grade);
        rebuilt.set(t.line, got.row);
      }
    }

    // Write each variant atomically; untouched lines byte for byte.
    const report: string[] = [];
    for (const v of variants) {
      const pv = perVariant.get(v)!;
      const w = writers.get(v)!;
      const changed = pv.lines.filter((l) => rebuilt.has(l));
      if (changed.length) {
        const text = pv.lines.map((l) => (rebuilt.has(l) ? JSON.stringify(w.redactRow(rebuilt.get(l)!)) : l.raw)).join("\n") + "\n";
        pv.v.backup = w.rewriteResults(text, pv.old);
        pv.v.rewritten = changed.length;
      }
      const moved = changed.map((l) => ({ l, keys: changedKeys(before.get(l), rebuilt.get(l)!.grade) })).filter((x) => x.keys.length);
      const mean = (rows: Array<Record<string, number> | undefined>) => {
        const xs = rows.map((g) => g?.pass).filter((x): x is number => typeof x === "number");
        return xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : "n/a";
      };
      const lines = [
        `# ${v}: hillclimb regrade ${at}${args.fillRefs ? " (--fill-refs)" : ""}`,
        "",
        `rewritten ${pv.v.rewritten}, listed ${pv.v.listed.length}; mean pass before ${mean(changed.map((l) => before.get(l)))}, after ${mean(changed.map((l) => rebuilt.get(l)!.grade))}`,
        ...(moved.length ? ["", "| case | rep | moved |", "|---|---|---|"] : []),
        ...moved.map(({ l, keys }) => {
          const b = before.get(l) ?? {};
          const a = rebuilt.get(l)!.grade ?? {};
          return `| ${String(l.row!.prompt_id)} | ${String(l.row!.rep)} | ${keys.map((k) => `${k} ${b[k] ?? "—"}→${a[k] ?? "—"}`).join(", ")} |`;
        }),
        ...(pv.v.listed.length ? ["", "Not re-graded:", ...pv.v.listed.map((x) => `- ${x.prompt_id} rep${x.rep}: ${x.why}`)] : []),
        "",
      ];
      if (changed.length || pv.v.listed.length) w.writeRegradeReport(lines.join("\n"));
      report.push(
        ...lines
          .slice(2)
          .filter(Boolean)
          .map((x) => `  [${v}] ${x}`),
      );
    }
    for (const l of report) say(l);
    for (const vr of outcome.variants) {
      const open = vr.listed.filter((x) => x.why.startsWith("an errors.jsonl row (judge_invalid)")).length;
      if (open)
        say(
          `  [${vr.variant}] ${open} slot(s) hold a judge_invalid error row; the next \`hillclimb run ${args.target} --flow ${flowArg} --variant ${vr.variant}\` re-runs them (about one agent run each)`,
        );
    }
    outcome.exitCode = outcome.variants.some((v) => v.listed.length) ? 1 : 0;
    say(
      `hillclimb regrade: ${outcome.variants.map((v) => `${v.variant} ${v.rewritten} rewritten${v.listed.length ? `, ${v.listed.length} listed` : ""}`).join("; ")}`,
    );
    return outcome;
  } finally {
    for (const r of releases.reverse()) r();
  }
}
