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
import { SERVED_HOOK_EVENTS, KNOWN_HOOK_EVENTS, LIVE_VERIFIED_PLUGIN_HOOK_EVENTS } from "../src/agent/session.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(REPO_ROOT, "schema");
/** The bundled linter (`scenario.py`) reads this for its assertion-key list. It lives NEXT TO scenario.py
 *  (not under schema/) because schema/ is not shipped inside the plugin tree — only the skill's scripts dir
 *  is. Writer + the drift-guard test both reference this one constant. */
export const ASSERTION_KEYS_PATH = join(REPO_ROOT, ".claude/skills/cowork-harness/scripts/assertion-keys.json");

/** Recursively collect every `enum` array in a JSON Schema node, keyed by a stable dotted field
 *  identifier built from object PROPERTY names only — an array's `items` contributes no path segment
 *  (there is exactly one item shape per array, so `assert.result`, not `assert.items.result`). Walking
 *  the compiled JSON Schema (rather than the Zod internals) keeps this immune to zod's wrapper
 *  representation for optional/default/refine — z.toJSONSchema has already resolved all of that. */
function collectEnums(node: unknown, path: string, out: Record<string, string[]>): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const en = obj.enum;
  if (Array.isArray(en) && en.every((v) => typeof v === "string")) {
    if (path) {
      // Array `items` contribute no path segment, so two enums at different depths CAN collide on one
      // dotted key (a future `assert[].something.result` would shadow `assert.result`). Silently keeping
      // the last one would leave the linter validating one field against another's values while the
      // key-set test still passed — a wrong rule that looks right. Fail the generator instead.
      if (out[path])
        throw new Error(`enum path collision in the scenario schema: "${path}" — give one of them a distinct key before regenerating`);
      out[path] = en as string[];
    }
    return; // an enum leaf has nothing further worth walking
  }
  const props = obj.properties as Record<string, unknown> | undefined;
  if (props) {
    for (const [k, v] of Object.entries(props)) collectEnums(v, path ? `${path}.${k}` : k, out);
  }
  if (obj.items !== undefined) collectEnums(obj.items, path, out); // array items: same path, no segment
}

/** Every enum-valued field in the scenario schema, keyed by a stable field id: a top-level key
 *  (`fidelity`), an `answers:` item key (`answers.decide`), an `assert:` item key (`assert.result`), or
 *  a nested assert-item object key (`assert.path_denied.source`). scenario.py's `enum-value-invalid`
 *  rule validates authored values against this — walking the schema (rather than hand-copying four
 *  top-level fields, which is the bug this map fixes) is what makes the nested `answers[]`/`assert[]`
 *  enums covered too.
 *
 *  `execution` legitimately includes `cloud-describe` here — it IS a valid schema value. The runtime
 *  REJECTS it at load anyway, as reserved (src/run/execute.ts — no cloud runner exists yet), so it must
 *  never be offered back to an author as the FIX for some other invalid `execution:` value. That
 *  carve-out belongs in scenario.py, where fix text gets composed — this map stays a faithful,
 *  mechanical mirror of what the schema actually accepts. */
