// `critique --summary-out <file>`: a one-object ledger line for a critique, safe to commit to a PUBLIC repository.
//
// Built by ALLOWLIST: a new object assembled field by field from typed values, never "the report minus some keys".
// No finding text (idea, evidence, action), no prompt, no host path, no git ref or path — only identifiers, hashes,
// enums and counts. Every string is checked against the shape its field must have before it is written; a value
// that fails is written as `null` and its field named in `withheld`, never passed through raw. The finished object
// then goes through the critique secret scrub: if the scrub would change anything, the file is not written at all.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { scrubCritiqueJson } from "./scrub-artifacts.js";
import { FINGERPRINT_SCHEME } from "./evidence.js";

export const SUMMARY_SCHEMA = "critique-summary/1";

const RE = {
  hash: /^sha256:[0-9a-f]{64}$/,
  commit: /^[0-9a-f]{40,64}$/,
  fingerprint: /^[0-9a-f]{16}$/,
  model: /^claude-[a-z0-9.-]{1,64}$/,
  skill: /^[A-Za-z0-9_.:-]{1,128}$/,
  label: /^[A-Za-z0-9._:+-]{1,64}$/,
  baseline: /^(desktop-)?\d+\.\d+\.\d+$/,
  version: /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
  session: /^[A-Za-z0-9_-]{1,80}$/,
  fidelity: /^(container|hostloop|protocol|microvm|cowork)$/,
  basis: /^(git-tracked|worktree-all|git-commit)$/,
  classification: /^(grounded-and-actionable|grounded-but-not-worth-it|confabulated|already-covered|not-adjudicable)$/,
  source: /^(evaluator|self-report)$/,
  selfReport: /^(captured|unavailable)$/,
};

export type SummaryStatus = "critiqued" | "task_turn_failed" | "reflection_turn_failed" | "evaluator_failed" | "corpus_only";

export interface SummaryItem {
  findingFingerprint: string;
  classification: string;
  source: string;
  /** false for a `not-adjudicable` item: a finding, but one with no deciding evidence. */
  adjudicable: boolean;
}

export interface CritiqueSummary {
  schema: string;
  harnessVersion: string | null;
  timestamp: string;
  sessionId: string | null;
  gradedSkill: string | null;
  /** `plugin_skill`: a skills/<name> of a plugin; `folder`: a plain skill folder, named by its SKILL.md
   *  frontmatter (else the folder's basename). */
  gradedSkillKind: "plugin_skill" | "folder";
  corpusHashScheme: number | null;
  fingerprintScheme: number;
  hashBasis: string | null;
  corpusHash: string | null;
  packagedCorpusHash: string | null;
  skillTreeHash: string | null;
  source: { kind: "dir" } | { kind: "git"; commit: string | null };
  label: string | null;
  fidelity: string | null;
  gradedBaseline: string | null;
  evaluatorModel: string | null;
  gradedModels: string[];
  status: SummaryStatus;
  selfReportStatus: string | null;
  evaluatorIntegrity: { pass1Canary: boolean | null; pass2Canary: boolean | null } | null;
  droppedEvaluatorItems: { pass1: number; pass2: number } | null;
  corpusCuts: number | null;
  corpusDrift: boolean;
  /** An evaluator reply was missing only its final closing brace, which was appended (see the report's evaluatorRepair). */
  evaluatorRepaired: boolean;
  costUsd?: { totalUsd: number | null; complete: boolean };
  promptSha256?: string;
  items: SummaryItem[];
  /** Fields whose value failed its shape check and were written as null (or, for a list, dropped). */
  withheld: string[];
}

export interface SummaryContext {
  /** The identity of the graded skill, from the resolver (see `CritiqueSummary.gradedSkillKind`). */
  identity: { name: string; kind: "plugin_skill" | "folder" };
  prompt?: string;
  includeCost: boolean;
  includePromptHash: boolean;
  now?: () => Date;
}

