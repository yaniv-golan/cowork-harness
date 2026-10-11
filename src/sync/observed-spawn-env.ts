// Reads the env key NAMES Desktop's own host-loop spawn carried on the synced build, for
// `provenance.observedSpawnEnv`, from Desktop's local log (`~/Library/Logs/Claude/main*.log`).
//
// Why Desktop's log and not the bundle: the bundle's env literals are only the start of the spawn env. Desktop keeps
// writing to it after it is built (computed keys, helper transforms, a second host-loop literal, a proxy transform that
// returns a new object), and a static scanner over that code was measured to be both noisy and silently blind. Desktop
// logs the FINAL key list of every local host-loop session as `[HostLoop] sdkOptions after patch: %o` (util.inspect of
// the options, whose `envKeys` field is `Object.keys(env).sort()`), so the names can be read with no static analysis.
// It sees only that lane: a cloud task and a VM-loop session log no such entry.
//
// PRIVACY is the design constraint, as in desktop-init-surface.ts. The same log entry holds username-bearing paths
// (`cwd`, `executable`, `executableArgs`, `CLAUDE_CONFIG_DIR`) and the plugin list, and an organisation's managed
// settings can add env names of its own. So:
//   - only files named `main.log` / `main<N>.log` are opened;
//   - the line parser keeps no line text: from a dump it keeps key names that fully match the env-name shape, and an
//     agent version captured by a strict dotted-number pattern; from a `Starting app` entry, its appVersion;
//   - a name is COMMITTED only if the registry classifies it (site "observed"). A name Desktop's bundle carries but
//     nobody classified is a LOCAL write-blocking delta that may name it (it is Desktop vocabulary). Any other name is
//     counted as withheld and never printed, hashed or committed;
//   - no message carries a file path or an `Error.message` from a file operation.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObservedSpawnEnv, ObservedSpawnEnvDeclaration, PlatformBaseline } from "../types.js";
import { buildHostLoopNativeEnv } from "../runtime/hostloop.js";
import { classifySpawnEnvKey } from "./spawn-env-registry.js";

/** Fixed display form of the logs dir: messages use this, never the resolved (username-bearing) path. */
export const DESKTOP_LOGS_DISPLAY = "~/Library/Logs/Claude";

/** The logged literal, with its `: %o` tail exactly as the bundle carries it (all saved builds 1.18286.2–2.31226.1). */
export const SPAWN_ENV_PRODUCER_LITERAL = "[HostLoop] sdkOptions after patch: %o";
const ENV_KEYS_CONSTRUCTION = /envKeys:([\w$]+)\.env\?Object\.keys\(\1\.env\)\.sort\(\):\[\]/;

/** Whether the Desktop bundle still logs the dump this reader parses, and still builds `envKeys` from the env's keys. */
export function bundleHasSpawnEnvProducer(bundle: string): boolean {
  const literal = ['"', "'", "`"].some((q) => bundle.includes(`${q}${SPAWN_ENV_PRODUCER_LITERAL}${q}`));
  return literal && ENV_KEYS_CONSTRUCTION.test(bundle);
}

export interface ObservedSpawnEnvInput {
  logsDir: string;
  /** The synced Desktop version: dumps are attributed to it by the `Starting app` entry that precedes them. */
  appVersion: string;
  /** The Desktop install time (asar ctime). Used ONLY for a dump with no `Starting app` entry before it in the
   *  retained logs. null selects none of those. */
  installedAtMs: number | null;
  /** null = the bundle is unavailable, so no name can be attributed to Desktop and nothing is recorded. */
  bundle: { hasProducer: boolean; hasProductName: (name: string) => boolean } | null;
  /** The newest committed baseline's block: an observation of the SAME build survives log rotation. */
  previous: ObservedSpawnEnv | null;
  /** `--spawn-env-unobservable`: the maintainer's declaration for this build. */
  declare: ObservedSpawnEnvDeclaration | null;
}

export interface ObservedSpawnEnvReading {
  block: ObservedSpawnEnv;
  /** Write-blocking. */
  deltas: string[];
  /** Informational, printed locally by sync; never committed. */
  notes: string[];
}

