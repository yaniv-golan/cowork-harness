// `manifest.json`: everything an eval fixed before its first run. Written once, before any spend, and read by
// the report (live and `eval report`) together with runs.jsonl.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Assertion } from "../types.js";
import type { Correction } from "./stats.js";
import type { AgentPin, JudgePins } from "./pins.js";

export const MANIFEST_FILE = "manifest.json";

export interface ManifestArm {
  label: string;
  /** `A` is the first `--arm` (the baseline), `B` the second. */
  role: "A" | "B";
  /** `~`-relative dir, or `git:<ref>:<path>`. */
  source: string;
  fileSet: "git-tracked" | "raw-walk" | "git-commit";
  fileCount: number;
  untrackedExcluded: number;
  commit?: string;
  dirty?: boolean;
  /** Relative to the eval dir. */
  snapshot: string;
  /** Per scenario name: the snapshot's content signature, from the SAME fingerprint call a rep makes. */
  sigs: Record<string, string>;
}

export interface ManifestScenario {
  name: string;
  /** `~`-relative. */
  file: string;
  sha256: string;
  session: string;
  sessionSha256: string;
  baseline: string;
  heldOut: boolean;
  /** The frozen assertion list the rows come from. */
  assertions: Assertion[];
}

export interface EvalManifest {
  schemaVersion: 0;
  evalId: string;
  startedAt: string;
  harnessVersion: string;
  arms: [ManifestArm, ManifestArm];
  scenarios: ManifestScenario[];
  settings: {
    reps: number;
    allowUnderpowered: boolean;
    alpha: number;
    q: number;
    correction: Correction;
    failOn: "possible" | "confirmed";
    concurrency: number;
    includeUntracked: boolean;
    allowIdenticalArms: boolean;
  };
  pins: { agent: AgentPin[]; judge: JudgePins };
  /** The skill whose invocation each rep records, or null when there is no single skill to check. */
  skill: string | null;
  answerKeyGuard: { evalFiles: number; findings: 0 };
}

export function readManifest(evalDir: string): EvalManifest {
  const m = JSON.parse(readFileSync(join(evalDir, MANIFEST_FILE), "utf8")) as EvalManifest;
  if (m.schemaVersion !== 0) throw new Error(`${join(evalDir, MANIFEST_FILE)}: unsupported schemaVersion ${String(m.schemaVersion)}`);
  return m;
}
