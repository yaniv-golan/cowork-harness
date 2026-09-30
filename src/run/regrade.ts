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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { composeJudgedDocument, evaluate, runSemanticJudges, type AssertContext } from "../assert.js";
import { parseArgs } from "../cli-args.js";
import { defaultJudgeModel, judgesForRun } from "../decide/semantic-judge.js";
import { tildeify, writeAllSync } from "../io.js";
import { collectSecrets, scrub } from "../secrets.js";
import type { Assertion, JudgedDocFingerprint, RunResult, Scenario } from "../types.js";
import { DEFAULT_AUTHORED_TOTAL_BYTES, parseAuthoredTotalBytes } from "./artifacts.js";
import { applyParsedCommandGlobals, withCommandGlobals } from "./command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope, pkgVersion } from "./envelope.js";
import { parseScenarioFile } from "./execute.js";
import { turnArtifactPath, turnWriteDir } from "./turn-layout.js";
import { assertContextFromRunDir } from "./verify-context.js";
import { isConcreteModelId } from "./model-provenance.js";
import { REGRADE_BOOLEAN_FLAGS, REGRADE_USAGE, REGRADE_VALUE_FLAGS } from "./regrade-usage.js";

export { REGRADE_BOOLEAN_FLAGS, REGRADE_USAGE, REGRADE_VALUE_FLAGS } from "./regrade-usage.js";

const CMD = "regrade";

/** Whether the re-grade's judged document is the one the live judge read. See REGRADE_USAGE. */
export type DocMatch = true | false | "scope_changed" | "unknown";

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

export interface RegradeRunReport extends JudgeSpend {
  runDir: string;
  turn: number;
  /** SHA-256 of the scenario file's bytes, so a grade names the exact rubric it was made with. */
  scenarioSha256: string;
  regradeFile: string;
  pass: boolean;
  /** Asserts whose grade is INVALID (the judge failed twice, e.g. an outage or a malformed grade) — counted
   *  apart from failures: an invalid grade says nothing about the run. It still makes `pass` false. */
  invalidGrades: number;
  docMatchesLive: DocMatch;
  differingSections: DifferingSection[];
  assertions: RegradedAssertion[];
  notRegraded: Array<{ assertionIndex: number; keys: string[] }>;
  authoredCapture: { totalBytes: number; perFileBytes?: number; source: "persisted" | "flag" };
}

export type RegradeOutcome =
  { ok: true; exitCode: 0 | 1; runs: RegradeRunReport[] } | { ok: false; kind: "usage" | "runtime"; message: string };

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
  /** The secret set the judged document, the regrade file and every message are scrubbed with. Default:
   *  `collectSecrets()`. The CLI passes the one set it also scrubs its own output with. */
  secrets?: string[];
  /** Test seam: the judge factory `judgesForRun` builds from (default: the real judge). */
  makeJudge?: Parameters<typeof judgesForRun>[1];
  /** Test seam: the clock that names the output file. */
  now?: () => Date;
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

/** What the judged document depends on besides the shared capture: an assert's own sub-agent opt-in and its
 *  `evidence_files` scope (order-free; an empty list is unscoped, as `scopeAuthoredEvidence` reads it). */
function ownScopeKey(sm: NonNullable<Assertion["semantic_matches"]>): string {
  return JSON.stringify([sm.include_subagent_text === true, [...new Set(sm.evidence_files ?? [])].sort()]);
}

