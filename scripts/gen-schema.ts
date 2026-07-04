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
import { z } from "zod";
import { ScenarioObject, Assertion, VERDICT_MODIFIER_KEYS } from "../src/types.js";
import { SessionConfig } from "../src/session.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(REPO_ROOT, "schema");
/** The bundled linter (`scenario.py`) reads this for its assertion-key list. It lives NEXT TO scenario.py
 *  (not under schema/) because schema/ is not shipped inside the plugin tree — only the skill's scripts dir
 *  is. Writer + the drift-guard test both reference this one constant. */
export const ASSERTION_KEYS_PATH = join(REPO_ROOT, ".claude/skills/cowork-harness/scripts/assertion-keys.json");

/** The authoritative key lists `scenario.py` reads — derived from the Zod schemas (the same source
 *  `assertions --list` reads). Generating them keeps the linter's unknown-key checks from drifting: `keys` is
 *  the `assert:` catalog, `topLevelKeys` the scenario top-level catalog (an earlier hand-maintained copy
 *  drifted and false-flagged the valid `requires_capabilities`). `assertions` is NOT here — it's a hard
 *  error handled by scenario.py's own special-case, so it's intentionally absent from the schema shape.
 *  (`profile` used to have a matching special-case for its now-removed alias; it has none anymore — an
 *  unrecognized `profile:` key falls through to the plain unknown-key rejection like any other typo.) */
export function buildAssertionKeys(): string {
  return (
    JSON.stringify(
      {
        $comment: "GENERATED from the Zod schemas (src/types.ts) by scripts/gen-schema.ts — do not edit; run `npm run schema`.",
        keys: Object.keys(Assertion.shape).sort(),
        // Every valid top-level scenario key, from the ScenarioObject strictObject shape (NOT the `Scenario`
        // preprocess wrapper). scenario.py keeps an embedded fallback parity-tested against this.
        topLevelKeys: Object.keys(ScenarioObject.shape).sort(),
        // The verdict-modifier subset (no-op assertions that suppress a default-fail). scenario.py keeps a
        // hardcoded copy parity-tested against this; see VERDICT_MODIFIER_KEYS in src/types.ts.
        verdictModifierKeys: [...VERDICT_MODIFIER_KEYS].sort(),
      },
      null,
      2,
    ) + "\n"
  );
}

const TARGETS = [
  {
    file: "scenario.schema.json",
    schema: ScenarioObject,
    description: "cowork-harness scenario YAML — prompt + scripted answers + assert:. See docs/scenario.md.",
  },
  {
    file: "session.schema.json",
    schema: SessionConfig,
    description: "cowork-harness session YAML — pre-prompt setup (model, mounts, discovery). See docs/session.md.",
  },
] as const;

/** zod 4's `z.toJSONSchema` lists every `.default()` field in `required` (at EVERY nesting level — the old
 *  `zod-to-json-schema` did not). For an authoring schema a defaulted field is NOT author-required, so strip
 *  defaulted keys from `required` everywhere. Do NOT swap this for `{ io: "input" }`: that drops the same
 *  `required` entries but ALSO strips `additionalProperties:false` from nested objects, silently disabling
 *  the strict-object fail-closed. */
function stripDefaultedRequired(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripDefaultedRequired);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const props = obj.properties as Record<string, { default?: unknown }> | undefined;
  if (props && Array.isArray(obj.required)) {
    obj.required = (obj.required as string[]).filter((k) => !(props[k] && "default" in props[k]));
    if ((obj.required as string[]).length === 0) delete obj.required;
  }
  for (const v of Object.values(obj)) stripDefaultedRequired(v);
}

/** Build { filename: pretty-printed-JSON } for every schema. Pure; no I/O. */
export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TARGETS) {
    const json = z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>;
    stripDefaultedRequired(json);
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
  writeFileSync(ASSERTION_KEYS_PATH, buildAssertionKeys());
  process.stdout.write(`wrote ${ASSERTION_KEYS_PATH}\n`);
}

// Run only when invoked directly (so the test can import buildSchemas without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
