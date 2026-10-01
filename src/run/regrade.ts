/**
 * `regrade <run-dir>… --scenario <yaml>` — re-grade a KEPT run's `semantic_matches` asserts with the semantic
 * judge, without re-running the agent. The judge call is the only spend.
 *
 * The evidence is rebuilt by the shared kept-run builder (`assertContextFromRunDir`) with the inputs the live
 * run's capture used: the persisted capture budget (`result.json` `authoredCapture`), the scenario's
 * `evidence_files` union as priority globs, and THIS process's secret set — every section of the judged
 * document is scrubbed with it before it leaves, but a value only the live run knew to scrub is not. Whether
 * that rebuilt document is the one the live judge read is then MEASURED, not assumed: each assert's
 * recomposed fingerprint is compared, section by section, with the `judgedDoc` the live run persisted. Before
 * any judge call, every live assert's document is rebuilt from the LIVE inputs (its scope, the live budget) and
 * a mismatch is refused unless the caller passes `--allow-doc-drift` — so a changed scope cannot hide a value
 * the live run scrubbed and this process does not. After grading, the new document is compared for the report.
 *
 * The result is written beside the run (`turns/<N>/regrade/<promptHash>-<judgeModel>-<iso>.json`).
 * `result.json` is never modified and no run-index row is added — a re-grade is not a run, and indexing it
 * would count the run twice in `stats`.
 */
import { remeasureMetrics } from "../metrics.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { claudeCliCompleteStructured, transportIdentity } from "../decide/llm-transport.js";
import { makePairwiseJudge, type CompleteStructured } from "../decide/pairwise-judge.js";
import { pairwiseRefsRefusal, scenarioPairwiseSetup, type PairwiseSetup } from "../refs/preflight.js";
import { runPairwiseJudges, type PairwiseRef } from "./pairwise-prepass.js";
import { composeJudgedDocument, evaluate, judgedOpts, runSemanticJudges, semanticRefusal, type AssertContext } from "../assert.js";
import { parseArgs } from "../cli-args.js";
import { isolationRefusal } from "../decide/llm-transport.js";
import { defaultJudgeModel, judgesForRun } from "../decide/semantic-judge.js";
import { tildeify, warn, writeAllSync } from "../io.js";
import { collectSecrets, scrub } from "../secrets.js";
import type { Assertion, JudgedDocFingerprint, RunResult, Scenario } from "../types.js";
import { DEFAULT_AUTHORED_TOTAL_BYTES, parseAuthoredTotalBytes } from "./artifacts.js";
import { applyParsedCommandGlobals, withCommandGlobals } from "./command-globals.js";
import { fail, isJsonOutput, jsonError, jsonPayloadEnvelope, pkgVersion } from "./envelope.js";
import { parseScenarioFile } from "./execute.js";
import { turnArtifactPath, turnWriteDir } from "./turn-layout.js";
import { assertContextFromRunDir } from "./verify-context.js";
import { isConcreteModelId } from "./model-provenance.js";
import { REGRADE_BOOLEAN_FLAGS, REGRADE_USAGE, REGRADE_VALUE_FLAGS } from "./regrade-usage.js";

export { REGRADE_BOOLEAN_FLAGS, REGRADE_USAGE, REGRADE_VALUE_FLAGS } from "./regrade-usage.js";

const CMD = "regrade";

/** Whether the re-grade's judged document is the one the live judge read. See REGRADE_USAGE. `unknown` and
 *  `live_refused` mean there was nothing live to compare with (this scope has no live fingerprint, or the live
 *  assert refused its evidence and none was recorded); `not_graded` means this re-grade's own assert refused its
 *  evidence, so no judge was called for it and no document was handed to one. */
export type DocMatch = true | false | "scope_changed" | "unknown" | "live_refused" | "not_graded";

export interface DifferingSection {
  /** Index of the assert in the new scenario's `assert:` list. */
  assertionIndex: number;
  kind: JudgedDocFingerprint["sections"][number]["kind"];
  path?: string;
  /** `changed`: same section, different bytes. `added`: only the re-grade's document has it. `removed`: only
   *  the live one did. */
  change: "changed" | "added" | "removed";
}

export interface RegradedAssertion {
  assertionIndex: number;
  assertion: Assertion;
  pass: boolean;
  message?: string;
  semanticClaims?: RunResult["assertions"][number]["semanticClaims"];
  judgeModel?: string;
  judgeCostUsd?: number;
  judgeUsage?: RunResult["assertions"][number]["judgeUsage"];
  judgePromptHash?: string;
  judgeTransport?: RunResult["assertions"][number]["judgeTransport"];
  judgedDoc?: JudgedDocFingerprint;
  judgeInvalid?: boolean;
  semanticEvidence?: RunResult["assertions"][number]["semanticEvidence"];
  docMatchesLive: DocMatch;
}

/** Judge spend over a set of grades: the sum of the priced ones (`undefined` when none was priced — unpriced
 *  is not $0), and how many were unpriced. With `unpricedGrades > 0` the sum is a FLOOR. */
export interface JudgeSpend {
  judgeCostUsd?: number;
  unpricedGrades: number;
}

/** A drift the drift check found in one LIVE assert's document, rebuilt from the live inputs: indexed by that assert's
 *  position in the live `result.assertions` (a live assert need not exist in the new scenario). An empty `sections`
 *  means only the whole-document hash differs. */
export interface LiveDocDrift {
  liveAssertionIndex: number;
  sections: Array<Omit<DifferingSection, "assertionIndex">>;
}

/** One run dir's evidence refusal, decided before any judge call. A dir with both gets two entries. */
export interface RegradeRefusal {
  runDir: string;
  code: "doc_drift" | "unchecked_content";
  uncheckedCount?: number;
  uncheckedSections?: UncheckedSection[];
  liveDocDrift?: LiveDocDrift[];
}

export interface RegradeRunReport extends JudgeSpend {
  runDir: string;
  turn: number;
  /** SHA-256 of the scenario file's bytes, so a grade names the exact rubric it was made with. */
  scenarioSha256: string;
  regradeFile: string;
  pass: boolean;
  /** Sections of the graded documents no live `judgedDoc` carried, so the drift check could not vouch for them
   *  (see `uncheckedSections`). Warned before the judge call, never refused. */
  uncheckedSections: UncheckedSection[];
  /** `uncheckedSections.length`. Non-zero only under `--allow-unchecked`: without it such content is refused. */
  uncheckedCount: number;
  /** The drift found in the live documents and accepted with `--allow-doc-drift`; `[]` when none was found. Any
   *  entry makes the run's `docMatchesLive` false, whatever its asserts' own values. */
  liveDocDrift: LiveDocDrift[];
  /** Asserts whose grade is INVALID (the judge failed twice, e.g. an outage or a malformed grade) — counted
   *  apart from failures: an invalid grade says nothing about the run. It still makes `pass` false. */
  invalidGrades: number;
  docMatchesLive: DocMatch;
  differingSections: DifferingSection[];
  assertions: RegradedAssertion[];
  notRegraded: Array<{ assertionIndex: number; keys: string[] }>;
  authoredCapture: { totalBytes: number; perFileBytes?: number; source: "persisted" | "flag" };
  /** The scenario's declared metrics, re-read from the kept work dir as it is now and checked against the run's own
   *  post-run hashes (a file changed since the run is `pruned`). Absent when the scenario declares none. */
  metrics?: NonNullable<RunResult["metrics"]>;
}

