// Generates JSON Schemas for the scenario & session YAML from the zod schemas,
// so any agent/editor can author valid files without reading the TS.
//
//   npm run schema        # regenerate schema/*.schema.json
//
// The committed files in schema/ are guarded by test/schema.test.ts, which calls
// buildSchemas() and fails if they drift from the zod source.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ScenarioObject } from "../src/types.js";
import { SessionConfig } from "../src/session.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(REPO_ROOT, "schema");

const TARGETS = [
  {
    file: "scenario.schema.json",
    schema: ScenarioObject,
    name: "CoworkHarnessScenario",
    description:
      "cowork-harness scenario YAML — prompt + scripted answers + assert:. See docs/scenario.md.",
  },
  {
    file: "session.schema.json",
    schema: SessionConfig,
    name: "CoworkHarnessSession",
    description:
      "cowork-harness session YAML — pre-prompt setup (model, mounts, discovery). See docs/session.md.",
  },
] as const;

/** Build { filename: pretty-printed-JSON } for every schema. Pure; no I/O. */
export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TARGETS) {
    const json = zodToJsonSchema(t.schema, {
      name: t.name,
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as Record<string, unknown>;
    json.description = t.description;
    out[t.file] = JSON.stringify(json, null, 2) + "\n";
  }
  return out;
}

function main(): void {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const schemas = buildSchemas();
  for (const [file, body] of Object.entries(schemas)) {
    writeFileSync(join(SCHEMA_DIR, file), body);
    process.stdout.write(`wrote schema/${file}\n`);
  }
}

// Run only when invoked directly (so the test can import buildSchemas without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
