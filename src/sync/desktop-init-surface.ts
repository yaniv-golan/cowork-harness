// Reads the tool surface Desktop's OWN SDK-MCP servers declared in real Cowork sessions, from the
// `system/init` frames Desktop's sessions write to `local-agent-mode-sessions/**/audit.jsonl`, for
// `provenance.desktopInitSurface`.
//
// Why real Desktop frames and not the harness's: the harness registers some of these tools itself and
// others (`save_skill`) at no tier, so a harness init frame is a mirror of OUR spawn — a `tool_absent`
// over it is green by construction. Only Desktop produces the fact this records.
//
// PRIVACY is the design constraint. A real init frame lists every MCP server the operator has — ~70 on a
// working machine, connector UUIDs and private server names among them — and the same tree holds
// `local_<id>.json` files carrying the account email, cwd and system prompt. So:
//   - only files named exactly `audit.jsonl` are opened (no fallback to a sibling);
//   - a server is kept only if its name is `===` one of DESKTOP_OWN_SERVERS; nothing else leaves the parse loop;
//   - no message this module emits carries a file path, an `Error.message` from a file operation, or any
//     server/tool name outside the allowlist — failures are COUNTED, never described.
// A subset check over this function's own output is a tautology (it cannot emit what it filtered out); the
// evidence that the filter holds is the strict schema over committed baselines plus the mutation and bait
// tests in test/desktop-init-surface.test.ts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_OWN_SERVERS, type DesktopInitSurface } from "../types.js";

/** Fixed display form of the sessions dir — messages use this, never the resolved (username-bearing) path. */
export const DESKTOP_SESSIONS_DISPLAY = "~/Library/Application Support/Claude/local-agent-mode-sessions";

/** When the Desktop bundle at `asarPath` was installed: the file's ctime, or null when it is unreadable.
 *
 *  Not its mtime. The updater preserves the packaged file's timestamps, so the asar's mtime (and birth
 *  time) is when the release was BUILT. Measured on Desktop 2.9939.2: mtime 17:40 on the release day,
 *  install and first launch 00:37 the next day. Selecting frames from that mtime would have counted
 *  seven hours of the previous release's sessions as this release's. The kernel sets ctime on the
 *  rename that installs the file, and no tool can backdate it. Any later metadata change only moves it
 *  forward, which selects fewer frames: an unobserved surface, a loud state, never a misattributed one. */
export function desktopInstalledAtMs(asarPath: string): number | null {
  return existsSync(asarPath) ? statSync(asarPath).ctimeMs : null;
}

export interface InitSurfaceInput {
  dir: string;
  agentVersion: string;
  appVersion: string;
  /** The synced Desktop's install time (see `desktopInstalledAtMs`). Frames older than this were written by a
   *  PREVIOUS Desktop release, which may run the same agent version (22 of 36 committed baselines share an
   *  agentVersion with another release), so the agent-version match alone would attribute the previous
   *  release's surface to this one. null = unknown install time, which selects nothing. */
  installedAtMs: number | null;
  /** Whether a name occurs as a quoted literal in the synced Desktop bundle; null = bundle unavailable. */
  bundleHasLiteral: ((name: string) => boolean) | null;
  /** Test seam ONLY: which server names count as Desktop's own. Production always uses the default. */
  isOwnServer?: (name: string) => boolean;
}

export interface InitSurfaceReading {
  surface: DesktopInitSurface;
  framesSelected: number;
  /** Non-Desktop server entries skipped across the selected frames — a COUNT, never names. */
  excludedServers: number;
  unreadableFiles: number;
  /** Write-blocking: a recorded tool that is not attributable to Desktop (or cannot be checked). */
  deltas: string[];
  /** Informational, printed locally by sync; never committed. */
  notes: string[];
}

const isDesktopOwn = (name: string) => (DESKTOP_OWN_SERVERS as readonly string[]).includes(name);

/** Every `audit.jsonl` under `dir`, without following symlinks. Unreadable directories are counted. */
function findAuditLogs(dir: string, counts: { unreadable: number }): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      counts.unreadable++;
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile() && e.name === "audit.jsonl") out.push(join(d, e.name));
    }
  };
  walk(dir);
  return out;
}