export type RegradeOutcome =
  | { ok: true; exitCode: 0 | 1; runs: RegradeRunReport[] }
  | {
      ok: false;
      kind: "usage" | "runtime";
      message: string;
      /** Set on an evidence refusal (`refusals` lists every refused run dir): `doc_drift` when any dir drifted,
       *  else `unchecked_content`. `no_semantic_asserts`: the scenario has no `semantic_matches` assert, so there is
       *  nothing to re-grade (a caller can tell this refusal from a failure without reading the message). */
      code?: "doc_drift" | "unchecked_content" | "no_semantic_asserts";
      refusals?: RegradeRefusal[];
      /** A failure writing a regrade file after earlier run dirs were graded and written: their reports. */
      completed?: RegradeRunReport[];
    };

/** One run dir's evidence as a `checkOnly` preflight saw it: the pre-spend fields of `RegradeRunReport`, under
 *  the same keys. `liveDocDrift` / `uncheckedSections` are non-empty only where `allowDocDrift` / `allowUnchecked`
 *  accepted them (a real re-grade would grade over them, warned). Nothing graded, so no `docMatchesLive`. */
export type RegradeCheckRun = Pick<
  RegradeRunReport,
  "runDir" | "turn" | "scenarioSha256" | "uncheckedSections" | "uncheckedCount" | "liveDocDrift" | "authoredCapture"
> & {
  /** The asserts that will be graded with nothing live to compare their document with — exactly those a real
   *  re-grade warns about before its spend. `docMatch` is the comparison result each would get, before an accepted
   *  drift (`allowDocDrift`) forces its `docMatchesLive` to `false`.
   *  Never refused: the grade goes ahead, but those documents are neither drift- nor secret-checked. */
  blind: BlindAssert[];
};

/** An assert with no live fingerprint to compare its rebuilt document with (see `RegradeCheckRun.blind`). */
export interface BlindAssert {
  /** Index of the assert in the new scenario's `assert:` list. */
  assertionIndex: number;
  docMatch: Extract<DocMatch, "unknown" | "live_refused">;
}

/** A `checkOnly` preflight that a real re-grade with the same options would NOT refuse: every run dir passed every
 *  pre-spend step. A refusal is the ordinary `{ ok: false }` arm of `RegradeOutcome`, identical to the real one.
 *  Like a real re-grade's `runs[]`, this arm is NOT scrubbed in-process (run dirs, section paths): a caller that
 *  serializes it must scrub it itself — `regradeEnvelope` accepts only the re-grade arm (with `exitCode`). */
export interface RegradeCheckPassed {
  ok: true;
  checkOnly: true;
  runs: RegradeCheckRun[];
}

export interface RegradeOptions {
  runDirs: string[];
  scenarioFile: string;
  /** Grade every semantic_matches assert with this model (a per-assert `judge_model` is then inert). */
  judgeModel?: string;
  /** Capture budget for a run that did not persist `authoredCapture`. */
  authoredTotalBytes?: number;
  /** Grade even when the rebuilt document differs from the live one (`docMatchesLive: false`), which is
   *  otherwise refused before any judge call. */
  allowDocDrift?: boolean;
  /** Grade even when a graded document carries content the live judge never read (`uncheckedSections`), which is
   *  otherwise refused before any judge call. Independent of `allowDocDrift`. */
  allowUnchecked?: boolean;
  /** The secret set the judged document, the regrade file and every message are scrubbed with. Default:
   *  `collectSecrets()`. The CLI passes the one set it also scrubs its own output with. */
  secrets?: string[];
  /** Test seam: the judge factory `judgesForRun` builds from (default: the real judge). */
  makeJudge?: Parameters<typeof judgesForRun>[1];
  /** Test seam: the clock that names the output file. */
  now?: () => Date;
  /** `semantic_pairwise` in a caller-owned flow (a hillclimb flow): the case's entry name, the references to compare
   *  with (replacing the scenario's `refs:`), the ones neutral for this run, and the gating ones — as
   *  `ExecuteOptions.pairwise`. `onlyRefs` makes it a FILL: only those references are judged; every other outcome,
   *  and every semantic_matches grade, is the live run's, kept unchanged. Omitted = the scenario's own setup. */
  pairwise?: { caseId?: string; refs?: PairwiseRef[]; neutralRefs?: string[]; gateRefs?: string[]; onlyRefs?: string[] };
  /** Test seam: the structured judge transport for `semantic_pairwise` (default: the host `claude -p`). */
  pairwiseComplete?: CompleteStructured;
}

/** `RegradeOptions` for an evidence preflight. Kept out of `RegradeOptions` itself so a caller that never asks for
 *  one keeps the plain `RegradeOutcome` type. */
export interface RegradeCheckOptions extends RegradeOptions {
  /** Evidence preflight: run every pre-spend step a real re-grade runs — the builder's refusals, the judge-model
   *  check, the live-inputs drift rebuild, the unchecked-content measurement — over EVERY run dir, honouring
   *  `allowDocDrift` / `allowUnchecked` exactly as a real re-grade would, then stop. No judge is constructed or
   *  called, no regrade file is written and no warning is printed (what a real re-grade would warn about is
   *  returned instead: `blind`, accepted `liveDocDrift`, accepted `uncheckedSections`). Returns the refusal a real re-grade with these
   *  options would return (same `code` and `refusals[]`), else `RegradeCheckPassed`. API-only (no CLI flag). */
  checkOnly: true;
}

const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Same basis as the run index's `judgeCostUsd` and `stats`' `unpricedRuns`. */
export function judgeSpend(grades: ReadonlyArray<{ judgeCostUsd?: number }>): JudgeSpend {
  const priced = grades.flatMap((g) => (typeof g.judgeCostUsd === "number" ? [g.judgeCostUsd] : []));
  return {
    ...(priced.length ? { judgeCostUsd: priced.reduce((sum, c) => sum + c, 0) } : {}),
    unpricedGrades: grades.length - priced.length,
  };
}

/** What the judged document depends on besides the shared capture: an assert's own sub-agent and Skill-result
 *  opt-ins and its `evidence_files` scope (order-free; an empty list is unscoped, as `scopeAuthoredEvidence`
 *  reads it). */
function ownScopeKey(a: Assertion): string {
  const o = judgedOpts(a)!;
  return JSON.stringify([o.includeSubagentText, [...new Set(o.evidenceFiles ?? [])].sort(), o.includeForkResults]);
}

/** The document a live judged assert recorded: `judgedDoc` (what its judge read) or, for a `semantic_pairwise`
 *  assert no judge read (every comparison neutral), `composedDoc` — the same fingerprint of the same document. */
const liveDoc = (r: LiveResult): JudgedDocFingerprint | undefined => r.judgedDoc ?? r.composedDoc;

/** The capture's priority globs — the same expression the live run uses. */
function evidenceUnion(asserts: Array<Assertion | undefined>): string[] {
  return [...new Set(asserts.flatMap((a) => (a ? (judgedOpts(a)?.evidenceFiles ?? []) : [])))];
}

const sameSet = (a: string[], b: string[]): boolean => {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
};

/** Section-by-section difference between the live fingerprint and the re-grade's. Sections are keyed by kind
 *  and path (authored files), or by their ordinal within the kind (the pathless ones). */
function diffSections(live: JudgedDocFingerprint, now: JudgedDocFingerprint, assertionIndex: number): DifferingSection[] {
  const keyed = (fp: JudgedDocFingerprint) => {
    const seen = new Map<string, number>();
    return fp.sections.map((s) => {
      const n = seen.get(s.kind) ?? 0;
      seen.set(s.kind, n + 1);
      return { key: s.path !== undefined ? `${s.kind}\0${s.path}` : `${s.kind}\0#${n}`, s };
    });
  };
  const l = keyed(live);
  const r = new Map(keyed(now).map((e) => [e.key, e.s]));
  const out: DifferingSection[] = [];
  const at = (s: JudgedDocFingerprint["sections"][number], change: DifferingSection["change"]): DifferingSection => ({
    assertionIndex,
    kind: s.kind,
    ...(s.path !== undefined ? { path: s.path } : {}),
    change,
  });
  for (const { key, s } of l) {
    const other = r.get(key);
    if (!other) out.push(at(s, "removed"));
    else if (other.sha256 !== s.sha256 || other.chars !== s.chars) out.push(at(s, "changed"));
    r.delete(key);
  }
  for (const s of r.values()) out.push(at(s, "added"));
  return out;
}

