/**
 * VM-path <-> host-path resolution and the `computer://`/`file://` text transform that goes with
 * it. This mirrors the link-translation subsystem in real Claude Desktop: the agent's own context
 * only ever sees VM paths (`/sessions/<id>/mnt/...`); a separate outbound transform rewrites those
 * into host paths for anything a human reads (rendered chat text, clickable links). The module's
 * shape mirrors the production implementation, verified against the Desktop app's bundle.
 *
 * This file is the transform in isolation — nothing in the harness calls it yet. Wiring it into
 * the renderer/execute path is a later phase.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Everything `mapVMPathToHostPath` needs to resolve one session's VM mount namespace. */
export interface VmPathContext {
  /** The VM process/session id; VM paths only resolve under `/sessions/<sessionId>/`. */
  sessionId: string;
  /** Host directory backing `mnt/outputs/...`. */
  outputsHostDir?: string;
  /** Host directory backing `mnt/uploads/...`. */
  uploadsHostDir?: string;
  /** Mount name (as it appears under `mnt/<name>/...`) -> real host source directory. */
  folders: Map<string, string>;
  /**
   * Resolves `mnt/.host-home/<sub>` to a host path (dormant feature). Called with
   * `sub` exactly as it appears after `.host-home/`, decoded per the `decodeSegments` option. A bare
   * `mnt/.host-home` (empty sub) is unmappable and never reaches the resolver, matching the
   * production resolver's own non-empty-sub guard.
   */
  hostHomeResolver?: (sub: string) => string;
  /** Host directory backing `mnt/.auto-memory/...` (dormant feature). */
  autoMemoryHostDir?: string;
}

export interface MapVMPathOpts {
  /** Set to `false` to skip `decodeURIComponent` on the mount-name/sub-path segments (default: decode). */
  decodeSegments?: boolean;
}

const AUTO_MEMORY_MOUNT_NAME = ".auto-memory";
const HOST_HOME_MOUNT_NAME = ".host-home";

/** A path segment of `".."`, `"."`, or `""` (the last catches doubled/trailing slashes). */
function isUnsafeSegment(segment: string): boolean {
  return segment === ".." || segment === "." || segment === "";
}

/** True if any `/`- or `\`-delimited segment of `path` is unsafe. Empty `path` is not unsafe. */
function hasUnsafeSegment(path: string): boolean {
  if (!path) return false;
  return path.split(/[/\\]/).some(isUnsafeSegment);
}

/**
 * Resolve a VM path to its host equivalent. Only paths under `/sessions/<ctx.sessionId>/mnt/...`
 * ever resolve — everything else (including the session's scratchpad/cwd, which has no host
 * identity) returns `null`. Traversal segments anywhere in the path are rejected, both before and
 * after per-segment decoding (so a percent-encoded `..` cannot slip through).
 */
export function mapVMPathToHostPath(vmPath: string, ctx: VmPathContext, opts?: MapVMPathOpts): string | null {
  const sessionPrefix = `/sessions/${ctx.sessionId}/`;
  if (!vmPath.startsWith(sessionPrefix)) return null;
  const rest = vmPath.slice(sessionPrefix.length);
  if (hasUnsafeSegment(rest)) return null;
  if (!rest.startsWith("mnt/")) return null;

  const afterMnt = rest.slice(4);
  const slashIdx = afterMnt.indexOf("/");
  const rawName = slashIdx === -1 ? afterMnt : afterMnt.slice(0, slashIdx);
  const rawSub = slashIdx === -1 ? "" : afterMnt.slice(slashIdx + 1);

  let mountName: string;
  let subPath: string;
  if (opts?.decodeSegments === false) {
    mountName = rawName;
    subPath = rawSub;
  } else {
    try {
      mountName = decodeURIComponent(rawName);
    } catch {
      mountName = rawName;
    }
    try {
      subPath = decodeURIComponent(rawSub);
    } catch {
      subPath = rawSub;
    }
  }
  if (hasUnsafeSegment(mountName) || hasUnsafeSegment(subPath)) return null;

  if (mountName === "outputs") return ctx.outputsHostDir ? join(ctx.outputsHostDir, subPath) : null;
  if (mountName === "uploads") return ctx.uploadsHostDir ? join(ctx.uploadsHostDir, subPath) : null;
  if (mountName === HOST_HOME_MOUNT_NAME) return subPath && ctx.hostHomeResolver ? ctx.hostHomeResolver(subPath) : null;
  if (mountName === AUTO_MEMORY_MOUNT_NAME) return ctx.autoMemoryHostDir ? join(ctx.autoMemoryHostDir, subPath) : null;

  const hostDir = ctx.folders.get(mountName);
  return hostDir ? join(hostDir, subPath) : null;
}

