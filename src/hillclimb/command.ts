// `hillclimb run`'s preparation before any spend: each case's session and baseline, the one lever the loop
// tunes, the model pins, and the tier the trace needs. It composes the existing pieces (the session loader,
// eval's pin resolvers, the protocol tier's managed-config rule); nothing here is a second copy of them.

import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { UsageError } from "../errors.js";
import { expandHome, resolveLaunchSources, type SessionConfig } from "../session.js";
import type { MountTier } from "../staging/mount-naming.js";
import { loadSessionFromFile } from "../run/execute.js";
import { loadBaseline } from "../baseline.js";
import { managedConfigMode } from "../runtime/protocol.js";
import { scenarioWorkspaceFixture } from "../fixture/workspace.js";
import { resolveAgentPins, resolveJudgePins } from "../eval/pins.js";
import type { PlatformBaseline } from "../types.js";
import type { HillclimbCase } from "./cases.js";

export interface PreparedCases {
  /** The live plugin directory the loop edits — the one lever every case shares. */
  lever: string;
  /** A SELECTED case's session (an unselected one's is not prepared). */
  session: (c: HillclimbCase) => SessionConfig;
  /** The case's session file (resolved), or undefined for an inline session. Known for every case: it comes from the
   *  scenario, not from parsing the session. */
  sessionFile: (c: HillclimbCase) => string | undefined;
  baseline: (c: HillclimbCase) => PlatformBaseline;
  /** The concrete model a SELECTED case's main loop must be served by. */
  pin: (c: HillclimbCase) => string;
  /** Every file that defines the measurement — the harness gate's derived set. A case whose session does not parse
   *  contributes its scenario and session files (and fixture), not its uploads: they cannot be read from it. */
  derivedPaths: (cases: readonly HillclimbCase[]) => string[];
  /** Per case with a workspace_fixture, its signature (`workspace-fixture:<case id>`): it covers each file's exec
   *  bit, which staging carries and the derived files' bytes do not. */
  derivedValues: (cases: readonly HillclimbCase[]) => Record<string, string>;
  /** The files that define the answer and must stay unreadable: each scenario and its session file. Uploads and
   *  fixtures are in the gate's set but are the agent's inputs, meant to be read. */
  hiddenPaths: (cases: readonly HillclimbCase[]) => string[];
  /** Every host root the agent can read: mounted folders, projects, uploads, plugins, local skills, and the
   *  workspace fixture copied into outputs/. Over cases whose session parses (every selected one). */
  mountRoots: (cases: readonly HillclimbCase[]) => string[];
  /** What the preparation skipped without refusing (an unselected case whose session does not parse). */
  notes: string[];
}

