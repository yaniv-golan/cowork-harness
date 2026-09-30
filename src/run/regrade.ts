/**
 * `regrade <run-dir>… --scenario <yaml>` — re-grade a KEPT run's `semantic_matches` asserts with the semantic
 * judge, without re-running the agent. The judge call is the only spend.
 *
 * The evidence is rebuilt by the shared kept-run builder (`assertContextFromRunDir`) with the inputs the live
 * run's capture used: the persisted capture budget (`result.json` `authoredCapture`), the scenario's
 * `evidence_files` union as priority globs, and this process's secret set, so every section of the judged
 * document is scrubbed before it leaves. Whether that rebuilt document is the one the live judge read is
 * then MEASURED, not assumed: each assert's recomposed fingerprint is compared, section by section, with the
 * `judgedDoc` the live run persisted.
 *
 * The result is written beside the run (`turns/<N>/regrade/<promptHash>-<judgeModel>-<iso>.json`).
 * `result.json` is never modified and no run-index row is added — a re-grade is not a run, and indexing it
 * would count the run twice in `stats`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluate, runSemanticJudges, type AssertContext } from "../assert.js";
import { parseArgs } from "../cli-args.js";
import { defaultJudgeModel, judgesForRun } from "../decide/semantic-judge.js";
import { tildeify, writeAllSync } from "../io.js";
import { collectSecrets } from "../secrets.js";
import type { Assertion, JudgedDocFingerprint, RunResult, Scenario } from "../types.js";
import { DEFAULT_AUTHORED_TOTAL_BYTES, parseAuthoredTotalBytes } from "./artifacts.js";
import { applyParsedCommandGlobals, withCommandGlobals } from "./command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "./envelope.js";
import { parseScenarioFile } from "./execute.js";
import { turnArtifactPath, turnWriteDir } from "./turn-layout.js";
import { assertContextFromRunDir } from "./verify-context.js";
import { REGRADE_USAGE, REGRADE_VALUE_FLAGS } from "./regrade-usage.js";

export { REGRADE_BOOLEAN_FLAGS, REGRADE_USAGE, REGRADE_VALUE_FLAGS } from "./regrade-usage.js";

const CMD = "regrade";

// dedupe with isConcreteModelId: this is the same check (a family alias or a mode alias names no single
// model; `[1m]` is a context-window selector on the same model). Replace with the shared helper when it lands.
const FAMILY_ALIASES = ["sonnet", "opus", "haiku", "fable"];
const UNRESOLVABLE_ALIASES = ["best", "opusplan"];
function isConcreteJudgeModel(id: string | undefined): id is string {
  if (id === undefined) return false;
  const n = id
    .trim()
    .replace(/\[\dm\]$/i, "")
    .toLowerCase();
  return n !== "" && !FAMILY_ALIASES.includes(n) && !UNRESOLVABLE_ALIASES.includes(n);
}

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

export interface RegradeRunReport {
  runDir: string;
  turn: number;
  regradeFile: string;
  pass: boolean;
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
  /** Test seam: the judge factory `judgesForRun` builds from (default: the real judge). */
  makeJudge?: Parameters<typeof judgesForRun>[1];
  /** Test seam: the clock that names the output file. */
  now?: () => Date;
}

const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

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
  result: RunResult;
  resultSha256: string;
  budget: RegradeRunReport["authoredCapture"];
  budgetChanged: boolean;
}

/**
 * Re-grade every run dir. Every run dir's evidence is rebuilt (and every refusal decided) BEFORE the first
 * judge call, so one bad dir in a batch spends nothing.
 */