/**
 * True for a `/sessions/<sessionId>/...` path that is NOT under `mnt/` — i.e. the session's
 * scratchpad/cwd, which (unlike anything under `mnt/`) has no host identity to map to.
 */
export function isScratchpadVMPath(path: string, sessionId: string): boolean {
  const sessionPrefix = `/sessions/${sessionId}/`;
  return path.startsWith(sessionPrefix) && !path.startsWith(`${sessionPrefix}mnt/`);
}

// --- percent-encoding helpers -----------------------------------------------------------------

/** `encodeURIComponent`, plus escaping `(`/`)` (which it otherwise leaves untouched). */
function percentEncodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Percent-encode a host path one `/`-delimited segment at a time (so `/` itself is preserved). */
function percentEncodePath(path: string): string {
  return path.split("/").map(percentEncodeSegment).join("/");
}

/** Decode a (possibly already percent-encoded) segment, then re-encode it. Used for the
 *  host-loop `computer://` payload normalization, where the model may emit either form. */
function normalizeEncodeSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // not percent-encoded (or malformed) — encode the segment as given
  }
  return percentEncodeSegment(decoded);
}

/** Decode-then-re-encode a whole `/`-delimited path, one segment at a time (see
 *  `normalizeEncodeSegment`). Exported for `src/run/display-translate.ts`'s `linkifyForTerminal`,
 *  which needs the SAME normalization when building a `file://` URI from a `computer://` payload
 *  that may already be percent-encoded — a second raw `encodeURIComponent` pass there would turn an
 *  already-encoded `%20` into `%2520`. */
export function normalizeEncodePath(path: string): string {
  return path.split("/").map(normalizeEncodeSegment).join("/");
}

// --- token scanning ----------------------------------------------------------------------------

/**
 * Scan forward from `start` for the end of a path-ish token. Parens are balanced (so
 * `report (draft).pdf` isn't truncated at its inner `)`); when `delimiters` is given, scanning
 * also stops at the first delimiter character (or whitespace) seen at paren-depth 0. Returns the
 * index one past the last token character (i.e. where a caller should slice up to, exclusive).
 */
function scanTokenEnd(text: string, start: number, delimiters: Set<string> | null): number {
  let depth = 0;
  let lastOpenParen = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "(") {
      if (depth === 0) lastOpenParen = i;
      depth++;
    } else if (ch === ")") {
      if (depth === 0) return i;
      depth--;
      if (depth === 0) lastOpenParen = -1;
    } else if (depth === 0 && delimiters !== null && (delimiters.has(ch) || /\s/.test(ch))) {
      return i;
    }
  }
  return depth > 0 ? lastOpenParen : text.length;
}

/**
 * Find every occurrence of `token`, scan each to its end via `scanTokenEnd`, and hand the captured
 * content to `resolve`. When `resolve` returns `null` the match is left verbatim (token + captured
 * text + closer); otherwise `emitPrefix + resolved + closer` is written. `emitPrefix` lets the
 * emitted text differ from the search token (the markdown-link search token bakes in the VM mount
 * prefix so it only matches VM-rooted links; only `"](computer://"` needs to be re-emitted).
 * `requireClosingParen` additionally requires the scan to land on `)`, or the match is treated as
 * unterminated and left verbatim (search resumes right after the token instead of at the scan end).
 */