type DumpStatus = "ok" | "incomplete" | "empty";

export interface ParsedDump {
  appVersion: string | null;
  atMs: number;
  agentVersion: string | null;
  names: Set<string>;
  status: DumpStatus;
  malformed: number;
}
export interface ParsedSession {
  appVersion: string | null;
  atMs: number;
}
export interface ParsedLog {
  dumps: ParsedDump[];
  sessions: ParsedSession[];
  /** `Starting app` entries that carried no appVersion line: the log format drifted. */
  startsWithoutVersion: number;
}

const ENTRY = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[\w+\] (.*)$/;
const DUMP_HEAD = /^\[HostLoop\] sdkOptions after patch: \{$/;
const SESSION_RUNNING = /^\[Lifecycle\] Session local_[0-9a-f-]+: initializing → running$/;
const START_APP_VERSION = /^ {2}appVersion: '(\d+\.\d+\.\d+)',?$/;
const AGENT_PATH = /\/claude-code\/(\d+\.\d+\.\d+)\/(?:[0-9a-f]{12}\/)?claude\.app\//;
const ENV_KEYS_OPEN = /^ {2}envKeys: \[$/;
const ENV_KEYS_EMPTY = /^ {2}envKeys: \[ \[length\]: 0 \],?$/;
const ENV_KEYS_TRAILER = /^ {4}\[length\]: (\d+)$/;
const ENV_KEYS_MORE = /^ {4}\.\.\. \d+ more items?$/;
const ENV_KEYS_CLOSE = /^ {2}\],?$/;
const KEY_ITEM = /^(['"])([A-Z][A-Z0-9_]{0,127})\1$/;

/** Desktop's log stamps are local wall-clock with no zone: read the fields as local time, never via Date.parse. */
function localMs(m: RegExpMatchArray): number {
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/**
 * The line-at-a-time parser. Its state holds no line text: per dump, a set of key names (each a full match of the
 * env-name shape), counters, a status, an agent version (strict dotted numbers); between dumps, the current app
 * version (likewise). `lines` must be in time order, oldest file first, so a `Starting app` entry in a rotated file
 * still attributes the dumps after it.
 */
export function parseDesktopLogLines(lines: Iterable<string>): ParsedLog {
  const dumps: ParsedDump[] = [];
  const sessions: ParsedSession[] = [];
  let currentApp: string | null = null;
  let startHadVersion = true;
  let startsWithoutVersion = 0;
  let mode: "none" | "start" | "dump" = "none";
  let dump: ParsedDump | null = null;
  let inEnvKeys = false;
  let envDone = false;
  let items = 0;
  let trailer: number | null = null;
  let more = false;

  const finish = () => {
    if (dump && dump.status !== "empty") dump.status = envDone && !more && trailer === items ? "ok" : "incomplete";
    dump = null;
    inEnvKeys = false;
    envDone = false;
    items = 0;
    trailer = null;
    more = false;
  };

  for (const line of lines) {
    const entry = line.match(ENTRY);
    if (entry) {
      if (mode === "dump") finish();
      if (mode === "start" && !startHadVersion) startsWithoutVersion++;
      const rest = entry[7];
      if (rest === "Starting app {") {
        // A new Desktop process: never let the previous build's version attribute what follows.
        mode = "start";
        currentApp = null;
        startHadVersion = false;
      } else if (DUMP_HEAD.test(rest)) {
        mode = "dump";
        dump = { appVersion: currentApp, atMs: localMs(entry), agentVersion: null, names: new Set(), status: "incomplete", malformed: 0 };
        dumps.push(dump);
      } else {
        mode = "none";
        if (SESSION_RUNNING.test(rest)) sessions.push({ appVersion: currentApp, atMs: localMs(entry) });
      }
      continue;
    }
    if (mode === "start") {
      const v = line.match(START_APP_VERSION);
      if (v) {
        currentApp = v[1];
        startHadVersion = true;
      }
      continue;
    }
    if (mode !== "dump" || !dump || envDone) continue;
    const d: ParsedDump = dump;
    if (!inEnvKeys) {
      if (d.agentVersion === null) {
        const a = line.match(AGENT_PATH);
        if (a) d.agentVersion = a[1];
      }
      if (ENV_KEYS_EMPTY.test(line)) {
        d.status = "empty";
        envDone = true;
      } else if (ENV_KEYS_OPEN.test(line)) inEnvKeys = true;
      continue;
    }
    const t = line.match(ENV_KEYS_TRAILER);
    if (t) {
      trailer = Number(t[1]);
      continue;
    }
    if (ENV_KEYS_MORE.test(line)) {
      more = true;
      continue;
    }
    if (ENV_KEYS_CLOSE.test(line)) {
      inEnvKeys = false;
      envDone = true;
      continue;
    }
    for (const piece of line.split(",")) {
      const item = piece.trim();
      if (item === "") continue;
      items++;
      const k = item.match(KEY_ITEM);
      if (k) d.names.add(k[2]);
      else d.malformed++;
    }
  }
  if (mode === "dump") finish();
  if (mode === "start" && !startHadVersion) startsWithoutVersion++;
  return { dumps, sessions, startsWithoutVersion };
}

/** `main<N>.log` oldest first (highest N), then `main.log`. Nothing else in the dir is opened. */
function* logLines(dir: string, counts: { unreadable: number }): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    counts.unreadable++;
    return;
  }
  const files = names
    .map((n) => ({ n, m: n.match(/^main(\d*)\.log$/) }))
    .filter((x): x is { n: string; m: RegExpMatchArray } => x.m !== null)
    .sort((a, b) => Number(b.m[1] || 0) - Number(a.m[1] || 0));
  for (const { n } of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, n), "utf8");
    } catch {
      counts.unreadable++;
      continue;
    }
    yield* text.split("\n");
  }
}

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function readObservedSpawnEnv(input: ObservedSpawnEnvInput): ObservedSpawnEnvReading {
  const deltas: string[] = [];
  const notes: string[] = [];
  const noSession: ObservedSpawnEnv = { observed: false, appVersion: input.appVersion, reason: "no-session" };
  if (input.bundle === null) {
    deltas.push(
      "observedSpawnEnv: the Desktop bundle is unavailable, so no env key name can be attributed to Desktop — fix the asar extraction and re-sync",
    );
    return { block: noSession, deltas, notes };
  }
  if (!input.bundle.hasProducer) {
    // Nothing in the logs can contradict a declaration when Desktop no longer writes the entry at all.
    if (input.declare) {
      notes.push(
        `WARNING: observedSpawnEnv UNOBSERVABLE (declared: ${input.declare}; the bundle no longer logs the host-loop dump) — coverage of Desktop's post-construction spawn env is down to the minimal scanner for Desktop ${input.appVersion}.`,
      );
      return { block: { observed: false, appVersion: input.appVersion, reason: "lane-gone", declared: input.declare }, deltas, notes };
    }
    deltas.push(
      `observedSpawnEnv: the Desktop bundle no longer logs "${SPAWN_ENV_PRODUCER_LITERAL}" with an envKeys list built from the env's keys — ` +
        "the oracle's producer is gone. Re-derive src/sync/observed-spawn-env.ts against this build, or pass --spawn-env-unobservable",
    );
    return { block: noSession, deltas, notes };
  }

  const counts = { unreadable: 0 };
  const parsed = parseDesktopLogLines(logLines(input.logsDir, counts));
  if (parsed.startsWithoutVersion > 0)
    deltas.push(
      `observedSpawnEnv: ${parsed.startsWithoutVersion} 'Starting app' log entr${parsed.startsWithoutVersion === 1 ? "y has" : "ies have"} no appVersion line, so dumps after ${parsed.startsWithoutVersion === 1 ? "it" : "them"} cannot be attributed to a Desktop build — the log format drifted; re-derive src/sync/observed-spawn-env.ts`,
    );
  let fallback = 0;
  const ours = (x: { appVersion: string | null; atMs: number }) => {
    if (x.appVersion !== null) return x.appVersion === input.appVersion;
    const hit = input.installedAtMs !== null && x.atMs >= input.installedAtMs;
    return hit;
  };
  const raw = parsed.dumps.filter(ours);
  fallback = raw.filter((d) => d.appVersion === null).length;
  const sessions = parsed.sessions.filter(ours).length;
  const selected = raw.filter((d) => d.status === "ok");
  if (counts.unreadable)
    notes.push(`observedSpawnEnv: ${counts.unreadable} log file(s) or dir(s) under ${DESKTOP_LOGS_DISPLAY} unreadable (skipped)`);
  if (fallback)
    notes.push(
      `observedSpawnEnv: ${fallback} dump(s) attributed by the Desktop install time (no 'Starting app' entry before them in the retained logs)`,
    );

  if (input.declare && (raw.length > 0 || sessions > 0)) {
    deltas.push(
      `observedSpawnEnv: refusing --spawn-env-unobservable — ${raw.length} host-loop dump(s) and ${sessions} local session(s) were logged under Desktop ${input.appVersion}, so the lane is not gone`,
    );
  }

  if (selected.length > 0) {
    const seen = new Map<string, number>();
    for (const d of selected) for (const n of d.names) seen.set(n, (seen.get(n) ?? 0) + 1);
    const committed: string[] = [];
    let withheld = 0;
    for (const n of [...seen.keys()].sort()) {
      if (classifySpawnEnvKey(n, "observed")) committed.push(n);
      else if (input.bundle.hasProductName(n))
        deltas.push(
          `observedSpawnEnv: Desktop's host-loop spawn carries ${n}, which src/sync/spawn-env-registry.ts does not classify — classify it (site "observed") and re-sync; do NOT bypass with --allow-empty`,
        );
      else withheld++;
    }
    const malformed = selected.reduce((a, d) => a + d.malformed, 0);
    if (malformed > 0)
      deltas.push(
        `observedSpawnEnv: ${malformed} malformed envKeys item(s) (not env-name shaped) — the dump format changed; re-derive the reader (items withheld)`,
      );
    if (withheld > 0)
      notes.push(
        `observedSpawnEnv: ${withheld} env key name(s) not attributable to Desktop (likely organisation-managed) — withheld, names not shown. Inspect envKeys in ${DESKTOP_LOGS_DISPLAY}/main.log by hand`,
      );
    const skipped = raw.length - selected.length;
    if (skipped > 0) notes.push(`observedSpawnEnv: ${skipped} dump(s) for this build skipped as incomplete or empty`);
    const block: ObservedSpawnEnv = {
      observed: true,
      appVersion: input.appVersion,
      nativeAgentVersions: sortedUnique(selected.map((d) => d.agentVersion).filter((v): v is string => v !== null)),
      sessions: selected.length,
      keysAll: committed.filter((n) => seen.get(n) === selected.length),
      keysSome: committed.filter((n) => seen.get(n)! < selected.length),
      withheld,
    };
    notes.push(
      `observedSpawnEnv: read ${selected.length} host-loop dump(s) under Desktop ${input.appVersion}; ${committed.length} classified name(s) recorded`,
    );
    return { block, deltas, notes };
  }

  if (raw.length > 0) {
    deltas.push(
      `observedSpawnEnv: ${raw.length} host-loop dump(s) were logged under Desktop ${input.appVersion} but none could be read (incomplete, truncated or empty) — ` +
        "the dump format or this reader drifted; re-derive src/sync/observed-spawn-env.ts",
    );
    return { block: noSession, deltas, notes };
  }

  if (input.declare) {
    if (sessions > 0) return { block: noSession, deltas, notes };
    notes.push(
      `WARNING: observedSpawnEnv UNOBSERVABLE (declared: ${input.declare}) — coverage of Desktop's post-construction spawn env is down to the minimal scanner for Desktop ${input.appVersion}.`,
    );
    return { block: { observed: false, appVersion: input.appVersion, reason: "lane-gone", declared: input.declare }, deltas, notes };
  }

  const prev = input.previous;
  if (prev?.observed === true && prev.appVersion === input.appVersion) {
    notes.push(
      `observedSpawnEnv: no dump for Desktop ${input.appVersion} remains in the logs; kept the committed observation of this same build`,
    );
    return { block: prev, deltas, notes };
  }

  notes.push(
    `WARNING: observedSpawnEnv UNOBSERVED — no local host-loop task has run under Desktop ${input.appVersion}` +
      (sessions > 0 ? ` (${sessions} local session(s) started, but none logged a host-loop dump; a VM-loop session logs none)` : "") +
      ". Recorded observed:false; a release cannot ship it. Start one Cowork task with 'Only on this computer' on, then re-run sync.",
  );
  return { block: noSession, deltas, notes };
}

