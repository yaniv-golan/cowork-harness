// An agent authoring a scenario copies an assertion's field shape from the docs. A row that shows a list-typed field
// as a bare name (`artifact_text: {artifact, contains?}`) reads as "a string goes here", the agent writes
// `contains: "# Status Report"`, and the loader refuses it. So every field-shape signature in the companion skill's
// references and in docs/scenario.md renders a list-typed field as a list (`contains?: [..]`), and a field that takes
// a string OR a list shows both (`tool: <glob> | [..]`).
//
// The list-typed fields are read from schema/scenario.schema.json, which test/schema.test.ts keeps identical to the
// zod schema in src/types.ts, so a field that becomes a list is covered here without editing this file.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hostPathTokens } from "../src/run/host-path-tokens.js";

const ROOT = join(import.meta.dirname, "..");
const REFS = ".claude/skills/cowork-harness/references";
const FILES = [
  ...readdirSync(join(ROOT, REFS))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `${REFS}/${f}`),
  ".claude/skills/cowork-harness/SKILL.md",
  "docs/scenario.md",
];

type Shape = "list" | "str|list";
type Node = { type?: string | string[]; anyOf?: Node[]; oneOf?: Node[]; properties?: Record<string, Node> };
const forms = (n: Node): Node[] => [n, ...(n.anyOf ?? []), ...(n.oneOf ?? [])];
const shapeOf = (n: Node): Shape | undefined => {
  const types = new Set(forms(n).flatMap((f) => (f.type === undefined ? [] : Array.isArray(f.type) ? f.type : [f.type])));
  if (!types.has("array")) return undefined;
  return types.size === 1 ? "list" : "str|list";
};

const schema = JSON.parse(readFileSync(join(ROOT, "schema/scenario.schema.json"), "utf8")) as {
  properties: { assert: { items: { properties: Record<string, Node> } } };
};
const KEYS = schema.properties.assert.items.properties;
/** key → field → shape, for every object-form field that takes a list; "" is the key's own value. */
const LIST_FIELDS = new Map<string, Map<string, Shape>>();
for (const [key, node] of Object.entries(KEYS)) {
  const fields = new Map<string, Shape>();
  const own = shapeOf(node);
  if (own) fields.set("", own);
  for (const f of forms(node))
    for (const [name, sub] of Object.entries(f.properties ?? {})) {
      const s = shapeOf(sub);
      if (s) fields.set(name, s);
    }
  if (fields.size) LIST_FIELDS.set(key, fields);
}

/** Split a signature's inside on top-level commas (not inside [..], {..} or <..>). */
function topLevelParts(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("[{<(".includes(ch)) depth++;
    if ("]}>)".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Every field-shape signature in `text`: a code span `key: {field, field?, …}` whose fields are placeholders. */
function findings(file: string, text: string): string[] {
  const out: string[] = [];
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/`(\w+): \{([^`]*)\}`/g)) {
    const fields = LIST_FIELDS.get(m[1]!);
    if (!fields) continue;
    for (const part of topLevelParts(m[2]!)) {
      const p = /^(\w+)(\?)?(?:\s*:\s*(.*))?$/.exec(part.replace(/\\\|/g, "|"));
      if (!p) continue;
      const shape = fields.get(p[1]!);
      if (!shape) continue;
      const value = (p[3] ?? "").trim();
      // A list field must show a list (`[..]`, or a literal list example); a string-or-list field may show either,
      // but never a bare name, which reads as "a string goes here".
      const ok = shape === "list" ? value.startsWith("[") : value !== "";
      if (!ok)
        out.push(
          `${file}:${lineOf(m.index!)}: \`${m[1]}\` field \`${p[1]}\` takes ${shape === "list" ? "a list" : "a string or a list"}; it reads \`${part}\``,
        );
    }
  }
  for (const m of text.matchAll(/`(\w+): (<[^`]*)`/g)) {
    const own = LIST_FIELDS.get(m[1]!)?.get("");
    if (!own) continue;
    const value = m[2]!.replace(/\\\|/g, "|");
    const ok = own === "list" ? value.startsWith("[") : value.includes("[");
    if (!ok)
      out.push(
        `${file}:${lineOf(m.index!)}: \`${m[1]}\` takes ${own === "list" ? "a list" : "a string or a list"}; it reads \`${m[1]}: ${m[2]}\``,
      );
  }
  return out;
}

describe("assertion field shapes in the docs show every list-typed field as a list", () => {
  it("reads list-typed fields from the schema (the derivation is not empty)", () => {
    expect(LIST_FIELDS.get("artifact_text")?.get("contains")).toBe("list");
    expect(LIST_FIELDS.get("tool_called")?.get("tool")).toBe("str|list");
  });

  it("flags a bare list field (the check can fail)", () => {
    expect(findings("x.md", "`artifact_text: {artifact, contains?}`")).toHaveLength(1);
    expect(findings("x.md", "`artifact_text: {artifact, contains?: [..]}`")).toEqual([]);
    expect(findings("x.md", "`input_unmodified: <glob>`")).toHaveLength(1);
  });

  it("every signature in the skill references and docs/scenario.md", () => {
    expect(FILES.flatMap((f) => findings(f, readFileSync(join(ROOT, f), "utf8")))).toEqual([]);
  });
});

// An agent that READS a skill reference during a sandboxed run echoes what it read into model-visible text. A literal
// host root in a reference (`/Users/…`) then trips the run's own host-path leak check: a false `host_path_leak` that the
// skill caused by documenting the check. So no skill page carries a token the leak detector would flag.

describe("the companion skill's files carry no host-path token", () => {
  // Every tracked text file of the skill an agent can read: references, SKILL.md, the manifest and the bundled
  // scripts (an agent reads a script to learn what it does).
  const SKILL_FILES = execFileSync("git", ["ls-files", ".claude/skills/cowork-harness"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("/_vendor/") && /\.(md|py|json|txt|ya?ml|sh)$/.test(f));
  it("the detector sees a literal root (the check can fail)", () => {
    expect(hostPathTokens("see `/Users/you/x`")).toHaveLength(1);
  });
  it("reads the skill's files (the list is not empty)", () => {
    expect(SKILL_FILES).toContain(".claude/skills/cowork-harness/scripts/scenario.py");
  });
  it("no file of the skill would be flagged", () => {
    expect(SKILL_FILES.flatMap((f) => hostPathTokens(readFileSync(join(ROOT, f), "utf8")).map((t) => `${f}: ${t}`))).toEqual([]);
  });
});

// In a GitHub table a bare `|` splits the cell even inside a code span, so a signature such as
// `input_unmodified: <glob> | [..]` in a table row eats the row's description. Inside a table row it is written `\|`.
describe("a code span in a table row escapes its pipes", () => {
  const bare = (text: string) =>
    text
      .split("\n")
      .flatMap((l, i) =>
        l.startsWith("|") ? [...l.matchAll(/`[^`]*`/g)].filter((m) => /(?<!\\)\|/.test(m[0])).map((m) => `${i + 1}: ${m[0]}`) : [],
      );
  it("flags a bare pipe in a table cell's code span (the check can fail)", () => {
    expect(bare("| `a: <x> | [..]` | desc |")).toHaveLength(1);
    expect(bare("| `a: <x> \\| [..]` | desc |")).toEqual([]);
  });
  it("every table row of the files above", () => {
    expect(FILES.flatMap((f) => bare(readFileSync(join(ROOT, f), "utf8")).map((x) => `${f}:${x}`))).toEqual([]);
  });
});
