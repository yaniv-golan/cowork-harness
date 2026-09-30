// The eval report: built from `manifest.json` + `runs.jsonl` alone, by ONE function that both the live eval
// and `eval report <dir>` call — so the two are byte-identical by construction. Pure apart from reading and
// writing the eval dir: no clock, no environment beyond $HOME (for `~` redaction).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRep,
  repRowValues,
  scenarioRows,
  armMedians,
  type ArmMedians,
  type RepBucket,
  type RowKey,
  type RepClassification,
} from "./classify.js";
import {
  attainableFloor,
  evaluateFamily,
  insufficientThreshold,
  minRowsToConfirm,
  ceilingRowCount,
  zeroRowCount,
  type FamilyRowOutput,
  type Mdd,
} from "./stats.js";
import { readManifest, type EvalManifest } from "./manifest.js";
import { readRunsLines, repEvidenceOf, RUNS_FILE, type RunsLine } from "./runs.js";
import { hostPathTokenOccurrences } from "../run/host-path-tokens.js";
import { tildeify } from "../io.js";

export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";

type RowKind = "assertion" | "claim" | "semantic_rollup" | "errored_agent_rate" | "invocation_rate";

export interface ReportRow extends FamilyRowOutput {
  scenario: string | null;
  kind: RowKind;
  /** Display text: the assertion key, or the claim. */
  text: string;
  assertionIndex?: number;
  minPass?: number | "all";
  /** In the section's correction family (claim and non-semantic assertion rows); derived rows are not. */
  inFamily: boolean;
  /** Reconciles the interval with the exact test when they point different ways. */
  note?: string;
  /** For a `possible`/`confirmed` row: run dirs where A passed and B failed (a drop), or the reverse. */
  evidence?: { a: string[]; b: string[] };
}

export interface ReportSection {
  scenarios: string[];
  /** Tested rows in the correction family. */
  m: number;
  floorAtFullReps: number;
  minRowsToConfirm: number | null;
  confirmableRows: number;
  ceilingRows: number;
  zeroRows: number;
  rows: ReportRow[];
  derivedRows: ReportRow[];
  classificationRows: ReportRow[];
}

export interface ReportArm {
  label: string;
  role: "A" | "B";
  source: string;
  fileSet: string;
  fileCount: number;
  untrackedExcluded: number;
  scheduled: number;
  recorded: number;
  buckets: Partial<Record<RepBucket, number>>;
  errorSources: Record<string, number>;
  unclassified: number;
  ambiguousExit: number;
  medians: ArmMedians;
}

export interface EvalReport {
  schemaVersion: 0;
  evalId: string;
  startedAt: string;
  harnessVersion: string;
  arms: ReportArm[];
  settings: EvalManifest["settings"] & { threshold: number };
  pins: EvalManifest["pins"];
  skill: string | null;
  sections: { tuned: ReportSection | null; heldOut: ReportSection | null };
  judgeDisagreements: Array<{ scenario: string; assertionIndex: number; models: string[] }>;
  summary: {
    familyRows: number;
    labels: Record<string, number>;
    allInsufficient: boolean;
    failOnHit: boolean;
    judgeDisagreement: boolean;
    missingJobs: number;
    tornFinalLine: boolean;
    exitCode: 0 | 1;
  };
  cost: { agentUsd: number; judgeUsd: number };
  stoppedEarly: null;
  redactedHostPaths: number;
}

const SCORED: ReadonlySet<RepBucket> = new Set(["valid", "judge_invalid", "errored_agent"]);

interface ClassifiedLine {
  line: RunsLine;
  c: RepClassification;
}

