import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { CASSETTE_VERSION } from "../src/run/cassette";

// Anti-drift tripwire for the SKILL's bundled docs (B3 remainder, from the founder-skills adoption
// analysis R3). Scoped to the surfaces that actually rotted and the KINDS that rot — machine-readable
// field lists the docs claim to cover — NOT a naive "new CLI flag must appear in a doc" gate (which
// would have caught neither motivating example: `--allow-file` WAS documented outside the skill, and
// `effectiveFidelity` isn't a flag). Extends the test/cassette-docs-sync.test.ts pattern:
//   1. schema/scenario.schema.json's assertion-key catalog ↔ references/scenario-schema.md
//   2. the CURRENT cassette schema's top-level fields ↔ SKILL.md ∪ references/*.md
// Source of truth is always the schema; the docs must mention every key as a backtick-quoted token.
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
  const doc = readFileSync(join(SKILL_DIR, "references/scenario-schema.md"), "utf8");

  it("parsed a sane key set (guards against a schema-shape change silently emptying this test)", () => {
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain("transcript_contains");
    expect(keys).toContain("questions_count_max");
  });

  it("every assertion key in the scenario schema appears backtick-quoted in references/scenario-schema.md", () => {
    const missing = keys.filter((k) => !documents(doc, k));
    expect(
      missing,
      `references/scenario-schema.md is missing: ${missing.join(", ")} — its assertion catalog claims to be complete`,
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
