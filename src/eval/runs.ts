// `runs.jsonl`: one line per finished eval job, appended as the job ends. The report is rebuilt from these
// lines and the manifest ALONE — never from the run dirs, which `prune` may remove — so each line carries
// every field the classifier, the row extractor and the medians read, plus the per-rep evidence facts
// (computed at run time, while the run dir is certainly there).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { BoundaryError, DeciderTimeoutError, UnansweredError } from "../errors.js";
import type { RunResult } from "../types.js";
import type { ClassifiableResult, RepEvidence } from "./classify.js";
import { tildeify } from "../io.js";
import { collectSecrets, scrub } from "../secrets.js";

export const RUNS_FILE = "runs.jsonl";

export type ThrownKind = "boundary" | "unanswered" | "decider_timeout" | "other";

/** A per-rep fact: observed true/false, or not observable from this run's record. */
export type Fact = boolean | "unobservable";

export interface EvidenceFacts {
  /** The selected skill was invoked (a `Skill` call, a sub-agent's `Skill` call, or the prompt's slash token). */
  invoked: Fact;
  /** The agent read the mounted SKILL.md or a reference directly. */
  sourceRead: Fact;
  /** Neither of the above. */
  neither: Fact;
}

/** The assertion fields a grade keeps. */
export type GradedAssertion = NonNullable<ClassifiableResult["assertions"]>[number] & {
  judgeModel?: string;
  judgeTransport?: RunResult["assertions"][number]["judgeTransport"];
};

export interface Grade {
  /** `live`: the grading the run itself did. Later re-grades append entries; the report reads entry 0. */
  source: "live";
  assertions: GradedAssertion[];
}

export interface RunsLine {
  v: 0;
  index: number;
  arm: string;
  scenario: string;
  rep: number;
  runId: string;
  /** `~`-relative; null when the job never produced a run dir. */
  runDir: string | null;
  /** What the job threw, if anything. */
  thrown?: { kind: ThrownKind; message: string };
  /** The result's classification inputs (no assertions — those are in `grades`). Absent when no result. */
  result?: Omit<ClassifiableResult, "assertions"> & { judgeCostUsd?: number };
  errorSource?: string;
  resultErrorKind?: string;
  models?: string[];
  judge?: { models: string[]; promptHashes: string[] };
  evidence?: EvidenceFacts;
  grades: Grade[];
}

export function thrownKind(e: unknown): ThrownKind {
  if (e instanceof DeciderTimeoutError) return "decider_timeout";
  if (e instanceof BoundaryError) return "boundary";
  if (e instanceof UnansweredError) return "unanswered";
  return "other";
}

/** Rebuild an error the classifier recognises by class, from its persisted kind. */
export function reviveThrown(t: { kind: ThrownKind; message: string }): unknown {
  switch (t.kind) {
    case "decider_timeout":
      return new DeciderTimeoutError(t.message, "", "decider-cmd");
    case "boundary":
      return new BoundaryError(t.message);
    case "unanswered":
      return new UnansweredError(t.message, "");
    default:
      return new Error(t.message);
  }
}

/** An error result's `finalMessage` is kept (bounded) because the classifier matches the agent's own
 *  authentication-failure text on it; a success's answer is not the report's business. */
export const FINAL_MESSAGE_MAX = 300;

const uniq = (xs: Array<string | undefined>): string[] => [...new Set(xs.filter((x): x is string => typeof x === "string"))].sort();

