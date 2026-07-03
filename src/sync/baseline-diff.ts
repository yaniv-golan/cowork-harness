// E7 — the recursive structural differ for baselines, replacing the one-level `diff()` in cli.ts
// (stringify-compares each top key, printing whole subtrees on any nested change). Used by both the
// standalone `diff <baseline-a> <baseline-b>` command and the refactored `sync --diff`.

export type BaselineDiffEntry =
  | { path: string; kind: "scalar"; from: unknown; to: unknown; annotation: boolean }
  | { path: string; kind: "array"; added: unknown[]; removed: unknown[]; annotation: boolean }
  | { path: string; kind: "added"; to: unknown; annotation: boolean }
  | { path: string; kind: "removed"; from: unknown; annotation: boolean };

/** A path segment is annotation-class ($comment, note, or any $-prefixed key) — still diffed (never
 *  silently dropped), but tagged so the changelog renderer can de-emphasize it rather than let comment
 *  churn read as real drift. */
function isAnnotationKey(key: string): boolean {
  return key.startsWith("$") || key === "note";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Two arrays diffed by structural (JSON) membership, order-insensitive — the fields this differ sees
 *  (allowDomains, tools, mounts) are sets/bags, not order-significant sequences. */
function diffArray(path: string, a: unknown[], b: unknown[], annotation: boolean): BaselineDiffEntry[] {
  const aKeys = a.map((v) => JSON.stringify(v));
  const bKeys = b.map((v) => JSON.stringify(v));
  const added = b.filter((_, i) => !aKeys.includes(bKeys[i]));
  const removed = a.filter((_, i) => !bKeys.includes(aKeys[i]));
  if (added.length === 0 && removed.length === 0) return [];
  return [{ path, kind: "array", added, removed, annotation }];
}

/**
 * Recursive structural diff between two baseline-shaped objects (or any nested JSON value reached
 * during that recursion). `pathAnnotation` carries whether any ancestor segment was itself
 * annotation-class, so a nested field under `$comment` (unlikely, but not assumed away) inherits the
 * tag rather than needing every leaf to re-derive it.
 */
export function diffBaselines(a: unknown, b: unknown, path = "", pathAnnotation = false): BaselineDiffEntry[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: BaselineDiffEntry[] = [];
    for (const k of keys) {
      const childPath = path ? `${path}.${k}` : k;
      const childAnnotation = pathAnnotation || isAnnotationKey(k);
      const hasA = Object.prototype.hasOwnProperty.call(a, k);
      const hasB = Object.prototype.hasOwnProperty.call(b, k);
      if (!hasA) {
        out.push({ path: childPath, kind: "added", to: b[k], annotation: childAnnotation });
      } else if (!hasB) {
        out.push({ path: childPath, kind: "removed", from: a[k], annotation: childAnnotation });
      } else {
        out.push(...diffBaselines(a[k], b[k], childPath, childAnnotation));
      }
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(path, a, b, pathAnnotation);
  // scalar (or a type mismatch, e.g. object vs string — treated as a plain value change, not a crash)
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  return [{ path, kind: "scalar", from: a, to: b, annotation: pathAnnotation }];
}

/** Maps KNOWN baseline fields to prose; an unrecognized path still renders (never silently dropped),
 *  just as a generic line. Annotation-class entries are grouped into their own de-emphasized section
 *  instead of interleaved with real drift. */
export function renderChangelog(entries: BaselineDiffEntry[]): string {
  const notable = entries.filter((e) => !e.annotation);
  const annotations = entries.filter((e) => e.annotation);
  const lines: string[] = [];

  const known: Record<string, (e: BaselineDiffEntry) => string | undefined> = {
    agentVersion: (e) => (e.kind === "scalar" ? `- staged agent bumped: \`${e.from}\` → \`${e.to}\`` : undefined),
    appVersion: (e) => (e.kind === "scalar" ? `- Desktop version bumped: \`${e.from}\` → \`${e.to}\`` : undefined),
    "network.allowDomains": (e) =>
      e.kind === "array"
        ? [
            e.added.length ? `- egress allowlist: added ${e.added.map((h) => `\`${h}\``).join(", ")}` : null,
            e.removed.length ? `- egress allowlist: removed ${e.removed.map((h) => `\`${h}\``).join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : undefined,
    requireFullVmSandbox: (e) =>
      e.kind === "scalar"
        ? `- \`requireFullVmSandbox\`: \`${e.from}\` → \`${e.to}\``
        : e.kind === "added"
          ? `- \`requireFullVmSandbox\` introduced: \`${e.to}\``
          : undefined,
    "provenance.asarFingerprint": (e) =>
      e.kind === "scalar" ? `- cowork-relevant asar regions changed (fingerprint \`${e.from}\` → \`${e.to}\`)` : undefined,
    capturedAt: (e) => (e.kind === "scalar" ? `- baseline captured: \`${e.from}\` → \`${e.to}\`` : undefined),
  };

  for (const e of notable) {
    // gate flips: provenance.gates.<name>.on|source|value|note
    const gateMatch = e.path.match(/^provenance\.gates\.([^.]+)\.(on|source|value)$/);
    if (gateMatch) {
      const [, gate, field] = gateMatch;
      if (e.kind === "scalar") lines.push(`- gate \`${gate}\`.${field}: \`${JSON.stringify(e.from)}\` → \`${JSON.stringify(e.to)}\``);
      else if (e.kind === "added") lines.push(`- gate \`${gate}\`.${field} introduced: \`${JSON.stringify(e.to)}\``);
      continue;
    }
    const renderer = known[e.path];
    const rendered = renderer?.(e);
    if (rendered) {
      lines.push(rendered);
      continue;
    }
    // field introduced in a newer baseline (older baseline predates it) reads as "introduced", not raw drift
    if (e.kind === "added") {
      lines.push(`- \`${e.path}\` introduced (field not present in the older baseline): \`${JSON.stringify(e.to)}\``);
    } else if (e.kind === "removed") {
      lines.push(`- \`${e.path}\` removed: was \`${JSON.stringify(e.from)}\``);
    } else if (e.kind === "scalar") {
      lines.push(`- \`${e.path}\`: \`${JSON.stringify(e.from)}\` → \`${JSON.stringify(e.to)}\``);
    } else {
      lines.push(
        `- \`${e.path}\`: added ${JSON.stringify(e.added)}, removed ${JSON.stringify(e.removed)}`,
      );
    }
  }

  if (annotations.length) {
    lines.push("", "<details><summary>Annotations / comments changed</summary>", "");
    for (const e of annotations) {
      lines.push(`- \`${e.path}\` (annotation)`);
    }
    lines.push("</details>");
  }

  return lines.length ? lines.join("\n") + "\n" : "No differences.\n";
}

/** Plain-line rendering for `sync --diff` / a `diff` command's `--output-format text` — one line per
 *  entry at its exact leaf path, replacing the old one-level `diff()` which printed the WHOLE subtree
 *  under any top-level key that changed (so a single gate flip three levels deep used to dump all of
 *  `provenance`). No annotation/known-field prose here — that's `renderChangelog`'s job. */
export function formatDiffLines(entries: BaselineDiffEntry[]): string[] {
  return entries.map((e) => {
    if (e.kind === "scalar") return `${e.path}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`;
    if (e.kind === "added") return `${e.path}: (absent) -> ${JSON.stringify(e.to)}`;
    if (e.kind === "removed") return `${e.path}: ${JSON.stringify(e.from)} -> (absent)`;
    return `${e.path}: +${JSON.stringify(e.added)} -${JSON.stringify(e.removed)}`;
  });
}
