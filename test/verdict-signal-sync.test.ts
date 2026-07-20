import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Anti-drift guard for the verdict-signal CODE SET, which is maintained in five places by hand:
//   1. the `VerdictSignal["code"]` union            — src/run/verdict.ts        (the source of truth)
//   2. an inlined copy of that union                — src/types.ts              (deliberately not
//      imported from verdict.ts, to avoid an import cycle — see the note above RunResult.verdict)
//   3. the persisted envelope's enum                — schema/run-result.json    (hand-maintained; NOT
//      emitted by `npm run schema`)
//   4. the full signal table                        — the companion skill's scenario-schema reference
//   5. the warn-severity enumeration                — docs/scenario.md
//
// Signal codes are a semver-COVERED surface (SPEC.md §12), and a code added to (1) without (2) or (3)
// does not even typecheck at the `result.verdict = computeVerdict(...)` assignment — but (4) and (5) are
// prose, so they rot silently. That is not hypothetical: `exec_infra_error` was added to the code, the
// schema and docs/scenario.md while the skill's "full signal list" kept advertising a set that no longer
// matched. Same scrape-the-source, token-free pattern as test/docs-index-sync.test.ts.

const SCHEMA_REF = ".claude/skills/cowork-harness/references/scenario-schema.md";

function read(rel: string): string {
  return readFileSync(resolve(rel), "utf8");
}

/** The codes in a TypeScript string-literal union: seek `marker`, then the first `code:` member after
 *  it, then read to the `;` that ends that member. (Seeking `code:` rather than slicing straight from
 *  the marker matters for the types.ts copy, whose block opens with `pass: boolean;`.) */
function unionCodes(src: string, marker: string): string[] {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const codeAt = src.indexOf("code:", start);
  if (codeAt === -1) throw new Error(`no \`code:\` member after marker: ${marker}`);
  const body = src.slice(codeAt, src.indexOf(";", codeAt));
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

/** The codes in the hand-maintained JSON-schema enum for verdict.signals[].code. */
function schemaEnumCodes(): string[] {
  const schema = JSON.parse(read("schema/run-result.json"));
  const codeNode = schema.properties?.verdict?.properties?.signals?.items?.properties?.code;
  if (!codeNode?.enum) throw new Error("verdict.signals[].code enum not found in schema/run-result.json");
  return codeNode.enum as string[];
}

/** The codes named in a markdown table's first column (`| \`code\` | fail|warn | … |`). */
function tableCodes(md: string): string[] {
  return [...md.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*(fail|warn)\s*\|/gm)].map((m) => m[1]);
}

/** code → severity, taken from the same table. */
function tableSeverities(md: string): Map<string, string> {
  return new Map([...md.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*(fail|warn)\s*\|/gm)].map((m) => [m[1], m[2]]));
}

const verdictSrc = read("src/run/verdict.ts");
const typesSrc = read("src/types.ts");
const schemaRefMd = read(SCHEMA_REF);
const scenarioMd = read("docs/scenario.md");
const skillMd = read(".claude/skills/cowork-harness/SKILL.md");

/** SKILL.md's signal bullets: `- **\`code\`** (\`WARN\`, …) — prose`. The severity marker is optional —
 *  a bullet that omits it simply makes no severity claim to check. */