/** Project a finished job into its runs.jsonl line. */
export function buildRunsLine(args: {
  index: number;
  arm: string;
  scenario: string;
  rep: number;
  runId: string;
  runDir: string | undefined;
  result: RunResult | undefined;
  thrown: unknown;
  evidence: EvidenceFacts | undefined;
}): RunsLine {
  const r = args.result;
  const assertions: GradedAssertion[] = (r?.assertions ?? []).map((a) => ({
    assertion: a.assertion,
    pass: a.pass,
    ...(a.source !== undefined ? { source: a.source } : {}),
    ...(a.semanticClaims !== undefined ? { semanticClaims: a.semanticClaims } : {}),
    ...(a.judgeInvalid !== undefined ? { judgeInvalid: a.judgeInvalid } : {}),
    ...(a.judgePromptHash !== undefined ? { judgePromptHash: a.judgePromptHash } : {}),
    ...(a.judgeTransport !== undefined ? { judgeTransport: a.judgeTransport } : {}),
    ...(a.judgeCostUsd !== undefined ? { judgeCostUsd: a.judgeCostUsd } : {}),
    ...(a.judgeModel !== undefined ? { judgeModel: a.judgeModel } : {}),
    // The reason only: the row extractor reads nothing else, and `scope_matched_nothing`'s `paths` is every
    // path the run authored. Without it a refused semantic grade is indistinguishable from a graded fail.
    ...(a.semanticEvidence !== undefined ? { semanticEvidence: { reason: a.semanticEvidence.reason } } : {}),
  }));
  const semantic = assertions.filter((a) => a.assertion.semantic_matches !== undefined);
  return {
    v: 0,
    index: args.index,
    arm: args.arm,
    scenario: args.scenario,
    rep: args.rep,
    runId: args.runId,
    runDir: args.runDir !== undefined ? tildeify(args.runDir) : null,
    ...(args.thrown !== undefined
      ? { thrown: { kind: thrownKind(args.thrown), message: String((args.thrown as Error)?.message ?? args.thrown) } }
      : {}),
    ...(r
      ? {
          result: {
            scenario: r.scenario,
            result: r.result,
            ...(r.errorSource !== undefined ? { errorSource: r.errorSource } : {}),
            ...(r.resultErrorKind !== undefined ? { resultErrorKind: r.resultErrorKind } : {}),
            ...(r.resultSubtype !== undefined ? { resultSubtype: r.resultSubtype } : {}),
            ...(r.result !== "success" && typeof r.finalMessage === "string"
              ? // Scrubbed BEFORE the cap: a secret straddling the cut would leave a prefix the line scrub
                // in appendRunsLine (scrubRunsLineText) can no longer match.
                { finalMessage: scrub(r.finalMessage, collectSecrets()).slice(0, FINAL_MESSAGE_MAX) }
              : {}),
            ...(r.stalledOnQuestion !== undefined ? { stalledOnQuestion: r.stalledOnQuestion } : {}),
            ...(r.partial !== undefined ? { partial: r.partial } : {}),
            ...(r.unansweredGate !== undefined ? { unansweredGate: r.unansweredGate } : {}),
            ...(r.models !== undefined ? { models: r.models } : {}),
            ...(r.modelPinHonored !== undefined ? { modelPinHonored: r.modelPinHonored } : {}),
            ...(r.fingerprint?.contentSig !== undefined ? { fingerprint: { contentSig: r.fingerprint.contentSig } } : {}),
            ...(r.cost?.usd !== undefined ? { cost: { usd: r.cost.usd } } : {}),
            ...(r.usage?.turns !== undefined ? { usage: { turns: r.usage.turns } } : {}),
            ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
          },
          ...(r.errorSource !== undefined ? { errorSource: r.errorSource } : {}),
          ...(r.resultErrorKind !== undefined ? { resultErrorKind: r.resultErrorKind } : {}),
          ...(r.models !== undefined ? { models: r.models } : {}),
          judge: { models: uniq(semantic.map((a) => a.judgeModel)), promptHashes: uniq(semantic.map((a) => a.judgePromptHash)) },
        }
      : {}),
    ...(args.evidence ? { evidence: args.evidence } : {}),
    grades: r ? [{ source: "live", assertions }] : [],
  };
}

/** The FREE-TEXT fields of a line, secret-scrubbed — the only fields that carry text the run produced:
 *  `thrown.message`, `result.finalMessage`, `result.unansweredGate.message` / `.hint`. Everything else is
 *  left as written ON PURPOSE: the authored assertions and claim text in `grades` are joined against the
 *  manifest's unscrubbed scenario (`classify.ts`), so a rewritten literal misaligns the grade and drops the
 *  row; `arm`/`scenario`/`runId`/`models`/hashes are join keys a short scrub value could corrupt; the
 *  semantic `rationale` is scrubbed at capture. Scrubbing string values (never the serialized text) keeps
 *  the line valid JSON whatever the secret set. */
export function scrubRunsLineText(line: RunsLine, secrets: string[] = collectSecrets()): RunsLine {
  if (!secrets.length) return line;
  const out: RunsLine = { ...line };
  if (line.thrown) out.thrown = { ...line.thrown, message: scrub(line.thrown.message, secrets) };
  if (line.result) {
    const r = { ...line.result };
    if (typeof r.finalMessage === "string") r.finalMessage = scrub(r.finalMessage, secrets);
    if (r.unansweredGate)
      r.unansweredGate = {
        ...r.unansweredGate,
        message: scrub(r.unansweredGate.message, secrets),
        ...(r.unansweredGate.hint !== undefined ? { hint: scrub(r.unansweredGate.hint, secrets) } : {}),
      };
    out.result = r;
  }
  return out;
}

/** Appended with its free-text fields secret-scrubbed ({@link scrubRunsLineText}), like each rep's
 *  result.json: the line is built from the in-memory RunResult, which `executeScenario` returns
 *  unscrubbed, and the report files are rebuilt from these lines. */
export function appendRunsLine(file: string, line: RunsLine): void {
  appendFileSync(file, JSON.stringify(scrubRunsLineText(line)) + "\n");
}

/** Read runs.jsonl, ordered by schedule index. A torn final line (a crash mid-append) is skipped and
 *  counted; any other unparseable line throws — a corrupt record must not render as a smaller eval. */
export function readRunsLines(file: string): { lines: RunsLine[]; tornFinalLine: boolean } {
  if (!existsSync(file)) return { lines: [], tornFinalLine: false };
  const raw = readFileSync(file, "utf8").split("\n");
  const lines: RunsLine[] = [];
  let torn = false;
  raw.forEach((text, i) => {
    if (!text.trim()) return;
    try {
      lines.push(JSON.parse(text) as RunsLine);
    } catch (e) {
      const isLast = raw.slice(i + 1).every((t) => !t.trim());
      if (isLast) torn = true;
      else throw new Error(`${file}: line ${i + 1} is not valid JSON (${(e as Error).message})`);
    }
  });
  lines.sort((a, b) => a.index - b.index);
  return { lines, tornFinalLine: torn };
}

/** The classifier's input for one line: the result excerpt with the LIVE grade's assertions, and the revived
 *  thrown error. */
export function repEvidenceOf(line: RunsLine): RepEvidence {
  const grade = line.grades[0];
  return {
    ...(line.result ? { result: { ...line.result, assertions: grade?.assertions ?? [] } } : {}),
    ...(line.thrown ? { thrown: reviveThrown(line.thrown) } : {}),
  };
}
