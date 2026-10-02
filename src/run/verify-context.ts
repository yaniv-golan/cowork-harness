/**
 * Rebuild an `AssertContext` from a KEPT run dir — no live agent, no tokens. This is the evidence-loading
 * half of `verify-run`, lifted out of the CLI so every consumer that re-grades a kept run reads the SAME
 * evidence the same way (and refuses the same way when the evidence is not there).
 *
 * Refusals are returned, never thrown and never printed: the caller owns the envelope and the exit code.
 * Every message is the text `verify-run` has always printed; `opts.command` only swaps the leading label.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { toDecisionRequest, questionLabel, type DecisionRequest } from "../agent/session.js";
import { budgetFields, evaluate, expandExpectDenied, judgedOpts, toolResultEvidence, type AssertContext } from "../assert.js";
import { recordedFixtureFileSigs, recordedFixtureRefusal } from "../fixture/workspace.js";
import { remeasureMetrics } from "../metrics.js";
import type { Assertion, RunResult, Scenario } from "../types.js";
import { captureAuthoredFilesWithHealth, authoredFilesHealthNonEmpty } from "./artifacts.js";
import { readPreRunManifestOrigin } from "./pre-run-manifest.js";
import { authoredCaptureOpts } from "./authored-capture-opts.js";
import { unionReferenceAccesses } from "./run.js";
import { requireTurns, turnArtifactPath } from "./turn-layout.js";
import { recordedSlashInvokedSkills } from "../critique/skill-invocation.js";

/** Read the persisted transcript from a kept run's `run.jsonl` (the `{t:"transcript"}` line).
 *  Returns `null` when the sidecar is absent or unreadable — distinct from an empty-but-present transcript.
 *  Returns `""` when the file is readable but contains no transcript line (run produced no model output). */
export function readTranscriptSidecar(file: string): string | null {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o && o.t === "transcript") return String(o.text ?? "");
    }
    return ""; // file readable but no transcript line — empty transcript (not missing)
  } catch {
    return null;
  }
}

/** Read the AskUserQuestion question texts from a kept run's `trace.json` (`questions` array).
 *  Returns `null` when the sidecar is absent or unreadable — distinct from a run with zero questions. */
export function readQuestionsSidecar(file: string): string[] | null {
  try {
    const t = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(t.questions)) return t.questions.map(String);
    return null;
  } catch {
    return null;
  }
}

/** Reconstruct the AskUserQuestion gates (WITH their offered options) a kept run actually fired,
 *  from its `events.jsonl` (the verbatim child→driver stream — the only sidecar that retains options; the
 *  distilled trace.json drops them). Returns `{ gates, corruptLines }`, or `null` if events.jsonl is
 *  absent/unreadable (distinct from "present but zero gates" → `{ gates: [], corruptLines: 0 }`).
 *
 *  Two deliberate decisions, both because this is a certification command and refuses rather than guesses:
 *  (a) a real events.jsonl can legitimately contain raw, non-JSON agent stdout lines (the child→driver stream
 *  is persisted verbatim before parsing) — so `corruptLines` counts ONLY a JSON.parse failure or a
 *  `toDecisionRequest` throw on an otherwise-`control_request`-typed frame, never a valid-JSON line that
 *  simply isn't a gate (e.g. an `assistant` event); the caller refuses when `corruptLines > 0` rather than
 *  silently skipping, because a present-but-fully-corrupt file is otherwise indistinguishable from "zero
 *  gates fired" and would false-green answer-coverage at 0/0. (b) the live lane (`scanEvents`) stays
 *  warn-only for this same class of evidence gap — this asymmetry with verify-run's hard refusal is
 *  intentional: a live run has already happened and a warn is the most a post-hoc scan can do, but
 *  verify-run is the tool a user runs specifically to certify a scenario as green, so it fails closed. */
export function parseGatesFromEvents(file: string): { gates: DecisionRequest[]; corruptLines: number } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const gates: DecisionRequest[] = [];
  let corruptLines = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(t);
    } catch {
      corruptLines++;
      continue;
    }
    if ((msg as { type?: string })?.type !== "control_request") continue;
    let req: DecisionRequest | null = null;
    try {
      req = toDecisionRequest(msg);
    } catch {
      corruptLines++; // malformed control_request frame — untrustworthy, counted; caller decides
      continue;
    }
    if (req && req.kind === "question") gates.push(req);
  }
  return { gates, corruptLines };
}

