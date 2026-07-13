import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// Anti-drift guards for the documentation *index* surfaces:
//   1. every COWORK_* env var read anywhere in src/ is documented in README.md or docs/*.md;
//   2. the judge-model default id the docs name matches the code's actual default;
//   3. llms.txt links every top-level docs/*.md guide, and links nothing that doesn't exist.
// Same scrape-the-source pattern as test/action-docs-sync.test.ts — token-free text parsing.

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

const srcText = tsFilesUnder(resolve("src"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

// Top-level guides only — docs/internal/ and docs/superpowers/ are untracked/npm-excluded working
// notes, not published index surfaces.
const docsDir = resolve("docs");
const docFiles = readdirSync(docsDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".md"))
  .map((e) => e.name);

const docsText = readFileSync(resolve("README.md"), "utf8") + "\n" + docFiles.map((f) => readFileSync(join(docsDir, f), "utf8")).join("\n");

describe("COWORK_* env vars ↔ docs", () => {
  // Vars read via helpers (envPositiveNumber("COWORK_…"), parseEnvPort("COWORK_…"), env-name
  // constants) never appear as a `process.env.X` token, so the scrape is the UNION of dot-access
  // and quoted string literals — dot-access alone misses the helper-read STATUS_* / DECIDER_DIR_* /
  // LLM_* / GITSET / VM_PROXY_PORT families entirely.
  const names = new Set<string>();
  for (const re of [/process\.env\.(COWORK[A-Z0-9_]+)/g, /["'](COWORK[A-Z0-9_]+)["']/g]) {
    for (const m of srcText.matchAll(re)) names.add(m[1]);
  }
  // Intentionally-internal vars go here, each with a stated reason. Empty today: every env knob
  // the harness reads is documented somewhere in README.md or docs/*.md.
  const ALLOWLIST = new Set<string>([]);

  it("scraped a sane env-var set", () => {
    expect(names.size).toBeGreaterThan(40);
    // the canary for the helper-read class — reachable only via the quoted-literal half
    expect([...names]).toContain("COWORK_HARNESS_STATUS_CORRUPT_TIMEOUT_MS");
    expect([...names]).toContain("COWORK_VM_PROXY_PORT");
  });

  it("every COWORK_* env var read in src/ is documented in README.md or docs/*.md", () => {
    const undocumented = [...names].filter((n) => !ALLOWLIST.has(n) && !docsText.includes(n)).sort();
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

describe("llms.txt ↔ docs/*.md", () => {
  const llms = readFileSync(resolve("llms.txt"), "utf8");
  // docs/README.md is itself an index page; llms.txt is the agent-facing index, so it is the one
  // deliberate omission.
  const LLMS_ALLOWLIST = new Set<string>(["README.md"]);

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
