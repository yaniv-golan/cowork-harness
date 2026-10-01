// `hillclimb run`'s preparation before any spend: each case's session and baseline, the one lever the loop
// tunes, the model pins, and the tier the trace needs. It composes the existing pieces (the session loader,
// eval's pin resolvers, the protocol tier's managed-config rule); nothing here is a second copy of them.

import { readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { UsageError } from "../errors.js";
import { expandHome, resolveLaunchSources, type SessionConfig } from "../session.js";
import type { MountTier } from "../staging/mount-naming.js";
import { loadSessionFromFile } from "../run/execute.js";
import { loadBaseline } from "../baseline.js";
import { managedConfigMode } from "../runtime/protocol.js";
import { resolveAgentPins, resolveJudgePins } from "../eval/pins.js";
import type { PlatformBaseline, Scenario } from "../types.js";
import type { HillclimbCase } from "./cases.js";

export interface PreparedCases {
  /** The live plugin directory the loop edits — the one lever every case shares. */
  lever: string;
  session: (c: HillclimbCase) => SessionConfig;
  sessionFile: (c: HillclimbCase) => string;
  baseline: (c: HillclimbCase) => PlatformBaseline;
  /** The concrete model the case's main loop must be served by. */
  pin: (c: HillclimbCase) => string;
  /** Every file that defines the measurement — the harness gate's derived set. */
  derivedPaths: (cases: readonly HillclimbCase[]) => string[];
  /** Every host root the agent can read through a mount: folders, projects, uploads, plugins, local skills. */
  mountRoots: (cases: readonly HillclimbCase[]) => string[];
}

/** The workspace fixture a scenario stages before its first turn, or null. The ONE hook point for hashing
 *  fixture files into the harness gate: it returns null until the scenario key that declares a fixture
 *  exists — no key is assumed here. */
export function fixtureDirOf(_scenario: Scenario): string | null {
  return null;
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const TIERS: readonly MountTier[] = ["hostloop", "container", "microvm", "protocol"];

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Throws UsageError (exit 2) on anything an unattended loop cannot run or measure. */
export function prepareCases(
  cases: readonly HillclimbCase[],
  opts: { modelFlag?: string; judgeModelFlag?: string; env: NodeJS.ProcessEnv },
): PreparedCases {
  const sessions = new Map<string, { session: SessionConfig; file: string; baseline: PlatformBaseline }>();
  for (const c of cases) {
    const s = c.scenario;
    if (s.on_unanswered === "prompt")
      throw new UsageError(`case ${c.id}: on_unanswered: prompt is refused — an unattended loop has nobody to answer`);
    if (s.session === "(inline)")
      throw new UsageError(`case ${c.id}: the scenario has no session file; the loop tunes the session's one plugins.local_plugins entry`);
    let session: SessionConfig;
    try {
      session = loadSessionFromFile(s.session);
    } catch (e) {
      throw new UsageError(`case ${c.id}: ${(e as Error).message}`);
    }
    if (session.plugins.local_plugins.length !== 1)
      throw new UsageError(
        `case ${c.id}: the session must declare exactly one plugins.local_plugins entry — the plugin the loop tunes (found ${session.plugins.local_plugins.length})`,
      );
    // A trace without its sub-agents' turns is incomplete: unmanaged protocol keeps no child transcripts.
    if (s.fidelity === "protocol" && !managedConfigMode(opts.env))
      throw new UsageError(
        `case ${c.id}: fidelity protocol without a managed config dir keeps no sub-agent transcripts, so its traces would be incomplete — set COWORK_MANAGED_CONFIG=1 or use another tier`,
      );
    sessions.set(c.id, { session, file: resolve(expandHome(s.session)), baseline: loadBaseline(s.baseline) });
  }
  const levers = [...new Set([...sessions.values()].map((x) => realOr(expandHome(x.session.plugins.local_plugins[0]))))];
  if (levers.length > 1)
    throw new UsageError(
      `every case must declare the SAME plugins.local_plugins entry — the one plugin the loop tunes (found ${levers.join(", ")})`,
    );
  const bases = [...new Set([...sessions.values()].map((x) => basename(expandHome(x.session.plugins.local_plugins[0]))))];
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
    pins = resolveAgentPins(
      cases.map((c) => ({ scenario: c.scenario, sessionModel: sessions.get(c.id)!.session.model })),
      opts.modelFlag,
    );
    resolveJudgePins(
      cases.map((c) => c.scenario),
      opts.judgeModelFlag,
    );
  } catch (e) {
    reword(e);
  }
  const pinOf = new Map(cases.map((c, i) => [c.id, pins[i].model]));
  return {
    lever: expandHome(sessions.get(cases[0].id)!.session.plugins.local_plugins[0]),
    session: (c) => sessions.get(c.id)!.session,
    sessionFile: (c) => sessions.get(c.id)!.file,
    baseline: (c) => sessions.get(c.id)!.baseline,
    pin: (c) => pinOf.get(c.id)!,
    derivedPaths: (cs) => [
      ...new Set(
        cs.flatMap((c) => {
          const x = sessions.get(c.id)!;
          const fixture = fixtureDirOf(c.scenario);
          return [
            resolve(c.file),
            x.file,
            ...x.session.uploads.map((u) => resolve(expandHome(u))),
            ...(fixture ? filesUnder(fixture) : []),
          ];
        }),
      ),
    ],
    mountRoots: (cs) => [
      ...new Set(
        cs.flatMap((c) => {
          const x = sessions.get(c.id)!;
          const tier = (TIERS as readonly string[]).includes(c.scenario.fidelity) ? (c.scenario.fidelity as MountTier) : "hostloop";
          // The preview form: input checks only, no staging, no notices.
          const src = resolveLaunchSources(x.session, x.baseline, tier, false, { stageFilters: false, quiet: true });
          return [...src.mounts.map((m) => m.hostPath), ...src.hostOnlyFolders.map((m) => m.hostPath), ...src.skills.map((k) => k.src)];
        }),
      ),
    ],
  };
}
