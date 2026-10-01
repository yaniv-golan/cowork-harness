// `ref freeze`'s composition: rebuild, from a kept run dir, the judged document each `semantic_pairwise` assert of a
// scenario would have compared — with the run's own capture budget and evidence globs, exactly as the live run
// captured — and say whether it equals what the live run's judge read.

import { createHash } from "node:crypto";
import { COMPOSER_ID, judgedOpts, semanticRefusal, type AssertContext } from "../assert.js";
import { pathSafeId } from "../hillclimb/ids.js";
import { tildeify } from "../io.js";
import { parseScenarioFile } from "../run/execute.js";
import { pkgVersion } from "../run/envelope.js";
import { candidateDocument, pairwiseComposeKey } from "../run/pairwise-prepass.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { assertContextFromRunDir } from "../run/verify-context.js";
import { NoFollowRoot } from "../hillclimb/fs.js";
import type { Assertion, RunResult } from "../types.js";
import type { ComposedForFreeze } from "./cli.js";

/** Live judged asserts by the compose key their options give: the document a live judge read under the same
 *  options is the same document, whichever judged key (semantic_matches or semantic_pairwise) recorded it. */
function liveFingerprints(result: RunResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of result.assertions ?? []) {
    if (e.source !== undefined || judgedOpts(e.assertion) === undefined || e.judgedDoc === undefined) continue;
    out.set(pairwiseComposeKey(e.assertion), e.judgedDoc.sha256);
  }
  return out;
}

export function composeFromRunDir(runDir: string, scenarioFile: string, secrets: string[]): ComposedForFreeze | { refused: string } {
  const cmd = "ref freeze";
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
  const pairwise = scenarioRef.assert.filter((a) => a.semantic_pairwise !== undefined);
  const evidenceGlobs = (asserts: Assertion[]): string[] => [...new Set(asserts.flatMap((a) => judgedOpts(a)?.evidenceFiles ?? []))];
  const built = assertContextFromRunDir(runDir, scenarioRef, {
    command: cmd,
    recomputeAuthored: "semantic",
    secrets,
    priorityGlobs: evidenceGlobs(liveJudged.length ? liveJudged.map((e) => e.assertion) : pairwise),
    ...(result.authoredCapture ? { totalBytes: result.authoredCapture.totalBytes, perFileBytes: result.authoredCapture.perFileBytes } : {}),
  });
  if (!built.ok) return { refused: built.kind === "scenario" ? String((built.error as Error)?.message ?? built.error) : built.message };
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
    source: {
      command: cmd,
      runDir: tildeify(runDir),
      resultSha256,
    },
    harnessVersion: pkgVersion(),
    composerId: COMPOSER_ID,
    docs,
  };
}