function replaceTokens(
  text: string,
  token: string,
  emitPrefix: string,
  delimiters: Set<string> | null,
  requireClosingParen: boolean,
  resolve: (captured: string) => string | null,
): string {
  let out = "";
  let cursor = 0;
  let matchAt = text.indexOf(token, cursor);
  while (matchAt !== -1) {
    out += text.slice(cursor, matchAt);
    const contentStart = matchAt + token.length;
    const end = scanTokenEnd(text, contentStart, delimiters);
    if (requireClosingParen && text.charAt(end) !== ")") {
      out += token;
      cursor = contentStart;
    } else {
      const closer = requireClosingParen ? ")" : "";
      const captured = text.slice(contentStart, end);
      const resolved = resolve(captured);
      out += resolved === null ? token + captured + closer : emitPrefix + resolved + closer;
      cursor = end + closer.length;
    }
    matchAt = text.indexOf(token, cursor);
  }
  out += text.slice(cursor);
  return out;
}

const BARE_TOKEN_DELIMITERS = new Set(['"', "`", "]", "\\"]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `file://` URI -> host `file://` URI, VM-side only (paths starting with `/`, e.g. not UNC). */
function translateFileUri(uri: string, ctx: VmPathContext): string {
  if (!uri.startsWith("file://")) return uri;
  const path = uri.slice("file://".length);
  if (!path.startsWith("/")) return uri;
  const mapped = mapVMPathToHostPath(path, ctx);
  return mapped === null ? uri : pathToFileURL(mapped).href;
}

/**
 * Rewrite every VM-path-shaped thing in one string to its host equivalent, in order:
 *   1. `file://` URIs.
 *   2. Markdown-link position, `](computer://<vmPath>)` -> `](computer://<hostPath>)`, percent-
 *      encoded per path segment.
 *   3. Backtick-quoted, `` `computer://<vmPath>` `` -> host path, NOT percent-encoded.
 *   4. Bare `computer://<vmPath>` tokens (ending at whitespace or a `"`/`` ` ``/`]`/`\` delimiter),
 *      percent-encoded per path segment (same as markdown-link position).
 *   5. Bare VM paths in prose (no scheme, no markdown wrapper) — rewritten unencoded.
 * A path `mapVMPathToHostPath` can't resolve is left exactly as it was written (verbatim), at
 * every one of the five positions above. `mountPrefix` is `/sessions/<sessionId>/mnt/`.
 */
function translateString(text: string, mountPrefix: string, ctx: VmPathContext): string {
  if (!text.includes(mountPrefix)) return text;

  if (text.includes("file://")) {
    if (text.startsWith("file://") && !/\s/.test(text)) {
      return translateFileUri(text, ctx);
    }
    text = text.replace(/file:\/\/\/[^\s)"'`\]\\#?]+/g, (m) => translateFileUri(m, ctx));
    if (!text.includes(mountPrefix)) return text;
  }

  const escapedPrefix = escapeRegExp(mountPrefix);

  // Fast path: the whole string IS a single bare VM path (no markdown/backtick wrapper, and the
  // last path segment doesn't look like it trails off into further prose).
  if (text.startsWith(mountPrefix) && !text.includes("\n")) {
    const lastSegment = text.split("/").pop() ?? "";
    if (!/\.\w+\s/.test(lastSegment)) {
      const mapped = mapVMPathToHostPath(text, ctx);
      if (mapped) return mapped;
    }
  }

  // 1. Markdown-link position.
  text = replaceTokens(text, `](computer://${mountPrefix}`, "](computer://", null, true, (sub) => {
    const mapped = mapVMPathToHostPath(mountPrefix + sub, ctx);
    return mapped ? percentEncodePath(mapped) : null;
  });

  // 2. Backtick-quoted (unencoded).
  text = text.replace(new RegExp("`computer://(" + escapedPrefix + "[^`]+)`", "g"), (_m, vmPath: string) => {
    const mapped = mapVMPathToHostPath(vmPath, ctx);
    return mapped ? `\`computer://${mapped}\`` : `\`computer://${vmPath}\``;
  });

  // 3. Bare `computer://` tokens.
  text = replaceTokens(text, `computer://${mountPrefix}`, "computer://", BARE_TOKEN_DELIMITERS, false, (sub) => {
    const mapped = mapVMPathToHostPath(mountPrefix + sub, ctx);
    return mapped ? percentEncodePath(mapped) : null;
  });

  // 4. Bare VM paths in prose — not preceded by an alphanumeric (so this doesn't fire mid-identifier).
  text = text.replace(
    new RegExp(`(?<![a-zA-Z0-9])(${escapedPrefix}[^\\s)"\`\\]\\\\]+)`, "g"),
    (_m, vmPath: string) => mapVMPathToHostPath(vmPath, ctx) ?? vmPath,
  );

  return text;
}

/**
 * Host-loop-mode pre-pass: in host-loop the model already speaks host paths, so there is no VM
 * path to translate — instead, `computer://` URL payloads just need normalizing percent-encoding.
 * Backtick-quoted `computer://` links pass through unencoded (matching the VM-mode transform's
 * backtick position); markdown-link and bare-token positions are both percent-encoded per segment.
 */
export function encodeComputerUrlsForHostLoop(text: string): string {
  if (!text.includes("computer://")) return text;
  const re = /(`computer:\/\/[^`]+`)|(\]\(computer:\/\/)|(computer:\/\/)/g;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[0];
    const backtickToken = m[1];
    const markdownOpen = m[2];
    const bareToken = m[3];
    out += text.slice(cursor, m.index);
    if (backtickToken !== undefined) {
      out += backtickToken;
      cursor = m.index + whole.length;
    } else if (markdownOpen !== undefined) {
      const contentStart = m.index + whole.length;
      const end = scanTokenEnd(text, contentStart, null);
      if (text.charAt(end) === ")") {
        const captured = text.slice(contentStart, end);
        out += markdownOpen + normalizeEncodePath(captured) + ")";
        cursor = end + 1;
      } else {
        out += markdownOpen;
        cursor = contentStart;
      }
    } else if (bareToken !== undefined) {
      const contentStart = m.index + whole.length;
      const end = scanTokenEnd(text, contentStart, BARE_TOKEN_DELIMITERS);
      const captured = text.slice(contentStart, end);
      out += bareToken + normalizeEncodePath(captured);
      cursor = end;
    } else {
      out += whole;
      cursor = m.index + whole.length;
    }
    re.lastIndex = cursor;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Deep-walk `value` (string / array / plain object, recursively) rewriting every VM path found in
 * a string leaf, exactly like `translateString` above. `{ type: "base64", data: string }` objects
 * are skipped whole (their `data` is never a path). Returns `value` itself (same reference) when
 * nothing changed anywhere in the tree, copy-on-write otherwise, so callers can cheaply tell
 * whether anything was rewritten.
 *
 * `hostLoopMode` applies `encodeComputerUrlsForHostLoop` to each string BEFORE the VM->host
 * transform runs; in that mode there's normally no VM-prefixed text left for the latter to touch,
 * so it's a no-op, but both passes always run for a plain string leaf so a string still containing
 * VM paths (unusual in host-loop, but not impossible) gets a correct result either way.
 */
export function deepTranslateVMPaths<T>(value: T, ctx: VmPathContext, hostLoopMode: boolean): T {
  const mountPrefix = `/sessions/${ctx.sessionId}/mnt/`;
  return walk(value, mountPrefix, ctx, hostLoopMode) as T;
}

function walk(value: unknown, mountPrefix: string, ctx: VmPathContext, hostLoopMode: boolean): unknown {
  if (typeof value === "string") {
    const pre = hostLoopMode ? encodeComputerUrlsForHostLoop(value) : value;
    return translateString(pre, mountPrefix, ctx);
  }
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const mapped = walk(value[i], mountPrefix, ctx, hostLoopMode);
      if (mapped !== value[i]) {
        if (!out) out = value.slice();
        out[i] = mapped;
      }
    }
    return out ?? value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "base64" && typeof obj.data === "string") return value;
    let out: Record<string, unknown> | undefined;
    for (const [key, v] of Object.entries(obj)) {
      const mapped = walk(v, mountPrefix, ctx, hostLoopMode);
      if (mapped !== v) {
        if (!out) out = { ...obj };
        out[key] = mapped;
      }
    }
    return out ?? value;
  }
  return value;
}
