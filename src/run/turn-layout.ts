// Addressing the PER-TURN artifacts of a run directory: `result.json`, `run.jsonl`, `trace.json`,
// `resources.jsonl`.
//
// A LEAF module (like `turn-events.ts`): imported by cli.ts, run/*, critique/*, runtime/*, so it must not
// import back into any of them. (`errors.ts` is safe to import — it has no imports of its own.)
//
// WHY THIS EXISTS. A run directory can hold several turns (any `--resume`, and every `critique` = task
// turn + reflection turn). This module is the ONE place that knows how a turn is addressed: every turn's
// artifacts live under `turns/<N>/`, full stop — SINGLE SHAPE, no per-turn name-mangling and no
// bidirectional legacy fallback. `critique` additionally writes role aliases (`result.graded.json`),
// resolved by `resolveGraded` below.
//
// A run dir written before this layout existed — or a `--resume` of one caught mid-migration, which
// leaves `turns/` AND stray root files behind — is DETECTED by `classifyRunDir`, the ONLY place the
// legacy/mixed shape is still named. It is never resolved as data by `turnArtifactPath` / `listTurns` /
// Silently substituting a root or name-mangled file for an unaddressable turn is exactly
// the defect class this single shape exists to make unrepresentable (turn 1 made invisible on a mixed dir,
// a resumed session's turn number going BACKWARDS). A detector that refuses is safe; a resolver that
// guesses is not.
//
// No writer produces a root compat copy of any per-turn artifact anymore (that was removed alongside
// this), so `classifyRunDir` can treat ANY of the four `PER_TURN_ARTIFACTS` at the run-dir root as
// contamination unconditionally — including `result.json` next to `turns/` — with no special-casing.