/** Which asserted keys trigger re-capturing the run's authored-file set from the kept work dir.
 *  - `no_lost_write_back` (the default, and `verify-run`'s behaviour): only when that key is asserted.
 *  - `semantic`: when any `semantic_matches` is asserted — the judged document's authored-file section.
 *  - `both`: either. */
export type RecomputeAuthored = "no_lost_write_back" | "semantic" | "both";

export interface AssertContextFromRunDirOpts {
  /** Put on the ctx as `secrets`, so the judged document scrubs every section (authored files included)
   *  before capping — exactly what the live run does. Omitted ⇒ no `secrets` on the ctx (verify-run). */
  secrets?: string[];
  /** Passed to the authored-file capture as its `priorityGlobs` when non-empty (the live run passes the
   *  union of every `semantic_matches.evidence_files`). Omitted/empty ⇒ not passed. */
  priorityGlobs?: string[];
  /** Authored-file capture budgets. Omitted ⇒ the capture's own defaults. */
  totalBytes?: number;
  perFileBytes?: number;
  /** Default `"no_lost_write_back"`. `semantic`/`both` also refuse a run whose work dir or transcript sidecar
   *  is gone when a `semantic_matches` is asserted: either is a section of the judged document. */
  recomputeAuthored?: RecomputeAuthored;
  /** The label leading every refusal message (and passed to the turn-layout gate). Default `"verify-run"`. */
  command?: string;
}

export type AssertContextFromRunDirResult =
  | {
      ok: true;
      ctx: AssertContext;
      result: RunResult;
      scenario: Scenario;
      /** The turn the evidence was read from (always the single turn — multi-turn dirs are refused). */
      turn: number;
      /** Raw sidecar reads: `null` = sidecar absent/unreadable (distinct from empty). */
      sidecarTranscript: string | null;
      sidecarQuestions: string[] | null;
    }
  | { ok: false; kind: "usage" | "runtime"; message: string }
  /** The scenario loader threw. Returned (not formatted) because only the caller knows what it loaded. */
  | { ok: false; kind: "scenario"; error: unknown };

/**
 * Rebuild the `AssertContext` a live run would have evaluated, from the run dir's persisted `result.json` +
 * the `run.jsonl`/`trace.json`/`events.jsonl` sidecars + the kept work dir.
 *
 * `scenario` may be a loader: it is then called at the point `verify-run` has always loaded its scenario
 * (after the run-dir refusals), so which refusal wins when both inputs are bad does not change.
 *
 * Limits (vs a fresh live record): sidecars are SCRUBBED at record time, so an assertion over a redacted
 * secret value is not faithfully re-checkable; and filesystem assertions (`file_exists`/`artifact_json`/
 * `user_visible_artifact`) need the run's `workDir` to still exist on disk — if it's gone (container/microvm
 * teardown) this refuses rather than false-failing them.
 */
