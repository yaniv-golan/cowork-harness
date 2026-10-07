import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { CATALOG_FILES } from "./helpers/assertion-catalog.js";
import { parse as parseYaml } from "yaml";
import { scrapeCoworkEnvVars } from "../scripts/lib/env-scrape.js";
import { AGENT_IMAGE_DEFAULT, PROXY_IMAGE_DEFAULT } from "../src/runtime/agent-image.js";

// Anti-drift guards for the documentation *index* surfaces:
//   1. every COWORK_* env var read anywhere in src/ is documented in README.md or docs/*.md;
//   2. the judge-model default id and the image-tag defaults the docs name match the code's defaults;
//   3. llms.txt links every top-level docs/*.md guide, and links nothing that doesn't exist;
//   4. CONTRIBUTING.md's CI stage table has exactly one row per job in .github/workflows/ci.yml.
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
  // Intentionally-internal vars go here, each with a stated reason.
  const ALLOWLIST = new Set<string>([
    // The `cowork-harness lint` wrapper → bundled scenario.py handoff of scenario-loader findings. Set by
    // the wrapper for one child process, scrubbed from anything inherited; not a user knob (SPEC.md lists
    // it as not covered).
    "COWORK_HARNESS_LINT_EXTRA_FINDINGS",
  ]);

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

  it("every COWORK_* env var read in src/ is named in docs/cli.md itself, which claims to be the full list", () => {
    // The check above accepts a mention on any page, so a var documented only on its feature page passed it
    // while cli.md's Reproducibility knobs — where AGENTS.md sends readers for the full list — lacked it. A
    // `_SUFFIX` shorthand after a sibling var does not count: nobody searching for the full name finds it.
    const cliMd = readFileSync(join(docsDir, "cli.md"), "utf8");
    const missing = [...names].filter((n) => !ALLOWLIST.has(n) && !new RegExp(`${n}(?![A-Z0-9_])`).test(cliMd)).sort();
    expect(missing, "add a line to docs/cli.md § Reproducibility knobs (it may link to the feature page)").toEqual([]);
  });
});

describe("semantic-judge default model ↔ docs", () => {
  it("every doc that names the judge default names the code's actual default", () => {
    const judgeSrc = readFileSync(resolve("src/decide/semantic-judge.ts"), "utf8");
    const m = judgeSrc.match(/JUDGE_MODEL_FALLBACK\s*=\s*"([^"]+)"/);
    // fail loud on a const rename — a null match must never degrade into a skipped sync check
    expect(m).not.toBeNull();
    const id = m![1];
    // The judge default is named on the CLI page since the router split moved the commands/flags
    // reference out of README.md; the README is a router and names no model ids.
    expect(readFileSync(resolve("docs/cli.md"), "utf8")).toContain(id);
    expect(readFileSync(resolve("docs/scenario.md"), "utf8")).toContain(id);
    expect(readFileSync(resolve(".claude/skills/cowork-harness/references/scenario-schema.md"), "utf8")).toContain(id);
  });
});

describe("image-tag defaults ↔ docs", () => {
  // The image tag is the cache key: the sidecar and the agent spawn reuse a local image on tag existence
  // alone, so a doc that names an older tag tells an operator to build or pin an image that no longer
  // carries the shipped code. Scoped to the pages that state the CURRENT default — the CLI reference, the
  // Python helper's setup, the cassette prerequisites and SPEC § 3's spawn argv. Dated records (DESIGN.md's
  // live-pass note names the image a past pass ran on) are deliberately out of scope: they may lag.
  const tagOf = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);
  const spec = readFileSync(resolve("SPEC.md"), "utf8");
  const s3 = spec.indexOf("\n## 3. ");
  const s4 = spec.indexOf("\n## 4. ", s3 + 1);
  const pages: Array<[string, string]> = [
    ["docs/cli.md", readFileSync(resolve("docs/cli.md"), "utf8")],
    ["python/README.md", readFileSync(resolve("python/README.md"), "utf8")],
    ["docs/cassette.md", readFileSync(resolve("docs/cassette.md"), "utf8")],
    ["SPEC.md § 3", s3 >= 0 && s4 > s3 ? spec.slice(s3, s4) : ""],
  ];

  function sites(re: RegExp): Array<{ page: string; ref: string; tag: string }> {
    return pages.flatMap(([page, text]) => [...text.matchAll(re)].map((m) => ({ page, ref: m[0], tag: m[1] })));
  }

  it("SPEC § 3 was found — a moved heading must not empty the scan", () => {
    expect(s3, "SPEC.md `## 3.` heading").toBeGreaterThanOrEqual(0);
    expect(s4, "SPEC.md `## 4.` heading").toBeGreaterThan(s3);
  });

  it("every agent-image tag the docs name equals AGENT_IMAGE_DEFAULT's tag", () => {
    // Both variants (base and full-parity) are built from the one Dockerfile and share the tag number; a
    // ghcr ref's `-rN` rebuild suffix is not part of the local tag.
    const found = sites(/cowork-agent-(?:base|full):(\d+)(?:-r\d+)?/g);
    expect(found.length, "no agent-image tag found — the scan is vacuous").toBeGreaterThan(0);
    const want = tagOf(AGENT_IMAGE_DEFAULT);
    expect(found.filter((f) => f.tag !== want).map((f) => `${f.page}: ${f.ref}`)).toEqual([]);
  });

  it("every egress-proxy tag the docs name equals PROXY_IMAGE_DEFAULT's tag", () => {
    const found = sites(/cowork-egress-proxy:(\d+)/g);
    expect(found.length, "no egress-proxy tag found — the scan is vacuous").toBeGreaterThan(0);
    const want = tagOf(PROXY_IMAGE_DEFAULT);
    expect(found.filter((f) => f.tag !== want).map((f) => `${f.page}: ${f.ref}`)).toEqual([]);
  });
});

