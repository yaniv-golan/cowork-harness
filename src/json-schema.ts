// `artifact_json.schema`: validate a JSON value against a JSON Schema (draft 2020-12) with ajv.
//
// Hermetic by construction. No `loadSchema` (nothing is fetched), no shared registry (a fresh ajv per compile, and
// `$id` refused, so one schema can never be resolved from another scenario or cassette), no format
// validators (`format` is refused rather than silently ignored), and a keyword walk that refuses everything ajv would
// either resolve outside the schema, crash on, or accept without validating anything.
import { createRequire } from "node:module";
import { scrub } from "./secrets.js";

/** The only `$schema` accepted: the dialect the validator implements. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Errors reported per failing value, and the longest one shown. */
const MAX_ERRORS = 5;
const MAX_ERROR_CHARS = 240;

// Keywords whose value is a map of NAMES to subschemas: recurse into the values, never treat the keys as keywords.
const NAMED_SUBSCHEMAS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
// Keywords whose value is an array of subschemas.
const SUBSCHEMA_ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
// Keywords whose value is one subschema.
const SUBSCHEMA_ONE = new Set([
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
]);
// Keywords whose value is DATA: never walked (a `format` or `$ref` inside an enum value is not a keyword).
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);
// ajv overflows its stack compiling these (even with a local `#` fragment), so they are refused by name.
const DYNAMIC = new Set(["$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]);
// Annotation-only in 2020-12: they validate nothing, and an author would assume they do.
const ANNOTATION_ONLY = new Set(["contentSchema", "contentMediaType", "contentEncoding"]);

// Keywords that describe, never constrain: a root made only of these (and of `$defs`) checks nothing.
const NON_VALIDATING = new Set([
  "title",
  "description",
  "$comment",
  "$schema",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$defs",
  "definitions",
  "$vocabulary",
]);
/** Deeper than this is refused before ajv sees it: ajv's compile recurses per level. */
const MAX_DEPTH = 64;
const escapePointer = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

/** A keyword the walk refuses, with where it is (a JSON pointer) — or undefined. `path` holds the objects on the
 *  way down: a YAML alias can make a schema contain itself, and walking it would never end. */
function walkProblem(node: unknown, at: string, path: object[] = []): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  if (path.includes(node))
    return `the schema contains itself at ${at} (a YAML alias loop): use \`$ref\` to a \`$defs\` entry for a recursive shape`;
  if (path.length >= MAX_DEPTH) return `the schema is deeper than ${MAX_DEPTH} levels at ${at}`;
  const down = [...path, node];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = `${at}/${escapePointer(k)}`;
    if (DATA_KEYWORDS.has(k)) continue;
    // ajv's own refusal covers every REACHABLE position; this one also covers a `$defs` entry nothing references.
    if (k === "format")
      return `\`format\` (${JSON.stringify(v)}) at ${at} is not supported (no format is validated, so it would check nothing): drop it, or use \`pattern\``;
    if (k === "$id")
      return `\`$id\` at ${at} is not supported: a schema here is self-contained (use local \`$defs\` and \`#/$defs/…\` refs)`;
    if (k === "nullable") return `\`nullable\` at ${at} is not JSON Schema (it is OpenAPI's): use \`type: [<type>, "null"]\``;
    if (k === "$schema" && v !== SCHEMA_DIALECT && v !== `${SCHEMA_DIALECT}#`)
      return `\`$schema\` at ${at} must be ${SCHEMA_DIALECT} (draft 2020-12, the only dialect validated), or be left out`;
    if (k === "$ref" && !(typeof v === "string" && v.startsWith("#")))
      return `\`$ref\` ${JSON.stringify(v)} at ${at} is not a local reference: only \`#…\` refs into this schema are resolved (nothing is fetched)`;
    if (DYNAMIC.has(k)) return `\`${k}\` at ${at} is not supported (use \`$ref\` to a local \`#/$defs/…\`)`;
    if (ANNOTATION_ONLY.has(k)) return `\`${k}\` at ${at} is not supported: it is an annotation in draft 2020-12 and validates nothing`;
    if (NAMED_SUBSCHEMAS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        const p = walkProblem(sub, `${here}/${escapePointer(name)}`, down);
        if (p) return p;
      }
    } else if (k === "dependencies" && v && typeof v === "object" && !Array.isArray(v)) {
      // draft-07 shape: a name maps to a subschema (an object) or a list of names (data)
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        const p = walkProblem(sub, `${here}/${escapePointer(name)}`, down);
        if (p) return p;
      }
    } else if (SUBSCHEMA_ARRAYS.has(k) && Array.isArray(v)) {
      for (const [i, sub] of v.entries()) {
        const p = walkProblem(sub, `${here}/${i}`, down);
        if (p) return p;
      }
    } else if (SUBSCHEMA_ONE.has(k)) {
      const p = walkProblem(v, here, down);
      if (p) return p;
    }
  }
  return undefined;
}