type LiveResult = RunResult["assertions"][number];

/** How the live run's semantic asserts are compared with this re-grade's: the live asserts, and whether the
 *  shared capture moved (a changed budget, or a changed `evidence_files` union) — either makes every
 *  document differ by design. */
interface LiveSide {
  liveSemantic: LiveResult[];
  captureMoved: boolean;
}

/** A live semantic assert that refused its evidence (any `semanticEvidence.reason` but `graded`) AND for which no
 *  fingerprint was recorded — every refusal the harness records now (the judge is not called for a refused
 *  assert, so there is no document to fingerprint), or a run from before `judgedDoc` existed — so it vouches for
 *  nothing. A refused assert that DID record one (a run recorded while the harness still called the judge before
 *  refusing) is compared like a graded one. A result without `semanticEvidence` predates the field and is read
 *  as graded. */
const liveRefused = (r: LiveResult): boolean =>
  liveDoc(r) === undefined && r.semanticEvidence !== undefined && r.semanticEvidence.reason !== "graded";

/** A live assert whose recorded document can be compared with: it has a `judgedDoc`, refused or not. */
const comparable = (r: LiveResult): boolean => liveDoc(r) !== undefined;

/** Why an assert has nothing live to compare with, whatever its own document: every same-scope live assert
 *  refused with no fingerprint recorded (`live_refused`), or no live assert recorded one at all (`unknown`).
 *  `compareWithLive` also reports `unknown` for an assert whose own scope has no live fingerprint. */
function nothingLive(a: Assertion, live: LiveSide): "live_refused" | "unknown" | undefined {
  const key = ownScopeKey(a);
  const sameScope = live.liveSemantic.filter((r) => ownScopeKey(r.assertion) === key);
  if (sameScope.length > 0 && sameScope.every(liveRefused)) return "live_refused";
  if (!live.liveSemantic.some(comparable)) return "unknown";
  return undefined;
}

function liveSide(result: RunResult, sc: Scenario, budgetChanged: boolean): LiveSide {
  const liveSemantic = (result.assertions ?? []).filter((r) => r.assertion !== undefined && judgedOpts(r.assertion) !== undefined);
  const captureMoved = budgetChanged || !sameSet(evidenceUnion(liveSemantic.map((r) => r.assertion)), evidenceUnion(sc.assert));
  return { liveSemantic, captureMoved };
}

/** Compare one assert's document (`now`, the fingerprint of what the judge was handed) with the one its live
 *  counterpart's judge read — the reported `docMatchesLive`. The refusal is decided separately, before any
 *  judge call, by `liveDocDrift`. Exported for tests. */
export function compareWithLive(
  a: Assertion,
  ordinal: number,
  assertionIndex: number,
  now: JudgedDocFingerprint | undefined,
  live: LiveSide,
  /** This re-grade's own assert refused its evidence. */
  regradeRefused: boolean,
): { match: DocMatch; differing: DifferingSection[] } {
  // Compare FIRST: whenever a judge was handed a document (`now`), the assert is reported by what that document
  // was, refused or not — the refusal stays visible in its own pass/message. `not_graded` is only for a refusal
  // with no document handed to a judge, which is every refusal now: `runSemanticJudges` decides it before the
  // call and does not call the judge for it.
  if (regradeRefused && !now) return { match: "not_graded", differing: [] };
  const none = nothingLive(a, live);
  if (none) return { match: none, differing: [] };
  // The document is a function of the shared capture and the assert's own scope, so any live assert with
  // the same own scope read the same document. With none, the one at the same position among the
  // semantic asserts is compared, for the section list, and the scope is reported changed.
  const key = ownScopeKey(a);
  const sameScope = live.liveSemantic.filter((r) => ownScopeKey(r.assertion) === key && !liveRefused(r));
  const positional = live.liveSemantic[ordinal];
  const counterpart =
    sameScope.find((r) => liveDoc(r)) ?? sameScope[0] ?? (positional && !liveRefused(positional) ? positional : undefined);
  // The assert's own scope ran live but recorded no fingerprint: nothing to compare with, whatever else moved.
  if (sameScope.length > 0 && !sameScope.some((r) => liveDoc(r))) return { match: "unknown", differing: [] };
  const scopeChanged = sameScope.length === 0 || live.captureMoved;
  const counterDoc = counterpart ? liveDoc(counterpart) : undefined;
  if (!counterDoc || !now) return { match: scopeChanged ? "scope_changed" : "unknown", differing: [] };
  const differing = diffSections(counterDoc, now, assertionIndex);
  const match: DocMatch = scopeChanged ? "scope_changed" : differing.length === 0 && counterDoc.sha256 === now.sha256 ? true : false;
  return { match, differing };
}

/**
 * Rebuild each LIVE semantic assert's document from the LIVE inputs — its own scope, the live `evidence_files`
 * union, the persisted budget — with this process's secrets, and compare it with the `judgedDoc` that assert
 * recorded. Independent of the new scenario, so a changed scope or budget (`scope_changed` on the graded
 * document) cannot hide a drift: in particular a value the live run scrubbed and this process does not, which
 * would otherwise reach the judge unredacted. A live assert that recorded no `judgedDoc` cannot be checked.
 * Returns the differing sections, indexed by the assert's position in `result.assertions`, and the rebuilt
 * documents themselves: what the live judge's inputs produce from the current bytes, which `uncheckedSections`
 * measures the new documents against.
 */
function liveDocDrift(
  runDir: string,
  result: RunResult,
  sc: Scenario,
  secrets: string[],
  budget: { totalBytes: number; perFileBytes?: number },
  sameInputs: AssertContext | undefined,
):
  | { drift: Array<{ liveIndex: number; sections: DifferingSection[] }>; rebuilt: JudgedDocFingerprint[] }
  | { refusal: { kind: "usage" | "runtime"; message: string } } {
  // The capture is built from EVERY live semantic assert (its priority globs are their union, as execute.ts
  // builds it), but only those that recorded a `judgedDoc` have anything to be compared with.
  const allLive = (result.assertions ?? [])
    .map((r, liveIndex) => ({ r, liveIndex }))
    .filter(({ r }) => r.assertion !== undefined && judgedOpts(r.assertion) !== undefined);
  // Only an assert with a recorded document can be checked (see `comparable`).
  const live = allLive.filter(({ r }) => comparable(r));
  if (live.length === 0) return { drift: [], rebuilt: [] };
  let ctx = sameInputs;
  if (!ctx) {
    // The live asserts stand in for the scenario: the builder reads only `assert` to decide what to capture.
    const built = assertContextFromRunDir(
      runDir,
      { ...sc, assert: allLive.map(({ r }) => r.assertion) },
      {
        command: CMD,
        recomputeAuthored: "semantic",
        secrets,
        priorityGlobs: evidenceUnion(allLive.map(({ r }) => r.assertion)),
        totalBytes: budget.totalBytes,
        ...(budget.perFileBytes !== undefined ? { perFileBytes: budget.perFileBytes } : {}),
      },
    );
    if (!built.ok) {
      if (built.kind === "scenario") throw new Error("unreachable: the scenario was passed as an object");
      return { refusal: { kind: built.kind, message: built.message } };
    }
    ctx = built.ctx;
  }
  const cache = new Map<string, JudgedDocFingerprint>();
  const drift: Array<{ liveIndex: number; sections: DifferingSection[] }> = [];
  for (const { r, liveIndex } of live) {
    const o = judgedOpts(r.assertion)!;
    const key = ownScopeKey(r.assertion);
    let fp = cache.get(key);
    if (!fp) {
      fp = composeJudgedDocument(ctx, o.includeSubagentText, o.evidenceFiles, o.includeForkResults).fingerprint;
      cache.set(key, fp);
    }
    const recorded = liveDoc(r)!;
    const sections = diffSections(recorded, fp, liveIndex);
    if (sections.length || recorded.sha256 !== fp.sha256) drift.push({ liveIndex, sections });
  }
  return { drift, rebuilt: [...cache.values()] };
}

