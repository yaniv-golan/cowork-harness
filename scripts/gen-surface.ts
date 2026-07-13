// Regenerates the committed structured-surface snapshot.
//
//   npm run gen:surface
//
// Writes test/fixtures/surface-baseline.json from the CURRENT repo state: schema/*.json field
// paths/enums, action.yml's inputs + outputs, and the documented COWORK_* env-var set (see
// scripts/lib/surface.ts for exactly what's covered and what's deliberately not).
//
// Run this whenever one of those surfaces changes intentionally, then review the diff — especially
// any removal or type/enum change, which pre-1.0 is still allowed to ship but must be a conscious
// decision, not silent drift. test/surface-contract.test.ts fails until the snapshot is regenerated
// to match the live surface.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeSurface } from "./lib/surface.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = join(REPO_ROOT, "test/fixtures/surface-baseline.json");

function main(): void {
  const surface = computeSurface();
  writeFileSync(BASELINE_PATH, JSON.stringify(surface, null, 2) + "\n");
  process.stdout.write("wrote test/fixtures/surface-baseline.json\n");
}

// Run only when invoked directly (so a test can import computeSurface/BASELINE_PATH without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
