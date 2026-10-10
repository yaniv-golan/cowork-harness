// The staleness-class enum and the manifest `truncationReason` values are covered surfaces that consumers read
// from prose: the CI recipe's class table (which classes fail a bare replay / --fail-on-skill-drift) and the
// manifest field descriptions. Pinned here against the published schemas, so a new class or reason cannot ship
// undocumented where a consumer decides how to gate on it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(p), "utf8");
const runResult = JSON.parse(read("schema/run-result.json"));
const cassette = JSON.parse(read("schema/cassette.v16.json"));
const CLASSES: string[] = runResult.properties.staleness.items.properties.class.enum;
const REASONS: string[] = cassette.properties.artifacts.items.properties.truncationReason.enum;

describe("staleness classes ↔ docs", () => {
  it("parsed the enum (an empty set would pass every check below)", () => {
    expect(CLASSES).toContain("unverifiable-fixture");
    expect(CLASSES.length).toBeGreaterThan(10);
  });
  it("the CI recipe's class table has a row for every class", () => {
    const doc = read(".claude/skills/cowork-harness/references/ci-recipe.md");
    const rows = new Set([...doc.matchAll(/^\| `([a-z-]+)`/gm)].map((m) => m[1]));
    for (const c of CLASSES) {
      const listed = rows.has(c) || [...doc.matchAll(/^\| `([a-z-]+)` \/ `([a-z-]+)`/gm)].some((m) => m[1] === c || m[2] === c);
      expect(listed, `ci-recipe.md class table has no row for \`${c}\``).toBe(true);
    }
  });
  it("docs/cassette.md and SPEC §11 name every class", () => {
    for (const f of ["docs/cassette.md", "SPEC.md"]) {
      const doc = read(f);
      for (const c of CLASSES)
        expect(doc.includes(`\`${c}\``) || doc.includes(`|${c}|`) || doc.includes(`|${c}"`), `${f} does not name ${c}`).toBe(true);
    }
  });
});

describe("truncationReason values ↔ docs", () => {
  it("parsed the enum", () => {
    expect(REASONS).toContain("fixture");
  });
  it("task-recipes.md and docs/cassette.md list every value", () => {
    for (const f of [".claude/skills/cowork-harness/references/task-recipes.md", "docs/cassette.md"]) {
      const doc = read(f);
      for (const r of REASONS) expect(doc.includes(`"${r}"`), `${f} does not list truncationReason "${r}"`).toBe(true);
    }
  });
});