/** A section of a graded document that no live `judgedDoc` vouches for. */
export interface UncheckedSection {
  /** Index of the assert in the new scenario's `assert:` list. */
  assertionIndex: number;
  kind: JudgedDocFingerprint["sections"][number]["kind"];
  path?: string;
}

/**
 * The sections of the NEW documents that the drift check cannot vouch for: content the live judge's inputs do not
 * produce. Measured against the live documents REBUILT from the live inputs over the current bytes
 * (`liveDocDrift`), not the persisted `judgedDoc`s: a section the rebuild has is either the bytes the live judge
 * read or a drift the check already reported (refused, or accepted with `--allow-doc-drift`), so the two flags stay
 * independent. A section is covered when some rebuilt document has one of the same kind and path with the same
 * bytes; a non-authored section (final answer, transcript, health note…) is also covered when it is no longer
 * than a rebuilt one of its kind, since those carry no file content a scope could newly bring in. What is left is
 * content a widened scope (`evidence_files`, `include_subagent_text`, `include_fork_results`) or a larger budget pulled in — never
 * compared with anything, so neither a drift nor a value the live run scrubbed and this process does not can be
 * detected in it. Empty when no live assert recorded a comparable `judgedDoc` at all: its asserts are then
 * `unknown` or `live_refused`, unchecked as a whole, and warned about as such rather than refused.
 */
