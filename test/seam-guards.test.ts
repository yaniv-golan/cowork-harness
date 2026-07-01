import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Structural guards for the staging resolver.
 *
 * `src/staging/resolve.ts` centralizes declared-source validation behind one choke point,
 * `resolveDeclaredSource`. Its rationale only has teeth if every declared source actually goes through
 * the resolver — a single hand-rolled `existsSync`-gated skip/kind-check re-opens the silent-accept hole
 * (a missing declared source that no-ops produces a false-green run). These tests read the staging source
 * as TEXT and assert the legacy inline idioms the resolver replaced are absent, so a future input type
 * that bypasses the resolver fails the build rather than slipping a silent skip back in.
 *
 * Precision note: this does NOT ban `existsSync` outright. Several `existsSync` uses are legitimate and
 * must stay — the post-loop AGGREGATED missing-mount check (`mounts.filter(... !existsSync ...)`), the
 * `presentMounts` filter, the marketplace plugin-resolution `continue`, the config_dir existing-dir
 * guard, the upload `statSync().isFile()` check, and the resume-tree probes in stage.ts. The guard
 * targets the SPECIFIC banned idioms (a declared source's own inline `existsSync` kind-gate / skip), not
 * all `existsSync`, so it does not false-positive on those legitimate uses.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const sessionSrc = readFileSync(join(SRC, "session.ts"), "utf8");
const stageSrc = readFileSync(join(SRC, "runtime", "stage.ts"), "utf8");

describe("Guard A: declared sources resolve through resolveDeclaredSource, not inline existsSync-skips", () => {
  it("session.ts routes the four declared-source loops (skills/folders/local_plugins/remote_plugins) through the resolver", () => {
    // One resolver call per declared-source kind. If a new loop is added that hand-rolls its own
    // existsSync gate instead of calling the resolver, this count drops and the test fails.
    const calls = sessionSrc.match(/resolveDeclaredSource\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("session.ts no longer kind-checks a declared source inline (no direct requireDir/requireFile call)", () => {
    // The kind-check (requireFile/requireDir) is the resolver's job now. A direct call here would be a
    // per-site copy of exactly what the seam centralizes. (Imports are via resolveDeclaredSource only.)
    expect(sessionSrc).not.toMatch(/\brequireDir\(/);
    expect(sessionSrc).not.toMatch(/\brequireFile\(/);
  });

  it("session.ts contains no inline `if (existsSync(src)) requireDir(...)` declared-source kind-gate", () => {
    // The legacy folders/plugins idiom the resolver replaced: gate the kind-check on existence inline.
    expect(sessionSrc).not.toMatch(/existsSync\(\s*src\s*\)\s*\)\s*require(Dir|File)/);
  });

  it("session.ts contains no inline skill `if (!existsSync(src)) { ... not found ... }` skip", () => {
    // The legacy skill idiom: hand-rolled existence check + per-site not-found throw / skip. The resolver
    // owns the missing-source decision now (throw vs null-under-softMissing). Banning the per-site
    // "<kind> source not found" string literal in source guarantees no site re-creates that message
    // inline — except the resolver itself lives in resolve.ts, so session.ts must not carry it.
    expect(sessionSrc).not.toMatch(/source not found:/);
  });
});

describe("Guard A (companion): stage.ts mcp.config resolves through the resolver", () => {
  it("stage.ts routes mcp.config through resolveDeclaredSource (no inline existsSync-gated kind-skip)", () => {
    // mcp.config is a declared source too; it must not hand-roll its own `!existsSync ? throw : requireFile`.
    expect(stageSrc).toMatch(/resolveDeclaredSource\(/);
    expect(stageSrc).not.toMatch(/\brequireFile\(/);
    // the prior inline shape was `if (plan.mcpConfig && !existsSync(plan.mcpConfig))` gating the
    // not-found throw — that decision now lives in the resolver.
    expect(stageSrc).not.toMatch(/!existsSync\(\s*plan\.mcpConfig\s*\)/);
  });
});

/**
 * Guard B — intentionally NOT built (a reasoned decision, not an oversight).
 *
 * Guard B was the proposed verdict structural guard: "no scenario pass/fail is computed outside
 * `computeVerdict`", covering the verdict sites (cli.ts run/skill exits, renderer.ts footer, cassette.ts
 * replay exit, envelope.ts `ok`). After review we decided NOT to implement it, because the invariant it
 * would protect is already both structurally true and behaviorally tested, while the guard itself would be
 * brittle:
 *
 *  1. STRUCTURALLY ENFORCED already. `computeVerdict` (src/run/verdict.ts) is the single verdict source and
 *     is wired into every site (cli.ts / envelope.ts / renderer.ts / cassette.ts all CONSUME it; none
 *     compute a verdict inline). Unlike the staging resolver — which had never been built, so Guard A locks in
 *     a freshly-created choke point — the verdict seam already shipped and matured (the verdict layer had no real
 *     bugs in the review). A guard over an already-correct, already-centralized seam is near-zero value.
 *  2. BEHAVIORALLY TESTED already. `verdict.test.ts` unit-tests `computeVerdict` (incl. exitCode↔pass,
 *     replay-lane, permissive/delete/error cases), and `cli-json.test.ts` asserts exit-code AND json `ok`
 *     together dozens of times — i.e. the cross-surface agreement (footer/exit/ok cannot diverge) is
 *     already covered.
 *  3. The literal form is BRITTLE. "No pass/fail outside computeVerdict" is a source-text assertion with no
 *     clean banned idiom to anchor on — every legitimate site that READS `verdict.pass`/`exitCode`/
 *     `result === "error"` looks like a verdict computation, so it false-positives (the reason the seam
 *     work deferred it originally). Guard A avoids this by banning specific staging idioms; Guard B has no
 *     equivalent.
 *
 * If a behavioral belt-and-suspenders is ever wanted, the SOUND form is a test asserting the three verdict
 * surfaces (exit code, footer, json `ok`) agree for pass/fail/error — but that largely duplicates the
 * existing exit+ok assertions. So this stays a conscious won't-fix.
 */
describe("Guard B", () => {
  it.todo("verdict-seam guard — intentionally not built (already structurally enforced + behaviorally tested; see note above)");
});
