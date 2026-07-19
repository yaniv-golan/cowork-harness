import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { scrapeCoworkEnvVars } from "../scripts/lib/env-scrape.js";

// Anti-drift guards for the documentation *index* surfaces:
//   1. every COWORK_* env var read anywhere in src/ is documented in README.md or docs/*.md;
//   2. the judge-model default id the docs name matches the code's actual default;
//   3. llms.txt links every top-level docs/*.md guide, and links nothing that doesn't exist.
// Same scrape-the-source pattern as test/action-docs-sync.test.ts — token-free text parsing.
// The COWORK_* scraper itself lives in scripts/lib/env-scrape.ts (shared with the structured-surface
// snapshot in scripts/lib/surface.ts) — imported here, not duplicated.

// Top-level guides only — docs/internal/ and docs/superpowers/ are untracked/npm-excluded working
// notes, not published index surfaces.
const docsDir = resolve("docs");
const docFiles = readdirSync(docsDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".md"))
  .map((e) => e.name);

const docsText = readFileSync(resolve("README.md"), "utf8") + "\n" + docFiles.map((f) => readFileSync(join(docsDir, f), "utf8")).join("\n");

describe("COWORK_* env vars ↔ docs", () => {
  // Vars read via helpers (envPositiveNumber("COWORK_…"), parseEnvPort("COWORK_…"), env-name
  // constants) never appear as a `process.env.X` token, and vars read off a destructured/aliased
  // env object appear only as `env.X` — so the scrape is the UNION of all three shapes.
  // Dot-access alone misses the helper-read STATUS_* / DECIDER_DIR_* / LLM_* / GITSET /
  // VM_PROXY_PORT families and the aliased NO_HYPERLINKS read.
  const names = scrapeCoworkEnvVars();
  // Intentionally-internal vars go here, each with a stated reason. Empty today: every env knob
  // the harness reads is documented somewhere in README.md or docs/*.md.
  const ALLOWLIST = new Set<string>([]);

  it("scraped a sane env-var set", () => {
    // 53 names at time of writing; the floor must sit ABOVE the 41 that dot-access alone yields,
    // so silently losing the literal/env-object halves fails here instead of false-greening.
    expect(names.size).toBeGreaterThan(50);
    // canary for the helper-read class — reachable only via the quoted-literal pattern
    expect([...names]).toContain("COWORK_HARNESS_STATUS_CORRUPT_TIMEOUT_MS");
    // canary for the aliased-env-object class — reachable only via the `env.X` pattern
    expect([...names]).toContain("COWORK_HARNESS_NO_HYPERLINKS");
    expect([...names]).toContain("COWORK_VM_PROXY_PORT");
  });

  it("every COWORK_* env var read in src/ is documented in README.md or docs/*.md", () => {
    // word-boundary match: a doc mentioning COWORK_HARNESS_DEBUG_SKILLHASH must not satisfy a
    // lookup for COWORK_HARNESS_DEBUG
    const documented = (n: string) => new RegExp(`${n}(?![A-Z0-9_])`).test(docsText);
    const undocumented = [...names].filter((n) => !ALLOWLIST.has(n) && !documented(n)).sort();
    expect(undocumented).toEqual([]);
  });
});

describe("semantic-judge default model ↔ docs", () => {
  it("every doc that names the judge default names the code's actual default", () => {
    const judgeSrc = readFileSync(resolve("src/decide/semantic-judge.ts"), "utf8");
    const m = judgeSrc.match(/DEFAULT_JUDGE_MODEL\s*=\s*process\.env\.\w+\s*\|\|\s*"([^"]+)"/);
    // fail loud on a const rename — a null match must never degrade into a skipped sync check
    expect(m).not.toBeNull();
    const id = m![1];
    expect(readFileSync(resolve("README.md"), "utf8")).toContain(id);
    expect(readFileSync(resolve("docs/scenario.md"), "utf8")).toContain(id);
    expect(readFileSync(resolve(".claude/skills/cowork-harness/references/scenario-schema.md"), "utf8")).toContain(id);
  });
});

describe("gotchas.md index blurbs don't claim non-existent content", () => {
  it("no 'egress-proxy races' claim remains (gotchas.md has no such section)", () => {
    expect(docsText).not.toMatch(/egress-proxy races/);
  });
});

describe("verdict-signals docs ↔ code", () => {
  const scenarioSchemaText = readFileSync(resolve(".claude/skills/cowork-harness/references/scenario-schema.md"), "utf8");
  const scenarioMdText = readFileSync(resolve("docs/scenario.md"), "utf8");

  it("neither doc uses the bare (wrong) `result.signals` JSON path — it's nested under `result.verdict.signals`", () => {
    expect(scenarioSchemaText).not.toMatch(/`result\.signals/);
    expect(scenarioMdText).not.toMatch(/`result\.signals/);
  });

  it('the docs\' "only four warn-severity signals" claim matches the actual count in verdict.ts', () => {
    const verdictSrc = readFileSync(resolve("src/run/verdict.ts"), "utf8");
    const warnCount = [...verdictSrc.matchAll(/severity:\s*"warn"/g)].length;
    expect(warnCount).toBe(4);
  });
});

describe("llms.txt ↔ docs/*.md", () => {
  const llms = readFileSync(resolve("llms.txt"), "utf8");
  // Every top-level docs/*.md guide, including docs/README.md itself, is now linked from llms.txt —
  // no deliberate omissions remain.
  const LLMS_ALLOWLIST = new Set<string>([]);

  it("every top-level docs guide is linked from llms.txt", () => {
    const missing = docFiles.filter((f) => !LLMS_ALLOWLIST.has(f) && !llms.includes(`docs/${f}`)).sort();
    expect(missing).toEqual([]);
  });

  it("every docs/*.md path referenced in llms.txt exists", () => {
    const referenced = [...llms.matchAll(/\(docs\/([^)\s]+\.md)\)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(5);
    const dangling = referenced.filter((f) => !docFiles.includes(f));
    expect(dangling).toEqual([]);
  });
});