function uncheckedSections(
  docs: Map<Assertion, JudgedDocFingerprint>,
  sc: Scenario,
  liveSections: JudgedDocFingerprint["sections"],
): UncheckedSection[] {
  if (liveSections.length === 0) return [];
  const exact = new Set(liveSections.map((s) => `${s.kind}\0${s.path ?? ""}\0${s.sha256}`));
  const longest = new Map<string, number>();
  for (const s of liveSections) longest.set(s.kind, Math.max(longest.get(s.kind) ?? 0, s.chars));
  const out: UncheckedSection[] = [];
  const seen = new Set<string>();
  for (const [a, fp] of docs) {
    const assertionIndex = sc.assert.indexOf(a);
    for (const s of fp.sections) {
      if (exact.has(`${s.kind}\0${s.path ?? ""}\0${s.sha256}`)) continue;
      // The evidence-health and scratch notes are the harness's own text: fixed wording plus file paths, scrubbed
      // with this process's secrets. They carry no file content, so nothing in them is "content the live judge
      // never read" — and a changed budget legitimately adds or reshapes them (a smaller budget truncates a file,
      // which adds a health note no live document had).
      if (s.kind === "health" || s.kind === "scratch_note") continue;
      // Covered by length only for the single, unscoped sections every document carries (final answer,
      // transcript): an allowlist, so a section kind added later is unchecked until it is reasoned about here.
      if ((s.kind === "final" || s.kind === "transcript") && s.chars <= (longest.get(s.kind) ?? -1)) continue;
      const key = `${assertionIndex}\0${s.kind}\0${s.path ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ assertionIndex, kind: s.kind, ...(s.path !== undefined ? { path: s.path } : {}) });
    }
  }
  return out;
}

const sectionLabel = (d: Omit<DifferingSection, "assertionIndex">): string =>
  `${d.change} ${d.kind}${d.path !== undefined ? ` ${d.path}` : ""}`;

/** `live assert <i>: <sections>` per drifted live assert — the files a drift is in. */
const liveDriftLabel = (drift: LiveDocDrift[]): string =>
  drift
    .map(
      ({ liveAssertionIndex, sections }) =>
        `live assert ${liveAssertionIndex}: ${sections.map(sectionLabel).join(", ") || "whole-document hash"}`,
    )
    .join("; ");

/** Scrub a refusal's string fields (the run dir and section paths) one by one. Scrubbing the serialized JSON would
 *  break it on a secret that matches JSON syntax, and the parse back would throw. */
function scrubRefusal(r: RegradeRefusal, secrets: string[]): RegradeRefusal {
  const sp = <T extends { path?: string }>(x: T): T => (x.path !== undefined ? { ...x, path: scrub(x.path, secrets) } : x);
  return {
    ...r,
    runDir: scrub(r.runDir, secrets),
    ...(r.uncheckedSections ? { uncheckedSections: r.uncheckedSections.map(sp) } : {}),
    ...(r.liveDocDrift ? { liveDocDrift: r.liveDocDrift.map((d) => ({ ...d, sections: d.sections.map(sp) })) } : {}),
  };
}

const UNCHECKED_LIST_CAP = 20;
/** `assert <i>: <kind> <path>` per unchecked section, the first 20 and a count of the rest. */
const uncheckedLabel = (u: UncheckedSection[]): string =>
  u
    .slice(0, UNCHECKED_LIST_CAP)
    .map((x) => `assert ${x.assertionIndex}: ${x.kind}${x.path !== undefined ? ` ${x.path}` : ""}`)
    .join(", ") + (u.length > UNCHECKED_LIST_CAP ? `, … and ${u.length - UNCHECKED_LIST_CAP} more` : "");

/** The run's value: the worst over the asserts that were graded. An assert this re-grade refused says nothing
 *  about the document, so it only decides the run's value when every assert was refused. */
function aggregate(matches: DocMatch[]): DocMatch {
  const graded = matches.filter((m) => m !== "not_graded");
  if (graded.length === 0) return matches.length ? "not_graded" : true;
  // The unchecked values rank above `scope_changed`, so "differs by design" never hides "never checked".
  for (const m of [false, "live_refused", "unknown", "scope_changed"] as const) if (graded.includes(m)) return m;
  return true;
}

/** Path-safe component: anything outside `[A-Za-z0-9._-]` (a `[1m]` suffix, an ISO time's colons) becomes `-`. */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-");

/** The regrade file's name before `.json`: `<prompt-hash>-<judge-model>-<time>`. Named by the models that
 *  graded; with none (every assert refused before a judge ran), by the requested model, else `not-graded` —
 *  never `unknown`, which would read as an unrecorded model. */
export function regradeFileStem(
  assertions: ReadonlyArray<{ judgeModel?: string; judgePromptHash?: string }>,
  judgeModel: string | undefined,
  at: string,
): string {
  const models = [...new Set(assertions.flatMap((a) => (a.judgeModel !== undefined ? [a.judgeModel] : [])))];
  const hashes = [...new Set(assertions.flatMap((a) => (a.judgePromptHash !== undefined ? [a.judgePromptHash] : [])))];
  const model = judgeModel ?? (models.length === 0 ? "not-graded" : models.length === 1 ? models[0] : "mixed");
  const hash = hashes.length === 0 ? "no-prompt-hash" : hashes.length === 1 ? hashes[0] : "mixed";
  return safe(`${hash}-${model}-${at}`);
}

/** Write `body` to a new file in `dir` named from `stem`, never over an existing one. */
function writeNew(dir: string, stem: string, body: string): string {
  for (let i = 1; ; i++) {
    const f = join(dir, `${stem}${i === 1 ? "" : `-${i}`}.json`);
    try {
      writeFileSync(f, body, { flag: "wx" });
      return f;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

interface Prepared {
  runDir: string;
  dirAsGiven: string;
  unchecked: UncheckedSection[];
  /** The live drift accepted with `--allow-doc-drift` (empty without the flag: a drift is then refused). */
  drift: LiveDocDrift[];
  /** Each assert with no live fingerprint to compare with (`unknown` | `live_refused`). */
  blind: BlindAssert[];
  /** The asserts whose evidence will be refused, so no judge is called for them (left out of both warnings). */
  willRefuse: Set<Assertion>;
  turn: number;
  ctx: AssertContext;
  resultSha256: string;
  budget: RegradeRunReport["authoredCapture"];
  live: LiveSide;
  /** The run's own post-run file record: a metric is read only from bytes that still match it (none recorded ⇒
   *  every metric is `pruned`). */
  workspaceFiles: RunResult["workspaceFiles"];
  /** The live result's assertion entries, by scenario index (a fill-mode re-grade keeps the ones it does not redo). */
  liveEntries: RunResult["assertions"];
}

/** What a re-grade's `semantic_pairwise` comparisons read: the caller's setup (a hillclimb flow's references, its
 *  gate, its own variant neutral), else the scenario's own `refs:`. */
function pairwiseSetupFor(sc: Scenario, opts: RegradeOptions): PairwiseSetup {
  const base = scenarioPairwiseSetup(sc);
  const o = opts.pairwise;
  return {
    caseId: o?.caseId ?? base.caseId,
    refsFor: o?.refs ? () => o.refs! : base.refsFor,
    neutralRefs: new Set(o?.neutralRefs ?? []),
    ...(o?.gateRefs ? { gateRefs: new Set(o.gateRefs) } : {}),
  };
}

/**
 * Re-grade every run dir. Every run dir's evidence is rebuilt (and every refusal decided) BEFORE the first
 * judge call, so one bad dir in a batch spends nothing. With `checkOnly: true` it stops there (see
 * `RegradeCheckOptions.checkOnly`): a refusal is returned as a real re-grade would return it, else `RegradeCheckPassed`.
 */
export async function regradeRuns(opts: RegradeCheckOptions): Promise<RegradeOutcome | RegradeCheckPassed>;
export async function regradeRuns(opts: RegradeOptions & { checkOnly?: false }): Promise<RegradeOutcome>;
/** A `checkOnly` not known to be `true` or absent (an options object built in a variable widens it to `boolean`):
 *  typed as either outcome, so a preflight's success is never read as a re-grade's. */
export async function regradeRuns(opts: RegradeOptions & { checkOnly?: boolean }): Promise<RegradeOutcome | RegradeCheckPassed>;
export async function regradeRuns(opts: RegradeOptions & { checkOnly?: boolean }): Promise<RegradeOutcome | RegradeCheckPassed> {
  // ONE secret set for the judged document, the written file and every message, so they cannot disagree.
  const secrets = opts.secrets ?? collectSecrets();
  const refuse = (kind: "usage" | "runtime", message: string): RegradeOutcome => ({ ok: false, kind, message: scrub(message, secrets) });
  if (opts.runDirs.length === 0) return refuse("usage", REGRADE_USAGE);
  if (opts.judgeModel !== undefined && !isConcreteModelId(opts.judgeModel))
    return refuse(
      "usage",
      `${CMD}: --judge-model "${opts.judgeModel}" is an alias; pass a concrete model id (e.g. claude-opus-4-8) so the grade names the model that made it`,
    );

  let scenario: Scenario | undefined;
  const loadScenario = (): Scenario => (scenario ??= parseScenarioFile(opts.scenarioFile));
  let scenarioSha256: string | undefined;
  const prepared: Prepared[] = [];
  // The evidence refusals (drift, unchecked content) are collected over EVERY run dir, so one refusal lists them
  // all; the batch is still refused before any judge call. Other refusals stop at the first.
  const refusals: RegradeRefusal[] = [];
  const refusalLines: string[] = [];
  const seen = new Set<string>();
  for (const dir of opts.runDirs) {
    const runDir = resolve(dir);
    // The same dir named twice — or once through a symlink — is graded (and paid for) once. A path that does
    // not resolve is left to the builder's own "run dir not found" refusal.
    let identity = runDir;
    try {
      identity = realpathSync(runDir);
    } catch {
      /* not there — refused below */
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    // First pass: the builder's run-dir refusals (multi-turn, partial, replay, chat…) and the persisted result,
    // which carries the budget the second pass needs.
    const first = assertContextFromRunDir(dir, loadScenario, { command: CMD }); // messages echo the path as given
    if (!first.ok) {
      if (first.kind === "scenario")
        return refuse("usage", `${CMD}: cannot load scenario ${opts.scenarioFile}: ${(first.error as Error).message}`);
      return refuse(first.kind, first.message);
    }
    const sc = first.scenario;
    scenarioSha256 ??= sha256Hex(readFileSync(opts.scenarioFile)); // loaded above, so it is readable
    const semantic = sc.assert.filter((a) => judgedOpts(a) !== undefined);
    if (semantic.length === 0)
      return {
        ok: false,
        kind: "usage",
        message: scrub(`${CMD}: ${opts.scenarioFile} has no semantic_matches or semantic_pairwise assert — nothing to re-grade`, secrets),
        code: "no_semantic_asserts",
      };
    if (opts.judgeModel === undefined) {
      const bad = sc.assert.flatMap((a, i) => {
        const o = judgedOpts(a);
        if (!o) return [];
        const m = o.judgeModel ?? defaultJudgeModel();
        return isConcreteModelId(m) ? [] : [`assertion ${i}: "${m}"`];
      });
      if (bad.length)
        return refuse(
          "usage",
          `${CMD} needs a concrete judge model for every judged assert: ${bad.join("; ")}. Pass --judge-model <id> to grade every assert with one model.`,
        );
    }
    // semantic_pairwise: every reference a comparison will read must resolve before any spend. The agent already ran,
    // so there is no mount to expose a store through (mountRoots: []).
    if (sc.assert.some((a) => a.semantic_pairwise !== undefined)) {
      const pw = pairwiseRefsRefusal(sc, pairwiseSetupFor(sc, opts), []);
      if (pw) return refuse("runtime", `${CMD}: ${pw}`);
    }

    const persisted = first.result.authoredCapture;
    if (!persisted && opts.authoredTotalBytes === undefined)
      return refuse(
        "runtime",
        `${CMD}: ${dir} does not record the authored-file capture budget its live judge used (no authoredCapture in result.json — ` +
          `recorded by an older harness), so the judged document cannot be rebuilt as the judge saw it — evidence unavailable. ` +
          `Pass --authored-total-bytes <N> with the budget that run used (${DEFAULT_AUTHORED_TOTAL_BYTES} unless COWORK_HARNESS_AUTHORED_TOTAL_BYTES was set). ` +
          `(can't verify ⇒ not green)`,
      );
    const totalBytes = opts.authoredTotalBytes ?? persisted!.totalBytes;
    const budget: RegradeRunReport["authoredCapture"] = {
      totalBytes,
      ...(persisted ? { perFileBytes: persisted.perFileBytes } : {}),
      source: opts.authoredTotalBytes !== undefined ? "flag" : "persisted",
    };

    // Second pass: the evidence as the live run captured it — its budget, the scenario's evidence_files
    // union, and this process's secrets (the live run scrubbed with its own; a secret it knew of and this
    // process does not is the one gap a kept run cannot close). A missing transcript sidecar or work dir is
    // refused here, by the builder: both are sections of the judged document.
    const second = assertContextFromRunDir(dir, sc, {
      command: CMD,
      recomputeAuthored: "both",
      secrets,
      priorityGlobs: evidenceUnion(sc.assert),
      totalBytes,
      ...(persisted ? { perFileBytes: persisted.perFileBytes } : {}),
    });
    // The scenario is passed as an object here, so the builder cannot return its loader-failure arm.
    if (!second.ok) {
      if (second.kind === "scenario") throw new Error("unreachable: the scenario was passed as an object");
      return refuse(second.kind, second.message);
    }
    const live = liveSide(
      second.result,
      sc,
      persisted !== undefined && opts.authoredTotalBytes !== undefined && opts.authoredTotalBytes !== persisted.totalBytes,
    );

    // Drift check, before any judge call, over the LIVE asserts rebuilt from the LIVE inputs (see liveDocDrift).
    // When the new scenario's capture inputs equal the live ones, the context just built is those inputs.
    // A drift means the judge would be handed different bytes than the live judge read — possibly a value the
    // live run scrubbed and this process does not know — so nothing is sent unless the caller accepts that. It runs
    // under --allow-doc-drift too: an accepted drift is reported, and the rebuilt documents are what the unchecked
    // content is measured against.
    const liveBudget = { totalBytes: persisted?.totalBytes ?? totalBytes, perFileBytes: persisted?.perFileBytes };
    const checked = liveDocDrift(dir, second.result, sc, secrets, liveBudget, live.captureMoved ? undefined : second.ctx);
    if ("refusal" in checked) return refuse(checked.refusal.kind, checked.refusal.message);
    const drift: LiveDocDrift[] = checked.drift.map(({ liveIndex, sections }) => ({
      liveAssertionIndex: liveIndex,
      sections: sections.map(({ kind, path, change }) => ({ kind, ...(path !== undefined ? { path } : {}), change })),
    }));
    if (drift.length && !opts.allowDocDrift) {
      refusals.push({ runDir, code: "doc_drift", liveDocDrift: drift });
      refusalLines.push(
        `${CMD}: ${dir}: rebuilt from the live run's own inputs, the judged document differs from the one the live judge read ` +
          `(${liveDriftLabel(drift)}). ` +
          `An authored file changed in the kept work dir since the run, a different secret-scrub set in this process ` +
          `(which can mean a value the live run scrubbed is NOT scrubbed here — compare COWORK_HARNESS_SCRUB_VALUES / ` +
          `COWORK_HARNESS_SCRUB_KEYS with the live run's), or a sub-agent section can each cause it. Nothing was sent ` +
          `to the judge; pass --allow-doc-drift to grade anyway. (can't verify ⇒ not green)`,
      );
    }

    // The documents the judge will be handed (composed exactly as `runSemanticJudges` will), for what can be
    // said before the spend: the content no live fingerprint covers, and the asserts with no live
    // fingerprint to compare with at all. An assert whose evidence will be refused is decided here by the same
    // `semanticRefusal` over the same context, and left out: no judge is called for it, so its document
    // reaches no one and there is nothing to warn about.
    const newSemantic = sc.assert.filter((a) => judgedOpts(a) !== undefined);
    const willRefuse = new Set<Assertion>();
    const newDocs = new Map<Assertion, JudgedDocFingerprint>();
    for (const a of newSemantic) {
      const o = judgedOpts(a)!;
      const built = composeJudgedDocument(second.ctx, o.includeSubagentText, o.evidenceFiles, o.includeForkResults);
      if (semanticRefusal(a, second.ctx, built)) willRefuse.add(a);
      else newDocs.set(a, built.fingerprint);
    }
    const blind = newSemantic.flatMap((a, ordinal) => {
      if (willRefuse.has(a)) return [];
      const { match } = compareWithLive(a, ordinal, sc.assert.indexOf(a), newDocs.get(a), live, false);
      return match === "unknown" || match === "live_refused" ? [{ assertionIndex: sc.assert.indexOf(a), docMatch: match }] : [];
    });
    const unchecked = uncheckedSections(
      newDocs,
      sc,
      checked.rebuilt.flatMap((fp) => fp.sections),
    );
    if (unchecked.length && !opts.allowUnchecked) {
      refusals.push({ runDir, code: "unchecked_content", uncheckedCount: unchecked.length, uncheckedSections: unchecked });
      refusalLines.push(
        `${CMD}: ${dir}: ${unchecked.length} section(s) of the graded document were never read by the live judge ` +
          `(${uncheckedLabel(unchecked)}) — brought in by a widened scope (evidence_files / include_subagent_text / include_fork_results) or a larger ` +
          `--authored-total-bytes. They cannot be checked for drift or for a secret the live run scrubbed and this process does not. ` +
          `Nothing was sent to the judge; pass --allow-unchecked to grade anyway. (can't verify ⇒ not green)`,
      );
    }
    prepared.push({
      liveEntries: second.result.assertions ?? [],
      runDir,
      dirAsGiven: dir,
      turn: second.turn,
      ctx: second.ctx,
      unchecked,
      drift: opts.allowDocDrift ? drift : [],
      blind,
      willRefuse,
      resultSha256: sha256Hex(readFileSync(turnArtifactPath(runDir, second.turn, "result.json"))),
      budget,
      live,
      workspaceFiles: second.result.workspaceFiles,
    });
  }

  if (refusals.length)
    return {
      ok: false,
      kind: "runtime",
      message: scrub(refusalLines.join("\n"), secrets),
      code: refusals.some((r) => r.code === "doc_drift") ? "doc_drift" : "unchecked_content",
      refusals: refusals.map((r) => scrubRefusal(r, secrets)),
    };

  // The preflight ends here: everything above is what a real re-grade decides before its first judge call. The
  // values are those a real re-grade's `runs[]` carries, unscrubbed in-process as those are.
  if (opts.checkOnly)
    return {
      ok: true,
      checkOnly: true,
      runs: prepared.map((p) => ({
        runDir: p.runDir,
        turn: p.turn,
        scenarioSha256: scenarioSha256!,
        uncheckedSections: p.unchecked,
        uncheckedCount: p.unchecked.length,
        liveDocDrift: p.drift,
        blind: p.blind,
        authoredCapture: p.budget,
      })),
    };

  const sc = loadScenario();
  const semantic = sc.assert.filter((a) => judgedOpts(a) !== undefined);
  const fill = opts.pairwise?.onlyRefs !== undefined;
  const runs: RegradeRunReport[] = [];
  for (const p of prepared) {
    // Accepted with --allow-unchecked (refused above otherwise), and said before the spend.
    if (p.unchecked.length)
      warn(
        scrub(
          `::warning:: ${CMD}: ${p.dirAsGiven}: ${p.unchecked.length} section(s) of the graded document were never read by the live judge ` +
            `(${uncheckedLabel(p.unchecked)}) — brought in by a widened scope (evidence_files / include_subagent_text / include_fork_results) or a larger ` +
            `--authored-total-bytes. They were never checked for drift or for a secret the live run scrubbed; this process's scrub set ` +
            `is all that protects them (--allow-unchecked).`,
          secrets,
        ),
      );
    // Accepted with --allow-doc-drift (refused above otherwise), and said before the spend.
    if (p.drift.length)
      warn(
        scrub(
          `::warning:: ${CMD}: ${p.dirAsGiven}: the kept evidence differs from what the live judge read (${liveDriftLabel(p.drift)}) — ` +
            `grading anyway (--allow-doc-drift); the run is reported docMatchesLive: false.`,
          secrets,
        ),
      );
    // Asserts with nothing live to compare with were neither drift-checked nor secret-checked. Not refused —
    // a run graded before fingerprints existed is still worth re-grading — but said before the spend.
    const blind = p.blind;
    if (blind.length)
      warn(
        scrub(
          `::warning:: ${CMD}: ${p.dirAsGiven}: ${blind.length} assert(s) have no live document to compare with (${blind.map((b) => `assert ${b.assertionIndex}: ${b.docMatch}`).join(", ")}) — ` +
            `unknown: this assert's scope has no live fingerprint; live_refused: the live assert refused its evidence and no fingerprint was recorded. ` +
            `Their rebuilt documents could not be checked for drift or for a secret the live run scrubbed; this process's scrub set ` +
            `is all that protects them.`,
          secrets,
        ),
      );
    // Fill mode only adds pairwise comparisons: a semantic_matches grade is not repeated (its live entry is kept below).
    if (!fill) {
      const { judge, judgeFor } = judgesForRun({ modelOverride: opts.judgeModel }, opts.makeJudge);
      // The SAME array to both calls: `check` reads the judge's results back by assertion identity.
      await runSemanticJudges(semantic, p.ctx, judge, judgeFor);
    }
    if (sc.assert.some((a) => a.semantic_pairwise !== undefined)) {
      const setup = pairwiseSetupFor(sc, opts);
      const liveEntries = p.liveEntries;
      // The FULL assert list: the comparison order is seeded by the assert's index in the scenario, as it was live,
      // and by the run id the live pre-pass used (the run dir's name).
      await runPairwiseJudges(sc.assert, p.ctx, {
        caseId: setup.caseId,
        sessionId: basename(p.runDir),
        task: sc.prompt,
        refsFor: setup.refsFor,
        neutralRefs: setup.neutralRefs,
        ...(setup.gateRefs ? { gateRefs: setup.gateRefs } : {}),
        ...(opts.pairwise?.onlyRefs
          ? {
              onlyRefs: new Set(opts.pairwise.onlyRefs),
              copyOutcome: (i: number, ref: string) => liveEntries[i]?.pairwise?.find((o) => o.ref === ref),
            }
          : {}),
        judgeFor: (model) => makePairwiseJudge({ model, complete: opts.pairwiseComplete ?? claudeCliCompleteStructured }),
        ...(opts.pairwiseComplete ? {} : { transport: () => transportIdentity() }),
        modelFor: (a) => opts.judgeModel ?? a.semantic_pairwise?.judge_model ?? defaultJudgeModel(),
      });
    }
    // The warnings above left out the asserts predicted to refuse. Had a judge been handed one of their
    // documents after all, it went out unwarned — fail loudly rather than report it as not_graded.
    for (const a of p.willRefuse)
      if (!p.ctx.semanticRefused?.has(a) || p.ctx.judgedDocs?.has(a))
        throw new Error(
          `${CMD}: internal: assert ${sc.assert.indexOf(a)} was predicted to refuse its evidence but a judge was called for it`,
        );
    // In fill mode a semantic_matches entry is the live one, unchanged: nothing about it was re-graded.
    const graded = evaluate(semantic, p.ctx).map((g, k) => {
      const live = p.liveEntries[sc.assert.indexOf(semantic[k]!)];
      return fill && semantic[k]!.semantic_matches !== undefined && live ? (live as typeof g) : g;
    });
    const metrics = remeasureMetrics(p.ctx, { workspaceFiles: p.workspaceFiles }, sc.metrics);

    const differing: DifferingSection[] = [];
    // A section the accepted drift touched (kind and path): an assert whose document carries one read drifted bytes.
    const drifted = new Set(p.drift.flatMap((d) => d.sections.map((x) => `${x.kind}\0${x.path ?? ""}`)));
    const assertions: RegradedAssertion[] = graded.map((g, ordinal) => {
      const a = semantic[ordinal];
      const assertionIndex = sc.assert.indexOf(a);
      // Over the fingerprint of what the judge was handed, not the drift check's copy.
      const refusedNow = g.semanticEvidence !== undefined && g.semanticEvidence.reason !== "graded";
      const c = compareWithLive(a, ordinal, assertionIndex, p.ctx.judgedDocs?.get(a) ?? p.ctx.composedDocs?.get(a), p.live, refusedNow);
      differing.push(...c.differing);
      const now = p.ctx.judgedDocs?.get(a) ?? p.ctx.composedDocs?.get(a);
      const readDrift = c.match !== "not_graded" && now?.sections.some((x) => drifted.has(`${x.kind}\0${x.path ?? ""}`)) === true;
      return {
        assertionIndex,
        ...g,
        docMatchesLive: readDrift ? false : c.match,
      } as RegradedAssertion;
    });
    // Per assert, the value describes that assert's own document; the run's value never reads true (or not_graded)
    // over a drift that was detected and accepted.
    const docMatchesLive = p.drift.length ? false : aggregate(assertions.map((a) => a.docMatchesLive));
    const notRegraded = sc.assert.flatMap((a, i) => (judgedOpts(a) !== undefined ? [] : [{ assertionIndex: i, keys: Object.keys(a) }]));
    const pass = assertions.every((a) => a.pass);
    const spend = judgeSpend(assertions);
    const invalidGrades = assertions.filter((a) => a.judgeInvalid === true).length;

    const at = (opts.now ?? (() => new Date()))().toISOString();
    const stem = regradeFileStem(assertions, opts.judgeModel, at);
    const dir = join(turnWriteDir(p.runDir, p.turn), "regrade");
    const body = {
      command: CMD,
      harnessVersion: pkgVersion(),
      regradedAt: at,
      scenario: sc.name,
      scenarioSha256: scenarioSha256!,
      authoredCapture: p.budget,
      docMatchesLive,
      differingSections: differing,
      liveDocDrift: p.drift,
      // An all-invalid round (a judge outage) is still written, and these counts are what tell it apart from
      // a failing grade without walking `assertions[]`.
      regraded: assertions.length,
      uncheckedSections: p.unchecked,
      uncheckedCount: p.unchecked.length,
      invalidGrades,
      ...spend,
      assertions,
      notRegraded,
      original: { resultSha256: p.resultSha256, turn: p.turn },
      ...(metrics ? { metrics } : {}),
    };
    // Scrubbed as a whole document, as result.json is: the rationales are scrubbed at grade time, but the
    // rubric and messages echo scenario text, and one pass over the serialized body leaves no field out.
    let regradeFile: string;
    try {
      mkdirSync(dir, { recursive: true });
      regradeFile = writeNew(dir, stem, scrub(JSON.stringify(body, null, 2), secrets) + "\n");
    } catch (e) {
      // This dir's judge calls were spent; the earlier dirs' files are written, and their reports are returned.
      return {
        ok: false,
        kind: "runtime",
        message: scrub(
          `${CMD}: ${p.dirAsGiven}: could not write the regrade file (${(e as Error).message}) — its judge calls were spent and ` +
            `its grade is lost. ${runs.length} earlier run dir(s) were graded and written.`,
          secrets,
        ),
        completed: runs,
      };
    }
    runs.push({
      runDir: p.runDir,
      turn: p.turn,
      scenarioSha256: scenarioSha256!,
      regradeFile,
      pass,
      invalidGrades,
      ...spend,
      uncheckedSections: p.unchecked,
      uncheckedCount: p.unchecked.length,
      docMatchesLive,
      differingSections: differing,
      liveDocDrift: p.drift,
      assertions,
      notRegraded,
      authoredCapture: p.budget,
      ...(metrics ? { metrics } : {}),
    });
  }
  return { ok: true, exitCode: runs.every((r) => r.pass) ? 0 : 1, runs };
}

/** The `--output-format json` document for a completed re-grade (payload-shaped: `runs[]`, not `results[]`),
 *  scrubbed as a whole with `secrets` — pass the set the re-grade used. */
export function regradeEnvelope(outcome: Extract<RegradeOutcome, { ok: true }>, secrets: string[] = collectSecrets()): string {
  return scrub(
    jsonPayloadEnvelope(CMD, outcome.exitCode === 0, { ...judgeSpend(outcome.runs.flatMap((r) => r.assertions)), runs: outcome.runs }),
    secrets,
  );
}

/** The `--output-format json` error document for a re-grade that did not complete: the shared error envelope, plus
 *  `error.code` and `refusals[]` on an evidence refusal, or the completed runs' reports (`runs`) after a failure
 *  writing a regrade file. Scrubbed as a whole with `secrets`. */
export function regradeErrorEnvelope(outcome: Extract<RegradeOutcome, { ok: false }>, secrets: string[] = collectSecrets()): string {
  return scrub(
    jsonError(CMD, outcome.kind, outcome.message, undefined, [], {
      ...(outcome.code ? { error: { code: outcome.code } } : {}),
      payload: {
        ...(outcome.refusals ? { refusals: outcome.refusals } : {}),
        ...(outcome.completed ? { runs: outcome.completed } : {}),
      },
    }),
    secrets,
  );
}

const usd = (s: JudgeSpend): string =>
  s.judgeCostUsd === undefined
    ? "unpriced"
    : `$${s.judgeCostUsd.toFixed(4)}${s.unpricedGrades > 0 ? ` (${s.unpricedGrades} unpriced — a floor)` : ""}`;

function docMatchLine(r: RegradeRunReport): string {
  const where = sectionLabel;
  switch (r.docMatchesLive) {
    case true:
      return "· judged document: identical to the one the live judge read";
    case "unknown":
      return "· judged document: cannot compare — this assert's scope has no live fingerprint (not drift- or secret-checked)";
    case "live_refused":
      return "· judged document: cannot compare — the live assert refused its evidence and no fingerprint was recorded (not drift- or secret-checked)";
    case "not_graded":
      return "· judged document: not graded — this re-grade's assert refused its evidence before any judge read a document (see its message)";
    case "scope_changed":
      return `· judged document: evidence scope or capture budget changed since the live run, so it differs by design${
        r.differingSections.length ? ` (${r.differingSections.map(where).join(", ")})` : ""
      }`;
    case false: {
      // Neutral about the cause on purpose: an authored file changed in the kept work dir, a secret this process
      // scrubs differently, and a sub-agent section all surface here, and the section list is what tells them apart.
      const parts = [
        ...(r.differingSections.length ? [`Differing: ${r.differingSections.map(where).join(", ")}`] : []),
        ...(r.liveDocDrift.length ? [`accepted live drift (--allow-doc-drift): ${liveDriftLabel(r.liveDocDrift)}`] : []),
      ];
      return `::warning:: judged document DIFFERS from the one the live judge read — this grade is not comparable with the live one. ${parts.join("; ") || "Differing: whole-document hash"}`;
    }
  }
}

/** The text-mode report (written to stderr), each line scrubbed with `secrets`: the claim lines and the
 *  messages echo scenario text. */
export function regradeTextReport(outcome: Extract<RegradeOutcome, { ok: true }>, secrets: string[] = collectSecrets()): string[] {
  const lines: string[] = [];
  const log = (s: string) => lines.push(scrub(s, secrets));
  for (const r of outcome.runs) {
    log(`regrade ${tildeify(r.runDir)}`);
    for (const a of r.assertions) {
      log(
        `${a.pass ? "✓" : "✗"} ${judgedOpts(a.assertion)?.key ?? "semantic_matches"} (assert ${a.assertionIndex})${a.message ? ` — ${a.message}` : ""}${a.judgeModel ? `  [judge ${a.judgeModel}]` : ""}`,
      );
      for (const c of a.semanticClaims ?? []) log(`    ${c.pass ? "✓" : "✗"} ${c.claim}`);
    }
    if (r.notRegraded.length) log(`· not re-graded: ${r.notRegraded.map((n) => n.keys.join("+")).join(", ")}`);
    log(docMatchLine(r));
    log(`· judge spend: ${usd(r)}`);
    log(`· wrote ${tildeify(r.regradeFile)}`);
  }
  const total = outcome.runs.flatMap((r) => r.assertions);
  const invalid = total.filter((a) => a.judgeInvalid === true).length;
  const failed = total.filter((a) => !a.pass && a.judgeInvalid !== true).length;
  const spend = `judge spend ${usd(judgeSpend(total))}`;
  log(
    failed === 0 && invalid === 0
      ? `✓ regrade: all ${total.length} re-graded assertion(s) pass · ${spend}`
      : `✗ regrade: ${failed}/${total.length} re-graded assertion(s) failed` +
          (invalid ? `, ${invalid} ungraded (judge invalid — not a verdict on the run)` : "") +
          ` · ${spend}`,
  );
  return lines;
}

/** `regrade` CLI entry. */
export async function cmdRegrade(args: string[]): Promise<never> {
  const json = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({
        booleans: [...REGRADE_BOOLEAN_FLAGS],
        values: [...REGRADE_VALUE_FLAGS],
        enums: { "--output-format": ["text", "json"] },
        noDashValue: ["--scenario"],
      }),
    );
  } catch (e) {
    // An argument error echoes what was typed, so it is scrubbed like every other message this command prints.
    return fail(CMD, "usage", scrub((e as Error).message, collectSecrets()), undefined, json);
  }
  applyParsedCommandGlobals(CMD, p, json);
  // One secret set for the re-grade and everything this command prints (after the globals, so a --dotenv
  // file's scrub settings count): the rubric and the judge's messages echo scenario text.
  const secrets = collectSecrets();
  const scenarioFile = p.options["--scenario"];
  if (p.positionals.length === 0 || !scenarioFile) return fail(CMD, "usage", REGRADE_USAGE, undefined, json);
  let authoredTotalBytes: number | undefined;
  const rawBudget = p.options["--authored-total-bytes"];
  if (rawBudget !== undefined) {
    const n = parseAuthoredTotalBytes(rawBudget);
    if (n === null)
      return fail(
        CMD,
        "usage",
        scrub(`--authored-total-bytes must be a whole number of bytes >= 1 (got ${JSON.stringify(rawBudget)})`, secrets),
        undefined,
        json,
      );
    authoredTotalBytes = n;
  }
  // Every grade is a host-`claude` judge call: one that cannot run isolated is refused here (exit 2), not graded
  // as a run of invalid judge replies.
  const refusal = isolationRefusal();
  if (refusal) return fail(CMD, "usage", scrub(refusal, secrets), undefined, json);
  const outcome = await regradeRuns({
    secrets,
    runDirs: p.positionals,
    scenarioFile,
    judgeModel: p.options["--judge-model"],
    authoredTotalBytes,
    allowDocDrift: p.flags["--allow-doc-drift"] === true,
    allowUnchecked: p.flags["--allow-unchecked"] === true,
  });
  if (!outcome.ok) {
    if (json) {
      writeAllSync(1, regradeErrorEnvelope(outcome, secrets) + "\n");
      return process.exit(2);
    }
    // After a failed write, what was graded is still reported before the error.
    if (outcome.completed?.length)
      for (const line of regradeTextReport({ ok: true, exitCode: 1, runs: outcome.completed }, secrets)) writeAllSync(2, line + "\n");
    return fail(CMD, outcome.kind, outcome.message, undefined, false);
  }
  if (json) writeAllSync(1, regradeEnvelope(outcome, secrets) + "\n");
  else for (const line of regradeTextReport(outcome, secrets)) writeAllSync(2, line + "\n");
  return process.exit(outcome.exitCode);
}
