// Scenario metrics: one number per declared metric, read from a JSON file the run wrote, reported beside the verdict
// (RunResult.metrics) and never in it. Pure: reads files, writes nothing, prints nothing.
//
// The evidence gates are artifact_json's own (`artifactBodyGate`), and "the run wrote it" is the rule `authored: true`
// uses (`authorshipOf`: the content hash against the pre-run manifest — there is no write signal, so a file the run
// rewrote with identical bytes reads as untouched). A value is reported only when every gate passes; otherwise the
// metric is `unavailable` with one reason from METRIC_UNAVAILABLE, never a 0 and never a coerced string.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { sep } from "node:path";
import { ARTIFACT_BODY_CAP, artifactBodyGate, authorshipOf, resolveDotPath, type AssertContext } from "./assert.js";
import type { MetricUnavailable, RunResult, ScenarioMetric } from "./types.js";

/** What the extractor reads. An `AssertContext` is one. */
export type MetricsContext = Pick<
  AssertContext,
  | "workRoot"
  | "lane"
  | "userVisiblePrefixes"
  | "readonlyFolderRoots"
  | "truncatedPaths"
  | "linkPaths"
  | "preRunHashes"
  | "preRunPaths"
  | "preRunOrigin"
  | "postRunHashes"
  | "resume"
> & {
  /** The run's own post-run sha256 per work-root-relative path (`RunResult.workspaceFiles`), set when the files are
   *  re-read later from a kept work dir (regrade). A file whose bytes no longer match — or that the run recorded no
   *  hash for — is `pruned`: the kept tree no longer holds what the run wrote. */
  recordedPostRunHashes?: Record<string, string>;
};

/** One declared metric's outcome, with the reason's detail. `evidenceLimited` marks an outcome the recorded evidence
 *  caused (no work tree, a body or hash the recording did not keep, a link placeholder) rather than one that states
 *  what the run did — replay warns on these. */
export interface MetricMeasurement {
  id: string;
  value?: number;
  unavailable?: MetricUnavailable;
  why?: string;
  evidenceLimited?: boolean;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function measure(ctx: MetricsContext, m: ScenarioMetric): MetricMeasurement {
  const off = (unavailable: MetricUnavailable, why: string, evidenceLimited = false): MetricMeasurement => ({
    id: m.id,
    unavailable,
    why,
    ...(evidenceLimited ? { evidenceLimited } : {}),
  });
  if (ctx.lane === "remote" || ctx.preRunOrigin === "remote-unavailable")
    return off("remote", "a remote lane's filesystem is not locally observable");
  if (!ctx.workRoot || !existsSync(ctx.workRoot)) return off("pruned", "there is no work tree to read", true);
  const gate = artifactBodyGate(ctx, m.artifact);
  switch (gate.kind) {
    case "unsafe":
      return off("missing_artifact", "the path leaves the work root");
    case "link":
      return off("pre_run", "it was a symlink or hard link at record time — a link is never counted as written by the run", true);
    case "escape":
      return off("missing_artifact", "a symlink resolves outside the work root");
    case "not_found":
      return off("missing_artifact", "no file there");
    case "body_less": {
      if (gate.liveReadonly || gate.replayReason === "readonly") return off("readonly", "a read-only connected-folder input");
      if (gate.replayReason === "fixture" || gate.replayReason === "input")
        return off("pre_run", gate.replayReason === "fixture" ? "an untouched workspace_fixture file" : "an uploaded input");
      if (gate.replayReason === "size") {
        // An untouched pre-run file over the body cap is pre_run, not a cap to raise: ask the recorded hashes first.
        if (ctx.postRunHashes !== undefined && authorshipOf(ctx, m.artifact).state === "untouched")
          return off("pre_run", "an untouched pre-run file");
        return off("size", "larger than the recorded artifact-body cap (raise --max-artifact-bytes)", true);
      }
      return off("missing_artifact", "its body was not recorded (unreadable at record time)", true);
    }
  }
  let buf: Buffer;
  try {
    const st = statSync(gate.realFile);
    if (!st.isFile()) return off("missing_artifact", "not a regular file");
    if (st.size > ARTIFACT_BODY_CAP) return off("size", `larger than ${ARTIFACT_BODY_CAP} bytes`);
    buf = readFileSync(gate.realFile);
  } catch (e) {
    return off("missing_artifact", `could not be read: ${(e as Error).message}`);
  }
  // ONE read: the bytes hashed for authorship are the bytes parsed below.
  const hash = sha256(buf);
  if (ctx.recordedPostRunHashes !== undefined) {
    const rel = gate.rel.split(sep).join("/");
    if (ctx.recordedPostRunHashes[rel] !== hash)
      return off("pruned", "the kept work dir no longer holds what the run wrote (no recorded post-run hash, or a different one)", true);
  }
  const who = authorshipOf(ctx, m.artifact, { postHash: hash });
  if (who.state === "untouched") return off("pre_run", "an untouched pre-run file (identical bytes, even if rewritten)");
  if (who.state === "undecidable") return off("pre_run", who.why, who.evidence);
  if (who.state !== "new" && who.state !== "rewritten") return off("missing_artifact", `not a regular file (${who.state})`);
  let doc: unknown;
  try {
    doc = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    return off("not_json", `not valid JSON: ${(e as Error).message}`);
  }
  const r = resolveDotPath(doc, m.path);
  if (r.state !== "value")
    return off("missing_path", r.state === "absent" ? `"${m.path}" is absent` : `"${r.at}" is missing or not an object`);
  if (typeof r.value !== "number" || !Number.isFinite(r.value))
    return off("not_a_number", `"${m.path}" is ${JSON.stringify(r.value) ?? String(r.value)}`);
  return { id: m.id, value: r.value };
}

/** One measurement per declared metric, in declaration order. */
export function measureMetrics(ctx: MetricsContext, decls: readonly ScenarioMetric[]): MetricMeasurement[] {
  return decls.map((m) => measure(ctx, m));
}

/** `RunResult.metrics` for the declared metrics: `{id, value}` or `{id, unavailable}`, one per declaration, in order. */
export function extractMetrics(ctx: MetricsContext, decls: readonly ScenarioMetric[]): NonNullable<RunResult["metrics"]> {
  return measureMetrics(ctx, decls).map((x) =>
    x.value !== undefined ? { id: x.id, value: x.value } : { id: x.id, unavailable: x.unavailable! },
  );
}

/** The one rule every producer applies: metrics are extracted only when the scenario declares at least one;
 *  otherwise `RunResult.metrics` is absent (an empty list is the same as none). */
export function metricsFor(ctx: MetricsContext, decls: readonly ScenarioMetric[] | undefined): RunResult["metrics"] {
  return decls !== undefined && decls.length > 0 ? extractMetrics(ctx, decls) : undefined;
}
