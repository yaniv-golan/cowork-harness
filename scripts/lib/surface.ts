// Computes a deterministic snapshot of the harness's structured, machine-checkable public surfaces:
// the JSON Schemas under schema/*.json (property paths + enum/const values, including the exit-code
// enums), action.yml's inputs + outputs, and the documented COWORK_* env-var set.
//
// Read by scripts/gen-surface.ts (writes the committed baseline) and scripts/check-surface.ts /
// test/surface-contract.test.ts (compare the live repo against it).
//
// This is deliberately a PARTIAL surface. Not covered (stays a manual release-checklist item):
//   - the CLI command/flag surface — no machine-readable source exists; cli-structural-guard drives
//     a hand-maintained CASES list and cli-help greps pinned strings, and --help text is explicitly
//     non-contractual.
//   - per-command exit-code SEMANTICS — the exit-code *values* are schema-expressible (and ARE
//     covered, e.g. verdict.exitCode / verify-cassettes' ok/coverage shape) but their meaning isn't.
//   - the PlatformBaseline shape — Zod-only in src/types.ts, no schema/*.json emitted for it.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { scrapeCoworkEnvVars } from "./env-scrape.js";

export { scrapeCoworkEnvVars } from "./env-scrape.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_DIR = join(REPO_ROOT, "schema");

interface SchemaLeaf {
  type?: unknown;
  enum?: unknown[];
  const?: unknown;
  ref?: string;
  required?: true;
  /** additionalProperties === false at this path — narrowing this later (adding it) is breaking. */
  closed?: true;
}

/** Walk one JSON Schema node, recording a leaf at `path` for anything meaningful (type/enum/const/
 *  $ref/closed/required), then recursing into properties, array items, additionalProperties' value
 *  schema, and oneOf/anyOf/allOf branches. `$ref` targets are recorded as a pointer string, not
 *  inlined — the referenced definition is walked separately as its own `definitions.<Name>` root, so
 *  nothing is lost and there's no risk of infinite recursion on a self-referential schema. */
function walkSchemaNode(node: unknown, path: string, requiredHere: boolean, out: Map<string, SchemaLeaf>): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const n = node as Record<string, unknown>;

  const leaf: SchemaLeaf = {};
  if ("type" in n) leaf.type = n.type;
  if (Array.isArray(n.enum)) leaf.enum = n.enum;
  if ("const" in n) leaf.const = n.const;
  if (typeof n.$ref === "string") leaf.ref = n.$ref;
  if (n.additionalProperties === false) leaf.closed = true;
  if (requiredHere) leaf.required = true;
  if (Object.keys(leaf).length > 0) {
    out.set(path, { ...(out.get(path) ?? {}), ...leaf });
  }

  const requiredSet = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
  const props = n.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>).sort()) {
      walkSchemaNode((props as Record<string, unknown>)[key], `${path}.${key}`, requiredSet.has(key), out);
    }
  }
  if ("items" in n) {
    const items = n.items;
    if (Array.isArray(items)) {
      items.forEach((item, i) => walkSchemaNode(item, `${path}[${i}]`, false, out));
    } else {
      walkSchemaNode(items, `${path}[]`, false, out);
    }
  }
  if (n.additionalProperties && typeof n.additionalProperties === "object") {
    walkSchemaNode(n.additionalProperties, `${path}{}`, false, out);
  }
  for (const kind of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = n[kind];
    if (Array.isArray(branches)) {
      branches.forEach((sub, i) => walkSchemaNode(sub, `${path}<${kind}:${i}>`, false, out));
    }
  }
}

/** Property-path surface of one JSON Schema document (root paths, plus each `definitions`/`$defs`
 *  entry as its own `definitions.<Name>` root), sorted by path for a stable diff. */
export function surfaceForSchemaDoc(doc: Record<string, unknown>): Record<string, SchemaLeaf> {
  const out = new Map<string, SchemaLeaf>();
  walkSchemaNode(doc, "", false, out);
  const defs = (doc.definitions ?? doc.$defs) as Record<string, unknown> | undefined;
  if (defs && typeof defs === "object") {
    for (const name of Object.keys(defs).sort()) {
      walkSchemaNode(defs[name], `definitions.${name}`, false, out);
    }
  }
  const sorted = [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(sorted);
}

/** Every schema/*.json file, each reduced to its property-path/enum surface. */
export function computeSchemaSurface(): Record<string, Record<string, SchemaLeaf>> {
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const out: Record<string, Record<string, SchemaLeaf>> = {};
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")) as Record<string, unknown>;
    out[f] = surfaceForSchemaDoc(doc);
  }
  return out;
}

interface ActionInputSurface {
  required: boolean;
  /** `null` when the input has no `default:` key at all (distinct from an explicit empty default). */
  default: string | null;
}

interface ActionSurface {
  inputs: Record<string, ActionInputSurface>;
  outputs: string[];
}

/** action.yml's caller-facing contract: input names + required/default, and output names. Input/
 *  output `description:` prose and each output's internal `value:` step-output expression are
 *  excluded on purpose — they're not part of the caller-facing surface (rewording a description, or
 *  renaming the internal step id an output reads from, isn't a breaking change for a consumer). */
export function computeActionSurface(): ActionSurface {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, "action.yml"), "utf8")) as {
    inputs?: Record<string, { required?: boolean; default?: unknown }>;
    outputs?: Record<string, unknown>;
  };
  const inputs: Record<string, ActionInputSurface> = {};
  for (const name of Object.keys(doc.inputs ?? {}).sort()) {
    const spec = doc.inputs![name];
    inputs[name] = {
      required: spec.required === true,
      default: "default" in spec ? String(spec.default) : null,
    };
  }
  const outputs = Object.keys(doc.outputs ?? {}).sort();
  return { inputs, outputs };
}

export interface Surface {
  schemas: Record<string, Record<string, SchemaLeaf>>;
  action: ActionSurface;
  env: { coworkVars: string[] };
}

/** The full v1 structured-surface snapshot: schema/*.json field paths + enums, action.yml IO, and
 *  the documented COWORK_* env-var set. Pure and deterministic — file reads only, sorted keys, no
 *  timestamps or unsorted Set/Map iteration reaching the output. */
export function computeSurface(): Surface {
  return {
    schemas: computeSchemaSurface(),
    action: computeActionSurface(),
    env: { coworkVars: [...scrapeCoworkEnvVars()].sort() },
  };
}
