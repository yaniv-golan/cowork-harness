import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkFingerprintFieldClaims, fingerprintShapeKeys } from "../scripts/check-versions.js";

/**
 * Invariant 14 (check:versions) — the docs' `sessionFingerprint` field-set claims against the shape.
 *
 * The field set has one source of truth (`buildSessionFingerprint`'s `shape`) and is re-stated in prose
 * across the shipped corpus. Hand-maintenance failed twice: one pass added `projects` to a single site and
 * left it missing from the others, and a later audit of that same line still missed `web_fetch` and
 * `agent_env` everywhere. Fourteen sites existed while the working assumption was three.
 *
 * A green run proves nothing, so every case below is a way the guard could go blind, and each must be
 * observed to FAIL — or, where the guard genuinely cannot see a defect, to be recorded as a known hole
 * rather than left to look covered.
 */

const KEYS = ["agent_env", "egress", "folders", "mcp", "plugins", "projects", "skills", "web_fetch"];
const site = (text: string, path = "docs/x.md") => [{ path, text }];

describe("fingerprintShapeKeys — parse-or-error, never parse-and-pass", () => {
  const src = readFileSync(join(process.cwd(), "src/run/cassette.ts"), "utf8");

  it("extracts all 8 keys, literal and spread, from the real source", () => {
    const { keys, error } = fingerprintShapeKeys(src);
    expect(error).toBeUndefined();
    expect(keys).toEqual(KEYS);
  });

  // M3 — the extractor must fail LOUDLY when the shape is renamed. A regex that stops matching and
  // yields an empty key set would make every site trivially satisfiable.
  it("M3: errors when the `shape` literal cannot be found", () => {
    const { error } = fingerprintShapeKeys(src.replace("const shape = {", "const shp = {"));
    expect(error).toMatch(/could not find/);
  });

  it("M3b: errors when the literal is found but yields too few keys", () => {
    const { error } = fingerprintShapeKeys("const shape = {\n    folders: 1,\n  };");
    expect(error).toMatch(/extracted only 1 keys/);
  });
});