const TIERS: readonly MountTier[] = ["hostloop", "container", "microvm", "protocol"];

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Throws UsageError (exit 2) on anything an unattended loop cannot run or measure.
 *
 *  `selected` (default: every case) is the --case selection. The per-case refusals (on_unanswered: prompt, an
 *  inline session, a session that does not load, the model pins, the protocol tier's managed config) cover the
 *  selected cases only: an unselected case does not run in this pass. What is flow-level covers every case: its
 *  baseline (the gate hashes the baseline ids) and the one-plugin rule, over every case whose session parses — an
 *  unselected case whose session does not parse is skipped for it, with a note. */
export function prepareCases(
  cases: readonly HillclimbCase[],
  /** `noAgentRun`: a caller that never runs the agent (`hillclimb regrade`) resolves no agent model and skips the
   *  checks that only protect a new run (a protocol run's sub-agent transcripts). */
  opts: { modelFlag?: string; judgeModelFlag?: string; env: NodeJS.ProcessEnv; noAgentRun?: boolean },
  selected: readonly HillclimbCase[] = cases,
): PreparedCases {
  const chosen = new Set(selected.map((c) => c.id));
  const sel = cases.filter((c) => chosen.has(c.id));
  const notes: string[] = [];
  const baselines = new Map<string, PlatformBaseline>();
  const sessions = new Map<string, SessionConfig>();
  const fileOf = (c: HillclimbCase): string | undefined =>
    c.scenario.session === "(inline)" ? undefined : resolve(expandHome(c.scenario.session));
  for (const c of cases) {
    const s = c.scenario;
    const isSel = chosen.has(c.id);
    if (isSel && s.on_unanswered === "prompt")
      throw new UsageError(`case ${c.id}: on_unanswered: prompt is refused — an unattended loop has nobody to answer`);
    if (s.session === "(inline)") {
      if (isSel)
        throw new UsageError(
          `case ${c.id}: the scenario has no session file; the loop tunes the session's one plugins.local_plugins entry`,
        );
    } else {
      try {
        sessions.set(c.id, loadSessionFromFile(s.session));
      } catch (e) {
        if (isSel) throw new UsageError(`case ${c.id}: ${(e as Error).message}`);
        notes.push(
          `note: case ${c.id}: its session does not load, and it is not selected — skipped for the one-plugin rule (a pass that selects it refuses): ${(e as Error).message}`,
        );
      }
    }
    const session = sessions.get(c.id);
    if (session !== undefined && session.plugins.local_plugins.length !== 1)
      throw new UsageError(
        `case ${c.id}: the session must declare exactly one plugins.local_plugins entry — the plugin the loop tunes (found ${session.plugins.local_plugins.length})`,
      );
    // A trace without its sub-agents' turns is incomplete: unmanaged protocol keeps no child transcripts.
    if (!opts.noAgentRun && isSel && s.fidelity === "protocol" && !managedConfigMode(opts.env))
      throw new UsageError(
        `case ${c.id}: fidelity protocol without a managed config dir keeps no sub-agent transcripts, so its traces would be incomplete — set COWORK_MANAGED_CONFIG=1 or use another tier`,
      );
    baselines.set(c.id, loadBaseline(s.baseline));
  }
  const levers = [...new Set([...sessions.values()].map((x) => realOr(expandHome(x.plugins.local_plugins[0]))))];
  if (levers.length > 1)
    throw new UsageError(
      `every case must declare the SAME plugins.local_plugins entry — the one plugin the loop tunes (found ${levers.join(", ")})`,
    );
  const bases = [...new Set([...sessions.values()].map((x) => basename(expandHome(x.plugins.local_plugins[0]))))];
  if (bases.length > 1)
    throw new UsageError(
      `the cases declare the plugin under different directory names (${bases.join(", ")}); declare it the same way in every session`,
    );
  const reword = (e: unknown): never => {
    if (e instanceof UsageError) throw new UsageError(e.message.replace(/^eval needs/, "hillclimb needs"), e.hint);
    throw e;
  };
  let pins: ReturnType<typeof resolveAgentPins> = [];
  try {
    if (!opts.noAgentRun)
      pins = resolveAgentPins(
        sel.map((c) => ({ scenario: c.scenario, sessionModel: sessions.get(c.id)!.model })),
        opts.modelFlag,
      );
    resolveJudgePins(
      sel.map((c) => c.scenario),
      opts.judgeModelFlag,
    );
  } catch (e) {
    reword(e);
  }
  // A selected case's fixture that staging would refuse is refused; an unselected one's contributes nothing (the gate
  // hashes what it can read, and a pass that selects the case refuses it).
  const fixtureOf = (c: HillclimbCase): ReturnType<typeof scenarioWorkspaceFixture> => {
    if (chosen.has(c.id)) return scenarioWorkspaceFixture(c.scenario);
    try {
      return scenarioWorkspaceFixture(c.scenario);
    } catch {
      return null;
    }
  };
  const pinOf = new Map(sel.map((c, i) => [c.id, pins[i]?.model]));
  // Every selected case has a session, so the first one is there (selectCases never returns an empty set).
  const first = sessions.get(sel[0]?.id ?? "") ?? [...sessions.values()][0];
  if (first === undefined) throw new UsageError("no case with a session file is selected");
  return {
    lever: expandHome(first.plugins.local_plugins[0]),
    notes,
    session: (c) => sessions.get(c.id)!,
    sessionFile: fileOf,
    baseline: (c) => baselines.get(c.id)!,
    pin: (c) => pinOf.get(c.id)!,
    derivedPaths: (cs) => [
      ...new Set(
        cs.flatMap((c) => {
          const x = sessions.get(c.id);
          const file = fileOf(c);
          // The fixture's files exactly as staging scans them (regular, tracked in git mode, OS metadata skipped);
          // a fixture staging would refuse is refused here, before spend. Like staging, the scan reads its git-mode
          // switch from process.env, not opts.env, so the two always agree.
          const fixture = fixtureOf(c);
          const inputs = [
            ...(file !== undefined ? [file] : []),
            // A session that does not parse names no uploads: its own bytes are still hashed.
            ...(x?.uploads ?? []).map((u) => resolve(expandHome(u))),
            ...(fixture ? fixture.files.map((f) => join(fixture.dir, ...f.path.split("/"))) : []),
          ];
          // An unselected case's input that does not exist is left out (a pass that selects the case refuses it); the
          // gate would refuse an unreadable derived file. Once it exists, it is hashed: the sha moves.
          return [resolve(c.file), ...(chosen.has(c.id) ? inputs : inputs.filter((p) => existsSync(p)))];
        }),
      ),
    ],
    derivedValues: (cs) =>
      Object.fromEntries(
        cs.flatMap((c) => {
          const fixture = fixtureOf(c);
          return fixture ? [[`workspace-fixture:${c.id}`, fixture.sig]] : [];
        }),
      ),
    hiddenPaths: (cs) => [...new Set(cs.flatMap((c) => [resolve(c.file), fileOf(c)]))].filter((p): p is string => p !== undefined),
    mountRoots: (cs) => [
      ...new Set(
        cs.flatMap((c) => {
          const x = sessions.get(c.id);
          if (x === undefined) return [];
          const tier = (TIERS as readonly string[]).includes(c.scenario.fidelity) ? (c.scenario.fidelity as MountTier) : "hostloop";
          // The preview form: input checks only, no staging, no notices.
          const src = resolveLaunchSources(x, baselines.get(c.id)!, tier, false, { stageFilters: false, quiet: true });
          return [
            ...src.mounts.map((m) => m.hostPath),
            ...src.hostOnlyFolders.map((m) => m.hostPath),
            ...src.skills.map((k) => k.src),
            // A workspace_fixture is copied into outputs/, where the agent reads: a root like a connected folder.
            ...(c.scenario.workspace_fixture !== undefined ? [c.scenario.workspace_fixture] : []),
          ];
        }),
      ),
    ],
  };
}