export async function regradeRuns(opts: RegradeOptions): Promise<RegradeOutcome> {
  const refuse = (kind: "usage" | "runtime", message: string): RegradeOutcome => ({ ok: false, kind, message });
  if (opts.runDirs.length === 0) return refuse("usage", REGRADE_USAGE);
  if (opts.judgeModel !== undefined && !isConcreteJudgeModel(opts.judgeModel))
    return refuse(
      "usage",
      `${CMD}: --judge-model "${opts.judgeModel}" is an alias; pass a concrete model id (e.g. claude-opus-4-8) so the grade names the model that made it`,
    );

  let scenario: Scenario | undefined;
  const loadScenario = (): Scenario => (scenario ??= parseScenarioFile(opts.scenarioFile));
  const prepared: Prepared[] = [];
  for (const dir of opts.runDirs) {
    const runDir = resolve(dir);
    // First pass: the builder's run-dir refusals (multi-turn, partial, replay, chat…) and the persisted result,
    // which carries the budget the second pass needs.
    const first = assertContextFromRunDir(dir, loadScenario, { command: CMD }); // messages echo the path as given
    if (!first.ok) {
      if (first.kind === "scenario")
        return refuse("usage", `${CMD}: cannot load scenario ${opts.scenarioFile}: ${(first.error as Error).message}`);
      return refuse(first.kind, first.message);
    }
    const sc = first.scenario;
    const semantic = sc.assert.filter((a) => a.semantic_matches !== undefined);
    if (semantic.length === 0) return refuse("usage", `${CMD}: ${opts.scenarioFile} has no semantic_matches assert — nothing to re-grade`);
    if (opts.judgeModel === undefined) {
      const bad = sc.assert.flatMap((a, i) => {
        if (!a.semantic_matches) return [];
        const m = a.semantic_matches.judge_model ?? defaultJudgeModel();
        return isConcreteJudgeModel(m) ? [] : [`assertion ${i}: "${m}"`];
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
    // process does not is the one gap a kept run cannot close).
    const second = assertContextFromRunDir(dir, sc, {
      command: CMD,
      recomputeAuthored: "both",
      secrets: collectSecrets(),
      priorityGlobs: evidenceUnion(sc.assert),
      totalBytes,
      ...(persisted ? { perFileBytes: persisted.perFileBytes } : {}),
    });
    // The scenario is passed as an object here, so the builder cannot return its loader-failure arm.
    if (!second.ok) {
      if (second.kind === "scenario") throw new Error("unreachable: the scenario was passed as an object");
      return refuse(second.kind, second.message);
    }
    prepared.push({
      runDir,
      turn: second.turn,
      ctx: second.ctx,
      result: second.result,
      resultSha256: sha256Hex(readFileSync(turnArtifactPath(runDir, second.turn, "result.json"))),
      budget,
      budgetChanged: persisted !== undefined && opts.authoredTotalBytes !== undefined && opts.authoredTotalBytes !== persisted.totalBytes,
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

    const liveSemantic = (p.result.assertions ?? []).filter((r) => r.assertion?.semantic_matches !== undefined);
    const captureMoved = p.budgetChanged || !sameSet(evidenceUnion(liveSemantic.map((r) => r.assertion)), evidenceUnion(sc.assert));
    const differing: DifferingSection[] = [];
    const assertions: RegradedAssertion[] = graded.map((g, ordinal) => {
      const a = semantic[ordinal];
      const assertionIndex = sc.assert.indexOf(a);
      const now = p.ctx.judgedDocs?.get(a);
      // The document is a function of the shared capture and the assert's own scope, so any live assert with
      // the same own scope read the same document. With none, the one at the same position among the
      // semantic asserts is compared, for the section list, and the scope is reported changed.
      const key = ownScopeKey(a.semantic_matches!);
      const sameScope = liveSemantic.filter((r) => ownScopeKey(r.assertion.semantic_matches!) === key);
      const counterpart = sameScope.find((r) => r.judgedDoc) ?? sameScope[0] ?? liveSemantic[ordinal];
      let match: DocMatch;
      if (!counterpart || !counterpart.judgedDoc || !now) match = sameScope.length === 0 || captureMoved ? "scope_changed" : "unknown";
      else {
        const diff = diffSections(counterpart.judgedDoc, now, assertionIndex);
        differing.push(...diff);
        match =
          sameScope.length === 0 || captureMoved
            ? "scope_changed"
            : diff.length === 0 && counterpart.judgedDoc.sha256 === now.sha256
              ? true
              : false;
      }
      return {
        assertionIndex,
        ...g,
        docMatchesLive: match,
      } as RegradedAssertion;
    });
    const docMatchesLive = aggregate(assertions.map((a) => a.docMatchesLive));
    const notRegraded = sc.assert.flatMap((a, i) =>
      a.semantic_matches !== undefined ? [] : [{ assertionIndex: i, keys: Object.keys(a) }],
    );
    const pass = assertions.every((a) => a.pass);

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
      regradedAt: at,
      scenario: sc.name,
      authoredCapture: p.budget,
      docMatchesLive,
      differingSections: differing,
      assertions,
      notRegraded,
      original: { resultSha256: p.resultSha256, turn: p.turn },
    };
    const regradeFile = writeNew(dir, stem, JSON.stringify(body, null, 2) + "\n");
    runs.push({
      runDir: p.runDir,
      turn: p.turn,
      regradeFile,
      pass,
      docMatchesLive,
      differingSections: differing,
      assertions,
      notRegraded,
      authoredCapture: p.budget,
    });
  }
  return { ok: true, exitCode: runs.every((r) => r.pass) ? 0 : 1, runs };
}

/** The `--output-format json` document for a completed re-grade (payload-shaped: `runs[]`, not `results[]`). */
export function regradeEnvelope(outcome: Extract<RegradeOutcome, { ok: true }>): string {
  return jsonPayloadEnvelope(CMD, outcome.exitCode === 0, { runs: outcome.runs });
}

const log = (s: string) => writeAllSync(2, s + "\n");

function docMatchLine(r: RegradeRunReport): string {
  const where = (d: DifferingSection) => `${d.change} ${d.kind}${d.path !== undefined ? ` ${d.path}` : ""}`;
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
      return `::warning:: judged document DIFFERS from the one the live judge read — this grade is not comparable with the live one: ${r.differingSections.map(where).join(", ") || "whole-document hash"}`;
  }
}

/** `regrade` CLI entry. */
export async function cmdRegrade(args: string[]): Promise<never> {
  const json = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({ values: [...REGRADE_VALUE_FLAGS], enums: { "--output-format": ["text", "json"] }, noDashValue: ["--scenario"] }),
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
  const outcome = await regradeRuns({ runDirs: p.positionals, scenarioFile, judgeModel: p.options["--judge-model"], authoredTotalBytes });
  if (!outcome.ok) return fail(CMD, outcome.kind, outcome.message, undefined, json);
  if (json) writeAllSync(1, regradeEnvelope(outcome) + "\n");
  else {
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
      log(`· wrote ${tildeify(r.regradeFile)}`);
    }
    const total = outcome.runs.flatMap((r) => r.assertions);
    const failed = total.filter((a) => !a.pass).length;
    log(
      failed === 0
        ? `✓ regrade: all ${total.length} re-graded assertion(s) pass`
        : `✗ regrade: ${failed}/${total.length} re-graded assertion(s) failed`,
    );
  }
  return process.exit(outcome.exitCode);
}
