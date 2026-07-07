import { existsSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";

/**
 * `computer_links_resolve` support. Extracts every `computer://`
 * link payload from a model-visible transcript and resolves it against whatever evidence the calling
 * lane (live run / verify-run / replay) actually has, WITHOUT touching `src/vm-paths.ts` (that module
 * is the production-mirroring outbound DISPLAY transform; this one is the assertion-side consumer of
 * the same link shapes, deliberately kept separate).
 *
 * Note on percent-encoding: `ctx.transcript` is the RAW model-visible record (never touched by the
 * display transform, which only runs at render surfaces — see src/run/display-translate.ts), so in
 * practice the model never emits percent-encoded segments itself. Extraction still decodes
 * defensively (a scenario fixture could legitimately contain an encoded literal), matching
 * `mapVMPathToHostPath`'s own per-segment decode discipline in vm-paths.ts.
 */

/** A `computer://` link found in a transcript, with its payload percent-decoded per `/`-segment. */
export interface ComputerLink {
  /** The link payload (everything after `computer://`), decoded. */
  raw: string;
  /** True for a payload shaped `/sessions/<any-id>/mnt/...`. AssertContext carries no sessionId, so
   *  this matches ANY session id rather than one pinned value. Anything else absolute is host-shaped. */
  vmShaped: boolean;
}

const VM_MOUNT_RE = /^\/sessions\/[^/]+\/mnt\//;

function percentDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // not percent-encoded (or malformed) — keep as given, mirrors vm-paths.ts's tolerance
  }
}

function percentDecodePath(payload: string): string {
  return payload.split("/").map(percentDecodeSegment).join("/");
}

function makeLink(payload: string): ComputerLink {
  const raw = percentDecodePath(payload);
  return { raw, vmShaped: VM_MOUNT_RE.test(raw) };
}

/** Delimiters that end a BARE `computer://...` token (mirrors vm-paths.ts's BARE_TOKEN_DELIMITERS) —
 *  whitespace also always ends a bare token. */
const BARE_TOKEN_DELIMITERS = new Set(['"', "`", "]", "\\"]);

/**
 * Scan forward from `start` for the end of a path-ish token, balancing parens (so `report (draft).pdf`
 * isn't cut at its own `)`) and optionally stopping at the first `delimiters` char (or whitespace) seen
 * at paren-depth 0. A small, extraction-only cousin of vm-paths.ts's `scanTokenEnd` — that one also
 * REWRITES text and tracks an unbalanced-open-paren fallback; this one only needs to find the end.
 */
function scanTokenEnd(text: string, start: number, delimiters: Set<string> | null): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && delimiters !== null && (delimiters.has(ch) || /\s/.test(ch))) {
      return i;
    }
  }
  return text.length;
}