describe("checkFingerprintFieldClaims", () => {
  // M0 — the guard must reproduce the defect it was built for. This is the exact text that shipped.
  it("M0: rejects the historical enumeration that omitted web_fetch and agent_env", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site("| `sessionFingerprint` | hash of the session's content-relevant SHAPE (folders/projects/plugins/skills/mcp/egress). |"),
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/omits `agent_env`, `web_fetch`/);
  });

  it("M0b: rejects the historical prose that also omitted `skills`", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site(
        "| A cassette carries a `sessionFingerprint` (content-SHAPE hash — connected folders, connected projects, plugin/MCP/egress config) |",
      ),
    });
    // The shipped prose said `MCP`, not `mcp` — strict case matching is why that counts as missing.
    expect(errs[0]).toMatch(/omits `agent_env`, `mcp`, `plugins`, `skills`, `web_fetch`/);
  });

  it("accepts a complete enumeration", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site(
        "`sessionFingerprint`: SHAPE hash of folders, plugins, skills, mcp, egress, web_fetch, plus projects and agent_env when set.",
      ),
    });
    expect(errs).toEqual([]);
  });

  // M1 — a single missing field, in one file, must be named with that file.
  it("M1: names the file and the missing field", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site("`sessionFingerprint`: folders, plugins, skills, mcp, egress, projects, agent_env.", "docs/only-me.md"),
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("docs/only-me.md:1");
    expect(errs[0]).toMatch(/omits `web_fetch`/);
  });

  // M2 — a NEW key in the shape must invalidate every previously-complete site. Uses a 9th key rather
  // than removing one, because that is the direction the shape actually grows.
  it("M2: a 9th key in the shape fails a site that was complete without it", () => {
    const complete = "`sessionFingerprint`: folders, plugins, skills, mcp, egress, web_fetch, projects, agent_env.";
    expect(checkFingerprintFieldClaims({ keys: KEYS, corpus: site(complete) })).toEqual([]);
    const errs = checkFingerprintFieldClaims({ keys: [...KEYS, "sandbox_net"], corpus: site(complete) });
    expect(errs[0]).toMatch(/omits `sandbox_net`/);
  });

  // M4 — discovery, not a hardcoded list. A brand-new doc nobody registered must be covered.
  it("M4: finds an enumeration in a file the guard was never told about", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site("A `sessionFingerprint` covers the connected folders and nothing else.", "docs/brand-new-page.md"),
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("docs/brand-new-page.md");
  });

  it("ignores prose that mentions the fingerprint without enumerating it", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site("The `sessionFingerprint` is checked only by `verify-cassettes`, never the replay verdict."),
    });
    expect(errs).toEqual([]);
  });

  // The no-op this guard must never become: a whole-FILE token check is satisfied the moment any field
  // name appears anywhere in the file, and then never fails again. JSON is where that nearly happened —
  // no line is blank or starts with a list marker, so a paragraph walk runs to end-of-file.
  it("scopes a JSON claim to its own line, so an unrelated mention elsewhere cannot satisfy it", () => {
    const json = [
      '{ "a": {',
      '  "description": "sessionFingerprint: SHAPE hash of connected folders, plugins, skills, mcp, egress."',
      "  },",
      '  "b": { "description": "unrelated: web_fetch and agent_env and projects appear here" }',
      "}",
    ].join("\n");
    const errs = checkFingerprintFieldClaims({ keys: KEYS, corpus: [{ path: "schema/cassette.v12.json", text: json }] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/omits `agent_env`, `projects`, `web_fetch`/);
  });

  it("reports one error per claim when a JSON key sits above its own description", () => {
    const json = [
      '{ "sessionFingerprint": {',
      '  "type": "string",',
      '  "description": "SHAPE hash of connected folders only" }',
      "}",
    ].join("\n");
    // A non-frozen schema: v9-v11 are in the default allowlist, which would (correctly) skip them.
    const errs = checkFingerprintFieldClaims({ keys: KEYS, corpus: [{ path: "schema/cassette.v12.json", text: json }] });
    expect(errs).toHaveLength(1);
  });

  it("honours the frozen allowlist, and the reason is required", () => {
    const stale = site("`sessionFingerprint`: connected folders, plugin/skill/mcp config.", "schema/cassette.v9.json");
    // `frozen: {}` proves the site IS detected; the default allowlist is what suppresses it below.
    expect(checkFingerprintFieldClaims({ keys: KEYS, corpus: stale, frozen: {} })).toHaveLength(1);
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: stale,
      frozen: { "schema/cassette.v9.json": "retained historical schema" },
    });
    expect(errs).toEqual([]);
  });

  // An inert guard is worse than a failing one: it reads as coverage.
  it("errors when coverage erodes below the floor", () => {
    const errs = checkFingerprintFieldClaims({ keys: KEYS, corpus: site("nothing about fingerprints here"), minSites: 1 });
    expect(errs[0]).toMatch(/found 0 enumeration sites, expected at least 1/);
  });

  /**
   * KNOWN HOLE #1 — a flat DENIAL is invisible to this guard.
   *
   * `SPEC.md` and `docs/scenario.md` both said the session was "not fingerprinted". That is a worse defect
   * than an incomplete list, and this guard cannot see it: there is no enumeration to check, so the lines
   * are not sites at all. They became guarded only once corrected. Run against the pre-fix corpus, the
   * guard flags 6 sites and the two denials are not among them — the coverage FLOOR is what notices the
   * absence, which is the reason `minSites` exists.
   */
  it("does not flag a flat denial that the field set exists (documented limitation)", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site("The `session` is **not** drift-checked or fingerprinted, so a mount change is undetected."),
    });
    expect(errs).toEqual([]);
  });

  /**
   * KNOWN HOLE #2 — recorded rather than papered over.
   *
   * A token check cannot see whether the *qualifier* survived. `agent_env` and `projects` are hashed only
   * when set; delete "when set" and every token is still present, so this passes while the reader is told
   * all eight fields are always hashed. Guarding it would mean pinning a prose substring next to two
   * specific keys — brittle in a different way, and a guard that fires on rewording trains authors to
   * route around it. The honest position is that the FIELD SET is guarded and the CONDITIONALITY is not.
   */
  it("does not catch a deleted conditional qualifier (documented limitation)", () => {
    const errs = checkFingerprintFieldClaims({
      keys: KEYS,
      corpus: site("`sessionFingerprint`: folders, plugins, skills, mcp, egress, web_fetch, projects, agent_env."),
    });
    expect(errs).toEqual([]);
  });
});

describe("the real corpus", () => {
  it("every discovered site is complete, and there are more than the three once assumed", () => {
    const R = process.cwd();
    const r = (p: string) => readFileSync(join(R, p), "utf8");
    const md = execFileSync("git", ["-C", R, "ls-files", "-z", "*.md"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .filter(
        (p) =>
          p !== "CHANGELOG.md" && (!p.includes("/") || ["docs/", ".claude/skills/", "examples/", "python/"].some((d) => p.startsWith(d))),
      );
    const corpus = [
      ...md.map((p) => ({ path: p, text: r(p) })),
      ...readdirSync(join(R, "schema"))
        .filter((f) => /^cassette\.v\d+\.json$/.test(f))
        .map((f) => ({ path: `schema/${f}`, text: r(`schema/${f}`) })),
    ];
    const { keys, error } = fingerprintShapeKeys(r("src/run/cassette.ts"));
    expect(error).toBeUndefined();
    expect(checkFingerprintFieldClaims({ keys, corpus })).toEqual([]);
  });
});