/** Build the summary from a critique report (as `buildJsonReport` emits it) or a `--corpus-only` payload. */
export function buildCritiqueSummary(report: Record<string, unknown>, ctx: SummaryContext, corpusOnly = false): CritiqueSummary {
  const withheld: string[] = [];
  const str = (field: string, v: unknown, re: RegExp): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === "string" && re.test(v)) return v;
    withheld.push(field);
    return null;
  };
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

  const src = report.source as { kind?: unknown; commit?: unknown } | undefined;
  const source: CritiqueSummary["source"] =
    src?.kind === "git" ? { kind: "git", commit: str("source.commit", src.commit, RE.commit) } : { kind: "dir" };
  const gradedModels: string[] = [];
  for (const m of Array.isArray(report.gradedModels) ? report.gradedModels : []) {
    if (typeof m === "string" && m.startsWith("<") && m.endsWith(">")) continue; // the agent's own <synthetic> marker
    if (typeof m === "string" && RE.model.test(m)) gradedModels.push(m);
    else if (!withheld.includes("gradedModels")) withheld.push("gradedModels");
  }
  const status: SummaryStatus = corpusOnly
    ? "corpus_only"
    : report.infraFailure
      ? report.infraFailurePhase === "reflection turn"
        ? "reflection_turn_failed"
        : "task_turn_failed"
      : report.evaluatorError
        ? "evaluator_failed"
        : "critiqued";
  const integrity = report.evaluatorIntegrity as { pass1Canary?: unknown; pass2Canary?: unknown } | undefined;
  const dropped = report.droppedEvaluatorItems as { pass1?: unknown; pass2?: unknown } | undefined;
  const budget = (corpusOnly ? report.corpus : report.evidenceBudget) as { corpusCuts?: unknown[] } | undefined;

  // Items: a DROPPED item (citation not verbatim in the evidence) is not a finding and is left out. A not-adjudicable
  // item is kept, marked.
  const items: SummaryItem[] = [];
  for (const it of Array.isArray(report.items) ? (report.items as Array<Record<string, unknown>>) : []) {
    if (it.citationResolved === false) continue;
    const fp = typeof it.findingFingerprint === "string" && RE.fingerprint.test(it.findingFingerprint) ? it.findingFingerprint : null;
    const cls = typeof it.classification === "string" && RE.classification.test(it.classification) ? it.classification : null;
    const s = typeof it.source === "string" && RE.source.test(it.source) ? it.source : null;
    if (fp === null || cls === null || s === null) {
      if (!withheld.includes("items")) withheld.push("items");
      continue;
    }
    items.push({ findingFingerprint: fp, classification: cls, source: s, adjudicable: cls !== "not-adjudicable" });
  }

  const summary: CritiqueSummary = {
    schema: SUMMARY_SCHEMA,
    harnessVersion: str("harnessVersion", report.harnessVersion, RE.version),
    timestamp: (ctx.now ?? (() => new Date()))().toISOString(),
    sessionId: corpusOnly ? null : str("sessionId", report.sessionId, RE.session),
    gradedSkill: str("gradedSkill", ctx.identity.name, RE.skill),
    gradedSkillKind: ctx.identity.kind,
    corpusHashScheme: num(report.corpusHashScheme),
    fingerprintScheme: FINGERPRINT_SCHEME,
    hashBasis: str("hashBasis", report.hashBasis, RE.basis),
    corpusHash: str("corpusHash", report.corpusHash, RE.hash),
    packagedCorpusHash: str("packagedCorpusHash", report.packagedCorpusHash, RE.hash),
    skillTreeHash: str("skillTreeHash", report.skillTreeHash, RE.hash),
    source,
    label: str("label", report.label, RE.label),
    fidelity: str("fidelity", corpusOnly ? undefined : report.fidelity, RE.fidelity),
    gradedBaseline: str("gradedBaseline", report.gradedBaseline, RE.baseline),
    evaluatorModel: str("evaluatorModel", report.evaluatorModel, RE.model),
    gradedModels,
    status,
    selfReportStatus: str("selfReportStatus", corpusOnly ? undefined : report.selfReportStatus, RE.selfReport),
    evaluatorIntegrity: integrity ? { pass1Canary: bool(integrity.pass1Canary), pass2Canary: bool(integrity.pass2Canary) } : null,
    droppedEvaluatorItems: dropped ? { pass1: num(dropped.pass1) ?? 0, pass2: num(dropped.pass2) ?? 0 } : null,
    corpusCuts: Array.isArray(budget?.corpusCuts) ? budget!.corpusCuts!.length : null,
    corpusDrift: report.corpusDrift !== undefined,
    evaluatorRepaired: Array.isArray(report.evaluatorRepair) && report.evaluatorRepair.length > 0,
    items,
    withheld,
  };
  if (ctx.includeCost && !corpusOnly) {
    const c = report.costUsd as { totalUsd?: unknown; complete?: unknown } | undefined;
    summary.costUsd = { totalUsd: num(c?.totalUsd), complete: c?.complete === true };
  }
  if (ctx.includePromptHash && ctx.prompt !== undefined) summary.promptSha256 = createHash("sha256").update(ctx.prompt).digest("hex");
  return summary;
}

/** Write the summary, or — if the secret scrub would change any value in it — withhold it with a warning. Never
 *  changes the exit code: the critique itself already ran (or failed) on its own terms. Returns whether it wrote. */
export function writeSummaryFile(path: string, summary: CritiqueSummary, warnFn: (s: string) => void, secrets?: string[]): boolean {
  const scrubbed = scrubCritiqueJson(summary, "summary", secrets);
  if (JSON.stringify(scrubbed) !== JSON.stringify(summary)) {
    warnFn(
      `::warning:: [critique] --summary-out ${path} NOT written: a value in it matched a configured secret, and the summary is meant for a public repository\n`,
    );
    return false;
  }
  try {
    writeFileSync(path, JSON.stringify(summary, null, 2) + "\n");
    return true;
  } catch (e) {
    warnFn(`critique: --summary-out ${path} could not be written: ${String(e)}\n`);
    return false;
  }
}