// ajv is pinned to an exact version: a frozen cassette's schema is re-checked under these rules when it is read, so a
// bump that tightens strict mode could refuse committed cassettes. Treat an ajv bump as cassette-affecting.
type Validate = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string; keyword: string; params: Record<string, unknown> }> | null;
};

// Loaded on first use: the import costs tens of milliseconds, and most commands never see a `schema:`.
type AjvCtor = new (opts: object) => { compile(schema: object): Validate };
let Ajv: AjvCtor | undefined;
function ajv() {
  if (!Ajv) {
    const m = createRequire(import.meta.url)("ajv/dist/2020.js") as { default?: AjvCtor } & AjvCtor;
    Ajv = m.default ?? m;
  }
  return new Ajv({
    allErrors: true,
    // Unknown keywords and unknown formats throw (a typo is a load error, not a constraint silently dropped), and so
    // does `required`/`properties` with no `type`: on a non-object document those pass vacuously.
    strictSchema: true,
    strictNumbers: true,
    strictTypes: true,
    // These reject ordinary schemas without guarding a verdict.
    strictRequired: false,
    strictTuples: false,
    // `type: [string, number]`: a union still names its types, so the missing-type guard above keeps its point.
    allowUnionTypes: true,
    logger: false,
  });
}

/** ajv's compile message, reworded where ajv's own wording names an option the author never set. */
function compileMessage(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  const fmt = /unknown format "([^"]*)" ignored in schema at path "([^"]*)"/.exec(m);
  if (fmt)
    return `\`format\` ("${fmt[1]}") at ${fmt[2]} is not supported (no format is validated, so it would check nothing): drop it, or use \`pattern\``;
  const types = /missing type "([^"]*)" for keyword "([^"]*)" at "([^"]*)"/.exec(m);
  if (types) {
    const article = /^[aeiou]/.test(types[1]!) ? "an" : "a";
    return `\`${types[2]}\` at ${types[3]} applies only to ${article} ${types[1]}, and passes on anything else: add \`type: ${types[1]}\` (or the intended type) at ${types[3]}`;
  }
  if (/data\/items must be object,boolean/.test(m))
    return "`items` takes one schema in draft 2020-12 (the list form is draft-07): use `prefixItems` for a tuple";
  return m.replace(/^strict mode: /, "");
}

const compiled = new Map<string, Validate | { error: string }>();
function compile(schema: object): Validate | { error: string } {
  const key = JSON.stringify(schema);
  let v = compiled.get(key);
  if (v === undefined) {
    try {
      v = ajv().compile(schema);
    } catch (e) {
      v = { error: compileMessage(e) };
    }
    compiled.set(key, v);
  }
  return v;
}

/** Why `schema` cannot be used, or undefined. The load-time check (types.ts), the schema-file step, and evaluate()
 *  for a hand-built context all ask this one function. */
export function schemaProblem(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return "the schema must be a JSON object";
  if (Object.keys(schema).length === 0) return "an empty schema matches anything, so it checks nothing";
  // Root-level only: a subschema of `true` or `{}` (a property allowed with any value) is ordinary.
  if (Object.keys(schema).every((k) => NON_VALIDATING.has(k)))
    return `the schema's root has no validating keyword (only ${Object.keys(schema).join(", ")}), so it checks nothing: add one, e.g. \`type\`, or \`$ref: "#/$defs/<name>"\``;
  // Never throws: a load-time check that throws escapes the schema parse as an internal error.
  try {
    const walk = walkProblem(schema, "#");
    if (walk) return walk;
    const v = compile(schema);
    return "error" in v ? v.error : undefined;
  } catch (e) {
    return `the schema cannot be checked: ${String((e as Error)?.message ?? e)}`;
  }
}

/** Validate `value` against an already-checked `schema`. The errors are scrubbed before they are cut, so a secret
 *  straddling the cut cannot survive it; an enum's allowed values are never echoed (a 1,000-value enum would put
 *  them all in every report). */
export function validateAgainstSchema(
  schema: object,
  value: unknown,
  secrets: string[] = [],
): { ok: true } | { ok: false; errors: string[]; more: number } | { ok: false; problem: string } {
  const problem = schemaProblem(schema);
  if (problem) return { ok: false, problem };
  const v = compile(schema) as Validate;
  if (v(value)) return { ok: true };
  const all = v.errors ?? [];
  const errors = all.slice(0, MAX_ERRORS).map((e) => {
    const params = Object.entries(e.params ?? {})
      .filter(([k]) => k !== "allowedValues" && k !== "allowedValue")
      .map(([k, p]) => `${k}: ${JSON.stringify(p)}`)
      .join(", ");
    const text = `${e.instancePath || "(root)"} ${e.message ?? e.keyword}${params ? ` (${params})` : ""}`;
    const clean = secrets.length ? scrub(text, secrets) : text;
    return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS - 1)}…` : clean;
  });
  return { ok: false, errors, more: Math.max(0, all.length - MAX_ERRORS) };
}