/** The capture's priority globs — the same expression the live run uses. */
function evidenceUnion(asserts: Array<Assertion | undefined>): string[] {
  return [...new Set(asserts.flatMap((a) => a?.semantic_matches?.evidence_files ?? []))];
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

function liveSide(result: RunResult, sc: Scenario, budgetChanged: boolean): LiveSide {
  const liveSemantic = (result.assertions ?? []).filter((r) => r.assertion?.semantic_matches !== undefined);
  const captureMoved = budgetChanged || !sameSet(evidenceUnion(liveSemantic.map((r) => r.assertion)), evidenceUnion(sc.assert));
  return { liveSemantic, captureMoved };
}

/** Compare one graded assert's document (`now`, the fingerprint of what the judge was handed) with the one
 *  its live counterpart's judge read — the reported `docMatchesLive`. The refusal is decided separately,
 *  before any judge call, by `liveDocDrift`. */
function compareWithLive(
  a: Assertion,
  ordinal: number,
  assertionIndex: number,
  now: JudgedDocFingerprint | undefined,
  live: LiveSide,
): { match: DocMatch; differing: DifferingSection[] } {
  // The document is a function of the shared capture and the assert's own scope, so any live assert with
  // the same own scope read the same document. With none, the one at the same position among the
  // semantic asserts is compared, for the section list, and the scope is reported changed.
  const key = ownScopeKey(a.semantic_matches!);
  const sameScope = live.liveSemantic.filter((r) => ownScopeKey(r.assertion.semantic_matches!) === key);
  const counterpart = sameScope.find((r) => r.judgedDoc) ?? sameScope[0] ?? live.liveSemantic[ordinal];
  const scopeChanged = sameScope.length === 0 || live.captureMoved;
  if (!counterpart || !counterpart.judgedDoc || !now) return { match: scopeChanged ? "scope_changed" : "unknown", differing: [] };
  const differing = diffSections(counterpart.judgedDoc, now, assertionIndex);
  const match: DocMatch = scopeChanged
    ? "scope_changed"
    : differing.length === 0 && counterpart.judgedDoc.sha256 === now.sha256
      ? true
      : false;
  return { match, differing };
}

/**
 * Rebuild each LIVE semantic assert's document from the LIVE inputs — its own scope, the live `evidence_files`
 * union, the persisted budget — with this process's secrets, and compare it with the `judgedDoc` that assert
 * recorded. Independent of the new scenario, so a changed scope or budget (`scope_changed` on the graded
 * document) cannot hide a drift: in particular a value the live run scrubbed and this process does not, which
 * would otherwise reach the judge unredacted. A live assert that recorded no `judgedDoc` cannot be checked.
 * Returns the differing sections, indexed by the assert's position in `result.assertions`.
 */
function liveDocDrift(
  runDir: string,
  result: RunResult,
  sc: Scenario,
  secrets: string[],
  budget: { totalBytes: number; perFileBytes?: number },
  sameInputs: AssertContext | undefined,
): { drift: Array<{ liveIndex: number; sections: DifferingSection[] }> } | { refusal: { kind: "usage" | "runtime"; message: string } } {
  const live = (result.assertions ?? [])
    .map((r, liveIndex) => ({ r, liveIndex }))
    .filter(({ r }) => r.assertion?.semantic_matches !== undefined && r.judgedDoc !== undefined);
  if (live.length === 0) return { drift: [] };
  let ctx = sameInputs;
  if (!ctx) {
    // The live asserts stand in for the scenario: the builder reads only `assert` to decide what to capture.
    const built = assertContextFromRunDir(
      runDir,
      { ...sc, assert: live.map(({ r }) => r.assertion) },
      {
        command: CMD,
        recomputeAuthored: "semantic",
        secrets,
        priorityGlobs: evidenceUnion(live.map(({ r }) => r.assertion)),
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
    const sm = r.assertion.semantic_matches!;
    const key = ownScopeKey(sm);
    let fp = cache.get(key);
    if (!fp) {
      fp = composeJudgedDocument(ctx, sm.include_subagent_text === true, sm.evidence_files).fingerprint;
      cache.set(key, fp);
    }
    const sections = diffSections(r.judgedDoc!, fp, liveIndex);
    if (sections.length || r.judgedDoc!.sha256 !== fp.sha256) drift.push({ liveIndex, sections });
  }
  return { drift };
}

const sectionLabel = (d: DifferingSection): string => `${d.change} ${d.kind}${d.path !== undefined ? ` ${d.path}` : ""}`;

function aggregate(matches: DocMatch[]): DocMatch {
  if (matches.includes(false)) return false;
  if (matches.includes("scope_changed")) return "scope_changed";
  if (matches.includes("unknown")) return "unknown";
  return true;
}

/** Path-safe component: anything outside `[A-Za-z0-9._-]` (a `[1m]` suffix, an ISO time's colons) becomes `-`. */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-");

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
  turn: number;
  ctx: AssertContext;
  resultSha256: string;
  budget: RegradeRunReport["authoredCapture"];
  live: LiveSide;
}

/**
 * Re-grade every run dir. Every run dir's evidence is rebuilt (and every refusal decided) BEFORE the first
 * judge call, so one bad dir in a batch spends nothing.
 */
export async function regradeRuns(opts: RegradeOptions): Promise<RegradeOutcome> {
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
    const semantic = sc.assert.filter((a) => a.semantic_matches !== undefined);
    if (semantic.length === 0) return refuse("usage", `${CMD}: ${opts.scenarioFile} has no semantic_matches assert — nothing to re-grade`);
    if (opts.judgeModel === undefined) {
      const bad = sc.assert.flatMap((a, i) => {
        if (!a.semantic_matches) return [];
        const m = a.semantic_matches.judge_model ?? defaultJudgeModel();
        return isConcreteModelId(m) ? [] : [`assertion ${i}: "${m}"`];
      });
      if (bad.length)
        return refuse(
          "usage",
          `${CMD} needs a concrete judge model for every semantic_matches assert: ${bad.join("; ")}. Pass --judge-model <id> to grade every assert with one model.`,
        );
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
    // live run scrubbed and this process does not know — so nothing is sent unless the caller accepts that.
    if (!opts.allowDocDrift) {
      const liveBudget = { totalBytes: persisted?.totalBytes ?? totalBytes, perFileBytes: persisted?.perFileBytes };
      const checked = liveDocDrift(dir, second.result, sc, secrets, liveBudget, live.captureMoved ? undefined : second.ctx);
      if ("refusal" in checked) return refuse(checked.refusal.kind, checked.refusal.message);
      if (checked.drift.length)
        return refuse(
          "runtime",
          `${CMD}: ${dir}: rebuilt from the live run's own inputs, the judged document differs from the one the live judge read ` +
            `(${checked.drift
              .map(
                ({ liveIndex, sections }) => `live assert ${liveIndex}: ${sections.map(sectionLabel).join(", ") || "whole-document hash"}`,
              )
              .join("; ")}). ` +
            `An authored file changed in the kept work dir since the run, a different secret-scrub set in this process ` +
            `(which can mean a value the live run scrubbed is NOT scrubbed here — compare COWORK_HARNESS_SCRUB_VALUES / ` +
            `COWORK_HARNESS_SCRUB_KEYS with the live run's), or a sub-agent section can each cause it. Nothing was sent ` +
            `to the judge; pass --allow-doc-drift to grade anyway. (can't verify ⇒ not green)`,
        );
    }

    prepared.push({
      runDir,
      turn: second.turn,
      ctx: second.ctx,
      resultSha256: sha256Hex(readFileSync(turnArtifactPath(runDir, second.turn, "result.json"))),
      budget,
      live,
    });
  }

  const sc = loadScenario();
  const semantic = sc.assert.filter((a) => a.semantic_matches !== undefined);
  const runs: RegradeRunReport[] = [];
  for (const p of prepared) {
    const { judge, judgeFor } = judgesForRun({ modelOverride: opts.judgeModel }, opts.makeJudge);
    // The SAME array to both calls: `check` reads the judge's results back by assertion identity.
    await runSemanticJudges(semantic, p.ctx, judge, judgeFor);
    const graded = evaluate(semantic, p.ctx);

    const differing: DifferingSection[] = [];
    const assertions: RegradedAssertion[] = graded.map((g, ordinal) => {
      const a = semantic[ordinal];
      const assertionIndex = sc.assert.indexOf(a);
      // Over the fingerprint of what the judge was handed, not the drift check's copy.
      const c = compareWithLive(a, ordinal, assertionIndex, p.ctx.judgedDocs?.get(a), p.live);
      differing.push(...c.differing);
      return {
        assertionIndex,
        ...g,
        docMatchesLive: c.match,
      } as RegradedAssertion;
    });
    const docMatchesLive = aggregate(assertions.map((a) => a.docMatchesLive));
    const notRegraded = sc.assert.flatMap((a, i) =>
      a.semantic_matches !== undefined ? [] : [{ assertionIndex: i, keys: Object.keys(a) }],
    );
    const pass = assertions.every((a) => a.pass);
    const spend = judgeSpend(assertions);
    const invalidGrades = assertions.filter((a) => a.judgeInvalid === true).length;

    const models = [...new Set(assertions.map((a) => a.judgeModel ?? "unknown"))];
    const hashes = [...new Set(assertions.map((a) => a.judgePromptHash ?? "no-prompt-hash"))];
    const at = (opts.now ?? (() => new Date()))().toISOString();
    const stem = safe(
      `${hashes.length === 1 ? hashes[0] : "mixed"}-${opts.judgeModel ?? (models.length === 1 ? models[0] : "mixed")}-${at}`,
    );
    const dir = join(turnWriteDir(p.runDir, p.turn), "regrade");
    mkdirSync(dir, { recursive: true });
    const body = {
      command: CMD,
      harnessVersion: pkgVersion(),
      regradedAt: at,
      scenario: sc.name,
      scenarioSha256: scenarioSha256!,
      authoredCapture: p.budget,
      docMatchesLive,
      differingSections: differing,
      // An all-invalid round (a judge outage) is still written, and these counts are what tell it apart from
      // a failing grade without walking `assertions[]`.
      regraded: assertions.length,
      invalidGrades,
      ...spend,
      assertions,
      notRegraded,
      original: { resultSha256: p.resultSha256, turn: p.turn },
    };
    // Scrubbed as a whole document, as result.json is: the rationales are scrubbed at grade time, but the
    // rubric and messages echo scenario text, and one pass over the serialized body leaves no field out.
    const regradeFile = writeNew(dir, stem, scrub(JSON.stringify(body, null, 2), secrets) + "\n");
    runs.push({
      runDir: p.runDir,
      turn: p.turn,
      scenarioSha256: scenarioSha256!,
      regradeFile,
      pass,
      invalidGrades,
      ...spend,
      docMatchesLive,
      differingSections: differing,
      assertions,
      notRegraded,
      authoredCapture: p.budget,
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
      return "· judged document: cannot compare — the run did not record the live document's fingerprint";
    case "scope_changed":
      return `· judged document: evidence scope or capture budget changed since the live run, so it differs by design${
        r.differingSections.length ? ` (${r.differingSections.map(where).join(", ")})` : ""
      }`;
    case false:
      // Neutral about the cause on purpose: an authored file changed in the kept work dir, a secret this process
      // scrubs differently, and a sub-agent section all surface here, and the section list is what tells them apart.
      return `::warning:: judged document DIFFERS from the one the live judge read — this grade is not comparable with the live one. Differing: ${r.differingSections.map(where).join(", ") || "whole-document hash"}`;
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
        `${a.pass ? "✓" : "✗"} semantic_matches (assert ${a.assertionIndex})${a.message ? ` — ${a.message}` : ""}${a.judgeModel ? `  [judge ${a.judgeModel}]` : ""}`,
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
    return fail(CMD, "usage", (e as Error).message, undefined, json);
  }
  applyParsedCommandGlobals(CMD, p, json);
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
        `--authored-total-bytes must be a whole number of bytes >= 1 (got ${JSON.stringify(rawBudget)})`,
        undefined,
        json,
      );
    authoredTotalBytes = n;
  }
  // One secret set for the re-grade and everything this command prints: the rubric and the judge's messages
  // echo scenario text, which reaches the claim lines and the envelope unscrubbed otherwise.
  const secrets = collectSecrets();
  const outcome = await regradeRuns({
    secrets,
    runDirs: p.positionals,
    scenarioFile,
    judgeModel: p.options["--judge-model"],
    authoredTotalBytes,
    allowDocDrift: p.flags["--allow-doc-drift"] === true,
  });
  if (!outcome.ok) return fail(CMD, outcome.kind, outcome.message, undefined, json);
  if (json) writeAllSync(1, regradeEnvelope(outcome, secrets) + "\n");
  else for (const line of regradeTextReport(outcome, secrets)) writeAllSync(2, line + "\n");
  return process.exit(outcome.exitCode);
}