function sumFinite(xs: Array<number | undefined>): number {
  return xs.reduce<number>((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
}

const normalizeModel = (m: string) => m.replace(/\[\dm\]$/i, "").toLowerCase();

function noteFor(r: FamilyRowOutput): string | undefined {
  if (!r.interval || r.label === "insufficient") return undefined;
  const excludes0 = r.interval.lower > 0 || r.interval.upper < 0;
  const flagged = r.label.startsWith("possible") || r.label.startsWith("confirmed");
  if (excludes0 && !flagged) return "interval excludes 0, but the exact test at this n cannot confirm it; see MDD";
  if (!excludes0 && flagged) return "the exact test flags it, though the interval still includes 0";
  return undefined;
}

/** Derived rows are shown with their own test but never corrected, so at most `possible`. */
function asDerived(r: FamilyRowOutput): FamilyRowOutput {
  const { adjustedP: _drop, ...rest } = r;
  void _drop;
  const label = r.label === "confirmed drop" ? "possible drop" : r.label === "confirmed rise" ? "possible rise" : r.label;
  return { ...rest, label };
}

function sectionOf(m: EvalManifest, scenarioNames: string[], classified: ClassifiedLine[], threshold: number): ReportSection {
  const [A, B] = m.arms;
  const opts = { correction: m.settings.correction, q: m.settings.q, alpha: m.settings.alpha, threshold };
  const familyInputs: Array<{
    key: RowKey;
    k1: number;
    n1: number;
    k2: number;
    n2: number;
    a: Array<[string, 0 | 1]>;
    b: Array<[string, 0 | 1]>;
  }> = [];
  const derivedInputs: typeof familyInputs = [];
  for (const name of scenarioNames) {
    const scen = m.scenarios.find((s) => s.name === name)!;
    const rows = scenarioRows(name, scen.assertions);
    const perRow = new Map(
      rows.map((row) => [
        row.id,
        { key: row, k1: 0, n1: 0, k2: 0, n2: 0, a: [] as Array<[string, 0 | 1]>, b: [] as Array<[string, 0 | 1]> },
      ]),
    );
    for (const { line, c } of classified) {
      if (line.scenario !== name) continue;
      const ev = repEvidenceOf(line);
      for (const v of repRowValues(rows, scen.assertions, c, ev.result)) {
        if (v.value === undefined) continue;
        const acc = perRow.get(v.row.id)!;
        const dir = line.runDir ?? "(no run dir)";
        if (line.arm === A.label) {
          acc.n1++;
          acc.k1 += v.value;
          acc.a.push([dir, v.value]);
        } else if (line.arm === B.label) {
          acc.n2++;
          acc.k2 += v.value;
          acc.b.push([dir, v.value]);
        }
      }
    }
    for (const acc of perRow.values()) (acc.key.kind === "semantic_rollup" ? derivedInputs : familyInputs).push(acc);
  }
  const fam = evaluateFamily(
    familyInputs.map((x) => ({ id: x.key.id, k1: x.k1, n1: x.n1, k2: x.k2, n2: x.n2 })),
    opts,
  );
  const der = evaluateFamily(
    derivedInputs.map((x) => ({ id: x.key.id, k1: x.k1, n1: x.n1, k2: x.k2, n2: x.n2 })),
    opts,
  );
  const withMeta = (inputs: typeof familyInputs, outs: FamilyRowOutput[], inFamily: boolean): ReportRow[] =>
    outs.map((o, i) => {
      const x = inputs[i];
      const base = inFamily ? o : asDerived(o);
      const scen = m.scenarios.find((s) => s.name === x.key.scenario)!;
      const assertion = scen.assertions[x.key.assertionIndex];
      const flagged = base.label.startsWith("possible") || base.label.startsWith("confirmed");
      const evidence = flagged
        ? base.direction === "drop"
          ? {
              a: x.a
                .filter(([, v]) => v === 1)
                .slice(0, 2)
                .map(([d]) => d),
              b: x.b
                .filter(([, v]) => v === 0)
                .slice(0, 2)
                .map(([d]) => d),
            }
          : {
              a: x.a
                .filter(([, v]) => v === 0)
                .slice(0, 2)
                .map(([d]) => d),
              b: x.b
                .filter(([, v]) => v === 1)
                .slice(0, 2)
                .map(([d]) => d),
            }
        : undefined;
      const note = noteFor(base);
      return {
        ...base,
        scenario: x.key.scenario,
        kind: x.key.kind,
        text: x.key.kind === "claim" ? x.key.claim! : x.key.label,
        assertionIndex: x.key.assertionIndex,
        ...(x.key.kind === "semantic_rollup" && assertion?.semantic_matches?.min_pass !== undefined
          ? { minPass: assertion.semantic_matches.min_pass }
          : {}),
        inFamily,
        ...(note ? { note } : {}),
        ...(evidence ? { evidence } : {}),
      };
    });
  const rows = withMeta(familyInputs, fam.rows, true);
  const derivedRows = withMeta(derivedInputs, der.rows, false);

  // Classification rows: the errored-by-agent rate and the invocation rate, over the scored reps.
  const inSection = classified.filter((x) => scenarioNames.includes(x.line.scenario) && SCORED.has(x.c.bucket));
  const count = (arm: string, pred: (x: ClassifiedLine) => boolean | undefined) => {
    const reps = inSection.filter((x) => x.line.arm === arm);
    const decided = reps.filter((x) => pred(x) !== undefined);
    return { n: decided.length, k: decided.filter((x) => pred(x) === true).length };
  };
  const erroredPred = (x: ClassifiedLine) => x.c.bucket === "errored_agent";
  const invokedPred = (x: ClassifiedLine) => {
    const f = x.line.evidence?.invoked;
    return f === undefined || f === "unobservable" ? undefined : f;
  };
  const cls = [
    {
      id: "errored_agent_rate",
      kind: "errored_agent_rate" as const,
      text: "errored by the agent (rate; a rise is worse)",
      pred: erroredPred,
    },
    {
      id: "invocation_rate",
      kind: "invocation_rate" as const,
      text: `skill invoked${m.skill ? ` (${m.skill})` : ""} (rate, observable reps only)`,
      pred: invokedPred,
    },
  ].map((d) => {
    const a = count(A.label, d.pred);
    const b = count(B.label, d.pred);
    return { d, row: { id: d.id, k1: a.k, n1: a.n, k2: b.k, n2: b.n } };
  });
  const clsOut = evaluateFamily(
    cls.map((x) => x.row),
    opts,
  );
  const classificationRows: ReportRow[] = clsOut.rows.map((o, i) => {
    const base = asDerived(o);
    const note = noteFor(base);
    return { ...base, scenario: null, kind: cls[i].d.kind, text: cls[i].d.text, inFamily: false, ...(note ? { note } : {}) };
  });

  const full = m.settings.reps;
  const floorAtFullReps = attainableFloor(full, full);
  return {
    scenarios: scenarioNames,
    m: fam.m,
    floorAtFullReps,
    minRowsToConfirm: fam.m > 0 ? fam.minRowsToConfirm : minRowsToConfirm(floorAtFullReps, familyInputs.length, opts),
    confirmableRows: fam.confirmableRows,
    ceilingRows: ceilingRowCount(familyInputs),
    zeroRows: zeroRowCount(familyInputs),
    rows,
    derivedRows,
    classificationRows,
  };
}

/** Build the report model from the eval dir's manifest and runs. */
export function buildEvalReport(evalDir: string): EvalReport {
  const m = readManifest(evalDir);
  const { lines, tornFinalLine } = readRunsLines(join(evalDir, RUNS_FILE));
  const sigFor = (arm: string, scenario: string) => m.arms.find((a) => a.label === arm)?.sigs[scenario];
  const classified: ClassifiedLine[] = lines.map((line) => ({
    line,
    c: classifyRep(repEvidenceOf(line), { contentSig: sigFor(line.arm, line.scenario), judgePromptHash: m.pins.judge.promptHash }),
  }));
  const threshold = insufficientThreshold(m.settings.reps, m.settings.allowUnderpowered);
  const tunedNames = m.scenarios.filter((s) => !s.heldOut).map((s) => s.name);
  const heldNames = m.scenarios.filter((s) => s.heldOut).map((s) => s.name);
  const tuned = tunedNames.length ? sectionOf(m, tunedNames, classified, threshold) : null;
  const heldOut = heldNames.length ? sectionOf(m, heldNames, classified, threshold) : null;

  const arms: ReportArm[] = m.arms.map((a) => {
    const mine = classified.filter((x) => x.line.arm === a.label);
    const buckets: Partial<Record<RepBucket, number>> = {};
    const errorSources: Record<string, number> = {};
    for (const x of mine) {
      buckets[x.c.bucket] = (buckets[x.c.bucket] ?? 0) + 1;
      const key = x.line.thrown
        ? `thrown:${x.line.thrown.kind}`
        : (x.c.termination.errorSource ?? (x.line.result?.result === "success" ? "none" : "unset"));
      errorSources[key] = (errorSources[key] ?? 0) + 1;
    }
    return {
      label: a.label,
      role: a.role,
      source: a.source,
      fileSet: a.fileSet,
      fileCount: a.fileCount,
      untrackedExcluded: a.untrackedExcluded,
      scheduled: m.settings.reps * m.scenarios.length,
      recorded: mine.length,
      buckets: Object.fromEntries(Object.entries(buckets).sort(([x], [y]) => x.localeCompare(y))),
      errorSources: Object.fromEntries(Object.entries(errorSources).sort(([x], [y]) => x.localeCompare(y))),
      unclassified: mine.filter((x) => x.c.termination.unclassified).length,
      ambiguousExit: mine.filter((x) => x.c.termination.ambiguousExit).length,
      medians: armMedians(mine.map((x) => ({ bucket: x.c.bucket, result: repEvidenceOf(x.line).result }))),
    };
  });

  // The judge must be one model per assertion across every scored rep that graded it (a judge_invalid grade
  // excluded). A tripwire that can only fire after spend, by construction.
  const judgeSeen = new Map<string, { scenario: string; assertionIndex: number; models: Set<string> }>();
  for (const { line, c } of classified) {
    if (!SCORED.has(c.bucket)) continue;
    const authored = (line.grades[0]?.assertions ?? []).filter((g) => g.source === undefined);
    authored.forEach((g, i) => {
      if (!g.assertion.semantic_matches || g.judgeInvalid === true || typeof g.judgeModel !== "string") return;
      const k = JSON.stringify([line.scenario, i]);
      const e = judgeSeen.get(k) ?? { scenario: line.scenario, assertionIndex: i, models: new Set<string>() };
      e.models.add(normalizeModel(g.judgeModel));
      judgeSeen.set(k, e);
    });
  }
  const judgeDisagreements = [...judgeSeen.values()]
    .filter((e) => e.models.size > 1)
    .map((e) => ({ scenario: e.scenario, assertionIndex: e.assertionIndex, models: [...e.models].sort() }));

  const familyRows = [...(tuned?.rows ?? []), ...(heldOut?.rows ?? [])];
  const gatingRows = [...familyRows, ...(tuned?.derivedRows ?? []), ...(heldOut?.derivedRows ?? [])];
  const labels: Record<string, number> = {};
  for (const r of familyRows) labels[r.label] = (labels[r.label] ?? 0) + 1;
  const failOnHit =
    m.settings.failOn !== null &&
    gatingRows.some((r) =>
      m.settings.failOn === "confirmed" ? r.label === "confirmed drop" : r.label === "possible drop" || r.label === "confirmed drop",
    );
  const allInsufficient = familyRows.length > 0 && familyRows.every((r) => r.label === "insufficient");
  const judgeDisagreement = judgeDisagreements.length > 0;
  const recordedIdx = new Set(lines.map((l) => l.index));
  const missingJobs = m.settings.reps * m.scenarios.length * 2 - recordedIdx.size;
  return {
    schemaVersion: 0,
    evalId: m.evalId,
    startedAt: m.startedAt,
    harnessVersion: m.harnessVersion,
    arms,
    settings: { ...m.settings, threshold },
    pins: m.pins,
    skill: m.skill,
    sections: { tuned, heldOut },
    judgeDisagreements,
    summary: {
      familyRows: familyRows.length,
      labels: Object.fromEntries(Object.entries(labels).sort(([x], [y]) => x.localeCompare(y))),
      allInsufficient,
      failOnHit,
      judgeDisagreement,
      missingJobs,
      tornFinalLine,
      exitCode: failOnHit || allInsufficient || judgeDisagreement ? 1 : 0,
    },
    cost: {
      agentUsd: sumFinite(lines.map((l) => l.result?.cost?.usd)),
      judgeUsd: sumFinite(lines.flatMap((l) => (l.grades[0]?.assertions ?? []).map((a) => a.judgeCostUsd))),
    },
    stoppedEarly: null,
    redactedHostPaths: 0,
  };
}

// ---- markdown ------------------------------------------------------------------------------------------

const pct = (k: number, n: number) => (n === 0 ? "—" : `${k}/${n} (${Math.round((100 * k) / n)}%)`);
const fmtP = (p: number | undefined) => (p === undefined ? "—" : p < 0.0001 ? p.toExponential(1) : p.toFixed(4));
const fmtDiff = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}pp`;
const fmtMdd = (d: Mdd) => (d === "n/a" ? "n/a" : d === "none" ? "none at this n" : `${Math.round(d * 100)}pp`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const fmtUsd = (x: number | undefined) => (x === undefined ? "—" : `$${x.toFixed(4)}`);

function rowLine(r: ReportRow): string {
  const tested = r.label !== "insufficient";
  const ci = r.interval ? `${fmtDiff(r.interval.difference)} [${fmtDiff(r.interval.lower)}, ${fmtDiff(r.interval.upper)}]` : "—";
  const mdd = r.mdd && r.label === "no detectable change" ? `MDD drop ${fmtMdd(r.mdd.drop)}, rise ${fmtMdd(r.mdd.rise)}` : "";
  const note = [r.minPass !== undefined ? `min_pass ${r.minPass}` : "", mdd, r.note ?? ""].filter(Boolean).join("; ");
  const where = r.scenario ? `${r.scenario} #${r.assertionIndex}${r.kind === "claim" ? " claim" : ""}` : "";
  return `| ${cell(where)} | ${cell(r.text)} | ${pct(r.k1, r.n1)} | ${pct(r.k2, r.n2)} | ${ci} | ${tested ? fmtP(r.p) : "—"} | ${tested ? fmtP(r.adjustedP) : "—"} | **${r.label}** | ${cell(note)} |`;
}