export function assertContextFromRunDir(
  runDir: string,
  scenarioOrLoader: Scenario | (() => Scenario),
  opts: AssertContextFromRunDirOpts = {},
): AssertContextFromRunDirResult {
  const cmd = opts.command ?? "verify-run";
  const refuse = (kind: "usage" | "runtime", message: string) => ({ ok: false as const, kind, message });
  // Shape-gate FIRST, before loading anything: a legacy/mixed/pre-completion dir gets a message naming
  // what it IS (see turn-layout.ts's preLayoutMessage), not a generic "no result.json" that reads as
  // corruption when the file is sitting right there at the root.
  // A path the caller named that does not exist is their input (usage); a directory that exists but holds
  // no completed run is the prior run's state (runtime, below).
  if (!existsSync(runDir)) return refuse("usage", `${cmd}: run dir not found: ${runDir}`);
  if (!statSync(runDir).isDirectory()) return refuse("usage", `${cmd}: not a run dir (a file): ${runDir}`);
  let turns: number[];
  try {
    turns = requireTurns(runDir, cmd);
  } catch (e) {
    return refuse("runtime", (e as Error).message);
  }
  // A MULTI-TURN run dir addresses more than one completion, and this command cannot tell which one the
  // caller's scenario describes. Checked on the TURN COUNT (before loading any result), not a `result.turn`
  // field read off whichever turn we'd otherwise load — RunResult.turn is documented absent on some lanes,
  // so a field-based check silently passed a multi-turn dir whose latest result happened to omit it.
  //
  // This command reads TURN 1. For a `critique` dir that is the GRADED task turn, not the reflection one —
  // so on a genuinely single-turn dir (the only case that survives this refusal) turn 1 IS the run's only
  // completion, and there is no ambiguity left to resolve. Today's cumulative gate scan at least fails
  // LOUDLY on the other turn's unmatched gates; scoping this command to "whichever turn is latest" instead
  // would have turned that into a silent PASS against a transcript the scenario never described. Refusing
  // is the fail-closed reading: an ambiguous target is not a verified one.
  //
  // Deliberately no turn selector yet — that is a new CLI surface (flag disposition, docs, tests) and this
  // guard is worth having before it. The message names the addressable files so the caller is not stuck.
  if (turns.length > 1) {
    return refuse(
      "runtime",
      `${cmd}: ${runDir} holds ${turns.length} turns (a --resume session, or a \`critique\` task+reflection pair). ` +
        `This command reads turn 1 only — for a critique dir that is the graded task turn, not the reflection one, ` +
        `so it cannot tell which turn your scenario describes when there is more than one. Verify a single-turn ` +
        `run dir instead; the graded turn is addressable as result.graded.json or turns/1/result.json for inspection. ` +
        `(can't verify ⇒ not green)`,
    );
  }
  const resultPath = turnArtifactPath(runDir, turns[0], "result.json");
  if (!existsSync(resultPath)) {
    return refuse(
      "runtime",
      `${cmd}: no result.json under ${resultPath} (turn ${turns[0]} directory exists with no completed ` +
        `result — a crash between run.jsonl and result.json, or a run still in flight)`,
    );
  }
  let result: RunResult;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  } catch (e) {
    return refuse("runtime", `${cmd}: cannot read ${resultPath}: ${(e as Error).message}`);
  }
  // JSON.parse alone would let `{}` (or any foreign/truncated-then-hand-fixed JSON) through, and
  // the `result.result === "error" ? "error" : "success"` collapse below would then certify
  // garbage as success. Gate on the one field the verdict hinges on. Everything else is
  // deliberately lenient: absent optional fields degrade loudly via the evidence-missing flags.
  const resultField = (result as { result?: unknown }).result;
  if (resultField !== "success" && resultField !== "error") {
    return refuse(
      "runtime",
      `${cmd}: ${resultPath} is structurally invalid — \`result\` is ${JSON.stringify(resultField)}, ` +
        `expected "success" | "error" (truncated, hand-edited, or not harness-written). (can't verify ⇒ not green)`,
    );
  }
  // A partial run did NOT complete (it exited on an unanswered gate). Its assertion outcome is empty and its
  // artifacts are pre-failure, so re-evaluating asserts against it would vouch for a run that never finished.
  // Refuse rather than false-fail or false-pass.
  if (result.partial) {
    return refuse(
      "runtime",
      `${cmd}: ${runDir} is a PARTIAL run — it did not complete (exited on an unanswered gate). ` +
        `Re-run to completion before verifying. (can't verify ⇒ not green)`,
    );
  }
  // A `command:"replay"` result is a RE-CHECK of a recorded cassette, not run evidence (same rule
  // as the stats indexer, which never indexes replay rows). Certifying it would launder a re-check into a
  // fresh verification. Keyed on `command`, not `workspaceFiles` — an old live result.json that simply
  // lacks workspaceFiles must keep verifying (absent optional fields degrade loud via the evidence flags).
  if (result.command === "replay") {
    return refuse(
      "runtime",
      `${cmd}: ${resultPath} was produced by \`replay\` (command:"replay") — a replay is a ` +
        `re-check of a recorded cassette, not run evidence; verify the original live run dir, or re-run live. ` +
        `(can't verify ⇒ not green)`,
    );
  }
  // A chat result carries no assertions and no verdict by contract (RunResult.mode doc) — reading it as
  // pass/fail is forbidden to consumers, including this one. Chat dirs DO persist result.json, so unlike
  // the replay case this is reachable with an ordinary on-disk run dir.
  if (result.mode === "chat") {
    return refuse(
      "runtime",
      `${cmd}: ${runDir} is a CHAT session (mode:"chat") — chat results carry no assertions or ` +
        `verdict and must not be read as pass/fail. (can't verify ⇒ not green)`,
    );
  }
  let scenario: Scenario;
  if (typeof scenarioOrLoader === "function") {
    try {
      scenario = scenarioOrLoader();
    } catch (error) {
      return { ok: false, kind: "scenario", error };
    }
  } else {
    scenario = scenarioOrLoader;
  }

  const workRoot = result.workDir ?? "";
  const scan = result.scan ?? { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false };
  // FS-class assertions resolve under workRoot; if it's gone we can't faithfully re-check them — refuse
  // rather than report a false fail. Content-only re-asserts stay valid without it. no_unexpected_files
  // belongs here too: on a missing workRoot its post-run walk returns [] → zero created files → a vacuous
  // PASS (the other FS keys false-FAIL safe-direction; this one false-GREENS, the worse failure mode).
  const FS_KEYS: (keyof Assertion)[] = [
    "file_exists",
    // Both read the run's real tree: artifact_text scans a body, file_absent proves a path is not there.
    // file_absent is the one that MUST be here — with no work dir, existsSync returns false for every
    // path and it would pass vacuously, the same false-green no_unexpected_files is listed for.
    "artifact_text",
    "file_absent",
    "user_visible_artifact",
    "artifact_json",
    "no_unexpected_files",
    "input_unmodified",
    // no_lost_write_back re-reads the run's authored sources from workRoot (recomputed below) — a missing
    // work dir can't be faithfully re-checked, so refuse rather than false-fail.
    "no_lost_write_back",
  ];
  const hasFsAssert = scenario.assert.some((a) => FS_KEYS.some((k) => a[k] !== undefined));
  if (hasFsAssert && !existsSync(workRoot)) {
    return refuse(
      "runtime",
      `${cmd}: work dir not found (${workRoot || "<unset>"}) — filesystem assertions ` +
        `(file_exists/file_absent/artifact_json/artifact_text/user_visible_artifact/no_unexpected_files/input_unmodified/no_lost_write_back) cannot be re-evaluated from this run dir; re-record. (can't verify ⇒ not green)`,
    );
  }

  // Which asserted keys need the run's authored-file set. It isn't persisted in result.json, so it is
  // recomputed from the KEPT work dir (a re-check on the same machine, exactly as input_unmodified re-hashes
  // the real tree under workRoot). Only recompute when a consuming key is actually asserted (a live
  // connected folder walk is not free). Absent (no consuming key) → authoredFiles stays undefined, harmless
  // for every other assertion.
  const mode = opts.recomputeAuthored ?? "no_lost_write_back";
  const wantsWriteBackCheck = mode !== "semantic" && scenario.assert.some((a) => a.no_lost_write_back !== undefined);
  const wantsSemanticEvidence = mode !== "no_lost_write_back" && scenario.assert.some((a) => judgedOpts(a) !== undefined);
  // The FS_KEYS refusal above covers no_lost_write_back. A semantic grade has no such refusal of its own,
  // and with the work dir gone the authored-file section would silently drop out of the judged document —
  // a grade over a different document than the live judge read. Refuse instead.
  if (wantsSemanticEvidence && !existsSync(workRoot)) {
    return refuse(
      "runtime",
      `${cmd}: work dir not found (${workRoot || "<unset>"}) — the files this run authored cannot be recaptured, ` +
        `so a semantic_matches grade would read a different document than the live judge did; re-record. ` +
        `(can't verify ⇒ not green)`,
    );
  }
  const recomputedAuthored =
    (wantsWriteBackCheck || wantsSemanticEvidence) && existsSync(workRoot)
      ? captureAuthoredFilesWithHealth(
          workRoot,
          result.userVisibleRoots ?? ["outputs", ".projects"],
          result.readonlyFolderRoots ?? [],
          result.preRunHashes,
          authoredCaptureOpts({
            workRoot,
            runDir,
            priorityGlobs: opts.priorityGlobs,
            totalBytes: opts.totalBytes,
            perFileBytes: opts.perFileBytes,
          }),
        )
      : undefined;

  // Through the seam, same turn the result above was read from (turns[0] — the guard above already
  // refused anything with more than one).
  const vrTurn = turns[0];
  const sidecarTranscript = readTranscriptSidecar(turnArtifactPath(runDir, vrTurn, "run.jsonl"));
  const sidecarQuestions = readQuestionsSidecar(turnArtifactPath(runDir, vrTurn, "trace.json"));
  // The transcript is a section of the judged document, so with the sidecar gone a semantic grade would read
  // an empty transcript the live judge never saw. `transcript_contains` and friends fail evidence-unavailable
  // on `transcriptMissing` by themselves; a judge handed the document has no such check, so refuse here.
  // An EMPTY transcript (`""`: the sidecar is readable and the run produced no model output) still grades.
  if (wantsSemanticEvidence && sidecarTranscript === null) {
    return refuse(
      "runtime",
      `${cmd}: no readable transcript sidecar (${turnArtifactPath(runDir, vrTurn, "run.jsonl")}) — the transcript is part ` +
        `of the document a semantic_matches judge grades, so a grade without it would read a different document than ` +
        `the live judge did; re-record. (can't verify ⇒ not green)`,
    );
  }

  // `question_options` grades the option SET a gate offered, and the distilled trace.json drops options
  // (see parseGatesFromEvents' own doc) — so this lane reads `events.jsonl` directly. Deliberately NOT
  // verify-run's answer-coverage check: that one is gated on `scenario.answers.length > 0`, so a scenario
  // asserting option order with no scripted answers (`on_unanswered: first`, an LLM-decided gate, a
  // post-hoc check on a kept run) would silently reach the evaluator with no evidence at all. Parsed only
  // when the key is asserted — a full events.jsonl read is not free on a long run.
  const wantsGateOptions = scenario.assert.some(
    (a) => a.question_options !== undefined || a.question_context !== undefined || a.question_option_count !== undefined,
  );
  const parsedGates = wantsGateOptions ? parseGatesFromEvents(join(runDir, "events.jsonl")) : undefined;
  // Absent file OR any unparseable frame ⇒ evidence-missing, never a partial set graded as complete:
  // a present-but-corrupt events.jsonl is otherwise indistinguishable from "these were all the gates".
  const gateOptionsMissing = wantsGateOptions && (!parsedGates || parsedGates.corruptLines > 0);
  const vrGateOptions = parsedGates
    ? (parsedGates.gates as DecisionRequest[]).flatMap((g) =>
        g.kind === "question"
          ? g.questions.map((q) => ({
              question: questionLabel(q),
              options: (q.options ?? []).map((o) => ({
                label: o.label,
                ...(o.description === undefined ? {} : { description: o.description }),
              })),
              ...(q.multiSelect === undefined ? {} : { multiSelect: q.multiSelect }),
            }))
          : [],
      )
    : undefined;

  const ctx: AssertContext = {
    transcript: sidecarTranscript ?? "",
    // The judged document's "Final answer" section — the live ctx carries the same value (the SDK result
    // text), persisted in result.json and scrubbed at write.
    finalMessage: result.finalMessage,
    toolsCalled: new Set(Object.keys(result.toolCounts ?? {})),
    subagentTools: new Set((result.subagents ?? []).flatMap((s) => (s.toolsUsed ?? []).map((d) => d.name))),
    egress: result.egress ?? [],
    egressMissing: result.egress === undefined, // absent field (old result.json) ≠ a run that made zero egress attempts
    result: result.result === "error" ? "error" : "success",
    workRoot,
    // Read the roots persisted at run time (folder mount names are dynamic/gated, not a fixed prefix).
    // Fall back to the legacy prefix for old result.json that predates the field.
    userVisiblePrefixes: result.userVisibleRoots ?? ["outputs", ".projects"],
    lane: result.lane,
    // Read-only folder inputs are captured body-less; keep artifact_json's verdict identical to the
    // replay lane (evidence-unavailable) instead of parsing the real on-disk input here.
    readonlyFolderRoots: result.readonlyFolderRoots ?? [],
    // result.json is the single source: every writer populates the field from the run's own
    // pre-run-manifest.json, so a missing field means the baseline genuinely doesn't exist
    // (pre-field run, or the run never captured) — evidence-unavailable, loud.
    preRunPaths: result.preRunPaths,
    // A pre-#38 result.json has no preRunLinkAware ⇒ undefined ⇒ no_unexpected_files excludes links from the
    // post walk, so re-verifying an old run dir doesn't false-stray its pre-existing symlinks.
    preRunLinkAware: result.preRunLinkAware,
    preRunHashes: result.preRunHashes,
    // baseline provenance. Prefer the value persisted in result.json; fall back to reading it straight
    // from the run dir's pre-run-manifest.json so re-verifying an OLD run dir (whose result.json predates
    // the field) still fails evidence-unavailable on a local-unreadable baseline instead of diffing it.
    preRunOrigin: result.preRunOrigin ?? readPreRunManifestOrigin(runDir),
    // Recomputed above (only when a consuming key is asserted) from the kept work dir. undefined when no
    // such key is asserted — nothing then reads it.
    authoredFiles: recomputedAuthored?.files,
    authoredFilesHealth:
      recomputedAuthored && authoredFilesHealthNonEmpty(recomputedAuthored.health) ? recomputedAuthored.health : undefined,
    // Only when the caller passed them: the judged document then scrubs every section before capping,
    // authored files included, as the live run does.
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
    outputsDeletes: scan.outputsDeletes,
    // read from the persisted result, never recomputed — a result written before these existed has neither,
    // which the tiering reads as unknown and fails closed.
    outputsDeleteBasis: result.scan?.outputsDeleteBasis,
    fsDiff: result.fsDiff,
    mountDeletes: scan.mountDeletes ?? [],
    questions: sidecarQuestions ?? [],
    gateOptions: vrGateOptions,
    gateOptionsMissing,
    hostPathLeaked: scan.hostPathLeaked,
    selfHealRan: scan.selfHealRan,
    subagents: result.subagents ?? [],
    gateDeliveries: result.gateDeliveries ?? [],
    gateDeliveriesMissing: result.gateDeliveries === undefined,
    toolResultTexts: (result.toolResults ?? []).map((r) => r.assertText ?? r.text),
    toolResultsTruncated: (result.toolResults ?? []).map((r) => r.assertText === undefined),
    // undefined (not []) when result.toolResults itself is absent — an old/partial result.json,
    // distinct from a genuine empty array — mirrors toolResultsMissing's own undefined-preserving convention.
    toolResults: result.toolResults?.map(toolResultEvidence),
    // Read, never re-derived: `Run` is the one place that classifies a call's origin. An older result.json
    // has no field — the object form of tool_called then fails evidence-unavailable (toolCallsMissing).
    toolCalls: result.toolCalls,
    toolCallsMissing: result.toolCalls === undefined,
    toolErrors: result.toolErrors,
    transcriptMissing: sidecarTranscript === null,
    questionsMissing: sidecarQuestions === null,
    // Evidence-missing flags: set ONLY when the underlying field is undefined (partial/old result.json),
    // not when it is a legitimately-empty {}/[]. The producer serializes these unconditionally
    // (execute.ts), so in this lane `undefined` reliably means the evidence is absent — not
    // that the run produced none. Negative/absence assertions then fail loud instead of vacuously green.
    toolResultsMissing: result.toolResults === undefined,
    toolsCalledMissing: result.toolCounts === undefined,
    // Left `undefined` when result.json carries no list (an older run, or one with no observable tool
    // stream) — which is exactly what makes both reference keys fail evidence-unavailable here rather
    // than pass vacuously off a missing field.
    referencesAccessed: unionReferenceAccesses(result),
    subagentsMissing: result.subagents === undefined,
    // Derive from `result.scan` directly — NOT the `scan` local, which already collapsed undefined into
    // the `{outputsDeletes:[],hostPathLeaked:false,selfHealRan:false}` default above.
    scanMissing: result.scan === undefined,
    skillsInvoked: result.skillsInvoked ?? [],
    skillsInvokedMissing: result.skillsInvoked === undefined,
    // The persisted slash channel, or — on a result.json written before the field existed — the same
    // derivation over the prompt and init inventory this record already carries.
    slashInvokedSkills: recordedSlashInvokedSkills(result),
    // `skillToolAvailable` predates being persisted on older result.json too; default true rather than
    // false so an old run's skill_triggered doesn't spuriously read as evidence-unavailable for the WRONG
    // reason (agent-tool-drift) when the real reason is just "this field didn't exist yet".
    skillToolAvailable: result.skillToolAvailable ?? true,
    skillActivity: result.skillActivity,
    tasks: result.tasks,
    // Context/Connectors panel — backs skill_available/connector_available/tool_available.
    // result.json's own `context` was fully populated at RunResult-assembly time, so this is a
    // straight read-through (no timing gap unlike the live evaluate() ctx in execute.ts).
    availableSkills: result.context?.availableSkills,
    mcpServers: result.context?.mcpServers,
    availableTools: result.context?.tools,
    contextEvents: result.contextEvents,
    mcpErrors: result.mcpErrors,
    resources: result.resources,
    hookEvents: result.hookEvents,
    fileToolAttempts: result.fileToolAttempts,
    pathDenials: result.pathDenials,
    presentedFiles: result.presentedFiles,
    presentFilesCalls: result.presentFilesCalls,
    evidenceErrors: result.evidenceErrors,
    effectiveFidelity: result.effectiveFidelity,
    // A kept run dir is re-checked on the SAME machine that ran it — grouped with the live
    // execute.ts lane (both check a host-shaped computer:// link's path directly). result.json doesn't
    // persist each connected folder's real host source path, so `workRoot` (the run's own mnt root,
    // already required above for FS-class asserts) is the only host root this can reconstruct —
    // a host-shaped link pointing outside it (or with workRoot unset) resolves as evidence-unavailable
    // rather than falling back to an unconstrained existsSync (see computer-links.ts).
    linkResolution: { mode: "live", hostRoots: workRoot ? [workRoot] : [] },
    ...budgetFields(result),
  };

  return { ok: true, ctx, result, scenario, turn: vrTurn, sidecarTranscript, sidecarQuestions };
}