// Same three-alternative scan order as vm-paths.ts's `encodeComputerUrlsForHostLoop` (backtick-quoted,
// then markdown-link-open, then bare token) — a verified-safe pattern for telling the three forms
// apart without double-counting a markdown/backtick occurrence as a bare token too.
const LINK_SCAN_RE = /(`computer:\/\/[^`]+`)|(\]\(computer:\/\/)|(computer:\/\/)/g;

/**
 * Extract every `computer://` link payload from `text`, in the three forms production/vm-paths.ts
 * recognizes: markdown-link position (`](computer://...)`), backtick-quoted, and bare tokens.
 * Backtick-quoted links count as a link form (not excluded as "inside code") — production's own
 * rewrite treats them as a link position too (vm-paths.ts `translateString`, position 2). An
 * unterminated markdown-link opener (no matching `)`) still yields a link: production's bare-token
 * pass rewrites the URL inside a malformed markdown link too (it doesn't require the `)` to close),
 * so the bare `computer://` payload is extracted the same way a genuine bare token would be — a link
 * the display would show is never silently un-extracted here.
 */
export function extractComputerLinks(text: string): ComputerLink[] {
  const out: ComputerLink[] = [];
  if (!text.includes("computer://")) return out;
  const re = new RegExp(LINK_SCAN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[0];
    const backtick = m[1];
    const mdOpen = m[2];
    const bare = m[3];
    if (backtick !== undefined) {
      out.push(makeLink(backtick.slice("`computer://".length, -1)));
      re.lastIndex = m.index + whole.length;
    } else if (mdOpen !== undefined) {
      const contentStart = m.index + whole.length;
      const end = scanTokenEnd(text, contentStart, null);
      if (text.charAt(end) === ")") {
        out.push(makeLink(text.slice(contentStart, end)));
        re.lastIndex = end + 1;
      } else {
        // Unterminated `](computer://…` — fall back to a bare-token scan from the same position (same
        // delimiter rules as the `bare` branch below), so the URL is still extracted even though the
        // markdown link itself never closes. Matches the display transform, which still rewrites this
        // URL via its bare-token pass.
        const bareEnd = scanTokenEnd(text, contentStart, BARE_TOKEN_DELIMITERS);
        out.push(makeLink(text.slice(contentStart, bareEnd)));
        re.lastIndex = bareEnd;
      }
    } else if (bare !== undefined) {
      const contentStart = m.index + whole.length;
      const end = scanTokenEnd(text, contentStart, BARE_TOKEN_DELIMITERS);
      out.push(makeLink(text.slice(contentStart, end)));
      re.lastIndex = end;
    }
  }
  return out;
}

/** Resolve `rel` under `root`, rejecting an absolute path or a `..` escape — same containment rule
 *  `assert.ts` applies to author-supplied `file_exists` paths, reused here so a dangling link can't be
 *  misreported as "resolved" by walking out of the work root. Returns the absolute path, or null. */
function safeJoin(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const base = resolve(root);
  const abs = resolve(base, rel);
  const back = relative(base, abs);
  if (back === ".." || back.startsWith(".." + sep) || isAbsolute(back)) return null;
  return abs;
}

/** Our own harness always nests the outputs/uploads mounts under a literal `mnt/outputs`/`mnt/uploads`
 *  path segment (see `vmPathContextFromPlan` in src/run/display-translate.ts:
 *  `<outDir>/work/session/mnt/{outputs,uploads}`), regardless of the (record-time-only,
 *  machine-specific) run dir prefix. That structural marker lets replay normalize a host-shaped
 *  outputs/uploads link with no recorded host path at all. */
const STRUCTURAL_MOUNT_NAMES = ["outputs", "uploads"];

function normalizeByStructuralMarker(hostPath: string): string | null {
  for (const name of STRUCTURAL_MOUNT_NAMES) {
    const marker = `/mnt/${name}/`;
    const idx = hostPath.lastIndexOf(marker);
    if (idx !== -1) return `${name}/${hostPath.slice(idx + marker.length)}`;
    if (hostPath.endsWith(`/mnt/${name}`)) return name;
  }
  return null;
}

/** Replay-only: normalize a host-shaped link to a mount-relative path (for a manifest lookup),
 *  reconstructing over the recorded data. Two strategies, in order: (1) the outputs/uploads
 *  structural marker above; (2) `folderPrefixes` — a recorded connected-folder HOST path prefix ->
 *  its resolved mount name (built at record-replay time from the cassette's recorded
 *  `session.folders` + `userVisibleRoots`; see cassette.ts's `buildFolderPrefixMap`). Returns null when
 *  neither strategy matches — an un-normalizable host-shaped link on replay (replay cannot probe the
 *  live filesystem to fall back on). */
export function normalizeHostShapedForReplay(hostPath: string, folderPrefixes: Map<string, string> | undefined): string | null {
  const structural = normalizeByStructuralMarker(hostPath);
  if (structural !== null) return structural;
  if (folderPrefixes) {
    // Longest prefix wins: Map iteration is insertion order, so nested connected folders (e.g.
    // /Users/me/project declared after /Users/me) would otherwise remap to the wrong — shorter — mount.
    // The `startsWith(prefix + "/")` boundary check below means the length sort introduces no new matches.
    const byLongest = [...folderPrefixes].sort((a, b) => b[0].length - a[0].length);
    for (const [prefix, mountName] of byLongest) {
      if (hostPath === prefix) return mountName;
      if (hostPath.startsWith(prefix + "/")) return mountName + hostPath.slice(prefix.length);
    }
  }
  return null;
}

/** Resolution context threaded onto `AssertContext.linkResolution` — see `src/assert.ts`. */
export interface LinkResolutionContext {
  /** "live" = execute.ts (real run) or verify-run (re-checking a kept run dir on the SAME machine) —
   *  both check a host-shaped link's path DIRECTLY on the filesystem (these two lanes are grouped
   *  together). "replay" = a cassette re-drive with no live filesystem access. */
  mode: "live" | "replay";
  /** Replay-only: see `normalizeHostShapedForReplay`. Absent/empty on live (host-shaped links are
   *  checked directly there, no normalization needed) and on any cassette whose session folders
   *  couldn't be recovered from disk. */
  folderPrefixes?: Map<string, string>;
  /** Replay-only (cassette Finding 25): true when a v9+ cassette REQUIRES a persisted folder-prefix map
   *  (see cassette.ts's `buildFolderPrefixMap`) but does not carry one. Distinguishes "we have no
   *  evidence to check this host-shaped link at all" from the ordinary "checked a real map, nothing
   *  matched" case — a v9+ cassette never falls back to reconstructing `folderPrefixes` from the
   *  CURRENT session file (that reconstruction is exactly what a stale/rotated session could silently
   *  get wrong), so an absent map here must fail evidence-unavailable, not report a plain no-match. */
  folderPrefixesRequiredButAbsent?: boolean;
  /** Live-only: the run's real host roots (outputs/uploads host dirs + each connected folder's host
   *  source). A host-shaped link must live INSIDE one of them — a link to an existing but
   *  out-of-workspace host path (e.g. computer:///etc/hosts) is a dangling link, not a delivered
   *  artifact. When absent/empty (e.g. verify-run against an older result.json, or a scenario with no
   *  filesystem evidence to derive a root from), a host-shaped link resolves as evidence-unavailable
   *  rather than falling back to a direct, unconstrained existence check — an arbitrary host path
   *  that happens to exist is never silently treated as "resolved". */
  hostRoots?: string[];
}

export interface LinkCheckOutcome {
  resolved: boolean;
  /** Human-readable description of WHAT was checked, for the failure message (per-tier honesty). */
  checkedDescription: string;
}

/**
 * Resolve one extracted link against `workRoot` (the live lane's collected work tree, same root
 * `file_exists`/`user_visible_artifact` use — see AssertContext.workRoot; or the replay lane's
 * materialized manifest temp dir, which holds a REAL file per manifest entry — see
 * `materializeManifest`) and `resolution`.
 *
 * VM-shaped links always resolve the same way in both modes: strip the `/sessions/<id>/mnt/` prefix
 * and existsSync the result under `workRoot`. Host-shaped links diverge: `"live"` requires the link's
 * path to fall inside a recorded `hostRoots` entry, then existsSync's it DIRECTLY (bypassing any
 * resolver — a hostloop link already names a real host path, not a VM path a resolver would
 * translate); `"replay"` cannot probe that host's filesystem, so it normalizes the host path to a
 * mount-relative path first (`normalizeHostShapedForReplay`), then does the same `workRoot`-relative
 * existsSync as a VM-shaped link.
 */
export function resolveComputerLink(link: ComputerLink, workRoot: string, resolution: LinkResolutionContext): LinkCheckOutcome {
  if (link.vmShaped) {
    // The work tree covers every tier: container/microvm collect there, and hostloop's post-run
    // folder snapshot (snapshotHostLoopWorkspace, which runs BEFORE assertion evaluation) copies each
    // connected folder's real host contents under the same root — so a VM-shaped folder link emitted
    // at hostloop resolves here too.
    const rel = link.raw.replace(VM_MOUNT_RE, "");
    const abs = safeJoin(workRoot, rel);
    if (!abs) return { resolved: false, checkedDescription: `unsafe path (escapes the work root): ${rel}` };
    return { resolved: existsSync(abs), checkedDescription: `work tree: ${abs}` };
  }
  if (resolution.mode === "live") {
    if (!resolution.hostRoots?.length) {
      // No recorded roots to constrain against — do NOT fall back to a raw existsSync of an
      // arbitrary host path (that would let e.g. computer:///etc/hosts "resolve" just because the
      // host file happens to exist). Evidence-unavailable, not a silent pass.
      return {
        resolved: false,
        checkedDescription: `host path — no recorded workspace roots to verify against, can't confirm this is a delivered artifact: ${link.raw}`,
      };
    }
    const base = resolve(link.raw);
    const inside = resolution.hostRoots.some((root) => {
      const r = resolve(root);
      return base === r || base.startsWith(r + sep);
    });
    if (!inside)
      return {
        resolved: false,
        checkedDescription: `host path outside the run's workspace roots (not a delivered artifact): ${link.raw}`,
      };
    return { resolved: existsSync(link.raw), checkedDescription: `host path (direct): ${link.raw}` };
  }
  const rel = normalizeHostShapedForReplay(link.raw, resolution.folderPrefixes);
  if (rel === null) {
    if (resolution.folderPrefixesRequiredButAbsent)
      return {
        resolved: false,
        checkedDescription:
          `evidence unavailable: this cassette has no persisted folder-mount map — a v9+ cassette must carry one, and replay ` +
          `refuses to re-derive it from the current session (which may have drifted since record)`,
      };
    return {
      resolved: false,
      checkedDescription: `no recorded folder/outputs/uploads prefix matched this host path (replay cannot probe the live filesystem)`,
    };
  }
  const abs = safeJoin(workRoot, rel);
  if (!abs) return { resolved: false, checkedDescription: `unsafe normalized path (escapes the work root): ${rel}` };
  return { resolved: existsSync(abs), checkedDescription: `replay manifest (normalized from host path): ${rel}` };
}