const TABLE_HEAD = [
  "| row | assertion / claim | A | B | B − A [95% CI] | p | adj. p | label | note |",
  "|---|---|---|---|---|---|---|---|---|",
];

function renderSection(title: string, s: ReportSection, rep: EvalReport): string[] {
  const out: string[] = [`## ${title}`, ""];
  const reps = rep.settings.reps;
  const level = rep.settings.correction === "bh" ? `BH at q = ${rep.settings.q}` : `Holm at alpha = ${rep.settings.alpha}`;
  if (s.rows.length === 0) out.push("No rows.", "");
  else {
    out.push(`Scenarios: ${s.scenarios.join(", ")}. Correction family: ${s.m} tested row(s) (${level}).`);
    out.push(
      `Attainable p floor at ${reps} vs ${reps} valid reps: ${fmtP(s.floorAtFullReps)}${s.floorAtFullReps > rep.settings.alpha ? ` — above alpha ${rep.settings.alpha}: no row can be flagged at this n` : ""}. ` +
        (s.minRowsToConfirm === null
          ? "`confirmed` is unreachable in this section at this n."
          : `\`confirmed\` needs ≥ ${s.minRowsToConfirm} row(s) at the floor; confirmable rows now: ${s.confirmableRows}.`),
    );
    out.push(
      `Ceiling: ${s.ceilingRows} row(s) at 100% in both arms: an improvement is undetectable for them. ${s.zeroRows} row(s) at 0% in both arms: a drop is undetectable for them.`,
    );
    out.push("", ...TABLE_HEAD, ...s.rows.map(rowLine), "");
  }
  const flagged = [...s.rows, ...s.derivedRows].filter((r) => r.evidence);
  if (flagged.length) {
    out.push("Evidence (run dirs; may be gone after `prune`):");
    for (const r of flagged)
      out.push(
        `- ${r.scenario} #${r.assertionIndex} ${r.kind === "claim" ? `"${r.text}"` : r.text} — ${r.label}: A ${r.direction === "drop" ? "passed" : "failed"} in ${r.evidence!.a.join(", ") || "—"}; B ${r.direction === "drop" ? "failed" : "passed"} in ${r.evidence!.b.join(", ") || "—"}`,
      );
    out.push("");
  }
  if (s.derivedRows.length) {
    out.push(
      "Derived rows — semantic_matches roll-ups (a function of their claims via min_pass). Not in the correction family, never `confirmed`; a `possible drop` here still counts for `--fail-on possible`:",
      "",
      ...TABLE_HEAD,
      ...s.derivedRows.map(rowLine),
      "",
    );
  }
  out.push("Classification rows — diagnostic, not in the family, never gate:", "", ...TABLE_HEAD, ...s.classificationRows.map(rowLine), "");
  return out;
}