describe("gotchas.md index blurbs don't claim non-existent content", () => {
  it("no 'egress-proxy races' claim remains (gotchas.md has no such section)", () => {
    expect(docsText).not.toMatch(/egress-proxy races/);
  });
});

describe("verdict-signals docs ↔ code", () => {
  // The signal table moved to assertion-catalog.md (its per-key rows since split across assertion-catalog-*.md);
  // scan every catalog file and scenario-schema.md so the check keeps its reach.
  const scenarioSchemaText = [".claude/skills/cowork-harness/references/scenario-schema.md", ...CATALOG_FILES]
    .map((f) => readFileSync(resolve(f), "utf8"))
    .join("\n");
  const scenarioMdText = readFileSync(resolve("docs/scenario.md"), "utf8");

  it("neither doc uses the bare (wrong) `result.signals` JSON path — it's nested under `result.verdict.signals`", () => {
    expect(scenarioSchemaText).not.toMatch(/`result\.signals/);
    expect(scenarioMdText).not.toMatch(/`result\.signals/);
  });

  // The count is pinned so ADDING a warn-severity signal is a conscious act, not drift — a warn signal
  // fires on every run without anyone opting in, so a careless one becomes noise for every user.
  // 7 as of `delivery_unobservable`. That one was added deliberately under exactly this scrutiny: it
  // REPLACES a `undelivered_deliverables` firing on the remote lane rather than adding new noise (the two
  // are mutually exclusive), and it is gated on the same candidate set, so a remote run that produced
  // nothing to deliver stays as quiet as it was before. Net warn volume on any given run is unchanged.
  // 9 as of `model_fallback`. Held to the same noise test as the two above and passes for a different
  // reason: it cannot fire on a healthy run at all. Its source is the agent's own `model_fallback` event,
  // which the binary emits only when a turn actually falls off the requested model — so a user who never
  // hits a retired pin or an overload never sees it, and one who does is being told the run measured a
  // model their scenario does not name. Zero added volume on every currently-green run.
  // 11 as of `outputs_delete_unconfirmed` + `outputs_diff_unavailable`. The first adds no noise: it can
  // only fire where the fail-severity `outputs_delete` used to, so every run that shows it was a red run
  // before. The second cannot fire on a healthy run: it needs the per-turn outputs diff to have been
  // unable to verify (missing/incomplete snapshot or an unreadable post-run walk) — and silence there was
  // the thing wrong with it.
  // 12 as of `partly_scripted_gate`. It fires only where the decider's existing stderr warning already
  // fires (scripted rules matched some, not all, sub-questions of one batch), so no clean run gains it; on
  // the `first`/`llm` fallbacks it co-occurs with `non_deterministic`, and on `fail` the run is already red.
  // 13 as of `parked_at_question`. It fires only under `answer_channel: none`, and only where `stalled` (a fail) would
  // otherwise have fired, so no run gains a signal it did not have.
  it('the docs\' "only thirteen warn-severity signals" claim matches the actual count in verdict.ts', () => {
    const verdictSrc = readFileSync(resolve("src/run/verdict.ts"), "utf8");
    const warnCount = [...verdictSrc.matchAll(/severity:\s*"warn"/g)].length;
    expect(warnCount).toBe(13);
    expect(scenarioMdText).toMatch(/Only thirteen codes are \*\*warn\*\*-severity/);
  });
});

