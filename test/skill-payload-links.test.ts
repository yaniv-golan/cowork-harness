import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";

// C1: payload-resolution link check.
//
// The installed plugin ships ONLY the payload — .claude/skills/cowork-harness/{SKILL.md,
// references/*.md, scripts/*, evals/*}. A markdown link `](target)` whose target escapes that
// payload (../README.md, docs/foo.md, SPEC.md, ../../whatever) dangles for an installed agent,
// since none of docs/, README.md, SPEC.md ship with the plugin.
//
// Bare prose mentions ("see docs/foo.md (repo-only)") are fine — only actual markdown link
// targets `](...)` are checked. Anchor-only links (`](#foo)`) and links that stay inside the
// payload are fine too.

const REPO_ROOT = resolve(".");
const SKILL_DIR = resolve(".claude/skills/cowork-harness");

interface LinkTarget {
  file: string;
  raw: string;
}

function markdownLinkTargets(file: string): LinkTarget[] {
  const text = readFileSync(file, "utf8");
  const targets: LinkTarget[] = [];
  // Matches inline markdown links: ](target) — deliberately does NOT match bare "[text]"
  // with no parens, and does not match prose.
  const re = /\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    targets.push({ file, raw: m[1].trim() });
  }
  return targets;
}

function skillMarkdownFiles(): string[] {
  const refsDir = join(SKILL_DIR, "references");
  const refs = readdirSync(refsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(refsDir, f));
  return [join(SKILL_DIR, "SKILL.md"), ...refs];
}

/** True if `target` is a link we don't need to check for payload-escape: anchor-only,
 *  or an absolute external URL / mailto / protocol-relative link. */
function isExempt(target: string): boolean {
  if (target === "" || target.startsWith("#")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return true; // http(s):, mailto:, etc.
  return false;
}

describe("skill payload links stay inside the shipped payload (C1)", () => {
  const files = skillMarkdownFiles();
  expect(files.length).toBeGreaterThan(1); // sanity: SKILL.md + at least one reference doc

  const escapes: { file: string; raw: string; resolved: string }[] = [];

  for (const file of files) {
    for (const { raw } of markdownLinkTargets(file)) {
      if (isExempt(raw)) continue;

      // Strip a trailing #fragment before resolving the filesystem path.
      const withoutFragment = raw.split("#")[0];
      if (withoutFragment === "") continue; // e.g. "same-file.md#frag" with empty path — n/a here

      const resolved = resolve(dirname(file), withoutFragment);
      const insidePayload = resolved === SKILL_DIR || resolved.startsWith(SKILL_DIR + sep);

      // Belt-and-suspenders: also flag known repo-only targets even if path resolution
      // somehow didn't catch them (e.g. odd relative forms).
      const knownRepoOnly = /(^|\/)docs\//.test(raw) || /README(\.md)?($|#)/i.test(raw) || /SPEC\.md/.test(raw);

      if (!insidePayload || knownRepoOnly) {
        escapes.push({ file: file.replace(REPO_ROOT + sep, ""), raw, resolved: resolved.replace(REPO_ROOT + sep, "") });
      }
    }
  }

  it("no markdown link in SKILL.md or references/*.md resolves outside the payload", () => {
    expect(
      escapes,
      escapes
        .map((e) => `${e.file}: ](${e.raw}) resolves to ${e.resolved}, which is outside ${SKILL_DIR.replace(REPO_ROOT + sep, "")}`)
        .join("\n"),
    ).toEqual([]);
  });
});
