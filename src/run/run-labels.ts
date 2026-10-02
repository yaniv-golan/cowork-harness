// Run labels: the `runLabel` a run carries in its status.json and its result.json, and the one reader every
// consumer of a kept run dir uses to recover it. Kept free of heavy imports so `prune` can read a label without
// loading the planner or the hillclimb runner.
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { latestTurn, turnArtifactPath } from "./turn-layout.js";

/** `runLabel` prefix of runs a hillclimb flow made. Any run whose label starts with it counts as a hillclimb
 *  run, including one a user labelled `--label hillclimb:…` by hand. */
export const HILLCLIMB_LABEL_PREFIX = "hillclimb:";
/** `runLabel` prefix of an eval's own reps (`eval:<eval-id>:<arm>`). */
export const EVAL_LABEL_PREFIX = "eval:";

/** The label a hillclimb pass gives every run it makes. It carries the flow dir's BASENAME only, so two
 *  projects on the default flow (`.claude/hillclimb/flow`) both label their runs `hillclimb:flow:<variant>`. */
export const hillclimbRunLabel = (flowArg: string, variant: string): string => `${HILLCLIMB_LABEL_PREFIX}${basename(flowArg)}:${variant}`;

/** A result.json larger than this is never parsed for its label. */
const MAX_LABEL_SOURCE_BYTES = 32 * 1024 * 1024;

/** Parse one JSON file: a regular file only (opened without following a symlink, and non-blocking so a FIFO
 *  cannot stall the read), at most `MAX_LABEL_SOURCE_BYTES`. undefined when absent, oversized or unparseable. */
function readSmallJson(p: string): unknown {
  let fd: number;
  try {
    fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_LABEL_SOURCE_BYTES) return undefined;
    return JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

const labelIn = (v: unknown): string | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const label = (v as { runLabel?: unknown }).runLabel;
  return typeof label === "string" && label.length > 0 ? label : undefined;
};

/** The run's label: from status.json (written right after the run dir is created, before any spawn), else from
 *  the latest turn's result.json (written at turn end, so it covers a run whose status.json write failed or was
 *  damaged). undefined when neither file yields one: an unlabelled run, or a dir nothing can be read from. */
export function runLabelOf(dir: string): string | undefined {
  const fromStatus = labelIn(readSmallJson(join(dir, "status.json")));
  if (fromStatus !== undefined) return fromStatus;
  const turn = latestTurn(dir);
  return turn === undefined ? undefined : labelIn(readSmallJson(turnArtifactPath(dir, turn, "result.json")));
}

/** Whether a label marks a hillclimb run. A prefix test, so a user label that merely contains the word does not
 *  match. */
export const isHillclimbLabel = (label: string | undefined): boolean => label?.startsWith(HILLCLIMB_LABEL_PREFIX) === true;

/** The eval id of an `eval:<eval-id>:<arm>` label, or undefined. */
export function evalIdOfLabel(label: string | undefined): string | undefined {
  const m = label !== undefined ? /^eval:([^:]+):/.exec(label) : null;
  return m ? m[1] : undefined;
}