describe("README § Documentation ↔ docs/README.md Guides (the two doc indexes can't drift)", () => {
  // The two human doc indexes are parallel surfaces (the planned dedup is a separate restructure);
  // until then, a guide listed in one and not the other is drift — that's exactly how critique.md
  // went missing from README's table while present in docs/README.md, llms.txt, and the command table.
  const readme = readFileSync(resolve("README.md"), "utf8");
  const docsReadme = readFileSync(resolve("docs/README.md"), "utf8");

  const section = (text: string, heading: string) => {
    const start = text.indexOf(`\n## ${heading}`);
    expect(start, `heading "## ${heading}" not found`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("every guide in docs/README.md's Guides table has a row in README's Documentation table", () => {
    const guides = [...section(docsReadme, "Guides").matchAll(/\| \[[^\]]+\]\(\.\/([\w.-]+\.md)\)/g)].map((m) => m[1]);
    expect(guides.length).toBeGreaterThan(10); // parse canary — an empty scrape must not false-green
    const docTable = section(readme, "Documentation");
    const missing = guides.filter((f) => !docTable.includes(`(./docs/${f})`)).sort();
    expect(missing).toEqual([]);
  });

  it("every docs/*.md in README's Documentation table is indexed somewhere in docs/README.md", () => {
    // docs/README.md can't list itself — the one intentional asymmetry.
    const ALLOWLIST = new Set<string>(["README.md"]);
    const rows = [...section(readme, "Documentation").matchAll(/\(\.\/docs\/([\w.-]+\.md)\)/g)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(10); // parse canary
    const missing = rows.filter((f) => !ALLOWLIST.has(f) && !docsReadme.includes(`(./${f})`)).sort();
    expect(missing).toEqual([]);
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

/** Bold first-cell names of a markdown table section. */
function stageRowNames(section: string): string[] {
  return [...section.matchAll(/^\|\s*(\*\*|__)([A-Za-z0-9_-]+)\1\s*\|/gm)].map((m) => m[2]);
}

describe("stageRowNames — the table-row reader the stage-table guard relies on", () => {
  // A row the reader cannot see is a job the guard reports as missing for the wrong reason — or, worse,
  // a stale row it silently ignores. Each case below is a legal spelling of a bold first cell.
  it("reads a cell with extra whitespace around the bold name", () => {
    expect(stageRowNames("|  **build**   | x |")).toEqual(["build"]);
  });
  it("reads underscore bold (`__name__`) as well as `**name**`", () => {
    expect(stageRowNames("| __build__ | x |")).toEqual(["build"]);
  });
  it("reads a job id with uppercase letters or underscores", () => {
    expect(stageRowNames("| **Build_Job** | x |")).toEqual(["Build_Job"]);
  });
});

describe("CONTRIBUTING.md CI stage table ↔ ci.yml jobs", () => {
  // The table named nine stages while ci.yml ran eleven jobs: two were added with no row, and the prose
  // count ("nine-stage") went stale with them. Compare JOB IDS — `Object.keys(jobs)` — not the display
  // `name:`s, which are long human strings (the `python` job's name is its required-context label).
  const ci = parseYaml(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")) as { jobs?: Record<string, unknown> } | null;
  const jobIds = Object.keys(ci?.jobs ?? {}).sort();

  const contributing = readFileSync(resolve("CONTRIBUTING.md"), "utf8");
  const start = contributing.indexOf("\n## This repo's own CI pipeline");
  const rest = start === -1 ? "" : contributing.slice(start + 1);
  const next = rest.indexOf("\n## ");
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows = stageRowNames(section).sort();

  it("parsed both sides (an empty parse must not pass)", () => {
    expect(start, "CONTRIBUTING.md lost its `## This repo's own CI pipeline` heading").toBeGreaterThan(-1);
    expect(jobIds.length).toBeGreaterThan(5);
    expect(rows.length).toBeGreaterThan(5);
  });

  it("every ci.yml job has a row, and every row names a real job", () => {
    const missingRows = jobIds.filter((j) => !rows.includes(j));
    const staleRows = rows.filter((r) => !jobIds.includes(r));
    expect({ missingRows, staleRows }).toEqual({ missingRows: [], staleRows: [] });
  });
});
