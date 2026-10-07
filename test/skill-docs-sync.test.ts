import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { CASSETTE_VERSION } from "../src/run/cassette";
import { catalogText } from "./helpers/assertion-catalog.js";

// Anti-drift tripwire for the SKILL's bundled docs.
// Scoped to the surfaces that actually rotted and the KINDS that rot — machine-readable
// field lists the docs claim to cover — NOT a naive "new CLI flag must appear in a doc" gate (which
// would have caught neither motivating example: `--allow-file` WAS documented outside the skill, and
// `effectiveFidelity` isn't a flag). Extends the test/cassette-docs-sync.test.ts pattern:
//   1. schema/scenario.schema.json's assertion-key catalog ↔ references/assertion-catalog*.md (hub + per-family files)
//   2. the CURRENT cassette schema's top-level fields ↔ SKILL.md ∪ references/*.md
//   3. the CURRENT cassette schema's NESTED fields ↔ SKILL.md ∪ references/*.md (see below)
// Source of truth is always the schema; the docs must mention every key as a backtick-quoted token.
// (3) is still a field list, not the declined flag gate: `environment.harnessVersion` shipped in 1.11.0
// documented nowhere a consumer reads, and (2) could not see it because (2) checks TOP-LEVEL keys only.
const SKILL_DIR = resolve(".claude/skills/cowork-harness");

/** A key counts as documented when it appears as a backtick-quoted token — either bare (`key`) or
 *  in the catalog's `key: <value>` row style. Plain-prose mentions don't count (too easy to match
 *  accidentally, and the docs' own convention is backticks). */
const documents = (doc: string, key: string): boolean => doc.includes(`\`${key}\``) || doc.includes(`\`${key}:`);

function skillDocs(): string {
  const refsDir = join(SKILL_DIR, "references");
  const refs = readdirSync(refsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(refsDir, f), "utf8"));
  return [readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"), ...refs].join("\n");
}

describe("skill docs ↔ schema assertion-key catalog", () => {
  const schema = JSON.parse(readFileSync(resolve("schema/scenario.schema.json"), "utf8")) as {
    properties: { assert: { items: { properties: Record<string, unknown> } } };
  };
  const keys = Object.keys(schema.properties.assert.items.properties);
  const doc = catalogText();

  it("parsed a sane key set (guards against a schema-shape change silently emptying this test)", () => {
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain("transcript_contains");
    expect(keys).toContain("questions_count_max");
  });

  it("every assertion key in the scenario schema appears backtick-quoted in the assertion catalog (references/assertion-catalog*.md)", () => {
    const missing = keys.filter((k) => !documents(doc, k));
    expect(
      missing,
      `references/assertion-catalog*.md is missing: ${missing.join(", ")} — its assertion catalog claims to be complete`,
    ).toEqual([]);
  });
});

describe("skill docs ↔ current cassette schema top-level fields", () => {
  const schemaPath = resolve(`schema/cassette.v${CASSETTE_VERSION}.json`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { properties: Record<string, unknown> };
  const fields = Object.keys(schema.properties);
  const docs = skillDocs();

  it("parsed a sane field set", () => {
    expect(fields.length).toBeGreaterThan(8);
    expect(fields).toContain("effectiveFidelity"); // the motivating rot: shipped consumer-visible, undocumented in the skill until flagged
    expect(fields).toContain("controlOut");
  });

  it(`every top-level field of cassette.v${CASSETTE_VERSION}.json appears backtick-quoted somewhere in SKILL.md ∪ references/`, () => {
    const missing = fields.filter((k) => !documents(docs, k));
    expect(
      missing,
      `skill docs never mention: ${missing.join(", ")} — a consumer reading the skill cannot learn these cassette fields exist ` +
        `(the cassette-anatomy table in references/task-recipes.md is the intended home)`,
    ).toEqual([]);
  });
});

// Nested cassette fields. The motivating miss: `environment.harnessVersion` (1.11.0) passed the
// surface-contract gate — which enumerates it and fails on ANY change, so it was consciously reviewed —
// and still shipped undocumented, because nothing couples a field's EXISTENCE to its EXPLANATION. That is
// this block's job: doc-coupling, not enumeration.
//
// Source is test/fixtures/surface-baseline.json rather than a hand-rolled schema walk: it already carries
// the full-depth, array-item-inclusive path list, and it is regenerated and reviewed on every schema
// change (`npm run gen:surface`). One source, already trusted.
describe("skill docs ↔ current cassette schema NESTED fields", () => {
  // `fingerprint.*` is a STATED SCOPE EXCLUSION, not debt: those are provenance hashes (contentSig,
  // fileSigs, agentScope, …) that the skill docs never claimed to cover — they are internal staleness
  // inputs, surfaced to users only as a staleness CLASS, which is documented. Excluding the family in one
  // line is honest; listing its 8 members as individual baseline entries would pretend they are a backlog.
  const EXCLUDED_PREFIX = "fingerprint.";

  // Known-undocumented at the time this guard landed. It is a RATCHET: the list may shrink, never grow.
  // A new nested field must be documented or consciously added here with a reason.
  const BASELINE = new Set([
    "artifacts.encoding",
    "authoring.channel",
    "folderPrefixMap.from",
    "folderPrefixMap.mount",
    "timeline.line",
    "timeline.seq",
    "timeline.ts",
    "timelineHeader.v",
  ]);

  const surface = JSON.parse(readFileSync(resolve("test/fixtures/surface-baseline.json"), "utf8")) as {
    schemas: Record<string, Record<string, unknown>>;
  };
  const nested = [
    ...new Set(
      Object.keys(surface.schemas[`cassette.v${CASSETTE_VERSION}.json`] ?? {})
        .map((path) => path.replace(/\[\]/g, "").split(".").filter(Boolean))
        .filter((parts) => parts.length >= 2)
        .map((parts) => `${parts[0]}.${parts[1]}`),
    ),
  ].sort();
  const docs = skillDocs();

  it("parsed a sane nested-field set (a schema-shape change must not silently empty this test)", () => {
    expect(nested.length).toBeGreaterThan(20);
    expect(nested).toContain("environment.harnessVersion"); // the motivating miss
  });

  it("every nested cassette field is documented, or explicitly baselined", () => {
    const undocumented = nested
      .filter((f) => !f.startsWith(EXCLUDED_PREFIX))
      .filter((f) => !documents(docs, f.split(".")[1]))
      .filter((f) => !BASELINE.has(f));
    expect(
      undocumented,
      `new nested cassette field(s) documented nowhere a consumer reads: ${undocumented.join(", ")} — ` +
        `add them to the cassette-anatomy table in references/task-recipes.md, or (if genuinely internal) ` +
        `to this test's BASELINE with a reason. A version bump is not documentation.`,
    ).toEqual([]);
  });

  it("the baseline only shrinks — a stale entry means the ratchet is not being tightened", () => {
    const stale = [...BASELINE].filter((f) => documents(docs, f.split(".")[1]));
    expect(stale, `now documented, so remove from BASELINE: ${stale.join(", ")}`).toEqual([]);
  });
});