const REDACTION_PLACEHOLDER = "@@EVAL_REDACTION_COUNT@@";

export function renderReportMarkdown(rep: EvalReport): { text: string; redacted: number } {
  const L: string[] = [];
  const [A, B] = rep.arms;
  L.push(`# Paired evaluation ${rep.evalId}`, "");
  L.push(`Started ${rep.startedAt} · cowork-harness ${rep.harnessVersion} · EXPERIMENTAL (report schema and labels may change)`, "");
  L.push("Units: runs × grades — each rep is one run, graded once. **A drop is a signal to investigate, not proof.**", "");
  for (const a of [A, B])
    L.push(
      `- **${a.role} ${a.role === "A" ? "(baseline)" : "(candidate)"}: ${a.label}** = \`${a.source}\` — ${a.fileCount} file(s), ${a.untrackedExcluded} untracked excluded (${a.fileSet})`,
    );
  L.push("");
  const s = rep.settings;
  L.push(
    `Reps: ${s.reps} per arm per scenario, scheduled ABBA (rep 1 runs A then B, rep 2 B then A, …); a row needs ≥ ${s.threshold} valid reps per arm${s.allowUnderpowered ? " (--allow-underpowered)" : ""}. ` +
      `Correction: ${s.correction === "bh" ? `bh (q = ${s.q}, fixed)` : "holm"}, within each section; alpha ${s.alpha}. ${s.failOn === null ? "No --fail-on: the exit code does not depend on what the rows show." : `--fail-on ${s.failOn}.`}`,
  );
  L.push("Family: claim sub-rows and non-semantic assertion rows. Roll-up and classification rows are shown separately.");
  L.push("No control arm: prior-answerable claims are not flagged.");
  const agentModels = [...new Set(rep.pins.agent.map((p) => p.model))].join(", ");
  const judgeModels = [...new Set(rep.pins.judge.resolved.map((p) => p.model))].join(", ") || "none (no semantic_matches)";
  L.push(
    `Agent model: ${agentModels}. Judge (${rep.pins.judge.mode === "override" ? "--judge-model" : "per assert"}): ${judgeModels}; prompt ${rep.pins.judge.promptHash.slice(0, 12)}.`,
  );
  L.push(`Host paths redacted: ${REDACTION_PLACEHOLDER}.`, "");

  L.push("### Reps per arm", "");
  for (const a of [A, B]) {
    L.push(
      `- ${a.label}: ${a.recorded}/${a.scheduled} recorded; buckets ${
        Object.entries(a.buckets)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      }; errorSource ${
        Object.entries(a.errorSources)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ") || "none"
      }`,
    );
    if (a.unclassified > 0)
      L.push(
        `  - **⚠ UNCLASSIFIED: ${a.unclassified} rep(s) in ${a.label}** — a termination the classification table does not recognise; excluded from the denominator. Read those run dirs before trusting this arm's rates.`,
      );
    if (a.ambiguousExit > 0)
      L.push(
        `  - ⚠ ${a.ambiguousExit} rep(s) ended in a nonzero agent exit — an out-of-memory kill and a skill-caused crash look alike here; scored as the agent's error.`,
      );
    const md = a.medians;
    L.push(
      `  - medians over ${md.eligibleReps} scored rep(s): cost ${fmtUsd(md.costUsd.median)} (n=${md.costUsd.n}), judge ${fmtUsd(md.judgeCostUsd.median)} (n=${md.judgeCostUsd.n}), turns ${md.turns.median ?? "—"} (n=${md.turns.n}), duration ${md.durationMs.median === undefined ? "—" : `${Math.round(md.durationMs.median / 1000)}s`} (n=${md.durationMs.n})`,
    );
  }
  if (rep.summary.missingJobs > 0) L.push(`- ⚠ ${rep.summary.missingJobs} scheduled job(s) have no record (the eval did not finish).`);
  if (rep.summary.tornFinalLine) L.push("- ⚠ runs.jsonl ends in a torn line (skipped).");
  L.push("");
  if (rep.judgeDisagreements.length) {
    L.push("**⚠ Judge model differed across reps** (exit 1):");
    for (const d of rep.judgeDisagreements) L.push(`- ${d.scenario} #${d.assertionIndex}: ${d.models.join(", ")}`);
    L.push("");
  }
  if (rep.sections.tuned) L.push(...renderSection(rep.sections.heldOut ? "Tuned scenarios" : "Rows", rep.sections.tuned, rep));
  if (rep.sections.heldOut) L.push(...renderSection("Held-out scenarios", rep.sections.heldOut, rep));
  L.push("## Summary", "");
  L.push(
    `Labels: ${
      Object.entries(rep.summary.labels)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"
    }.`,
  );
  if (rep.summary.allInsufficient) L.push("Every row is insufficient — see the errorSource histogram above for why reps were lost.");
  L.push(`Cost: agent ${fmtUsd(rep.cost.agentUsd)}, judge ${fmtUsd(rep.cost.judgeUsd)}.`);
  L.push(`Exit: ${rep.summary.exitCode}${rep.summary.failOnHit ? ` (a drop at the --fail-on ${rep.settings.failOn} level)` : ""}.`, "");
  const { text, redacted } = redactHostPaths(L.join("\n"));
  return { text: text.replace(REDACTION_PLACEHOLDER, String(redacted)), redacted };
}

/** Replace each host-path token with its `~` form when it is under $HOME, else `<host-path>`. Deterministic
 *  for a given text and $HOME, so a re-render is byte-identical. */
export function redactHostPaths(text: string): { text: string; redacted: number } {
  const tokens = [...new Set(hostPathTokenOccurrences(text).map((o) => o.token))].sort((a, b) => b.length - a.length);
  let out = text;
  let redacted = 0;
  for (const t of tokens) {
    const home = tildeify(t);
    const replacement = home !== t ? home : "<host-path>";
    const parts = out.split(t);
    if (parts.length > 1) {
      redacted += parts.length - 1;
      out = parts.join(replacement);
    }
  }
  return { text: out, redacted };
}

/** Build, render and write `report.json` + `report.md`. The single path for both the live eval and
 *  `eval report`. */
export function writeEvalReport(evalDir: string): EvalReport {
  const model = buildEvalReport(evalDir);
  const { text, redacted } = renderReportMarkdown(model);
  const withCount = { ...model, redactedHostPaths: redacted };
  writeFileSync(join(evalDir, REPORT_JSON), JSON.stringify(withCount, null, 2) + "\n");
  writeFileSync(join(evalDir, REPORT_MD), text);
  return withCount;
}
