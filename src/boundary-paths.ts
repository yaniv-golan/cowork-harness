import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";

/**
 * Shared boundary/path/host helpers. Several bugs came from
 * lexical path checks where realpath checks are needed, missing host normalization, or
 * incomplete domain validation. These helpers are the single source of truth so the policies
 * cannot fork across runtime staging, baseline loading, assertions, and egress code.
 *
 * Per the repo's fidelity-first principle these HARDEN inputs the real product also distrusts;
 * none of them relaxes observable Cowork behavior. (The boundary *self-test* lives in `boundary.ts`;
 * this module is the path/host primitives those and other call sites share.)
 */

/**
 * Validate a NAMED (non-absolute) baseline. A named baseline is a bare filename resolved under
 * `baselines/`; it must not contain path separators (so `../`, nested dirs, and Windows `\`
 * cannot escape the directory). Absolute paths remain the explicit out-of-tree escape hatch and
 * are NOT passed here. Returns the name unchanged when safe; throws otherwise.
 */
export function safeNamedBaseline(name: string): string {
  // Reject POSIX and Windows separators outright. `..` is only dangerous via a separator (a bare
  // file literally named ".." has no `/` and resolves to the directory itself, harmlessly), but a
  // separator is the actual escape vector, so reject any of `/`, `\`, or a NUL byte.
  if (name.includes("/") || name.includes("\\") || name.includes("\0"))
    throw new Error(
      `cowork-harness: baseline name "${name}" must be a bare filename with no path separators — ` +
        `use an absolute path for an out-of-tree baseline`,
    );
  return name;
}

/**
 * Require that `target` is contained within `root` AFTER resolving symlinks on BOTH sides. Unlike a
 * lexical `relative()` check, this catches an in-root symlink whose target points outside the root
 * (e.g. `root/sub -> /etc`), because `statSync`/`cpSync` would follow it at access time.
 *
 * BOTH paths must already exist (callers realpath them or pass paths known to exist); a non-existent
 * target throws from `realpathSync` (a caller error here, not a containment decision). Returns true
 * iff `target` equals `root` or sits under it; false otherwise.
 */
export function containedRealPath(root: string, target: string): boolean {
  const realRoot = realpathSync(resolve(root));
  const realTarget = realpathSync(resolve(target));
  if (realTarget === realRoot) return true;
  const rel = relative(realRoot, realTarget);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/**
 * Normalize a hostname: lowercase + strip a single trailing dot. Extracted (and exported) from the
 * private helper that lived in `run.ts` so the approvedDomains set, egress seed validation, and
 * `hostMatches` assertions all fold case/trailing-dot the same way and cannot diverge.
 *
 * NOT normalized here (deferred — needs binary verification before touching matching semantics):
 *   - IPv6 bracket stripping (e.g. "[::1]" → "::1"): affects URL-parsing parity with the host sandbox.
 *   - Punycode / IDNA folding: requires a unicode-aware library not currently in scope.
 *   - Wildcard subdomain semantics (e.g. "*.example.com"): structural, not cosmetic.
 */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Validate a single bare-host egress allow entry (or `*` / `*.suffix` wildcard). Extracted from the
 * inline per-pattern checks in `proxy.ts:compile()` so `compile()` and the run-side seed path share
 * ONE policy and cannot fork egress fidelity. Rejects scheme/path/port/whitespace entries (which
 * could never match a bare hostname) and — NEW hardening — empty/whitespace-only entries, which
 * `compile()` previously stored silently as an unmatchable exact "".
 *
 * Returns a classification the caller acts on:
 *   - `{ kind: "all" }`       — the unrestricted `*` entry (compile() short-circuits to allow-all).
 *   - `{ kind: "suffix" }`    — a `*.suffix` wildcard; `value` is the lowercased `.suffix`.
 *   - `{ kind: "exact" }`     — a bare host; `value` is the lowercased host.
 *
 * Throws on any invalid entry — both `compile()` and the seed path want fail-loud here. The `*`
 * short-circuit is checked BEFORE the scheme/path/port rejection so a lone `*` is preserved (the
 * wildcard ordering from the original inline checks).
 */
export type BareDomainKind = { kind: "all" } | { kind: "suffix"; value: string } | { kind: "exact"; value: string };
export function validateBareDomain(host: string): BareDomainKind {
  // Empty / whitespace-only is invalid — it can never match a real host and used to be stored as a
  // silent unmatchable exact "" (the fail-loud hardening).
  if (host.trim() === "") throw new Error(`invalid egress allow entry "${host}" — an empty/whitespace host can never match`);
  const p = host.toLowerCase();
  if (p === "*") return { kind: "all" };
  // A scheme / path / port / whitespace entry (e.g. `https://api.anthropic.com`, `api:443`) can never
  // match a bare hostname — reject it loudly rather than store a silent always-deny.
  if (p.includes("://") || p.includes("/") || p.includes(":") || /\s/.test(p))
    throw new Error(
      `invalid egress allow entry "${host}" — use a bare host (api.anthropic.com) or a wildcard (*.claude.ai), not a URL / scheme / path / port`,
    );
  if (p.startsWith("*.")) return { kind: "suffix", value: p.slice(1) }; // ".claude.ai"
  return { kind: "exact", value: p };
}
