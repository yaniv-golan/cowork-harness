/**
 * SEAM A — staging-source validation primitives.
 *
 * The harness's cardinal rule is fail-loud: a declared session source that cannot be honored must
 * raise, never silently no-op (a silent skip manufactures a false-green run). That discipline was
 * originally implemented for *mounts* only; these primitives centralize the path-segment and charset
 * rules so every declared source (uploads, folders, skills, local/remote plugins, marketplace
 * metadata) is validated through the same place and the fail-loud path is the only path.
 */

/**
 * A single safe path segment: not empty, not "." / "..", no separators. For ids interpolated into a
 * fixed parent (`.projects/<id>`, `uploads/<id>`, `.local-plugins/cache/<id>`) so a crafted or
 * default id cannot escape it. NOTE: `basename("..")` is `".."` (it does NOT collapse), so a default
 * id derived from `basename(src)` must pass through here too, not just an explicit user-supplied id.
 */
export function safePathSegment(s: string, what: string): string {
  if (!s || s === "." || s === ".." || /[/\\\0]/.test(s))
    throw new Error(`unsafe ${what} "${s}" — must be a single path segment (no "/", "\\", "..", or empty)`);
  return s;
}

/**
 * Reject a path that could escape its parent (traversal / absolute / NUL) while allowing LEGITIMATE
 * nesting (e.g. a scoped plugin name "@scope/pkg") — never a ".." / "." segment.
 */
export function noTraversal(s: string, what: string): string {
  if (!s || s.includes("\0") || s.startsWith("/") || s.startsWith("\\") || s.split(/[/\\]/).some((seg) => seg === ".." || seg === "."))
    throw new Error(`unsafe ${what} "${s}" — must not be empty, absolute, or contain "." / ".." path segments`);
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
