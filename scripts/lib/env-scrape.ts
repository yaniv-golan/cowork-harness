// Scrapes every COWORK_* env-var name referenced anywhere in src/, across all three shapes the
// codebase actually reads env vars in:
//   1. `process.env.COWORK_X` dot-access
//   2. a quoted literal (helper-read families like envPositiveNumber("COWORK_X"), or an env-name
//      constant assigned once and dot-accessed elsewhere)
//   3. `env.COWORK_X` — a destructured/aliased env object read
// Dot-access alone misses (2) and (3) entirely, so all three patterns are required for a complete
// scrape. Extracted from test/docs-index-sync.test.ts (its original home) so the documented-env-var
// surface can be computed once and shared by that anti-drift test and scripts/lib/surface.ts's
// structured-surface snapshot, instead of drifting as two copies.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

const ENV_SCRAPE_PATTERNS = [/process\.env\.(COWORK[A-Z0-9_]+)/g, /["'](COWORK[A-Z0-9_]+)["']/g, /\benv\.(COWORK[A-Z0-9_]+)/g];

/** Every COWORK_* env-var name read anywhere under src/, unioned across all three read shapes. */
export function scrapeCoworkEnvVars(): Set<string> {
  const srcText = tsFilesUnder(join(REPO_ROOT, "src"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const names = new Set<string>();
  for (const re of ENV_SCRAPE_PATTERNS) {
    for (const m of srcText.matchAll(re)) names.add(m[1]);
  }
  return names;
}
