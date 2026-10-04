// `ref freeze`'s composition: rebuild, from a kept run dir, the judged document each `semantic_pairwise` assert of a
// scenario would have compared — with the run's own capture budget and evidence globs, exactly as the live run
// captured — and say whether it equals what the live run's judge read.

import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { runsWriteRoot } from "../run/trace-view.js";
import { COMPOSER_ID, judgedOpts, semanticRefusal, type AssertContext } from "../assert.js";
import { pathSafeId } from "../hillclimb/ids.js";
import { tildeify } from "../io.js";
import { scrub } from "../secrets.js";
import { parseScenarioFile } from "../run/execute.js";
import { pkgVersion } from "../run/envelope.js";
import { candidateDocument, pairwiseComposeKey } from "../run/pairwise-prepass.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { assertContextFromRunDir } from "../run/verify-context.js";
import { NoFollowRoot } from "../hillclimb/fs.js";
import { redactDeep } from "../hillclimb/flow.js";
import type { Assertion, RunResult } from "../types.js";
import type { ComposedForFreeze } from "./cli.js";

/** Live judged asserts by the compose key their options give: the document a live judge read under the same
 *  options is the same document, whichever judged key (semantic_matches or semantic_pairwise) recorded it. A
 *  pairwise assert no judge read (every comparison neutral: a run of the reference's own variant) still recorded
 *  the document it composed (`composedDoc`), which is the same check. */
function liveFingerprints(result: RunResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of result.assertions ?? []) {
    if (e.source !== undefined || judgedOpts(e.assertion) === undefined) continue;
    const fp = e.judgedDoc ?? e.composedDoc;
    if (fp !== undefined) out.set(pairwiseComposeKey(e.assertion), fp.sha256);
  }
  return out;
}

/** Who is freezing, recorded in the entry's `source`: `ref freeze` by default; a hillclimb flow names itself and the
 *  variant and rep the run belongs to. */
export interface ComposeSource {
  command: string;
  variant?: string;
  rep?: number;
}

function recordedRunDir(runDir: string, secrets: string[]): string {
  const rel = relative(resolve(runsWriteRoot()), resolve(runDir));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return scrub(`<runs>/${rel.split(sep).join("/")}`, secrets);
  return redactDeep(tildeify(runDir), secrets);
}

export function composeFromRunDir(
  runDir: string,
  scenarioFile: string,
  secrets: string[],
  by: ComposeSource = { command: "ref freeze" },
): ComposedForFreeze | { refused: string } {
  const cmd = by.command;
  // The live result first: its capture budget and evidence globs decide what the recomposition captures.
  let result: RunResult;
  let resultSha256: string;
  try {
    const turn = latestTurn(runDir);
    if (turn === undefined) return { refused: `${runDir} has no turns/` };
    const raw = NoFollowRoot.existing(runDir).readFile(turnArtifactPath(runDir, turn, "result.json"));
    resultSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    result = JSON.parse(raw) as RunResult;
  } catch (e) {
    return { refused: `cannot read the run's result.json: ${(e as Error).message}` };
  }
  // A reference is the baseline's OUTPUT: a run that errored produced no output worth comparing against.
  if (result.result === "error")
    return { refused: `${runDir} is a run that ended in an error — a reference must be a completed run's output` };
  const liveJudged = (result.assertions ?? []).filter((e) => e.source === undefined && judgedOpts(e.assertion) !== undefined);
  let scenarioRef: ReturnType<typeof parseScenarioFile>;
  try {
    scenarioRef = parseScenarioFile(scenarioFile);
  } catch (e) {
    return { refused: (e as Error).message };
  }
  // The run must be OF this scenario: a reference is the answer to one task, and freezing another scenario's run under
  // this name would make every later comparison grade against an answer to a different question. result.json is
  // written scrubbed, so the scenario's own values are compared in the same scrubbed form; the task identity recorded
  // below stays the hash of the RAW prompt (what the pre-spend check and the prepass hash).
  const name = scrub(scenarioRef.name ?? "", secrets);
  if (result.scenario !== name) return { refused: `${runDir} is a run of scenario "${result.scenario}", not "${name}" (--scenario)` };
  if (typeof result.prompt === "string" && result.prompt !== scrub(scenarioRef.prompt, secrets))
    return {
      refused: `${runDir} ran a different prompt than ${scenarioFile} declares — re-run the scenario, or freeze with the scenario that run used`,
    };
  const pairwise = scenarioRef.assert.filter((a) => a.semantic_pairwise !== undefined);
  const evidenceGlobs = (asserts: Assertion[]): string[] => [...new Set(asserts.flatMap((a) => judgedOpts(a)?.evidenceFiles ?? []))];
  const built = assertContextFromRunDir(runDir, scenarioRef, {
    command: cmd,
    recomputeAuthored: "semantic",
    secrets,
    priorityGlobs: evidenceGlobs(liveJudged.length ? liveJudged.map((e) => e.assertion) : pairwise),
    ...(result.authoredCapture ? { totalBytes: result.authoredCapture.totalBytes, perFileBytes: result.authoredCapture.perFileBytes } : {}),
  });
  // The builder's messages lead with the command label; this composition's refusals carry none (its caller adds it).
  if (!built.ok)
    return {
      refused:
        built.kind === "scenario"
          ? String((built.error as Error)?.message ?? built.error)
          : built.message.startsWith(`${cmd}: `)
            ? built.message.slice(cmd.length + 2)
            : built.message,
    };
  const ctx: AssertContext = built.ctx;
  const live = liveFingerprints(result);
  const docs: ComposedForFreeze["docs"] = [];
  const seen = new Set<string>();
  for (const a of pairwise) {
    const key = pairwiseComposeKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = candidateDocument(ctx, a);
    const refusal = semanticRefusal(a, ctx, {
      evidenceCut: doc.evidenceCut,
      overflowSection: doc.overflowSection,
      skillResultsCut: doc.skillResultsCut,
    });
    if (refusal) return { refused: `the run's evidence cannot be frozen whole for compose key ${key}: ${refusal.message}` };
    const liveSha = live.get(key);
    docs.push({
      key,
      text: doc.candidate,
      live: liveSha === undefined ? "unknown" : liveSha === doc.fingerprint.sha256 ? "match" : "differs",
    });
  }
  return {
    caseId: pathSafeId(scenarioRef.name ?? ""),
    // The entry is written into a store that may be committed or shared: its strings carry no secret and no host path.
    source: {
      command: cmd,
      ...(by.variant !== undefined ? { variant: by.variant } : {}),
      ...(by.rep !== undefined ? { rep: by.rep } : {}),
      // A store may be committed or shared, so no host path: under the runs root the dir is recorded relative to it
      // (`<runs>/…`), anywhere else redacted. The run id (the dir's name, never a path) rides beside it, so a later
      // `hillclimb freeze-ref` finds the run under whatever runs root is current.
      runDir: recordedRunDir(runDir, secrets),
      resultSha256,
      sessionId: basename(runDir),
    },
    harnessVersion: pkgVersion(),
    composerId: COMPOSER_ID,
    scenario: redactDeep(scenarioRef.name ?? "", secrets),
    taskSha256: createHash("sha256").update(scenarioRef.prompt, "utf8").digest("hex"),
    docs,
  };
}