/** Classes whose keys the harness host loop claims to set itself; an observed one it does not set is a contradiction. */
const HARNESS_OWNED = new Set(["pinned", "harness-set"]);
/** Classes whose keys a default session should not carry. */
const DEFAULT_ABSENT = new Set(["settings-conditional", "session-conditional", "gate-conditional-off", "non-cowork-session", "3p-only"]);

/**
 * The env key names the harness host loop spawns for `baseline`, built over an EMPTY operator env (so no name from the
 * maintainer's shell can enter the comparison or a message) and with placeholder values for the keys the harness adds
 * at spawn (`runtimeAuthEnv`: TZ and the OAuth token) and for a connected folder. Only the key set is used. The OAuth
 * token is assumed present: `runtimeAuthEnv` sends ANTHROPIC_API_KEY instead when the operator has no token, which is
 * the CI fallback, not the Cowork path being compared.
 */
export function harnessHostLoopKeys(baseline: PlatformBaseline): Set<string> {
  const env = buildHostLoopNativeEnv(baseline, {
    configDir: "/placeholder/config",
    folderHostPaths: ["/placeholder/folder"],
    extra: { TZ: "UTC", CLAUDE_CODE_OAUTH_TOKEN: "placeholder" },
    operatorEnv: {},
  });
  return new Set(Object.keys(env));
}