function skillBullets(): Array<[string, string | undefined]> {
  return [...skillMd.matchAll(/^- \*\*`([a-z0-9_]+)`\*\*(?:\s*\(`(WARN|FAIL)`)?/gm)].map((m) => [m[1], m[2]]);
}

// The source of truth. Everything else is compared against this.
const CODES = unionCodes(verdictSrc, "export interface VerdictSignal");

// Severity per code, scraped from the `signals.push({ code: "x", severity: "y" })` call sites.
const SEVERITY = new Map(
  [...verdictSrc.matchAll(/code:\s*"([a-z0-9_]+)",\s*\n?\s*severity:\s*(?:"(fail|warn)"|[^,\n]+)/g)].map((m) => [m[1], m[2]]),
);

describe("verdict-signal code set ↔ its five hand-maintained copies", () => {
  it("the source union is non-empty and unique (guards the scraper itself)", () => {
    expect(CODES.length).toBeGreaterThan(10);
    expect(new Set(CODES).size).toBe(CODES.length);
  });

  it("the inlined copy in types.ts matches the union in verdict.ts", () => {
    // types.ts intentionally re-declares rather than imports (import-cycle avoidance), so nothing but
    // this test stops the two from diverging.
    const inlined = unionCodes(typesSrc, "verdict?: {");
    expect(new Set(inlined)).toEqual(new Set(CODES));
  });

  it("the hand-maintained schema enum matches the union", () => {
    expect(new Set(schemaEnumCodes())).toEqual(new Set(CODES));
  });

  it("the skill's signal table lists exactly the union — no missing, no invented codes", () => {
    const documented = tableCodes(schemaRefMd);
    expect(documented.length).toBeGreaterThan(10); // the table was found and parsed
    expect(new Set(documented)).toEqual(new Set(CODES));
  });

  it("the skill's table gives each code the severity the code actually pushes", () => {
    const documented = tableSeverities(schemaRefMd);
    for (const [code, severity] of SEVERITY) {
      // only codes with a statically-known severity literal are checkable
      if (severity !== "fail" && severity !== "warn") continue;
      expect(documented.get(code), `${code} severity in ${SCHEMA_REF}`).toBe(severity);
    }
  });

  // SKILL.md's list is CURATED, not exhaustive: it documents the signals an author is likely to
  // misread (a warn worth watching, plus the fail-severity ones that are tier/image artifacts rather
  // than skill defects), and points at the reference table for the rest. So exact-set equality is the
  // wrong contract here — these guards instead pin that whatever it DOES name is real and correctly
  // described, and that every omission stays deliberate. Same allowlist convention as the llms.txt
  // guard in test/docs-index-sync.test.ts.
  const SKILL_MD_UNDOCUMENTED = new Set([
    "assertion", // a failing assertion — self-explanatory in the run output
    "result_error", // the agent turn itself errored
    "transport_error", // connection dropped; not skill-authorable
    "usage_limit", // account limit; not skill-authorable
    "permissive_auto_allow", // covered by the permission/decider sections
    "outputs_delete", // covered by the assertion docs (no_delete_in_outputs)
    "non_deterministic", // covered by the decider/reproducibility sections
    "l0_plugin_divergence", // L0/protocol-tier specific; covered by the fidelity sections
    "infra_error", // a dead supervisor — nothing an author can do but re-run
    "stalled", // covered at length by the gate/answer-scripting sections
  ]);

  it("every signal SKILL.md names is a real code (catches a stale or renamed one lingering)", () => {
    const named = skillBullets().map(([code]) => code);
    expect(named.length).toBeGreaterThan(3); // the bullets were found and parsed
    for (const code of named) {
      expect(CODES, `SKILL.md documents \`${code}\`, which is not a VerdictSignal code`).toContain(code);
    }
  });

  it("every severity SKILL.md states matches the severity the code actually pushes", () => {
    for (const [code, stated] of skillBullets()) {
      if (!stated) continue; // a bullet that declares no severity makes no claim to check
      expect(stated.toLowerCase(), `SKILL.md severity for \`${code}\``).toBe(SEVERITY.get(code));
    }
  });

  it("every code SKILL.md omits is omitted DELIBERATELY, not by drift", () => {
    // A new signal lands here on its first CI run, forcing a decision: document it in SKILL.md, or add
    // it to SKILL_MD_UNDOCUMENTED with a reason. Silence is not one of the options.
    const named = new Set(skillBullets().map(([code]) => code));
    const omitted = CODES.filter((c) => !named.has(c));
    expect(new Set(omitted)).toEqual(SKILL_MD_UNDOCUMENTED);
  });

  it("docs/scenario.md enumerates every warn-severity code, and claims the right count", () => {
    const warnCodes = [...SEVERITY].filter(([, s]) => s === "warn").map(([c]) => c);
    expect(warnCodes.length).toBeGreaterThan(3);
    for (const code of warnCodes) {
      expect(scenarioMd, `docs/scenario.md should document the warn signal ${code}`).toContain(`\`${code}\``);
    }
    // the prose states the count in words; keep it honest as the set grows
    const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    expect(scenarioMd).toContain(`Only ${WORDS[warnCodes.length]} codes are **warn**-severity`);
  });
});