export function readDesktopInitSurface(input: InitSurfaceInput): InitSurfaceReading {
  const isOwn = input.isOwnServer ?? isDesktopOwn;
  const unobserved: DesktopInitSurface = { agentVersion: input.agentVersion, appVersion: input.appVersion, observed: false, servers: {} };
  const counts = { unreadable: 0 };
  const reading = (surface: DesktopInitSurface, framesSelected: number, excludedServers: number): InitSurfaceReading => ({
    surface,
    framesSelected,
    excludedServers,
    unreadableFiles: counts.unreadable,
    deltas: [],
    notes: [],
  });

  let logs: string[] = [];
  let dirPresent = true;
  try {
    readdirSync(input.dir);
    logs = findAuditLogs(input.dir, counts);
  } catch {
    dirPresent = false;
  }

  // Per server: how many selected frames list it as connected, and per tool how many of THOSE frames declare it.
  const perServer = new Map<string, { frames: number; tools: Map<string, number> }>();
  let framesSelected = 0;
  let excludedServers = 0;

  if (input.installedAtMs !== null) {
    for (const file of logs) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        counts.unreadable++;
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes('"init"')) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame === null || typeof frame !== "object") continue;
        if (frame.type !== "system" || frame.subtype !== "init") continue;
        // A shape filter, not a producer proof: the HMAC is not verifiable here, and the producer boundary
        // is the directory. It excludes frames written by anything that does not emit Desktop's audit shape.
        if (typeof frame._audit_hmac !== "string") continue;
        if (frame.claude_code_version !== input.agentVersion) continue;
        const ts = typeof frame._audit_timestamp === "string" ? Date.parse(frame._audit_timestamp) : NaN;
        if (!(ts >= input.installedAtMs)) continue;

        framesSelected++;
        const connected = new Set<string>();
        for (const s of Array.isArray(frame.mcp_servers) ? frame.mcp_servers : []) {
          const name = (s as Record<string, unknown> | null)?.name;
          const status = (s as Record<string, unknown> | null)?.status;
          if (typeof name === "string" && isOwn(name)) {
            if (status === "connected") connected.add(name);
          } else excludedServers++;
        }
        for (const name of connected) {
          const entry = perServer.get(name) ?? { frames: 0, tools: new Map<string, number>() };
          entry.frames++;
          perServer.set(name, entry);
        }
        const seen = new Set<string>();
        for (const t of Array.isArray(frame.tools) ? frame.tools : []) {
          if (typeof t !== "string") continue;
          for (const name of connected) {
            const prefix = `mcp__${name}__`;
            if (!t.startsWith(prefix)) continue;
            const local = t.slice(prefix.length);
            // Anchored on BOTH sides: `mcp__cowork__x__y` is a server named `cowork__x`, not a cowork tool.
            if (local.length === 0 || local.includes("__")) continue;
            const key = `${name}\u0000${local}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const tools = perServer.get(name)!.tools;
            tools.set(local, (tools.get(local) ?? 0) + 1);
          }
        }
      }
    }
  }

  if (framesSelected === 0) {
    const r = reading(unobserved, 0, excludedServers);
    const why = !dirPresent
      ? `no Cowork session logs found under ${DESKTOP_SESSIONS_DISPLAY}`
      : input.installedAtMs === null
        ? "the Desktop install time is unknown (app.asar unreadable)"
        : `no Cowork session has started under Desktop ${input.appVersion} / agent ${input.agentVersion} since it was installed`;
    r.notes.push(
      `WARNING: desktopInitSurface UNOBSERVED — ${why}. Recorded observed:false; a release cannot ship it. ` +
        "Start one Cowork session in Claude Desktop, then re-run sync.",
    );
    if (counts.unreadable > 0) r.notes.push(`desktopInitSurface: ${counts.unreadable} session-log file(s)/dir(s) unreadable (skipped)`);
    return r;
  }

  const servers: DesktopInitSurface["servers"] = {};
  const deltas: string[] = [];
  for (const name of [...perServer.keys()].sort()) {
    const { frames, tools } = perServer.get(name)!;
    let unverified = 0;
    const kept = [...tools.entries()].filter(([tool]) => {
      if (input.bundleHasLiteral === null) return false;
      if (input.bundleHasLiteral(tool)) return true;
      unverified++;
      return false;
    });
    if (input.bundleHasLiteral === null && tools.size > 0) {
      deltas.push(
        `desktopInitSurface: cannot verify server "${name}"'s ${tools.size} tool name(s) against the Desktop bundle (bundle unavailable) — not recorded; fix the asar extraction and re-sync`,
      );
    } else if (unverified > 0) {
      // Name withheld on purpose: a name absent from Desktop's bundle may belong to a user server that
      // shadows Desktop's server name, i.e. the operator's inventory.
      deltas.push(
        `desktopInitSurface: ${unverified} tool name(s) on server "${name}" are not a quoted literal in the Desktop bundle, so not attributable to Desktop — dropped, names withheld. Inspect that server's tools[] in a local init frame by hand`,
      );
    }
    const toolsAll = kept
      .filter(([, n]) => n === frames)
      .map(([t]) => t)
      .sort();
    const toolsSome = kept
      .filter(([, n]) => n < frames)
      .map(([t]) => t)
      .sort();
    (servers as Record<string, unknown>)[name] = { presence: frames === framesSelected ? "all" : "some", toolsAll, toolsSome };
  }

  const r = reading(
    { agentVersion: input.agentVersion, appVersion: input.appVersion, observed: true, servers },
    framesSelected,
    excludedServers,
  );
  r.deltas.push(...deltas);
  r.notes.push(
    `desktopInitSurface: read ${framesSelected} init frame(s) at agent ${input.agentVersion} since the Desktop ${input.appVersion} install; ` +
      `excluded ${excludedServers} non-Desktop server entr${excludedServers === 1 ? "y" : "ies"}` +
      (counts.unreadable ? `; ${counts.unreadable} session-log file(s)/dir(s) unreadable (skipped)` : ""),
  );
  return r;
}