import { existsSync, readFileSync, readdirSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { LegacyRunDirError, MultiLegRunDirError } from "../errors.js";

/** The four artifacts written once per turn. Anything else in a run dir is cumulative or session state. */
export const PER_TURN_ARTIFACTS = ["result.json", "run.jsonl", "trace.json", "resources.jsonl"] as const;
export type PerTurnArtifact = (typeof PER_TURN_ARTIFACTS)[number];

/** `result.json` -> `result`, `run.jsonl` -> `run` — the stem `resolveGraded` uses to build the
 *  `*.graded.json` alias name. */
function stemAndExt(artifact: PerTurnArtifact): { stem: string; ext: string } {
  const i = artifact.indexOf(".");
  return { stem: artifact.slice(0, i), ext: artifact.slice(i) };
}

/** Turn numbers present in `turns/`, ascending.
 *
 *  ANCHORED match on purpose: a `parseInt`-style scan happily reads `2junk` as turn 2, which would let a
 *  stray directory shift every turn number in the run dir. */
function turnsDirNumbers(outDir: string): number[] {
  try {
    // A turn is a DIRECTORY named with a CANONICAL decimal: `withFileTypes` excludes a stray file (or
    // symlink) that happens to be named like a number, and `^(0|[1-9]\d*)$` rejects a non-canonical
    // spelling like `01` — the writer only ever produces `String(n)`, so `turns/01` would be addressed as
    // the missing `turns/1` and its data left invisible. An anchored match already stopped `2junk`; these
    // close the file-masquerading-as-a-turn and leading-zero variants.
    return readdirSync(join(outDir, "turns"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^(?:0|[1-9]\d*)$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MULTI-LEG RUN DIRS. A `legs:` scenario writes one scenario root holding `legs/<id>/`:
//   - a PROMPT leg is a complete single-session run dir (`turns/<N>/`, `events.jsonl`, manifests), so every reader
//     here works unchanged when pointed at it;
//   - a HOST-ACTION leg holds `action.json` and its manifests, and no agent session at all.
// Each leg dir carries `leg.json`, written BEFORE the leg starts. That marker, not `scenario-result.json`, decides
// the shape: an in-flight or crashed root is already `legs` (prune must not take it for junk), and
// `scenario-result.json` only says whether the scenario finished.
//
// The root has no `turns/` of its own. The helpers below would answer it with []/undefined/false, which a caller
// reads as "an empty run", so they THROW `MultiLegRunDirError` on a legs root or an action leg instead. A caller
// that understands the shape branches on `classifyRunDir` before its first helper call.
// ---------------------------------------------------------------------------------------------------------------

/** A leg id: the directory name under `legs/`. The scenario schema enforces the same grammar on `legs[].id`. */
export const LEG_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `legs/<id>/leg.json`. `scenarioRoot` is relative to the leg dir (always `../..`). */
export interface LegMarker {
  scenarioRoot: string;
  id: string;
  index: number;
  kind: "prompt" | "action";
  workdir: "persistent" | "cowork-task";
}

/** The leg marker in `dir`, or undefined when there is none (or it is not a regular file, or unparseable). */
export function readLegMarker(dir: string): LegMarker | undefined {
  const p = join(dir, "leg.json");
  try {
    if (!lstatSync(p).isFile()) return undefined;
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<LegMarker>;
    if (typeof o.id !== "string" || (o.kind !== "prompt" && o.kind !== "action") || typeof o.index !== "number") return undefined;
    return {
      scenarioRoot: typeof o.scenarioRoot === "string" ? o.scenarioRoot : "../..",
      id: o.id,
      index: o.index,
      kind: o.kind,
      workdir: o.workdir === "cowork-task" ? "cowork-task" : "persistent",
    };
  } catch {
    return undefined;
  }
}

/** The legs of a scenario root that carry a marker, in leg order (the marker's `index`, then id). */
export function legDirsOf(outDir: string): Array<{ id: string; dir: string; marker: LegMarker | undefined }> {
  const root = join(outDir, "legs");
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // A leg is a grammar-matching dir whose leg.json EXISTS. A marker that does not parse (a crash mid-write, a damaged
  // disk) still makes it a leg — the shape must not fall back to "none", which prune treats as junk — but with no
  // marker (`undefined`), so nothing resolves a tree or a kind from it.
  const out: Array<{ id: string; dir: string; marker: LegMarker | undefined }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !LEG_ID_RE.test(e.name)) continue;
    const dir = join(root, e.name);
    if (!existsSync(join(dir, "leg.json"))) continue;
    out.push({ id: e.name, dir, marker: readLegMarker(dir) });
  }
  const order = (x: { marker: LegMarker | undefined }) => x.marker?.index ?? Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}

/** A leg dir whose leg.json exists but does not parse. */
export function legMarkerUnreadable(dir: string): boolean {
  return existsSync(join(dir, "leg.json")) && readLegMarker(dir) === undefined;
}

/** Where a leg's session tree (`work/`) is, for a reader that needs the files and not just the turns.
 *  - not a leg dir → the dir itself;
 *  - `cowork-task` → the leg's own `legs/<id>/work/` (each leg had its own session root);
 *  - `persistent` → the scenario root's shared `work/`, which only the LAST leg's post-state still matches, and only
 *    once the scenario has finished. Any other persistent leg is refused: later legs changed that tree, and its
 *    post-state survives only as hashes in its leg-post-manifest.json. */
export function legTreeRoot(dir: string, command: string): { root: string } | { refused: string } {
  if (legMarkerUnreadable(dir))
    return { refused: `${command}: ${dir}'s leg.json is unreadable, so which leg it is (and where its files are) cannot be told` };
  const marker = readLegMarker(dir);
  if (!marker) return { root: dir };
  if (marker.workdir === "cowork-task") return { root: dir };
  // A leg dir is always <root>/legs/<id>: the marker's own claim about where its root is is not trusted.
  const scenarioRoot = join(dir, "..", "..");
  const legs = legDirsOf(scenarioRoot);
  if (legs.some((l) => !l.marker))
    return { refused: `${command}: a leg marker under ${join(scenarioRoot, "legs")} is unreadable, so which leg was last cannot be told` };
  const last = legs[legs.length - 1];
  if (last?.id === marker.id && existsSync(join(scenarioRoot, SCENARIO_RESULT))) return { root: scenarioRoot };
  return {
    refused:
      `${command}: ${dir} is leg ${marker.id} of a multi-leg run; its session tree is shared and was changed by ` +
      `later legs, so its post-state is only in its leg-post-manifest.json.`,
  };
}

/** The scenario-level result of a multi-leg run, written once every leg has finished (or the scenario stopped). */
export const SCENARIO_RESULT = "scenario-result.json";

/** Throw `MultiLegRunDirError` if `outDir` is a multi-leg root or an action leg — the quiet-empty guard. */
function refuseMultiLeg(outDir: string, command = "this command"): void {
  // Two existence checks first: the helpers are on hot paths, and almost no dir has either name.
  if (!existsSync(join(outDir, "legs")) && !existsSync(join(outDir, "leg.json"))) return;
  const shape = classifyRunDir(outDir);
  if (shape.kind === "legs" || shape.kind === "action-leg")
    throw new MultiLegRunDirError(`${command}: ${preLayoutMessage(shape, outDir, command)}`);
}

/** Does this run dir use the per-turn directory layout? */
export function hasTurnDirs(outDir: string): boolean {
  refuseMultiLeg(outDir);
  return turnsDirNumbers(outDir).length > 0;
}

/** Every turn number addressable in this run dir, ascending. Single shape: this is exactly
 *  `turns/<N>/` — a `legacy`/`mixed`/`none` dir (see `classifyRunDir`) addresses no turns at all, rather
 *  than inventing one from a root or name-mangled file. */
export function listTurns(outDir: string): number[] {
  refuseMultiLeg(outDir);
  return turnsDirNumbers(outDir);
}

export function latestTurn(outDir: string): number | undefined {
  const all = listTurns(outDir);
  return all.length ? all[all.length - 1] : undefined;
}

/** Absolute path to one artifact of one turn — the accessor every reader should use.
 *
 *  Single shape: always `turns/<turn>/<artifact>`, whether or not the file exists — callers test
 *  existence as they do today. No root fallback and no name-mangled archive fallback: a `legacy`/`mixed`
 *  dir is refused (see `classifyRunDir`/`requireTurns`), never silently resolved here. */
export function turnArtifactPath(outDir: string, turn: number, artifact: PerTurnArtifact): string {
  return join(outDir, "turns", String(turn), artifact);
}

/** The GRADED turn's artifact for a `critique` run dir.
 *
 *  Role, not number: a consumer asks "which turn was graded?", never "which number was it?". Prefers the
 *  stable `*.graded.json` alias `critique` writes, because it is correct the moment it is written and
 *  survives a reflection turn that never completed; falls back to turn 1. */
/** The graded-alias PATH for an artifact — `result.json` -> `<outDir>/result.graded.json`. The seam owns
 *  this naming so a writer and a reader cannot drift apart on it; `critique` used to hardcode the pairs. */
export function gradedAliasPath(outDir: string, artifact: "result.json" | "trace.json"): string {
  const { stem, ext } = stemAndExt(artifact);
  return join(outDir, `${stem}.graded${ext}`);
}

export function resolveGraded(outDir: string, artifact: "result.json" | "trace.json"): string | undefined {
  refuseMultiLeg(outDir);
  const alias = gradedAliasPath(outDir, artifact);
  if (existsSync(alias)) return alias;
  const byTurn = turnArtifactPath(outDir, 1, artifact);
  return existsSync(byTurn) ? byTurn : undefined;
}

/** The directory this turn's artifacts are WRITTEN to, created if needed.
 *
 *  Writers use this; readers use `turnArtifactPath`. Separate because a writer always knows its own turn
 *  number, while a reader may be addressing any turn of an already-written dir. */
export function turnWriteDir(outDir: string, turn: number): string {
  const d = join(outDir, "turns", String(turn));
  mkdirSync(d, { recursive: true });
  return d;
}

/** Turn detection: one past the highest turn that has a `run.jsonl`.
 *
 *  KEYED ON `run.jsonl`, NOT `result.json`, and that is the whole crash contract. The writer emits
 *  `run.jsonl` BEFORE `result.json` (see execute.ts's ordering comment — "Order matters, do not swap"), so
 *  a crash between the two leaves a turn whose transcript is COMPLETE and whose result assembly failed.
 *  That is a real, paid, history-advancing turn: the model produced it and the session moved on. Counting
 *  it as done is what stops a retry from overwriting it.
 *
 *  An earlier draft of this keyed on `result.json` and would have called that shape incomplete — letting
 *  the retry clobber a completed transcript, and (on a retried turn 1, which gets no events marker) fusing
 *  two attempts' events into one verdict. An adversarial review caught it by prototype.
 *
 *  `mkdir` without a `run.jsonl` is therefore NOT a turn: a crash right after creating the directory
 *  leaves it reusable rather than inflating every later turn number.
 *
 *  Single shape: this counts `turns/<N>/run.jsonl` only. `execute.ts`'s own `currentTurn` still ORs this
 *  against an independent root-archive count for its write-side legacy handling (untouched here — see that
 *  function); this seam function no longer needs to, since `turnArtifactPath` never resolves a root file
 *  for this module's readers to disagree with. */
export function currentTurnFromDirs(outDir: string): number {
  refuseMultiLeg(outDir);
  const withTranscript = turnsDirNumbers(outDir).filter((n) => existsSync(join(outDir, "turns", String(n), "run.jsonl")));
  return (withTranscript[withTranscript.length - 1] ?? 0) + 1;
}

/** Root-level names that indicate CONTAMINATION — a pre-layout marker, whether or not `turns/` also
 *  exists. No writer produces a root compat copy of any `PER_TURN_ARTIFACT` anymore, and a name-mangled
 *  `<stem>.turn-<N>.<ext>` archive is a PRE-LAYOUT artifact — no writer produces one anymore (the LEGACY
 *  branch, which is itself gated `!hasTurnDirs`. So any of these can only mean a pre-layout dir (with
 *  `turns/` present: one that was resumed under current code). Detection only, for `classifyRunDir`'s
 *  message — never used to resolve a read. */
function contaminationMarkers(outDir: string): string[] {
  const markers: string[] = [];
  for (const a of PER_TURN_ARTIFACTS) if (existsSync(join(outDir, a))) markers.push(a);
  try {
    for (const e of readdirSync(outDir)) {
      // Mirror the migrator's ARCHIVE_RE, INCLUDING the optional `.retry-<N>` — the migrator plans to move
      // a root retry archive, so if this detector missed it the dir classified as clean `turns` and readers
      // read it instead of refusing. The two seams must name the same set of pre-layout markers.
      if (/^(?:result|run|trace|resources)\.turn-\d+(?:\.retry-\d+)?\.(?:json|jsonl)$/.test(e)) markers.push(e);
    }
  } catch {
    /* outDir absent/unreadable — no markers */
  }
  return markers;
}

export type RunDirShape =
  | { kind: "turns"; turns: number[] }
  | { kind: "legacy"; markers: string[] }
  | { kind: "mixed"; turns: number[]; markers: string[] }
  /** A multi-leg scenario root: `legs/` holds at least one `leg.json`. `complete` = `scenario-result.json` exists. */
  | { kind: "legs"; legs: string[]; complete: boolean }
  /** A host-action leg dir: no agent session, its record is `action.json`. */
  | { kind: "action-leg" }
  | { kind: "none" };

/** Classify a run dir's on-disk shape. The ONLY place the legacy/mixed shape is still named after the
 *  removal above — as a DETECTOR feeding a refusal message, never as a resolver `turnArtifactPath` falls
 *  back to. See `requireTurns`/`preLayoutMessage` for how a caller acts on this. */
export function classifyRunDir(outDir: string): RunDirShape {
  const turns = turnsDirNumbers(outDir);
  const markers = contaminationMarkers(outDir);
  const legs = legDirsOf(outDir);
  if (legs.length) {
    // A legs root never has turns/ or per-turn files of its own; one that does is contaminated, refused as mixed.
    if (turns.length || markers.length) return { kind: "mixed", turns, markers: [...markers, "legs/"] };
    return { kind: "legs", legs: legs.map((l) => l.id), complete: existsSync(join(outDir, SCENARIO_RESULT)) };
  }
  // A host-action leg, or a leg whose marker is unreadable: neither is an agent session to read.
  if (readLegMarker(outDir)?.kind === "action" || legMarkerUnreadable(outDir)) return { kind: "action-leg" };
  if (turns.length) return markers.length ? { kind: "mixed", turns, markers } : { kind: "turns", turns };
  return markers.length ? { kind: "legacy", markers } : { kind: "none" };
}

/** Refuse a `legacy` / `mixed` / `none` dir with a message naming the shape; return the addressable turn
 *  list for a genuine current-layout (`turns`) dir. `command` is folded into the thrown message so a
 *  caller need not repeat itself at every call site. */
export function requireTurns(outDir: string, command: string): number[] {
  const shape = classifyRunDir(outDir);
  if (shape.kind === "turns") return shape.turns;
  if (shape.kind === "legs" || shape.kind === "action-leg")
    throw new MultiLegRunDirError(`${command}: ${preLayoutMessage(shape, outDir, command)}`);
  throw new LegacyRunDirError(`${command}: ${preLayoutMessage(shape, outDir)}`);
}

/** ONE shared message builder so every refusing command names the same shape/markers/remediation instead
 *  of independently re-deriving (and drifting on) the wording. Names what the dir IS, never what's
 *  "missing": on a legacy dir the file is right there at the root — the ambiguity is which SHAPE it's in,
 *  not whether evidence exists. */
export function preLayoutMessage(shape: RunDirShape, outDir: string, command = "this command"): string {
  if (shape.kind === "legs")
    return shape.complete
      ? `${outDir} is a multi-leg run dir (legs: ${shape.legs.join(", ")}). ${command} reads one agent session; ` +
          `point it at ${join(outDir, "legs")}/<id> for a prompt leg, or see ${join(outDir, SCENARIO_RESULT)} for the ` +
          `scenario verdict.`
      : `${outDir} is a multi-leg run that has not finished (legs started: ${shape.legs.join(", ")}; no ` +
          `${SCENARIO_RESULT}): it is still running or was interrupted. A finished leg is readable at ` +
          `${join(outDir, "legs")}/<id>.`;
  if (shape.kind === "action-leg")
    return legMarkerUnreadable(outDir)
      ? `${outDir} is a leg of a multi-leg run whose leg.json is unreadable, so it cannot be read as an agent session.`
      : `${outDir} is a host-action leg (no agent session); its record is ${join(outDir, "action.json")}.`;
  if (shape.kind === "legacy")
    return (
      `${outDir} is a pre-layout run dir (written before the turns/<N>/ layout): ${shape.markers.join(", ")} ` +
      `found at the run-dir root, no turns/ directory. \`trace ${outDir}\` still works (its views derive ` +
      `from events.jsonl, which never moves). Convert it in place: \`cowork-harness migrate-run-dir\`.`
    );
  if (shape.kind === "mixed")
    return (
      `${outDir} is a MIXED run dir: turns/ (${shape.turns.join(", ")}) AND pre-layout markers at the root ` +
      `(${shape.markers.join(", ")}) — almost certainly a pre-layout dir that was resumed under current code, ` +
      `which leaves its earliest turn unaddressable. \`trace ${outDir}\` still works. Convert it in place: ` +
      `\`cowork-harness migrate-run-dir\`.`
    );
  if (shape.kind === "none")
    return (
      `${outDir} has neither a turns/<N>/ directory nor any pre-layout marker — this run never completed ` +
      `(or ${outDir} is not a run dir at all).`
    );
  return `${outDir} is a current-layout run dir (turns: ${shape.turns.join(", ")}).`;
}
