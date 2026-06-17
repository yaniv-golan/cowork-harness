/**
 * SEAM A — staging-source validation primitives.
 *
 * The harness's cardinal rule is fail-loud: a declared session source that cannot be honored must
 * raise, never silently no-op (a silent skip manufactures a false-green run). That discipline was
 * originally implemented for *mounts* only; these primitives centralize the path-segment and charset
 * rules so every declared source (uploads, folders, skills, local/remote plugins, marketplace
 * metadata) is validated through the same place and the fail-loud path is the only path.
 */

import { existsSync, statSync } from "node:fs";

/** A concrete mount the runtime should create (path relative to the mnt cwd). Mirrors `Mount` in session.ts. */
export interface ResolvedMount {
  hostPath: string;
  mountPath: string;
  mode: "r" | "rw" | "rwd";
}

export interface ResolveDeclaredSourceOptions {
  /** COWORK_HARNESS_SOFT_MISSING is set: a missing source is warn-and-skip, not a hard failure. */
  softMissing: boolean;
  /**
   * Whether the MISSING-source case is reconciled by a later batch check rather than here.
   *
   *  - `true` (folders / local_plugins / remote_plugins): a missing source is NOT decided here — the
   *    Mount is returned regardless so it joins the mount list and the post-loop aggregated
   *    "mount source(s) not found" check (softMissing-aware) owns the missing decision. The resolver
   *    only kind-checks a source that EXISTS and validates the mount-path segments.
   *  - `false` (skills): the source is staged immediately (copied now, not via the mount list), so the
   *    missing decision is made HERE — throw (loud) by default, or `null` (skip) under softMissing.
   */
  deferMissing: boolean;
  /** Human label for the source kind, used verbatim in the not-found / wrong-kind messages. */
  what: string;
}

/**
 * The single choke point every declared session source resolves through (SEAM A). Given a host path, a
 * mount path, a mode, and a `kind`, it validates the source's existence + kind and returns a validated
 * `ResolvedMount` — or `null` when a declared-but-absent source is being reconciled here (the immediate
 * softMissing-skip case).
 *
 * Behavior contract (preserves exactly the prior inline per-site logic):
 *  - WRONG-KIND existing source → throw (a file where a dir is required, or vice versa). This is
 *    malformed, not missing, so it fails loud regardless of softMissing.
 *  - MISSING source, `deferMissing: true` → return the Mount anyway; the post-loop batch check decides
 *    (loud aggregated error by default, warn-and-exclude under softMissing).
 *  - MISSING source, `deferMissing: false` → softMissing ? `null` (skip) : throw the not-found error.
 *  - the mount-path leaf segment(s) are validated by the CALLER (it owns the per-site segment rule, e.g.
 *    `safePathSegment(basename(src), ...)`), so this resolver takes an already-built mountPath.
 */
export function resolveDeclaredSource(
  hostPath: string,
  mountPath: string,
  mode: ResolvedMount["mode"],
  kind: "file" | "dir",
  opts: ResolveDeclaredSourceOptions,
): ResolvedMount | null {
  const present = existsSync(hostPath);
  if (!present) {
    if (opts.deferMissing) return { hostPath, mountPath, mode }; // post-loop batch check owns the decision
    if (opts.softMissing) return null; // immediate-copy caller: warn-and-skip is the caller's job
    throw new Error(`${opts.what} not found: ${hostPath}. Fix the path, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`);
  }
  // Present → kind-check now (the only place a wrong-kind source can be caught before staging).
  if (kind === "file") requireFile(hostPath, opts.what);
  else requireDir(hostPath, opts.what);
  return { hostPath, mountPath, mode };
}

/**
 * A single safe path segment: not empty, not "." / "..", no separators. For ids interpolated into a
 * fixed parent (`.projects/<id>`, `uploads/<id>`, `.local-plugins/cache/<id>`) so a crafted or
 * default id cannot escape it. NOTE: `basename("..")` is `".."` (it does NOT collapse), so a default
 * id derived from `basename(src)` must pass through here too, not just an explicit user-supplied id.
 */
export function safePathSegment(s: string, what: string): string {
  // Reject separators/NUL/empty/dot-dirs AND ":" + control chars: a ":" breaks a Docker `-v src:dst:ro`
  // overlay and control chars are never valid in a path component (both Docker-hostile / unsafe).
  if (!s || s === "." || s === ".." || /[/\\:\x00-\x1f]/.test(s))
    throw new Error(`unsafe ${what} "${s}" — must be a single path segment (no "/", "\\", ":", control chars, "..", or empty)`);
  return s;
}

/** Require a declared source PATH to be an existing regular file (mirrors the upload `isFile` guard). */
export function requireFile(path: string, what: string): string {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`${what} must be a file, not a directory: ${path}`);
  return path;
}

/** Require a declared source PATH to be an existing directory (plugins/folders/skills model directories). */
export function requireDir(path: string, what: string): string {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`${what} must be a directory, not a file: ${path}`);
  return path;
}

/**
 * Reject a path that could escape its parent (traversal / absolute / NUL) while allowing LEGITIMATE
 * nesting (e.g. a scoped plugin name "@scope/pkg") — never a ".." / "." segment.
 */
export function noTraversal(s: string, what: string): string {
  // Also reject EMPTY interior/trailing components (`foo//bar`, `foo/`) — ambiguous, never a valid source.
  if (
    !s ||
    s.includes("\0") ||
    s.startsWith("/") ||
    s.startsWith("\\") ||
    s.split(/[/\\]/).some((seg) => seg === ".." || seg === "." || seg === "")
  )
    throw new Error(`unsafe ${what} "${s}" — must not be empty, absolute, or contain "." / ".." / empty path segments`);
  return s;
}

/**
 * noTraversal PLUS a Docker-safe charset. Untrusted marketplace metadata (marketplace name / plugin
 * name / version) is interpolated into a Docker `-v src:dst:ro` overlay arg; a ":" or a control char
 * would break the colon-delimited overlay (and traversal would escape the cache layout). "+" is
 * permitted for SemVer build metadata (e.g. "1.2.3+build.5") — it is `-v`-safe; only ":" and control
 * chars break the overlay.
 */
export function safeMountSegment(s: string, what: string): string {
  noTraversal(s, what);
  if (!/^[A-Za-z0-9._@/+-]+$/.test(s))
    throw new Error(
      `unsafe ${what} "${s}" — only [A-Za-z0-9._@/+-] are allowed (no ":", spaces, or control characters; they break the Docker -v overlay)`,
    );
  return s;
}
