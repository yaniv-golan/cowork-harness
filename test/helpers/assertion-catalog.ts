import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// The skill's assertion catalog is a hub (assertion-catalog.md: conventions + the verdict-signal table) and
// per-family files (assertion-catalog-<family>.md) holding the per-key rows, split so each stays under the
// skill-lint reference read cap. Enumerated from the directory, so a further split is covered without
// editing every docs-sync test that asks "is this key documented in the catalog?".
const REFERENCES_DIR = ".claude/skills/cowork-harness/references";
export const CATALOG_HUB = `${REFERENCES_DIR}/assertion-catalog.md`;
export const CATALOG_FILES: readonly string[] = readdirSync(resolve(REFERENCES_DIR))
  .filter((f) => /^assertion-catalog(-[a-z0-9-]+)?\.md$/.test(f))
  .sort()
  .map((f) => `${REFERENCES_DIR}/${f}`);

/** Every catalog file's text, joined: where a test looks for a key's row. */
export function catalogText(): string {
  return CATALOG_FILES.map((f) => readFileSync(resolve(f), "utf8")).join("\n");
}