/** A kept run re-evaluated against a scenario: the rebuilt context, and what it yields. */
export type ReevaluateRunResult =
  | (Extract<AssertContextFromRunDirResult, { ok: true }> & {
      /** `evaluate(scenario.assert)` — every assert, a judged one included (with no judge result in the context it
       *  reads unevaluated; no judge is called) — then one `egress_denied` entry per `expect_denied` host, in that
       *  order: the authored entries a live run persists. */
      deterministic: RunResult["assertions"];
      /** The scenario's declared metrics, re-measured from the kept work dir (absent when it declares none). */
      metrics: RunResult["metrics"];
    })
  | Exclude<AssertContextFromRunDirResult, { ok: true }>;

/**
 * Re-evaluate a kept run against a scenario with no live agent and no judge: the evaluation half of `verify-run`,
 * shared with every consumer that rebuilds a run's outcome from its kept run dir (`hillclimb regrade`).
 *
 * The context is `assertContextFromRunDir`'s; then the pre-spawn refusal a live run makes against the fixture files
 * this run recorded (an on-disk presence/body assert on one of them with no `authored:` would pass on the fixture
 * alone — refused `usage`); then `evaluate` and `expandExpectDenied` (the live run's own helper, which `evaluate`
 * does not cover; passing `ctx.egressMissing` tells a missing `egress` field from a run that made no calls); then
 * `remeasureMetrics` on the same context — each metric file read only while its bytes still equal the run's recorded
 * post-run hash, never the live run's values.
 *
 * Not here: `verify-run`'s answer-coverage and skill-drift checks, which judge the kept run against the CURRENT
 * skill's gates — a caller that compares runs of different skill snapshots (hillclimb's variants) must not inherit
 * them.
 */
export function reevaluateRun(
  runDir: string,
  scenarioOrLoader: Scenario | (() => Scenario),
  opts: AssertContextFromRunDirOpts = {},
): ReevaluateRunResult {
  const loaded = assertContextFromRunDir(runDir, scenarioOrLoader, opts);
  if (!loaded.ok) return loaded;
  const { ctx, result, scenario } = loaded;
  const vacuousFixture = recordedFixtureRefusal(scenario, recordedFixtureFileSigs(runDir) ?? result.fingerprint?.workspaceFixtureFileSigs);
  if (vacuousFixture) return { ok: false, kind: "usage", message: `${opts.command ?? "verify-run"}: ${vacuousFixture}` };
  const deterministic = evaluate(scenario.assert, ctx);
  deterministic.push(...expandExpectDenied(scenario.expect_denied, ctx.egress, ctx.egressMissing));
  return { ...loaded, deterministic, metrics: remeasureMetrics(ctx, result, scenario.metrics) };
}