/**
 * Compare Desktop's observed host-loop spawn env with the harness's. Write-blocking: an observed key the registry
 * classes `pinned` or `harness-set` that the harness does not set. Informational: registry-named keys the harness sets
 * that no observed dump carried (conditional keys legitimately differ). Unregistered names are never printed.
 */
export function checkObservedAgainstHarness(
  block: ObservedSpawnEnv,
  harnessKeys: ReadonlySet<string>,
): { deltas: string[]; notes: string[] } {
  if (!block.observed) return { deltas: [], notes: [] };
  const seen = new Set([...block.keysAll, ...block.keysSome]);
  const deltas: string[] = [];
  const notes: string[] = [];
  for (const k of [...seen].sort()) {
    const c = classifySpawnEnvKey(k, "observed");
    if (c && HARNESS_OWNED.has(c.class) && !harnessKeys.has(k))
      deltas.push(
        `observedSpawnEnv: Desktop's host-loop spawn carries ${k}, classed ${c.class}, but the harness host loop does not set it — model it or reclassify it in src/sync/spawn-env-registry.ts; do NOT bypass with --allow-empty`,
      );
  }
  // A key the registry calls absent by default that every observed session carries: the reason is out of date.
  for (const k of block.keysAll) {
    const c = classifySpawnEnvKey(k, "observed");
    if (c && DEFAULT_ABSENT.has(c.class))
      notes.push(
        `observedSpawnEnv: ${k} is classed ${c.class} (absent by default) but every observed session carries it — re-check its classification in src/sync/spawn-env-registry.ts`,
      );
  }
  const harnessOnly = [...harnessKeys].filter((k) => !seen.has(k) && classifySpawnEnvKey(k, "observed") !== null).sort();
  if (harnessOnly.length)
    notes.push(
      `observedSpawnEnv: the harness host loop sets ${harnessOnly.length} key(s) no observed dump carried: ${harnessOnly.join(", ")}`,
    );
  return { deltas, notes };
}
