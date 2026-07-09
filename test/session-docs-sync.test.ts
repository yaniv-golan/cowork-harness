import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Anti-drift guard: docs/session.md's "Full schema" YAML block + "Field reference" tables hand-document
// every top-level field in schema/session.schema.json — the session analogue of
// test/scenario-docs-sync.test.ts (which guards docs/scenario.md against src/types.ts's Assertion zod
// shape). A field added to the session schema without a matching doc entry would silently leave the
// user-facing session reference stale. Catch that here instead of relying on a human noticing during
// review.
//
// Two decisions, spelled out because the two anti-drift tests LOOK alike but the doc shapes differ:
//  1. Scope is TOP-LEVEL schema properties only (Object.keys(schema.properties)). Nested fields (e.g.
//     `plugins.config_dir`, `folders[].mode`, `debug.max_thinking_tokens`) are NOT enumerated or checked
//     individually — that's a deeper, noisier guard than this file's contract calls for. We deliberately
//     skip schema-only meta keys by only ever reading `properties` (never `$schema`/`$id`/`title`/
//     `description`/`additionalProperties`, which aren't properties at all).
//  2. Unlike docs/scenario.md (a markdown TABLE, one row per assertion key — anchored on
//     `^\|\s*\`key\``), docs/session.md documents fields two ways: (a) as a `key:` line inside the
//     "## Full schema" fenced YAML block (e.g. `model: claude-opus-4-8`), and (b) as a backticked
//     `` `key` `` mention in the "## Field reference" prose tables (e.g. `| \`model\` | ... |`). Some
//     fields (like `debug`, `web_fetch`, `staleness`) are documented richly in the YAML fence /
//     surrounding prose but don't get their own field-reference table row — so anchoring ONLY on the
//     table-row shape (like the scenario test does) would false-fail here. The anchor below accepts
//     EITHER form, matching docs/session.md's actual shape instead of copying scenario's table anchor.
describe("docs/session.md ↔ schema/session.schema.json top-level field sync", () => {
  const doc = readFileSync(resolve("docs/session.md"), "utf8");
  const schema = JSON.parse(readFileSync(resolve("schema/session.schema.json"), "utf8")) as {
    properties: Record<string, unknown>;
  };
  const topLevelKeys = Object.keys(schema.properties);

  it("parsed a sane top-level key set (guards against a schema read that silently resolved empty)", () => {
    expect(topLevelKeys.length).toBeGreaterThan(15);
    expect(topLevelKeys).toContain("model");
    expect(topLevelKeys).toContain("folders");
  });

  // A field counts as documented if EITHER:
  //   (a) it appears as a YAML mapping key at the START of a line inside the "Full schema" fence, e.g.
  //       `model:` or `debug:` — real session YAML only ever sets these fields un-indented at the top
  //       level, so `^key:` (no required leading whitespace) is specific to a top-level key and won't
  //       match a nested key like `config_dir:` (which is indented under `plugins:`).
  //   (b) it appears as a backticked `` `key` `` mention anywhere in the doc (covers the "Field
  //       reference" table rows, which use `| \`model\` | ... |`, plus any prose mention).
  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const documented = (key: string): boolean => {
    const yamlKeyLine = new RegExp("^" + escapeRegExp(key) + ":", "m");
    const backtickMention = new RegExp("`" + escapeRegExp(key) + "(?:[.\\[`])");
    return yamlKeyLine.test(doc) || backtickMention.test(doc);
  };

  it("the anchor matches a real top-level YAML key / backtick mention but not an unrelated nested key", () => {
    // known-documented top-level key: has an un-indented `model:` line in the Full schema fence, and a
    // `` `model` `` row in the Field reference table.
    expect(documented("model")).toBe(true);
    // sanity: a nested-only key name should NOT satisfy the top-level YAML-key branch (it's indented,
    // so `^config_dir:` must not match) — it's only reachable via the backtick-mention branch, which is
    // exactly why this key is excluded from topLevelKeys (it isn't a schema.properties key at all).
    expect(new RegExp("^config_dir:", "m").test(doc)).toBe(false);
  });

  it("every top-level session schema field is documented", () => {
    const missing = topLevelKeys.filter((k) => !documented(k));
    expect(missing, `docs/session.md is missing documentation for: ${missing.join(", ")}`).toEqual([]);
  });
});
