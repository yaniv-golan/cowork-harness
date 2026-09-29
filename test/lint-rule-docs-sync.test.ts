// The companion skill's `references/authoring.md` carries the table of every rule `cowork-harness lint`
// reports. Both directions are checked against the sources, never a copied list: every id in scenario.py's
// LINT_RULES and every rule the TypeScript wrapper emits (`rule: "…"` literals in src/run/lint-load.ts) has
// a row with its registry severity, and every row names a rule that exists. A new rule that is not
// documented, a severity change, or a row for a retired rule fails here.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const AUTHORING = resolve(".claude/skills/cowork-harness/references/authoring.md");
const LINT_LOAD = resolve("src/run/lint-load.ts");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

/** `| \`id\` | SEVERITY | … |` rows of the lint rule table. */
function tableRows(md: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const m of md.matchAll(/^\| `([a-z0-9-]+)` \| (ERROR|WARN|INFO) \|/gm)) {
    expect(rows.has(m[1]), `row for ${m[1]} appears twice`).toBe(false);
    rows.set(m[1], m[2]);
  }
  return rows;
}

/** Every `severity: "<SEV>", rule: "<id>"` pair the wrapper builds. Each literal must be written in that
 *  order: a `rule:` literal this pattern does not pair is a failure, not a silent omission. */
function wrapperRules(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const pairs = [...src.matchAll(/severity: "(ERROR|WARN|INFO)",\s*rule: "([a-z0-9-]+)"/g)];
  const literals = [...src.matchAll(/\brule: "[a-z0-9-]+"/g)];
  expect(pairs.length, "a `rule:` literal in lint-load.ts without a `severity:` just before it").toBe(literals.length);
  for (const m of pairs) {
    expect(out.get(m[2]) ?? m[1], `wrapper rule ${m[2]} emitted at two severities`).toBe(m[1]);
    out.set(m[2], m[1]);
  }
  return out;
}

describe.skipIf(!havePython)("authoring.md's lint rule table matches the rule registries", () => {
  const r = spawnSync(
    py,
    [
      "-c",
      "import importlib.util, json, sys\n" +
        "spec = importlib.util.spec_from_file_location('scenario_mod', sys.argv[1])\n" +
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n" +
        "print(json.dumps(m.LINT_RULES))",
      SCRIPT,
    ],
    { encoding: "utf8" },
  );
  const registry = new Map(Object.entries(JSON.parse(r.stdout || "{}") as Record<string, string>));
  const wrapper = wrapperRules(readFileSync(LINT_LOAD, "utf8"));
  const table = tableRows(readFileSync(AUTHORING, "utf8"));

  it("the instruments see the rules (an empty set would pass every check below)", () => {
    expect(r.status, r.stderr).toBe(0);
    expect(registry.size).toBeGreaterThan(30);
    expect([...wrapper.keys()].sort()).toEqual(expect.arrayContaining(["baseline-unknown", "scenario-invalid"]));
    expect(table.size).toBeGreaterThan(30);
  });

  it("every registry and wrapper rule has a row with its severity", () => {
    const expected = new Map([...registry, ...wrapper]);
    const missing = [...expected.keys()].filter((id) => !table.has(id));
    expect(missing, "rules with no row in references/authoring.md").toEqual([]);
    for (const [id, sev] of expected) expect(table.get(id), `severity of ${id}`).toBe(sev);
  });

  it("every row names a rule that exists", () => {
    const unknown = [...table.keys()].filter((id) => !registry.has(id) && !wrapper.has(id));
    expect(unknown, "rows naming no lint rule").toEqual([]);
  });
});