function buildEnumMap(): Record<string, string[]> {
  const json = z.toJSONSchema(ScenarioObject, { target: "draft-7" }) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  collectEnums(json, "", out);
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

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
        // Hook events. `servedHookEvents` is what THIS harness installs on `initialize`;
        // `knownHookEvents` is every event the agent binary understands. The linter needs both to tell
        // "a real event we don't serve" (a fidelity gap worth warning about) from "a typo" (an error).
        // Generated for the same reason as the key lists above: a hand-copied served-set would stop
        // warning about the very event it was later extended to cover. See SERVED_HOOK_EVENTS in
        // src/agent/session.ts for why the served set is narrower than production's install.
        servedHookEvents: [...SERVED_HOOK_EVENTS].sort(),
        knownHookEvents: [...KNOWN_HOOK_EVENTS].sort(),
        // The subset of knownHookEvents a plugin hook has actually been OBSERVED to fire for here.
        // Separate from knownHookEvents on purpose: "the agent's validator accepts this name" and "a run
        // reaches this trigger" are different claims, and the linter's wording depends on which one it
        // can make. See LIVE_VERIFIED_PLUGIN_HOOK_EVENTS in src/agent/session.ts.
        liveVerifiedHookEvents: [...LIVE_VERIFIED_PLUGIN_HOOK_EVENTS].sort(),
        // Every enum-valued scenario field, top-level AND nested (answers[]/assert[] item keys), keyed
        // by a stable dotted field id. See collectEnums/buildEnumMap above. scenario.py's
        // `enum-value-invalid` rule keeps an embedded fallback parity-tested against this.
        enums: buildEnumMap(),
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
    // STRUCTURAL-ONLY label (plus the mirrored `not`). Without it the schema reads as the authority on
    // what runs, and it is not: a `{}` answer rule validates here and is refused by the loader (exit 2),
    // and `lane: remote` with a delivery-shaped assertion validates here and is refused at load too.
    // `cowork-harness lint` runs the real loader as well as the authoring checks, so it catches both; the
    // text still names `record --dry-run`, which additionally applies the pre-spend refusals lint does not
    // model. (Direct `python3 scenario.py lint` does not run the loader — the CLI is what to point at.)
    description:
      "cowork-harness scenario YAML — prompt + scripted answers + assert:. STRUCTURAL validation only, " +
      "plus the mutually-exclusive delete-assertion rules mirrored as a top-level `not`. The loader and the " +
      "runner enforce cross-field rules this schema cannot express, so a file that validates here can still " +
      "be refused: an `answers:` entry with no matcher is rejected at load, and delivery-shaped assertion " +
      "keys are rejected on `lane: remote`. Run `cowork-harness lint <file>` — it runs the real loader as " +
      "well as the authoring checks — and `cowork-harness record <file> --dry-run` for the pre-spend " +
      "refusals on top. See docs/scenario.md.",
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

/** Mirror `Scenario`'s cross-key rules (src/types.ts `superRefine`) into the published JSON Schema.
 *
 *  A zod refinement has NO JSON Schema representation, so `z.toJSONSchema` silently drops it. Without
 *  this, the loader would reject a scenario that the published schema accepts — and an editor or a CI
 *  step validating against `schema/scenario.schema.json` would green a file that cannot actually run.
 *  Any rule added to that `superRefine` must be added here too; `test/schema.test.ts` validates the
 *  emitted schema with a real validator so a forgotten mirror fails loudly rather than drifting. */
function addScenarioCrossKeyRules(json: Record<string, unknown>): void {
  // `assert` is an ARRAY, and the two keys may live in different entries, so the rule is expressed over
  // the array with `contains` rather than over a single item: reject when SOME entry carries
  // `no_delete_in_outputs` and SOME entry carries `allow_outputs_delete` (one entry carrying both
  // satisfies each `contains`, so that case is covered too).
  // `type: "array"` is required alongside `contains` for ajv STRICT mode (strictTypes) — without it the
  // schema compiles under `strict:false` but throws for a strict consumer. test/schema-ajv.test.ts pins it.
  const someEntryHas = (key: string) => ({
    type: "object",
    required: ["assert"],
    // ajv strict also wants every `required` name declared in `properties` (strictRequired), hence the
    // `{ [key]: {} }` stub — the presence of the key is the whole condition, its value is irrelevant here.
    properties: { assert: { type: "array", contains: { type: "object", required: [key], properties: { [key]: {} } } } },
  });
  // Second rule, same contradiction reached through the per-mount key: waiving `outputs` via
  // `allow_delete_in` while also asserting no delete touched it. Needs a value-aware `contains` (the
  // waiver is an ARRAY of mount names), unlike the presence-only checks above.
  const someEntryWaivesOutputs = {
    type: "object",
    required: ["assert"],
    properties: {
      assert: {
        type: "array",
        contains: {
          type: "object",
          required: ["allow_delete_in"],
          properties: { allow_delete_in: { type: "array", contains: { const: "outputs" } } },
        },
      },
    },
  };
  json.not = {
    anyOf: [
      { allOf: [someEntryHas("no_delete_in_outputs"), someEntryHas("allow_outputs_delete")] },
      { allOf: [someEntryHas("no_delete_in_outputs"), someEntryWaivesOutputs] },
    ],
  };
}

/** Build { filename: pretty-printed-JSON } for every schema. Pure; no I/O. */
export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TARGETS) {
    const json = z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>;
    stripDefaultedRequired(json);
    if (t.file === "scenario.schema.json") addScenarioCrossKeyRules(json);
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
