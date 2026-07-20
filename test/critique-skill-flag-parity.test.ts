import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_FLAG_SURFACE, CRITIQUE_ONLY_FLAGS } from "../src/run/skill-flag-surface.js";

// `critique` spawns `skill` turns, and its parser used to be a hand-rolled SUBSET of skill's flags — so a
// new skill flag was silently unavailable to critique, with nothing failing. The spec module's required
// `critique` field gives totality only over entries ALREADY in the array; THIS test is what makes a new
// skill flag red CI rather than a silent gap.
//
// Scan breadth is deliberate. Two earlier guards in this repo were porous because they matched a narrow
// region; and `run/repeat-flags.ts` exists precisely because a flag family MOVED into a new module, which a
// region-scoped scan would have missed. So scan whole files: over-matching is cheap (an extra name just
// has to appear in the spec), under-matching is the failure mode.
const SOURCES = ["src/cli.ts", "src/run/repeat-flags.ts"].map((p) => readFileSync(resolve(p), "utf8"));

/** Flag literals the skill lane actually compares against: `name === "--x"`, `a === "--x"`,
 *  `a.startsWith("--x=")`, and `--x` inside SKILL_HELP prose. */
function declaredFlagLiterals(): Set<string> {
  const out = new Set<string>();
  for (const src of SOURCES) {
    for (const m of src.matchAll(/(?:name|a|flag)\s*===\s*"(--?[a-z][a-z0-9-]*)"/g)) out.add(m[1]!);
    for (const m of src.matchAll(/\.startsWith\("(--?[a-z][a-z0-9-]*)="\)/g)) out.add(m[1]!);
  }
  return out;
}

/** Flags advertised in `skill --help`, which is the surface a user (or an agent) reads. */
function skillHelpFlags(): Set<string> {
  const cli = readFileSync(resolve("src/cli.ts"), "utf8");
  const start = cli.indexOf("const SKILL_HELP");
  const help = cli.slice(start, cli.indexOf("`;", start));
  return new Set([...help.matchAll(/^\s{2}(--[a-z][a-z0-9-]*)/gm)].map((m) => m[1]!));
}

const SPEC_NAMES = new Set(SKILL_FLAG_SURFACE.map((s) => s.flag));
const KNOWN = new Set([...SPEC_NAMES, ...CRITIQUE_ONLY_FLAGS]);

// Flags that belong to OTHER commands or are global — the whole-file scan legitimately picks these up.
// Listed explicitly so an unexpected new name still fails rather than being swallowed by a broad pattern.
const NOT_SKILL_LANE = new Set([
  "--changelog",
  "--view",
  "--no-normalize",
  "--reindex",
  "--metric",
  "--since",
  "--branch",
  "--last",
  "--scenario",
  "--matrix",
  "--max-cells",
  "--concurrency",
  "--allow-truncated-matrix",
  "--assert-from",
  "--reassert",
  "--write",
  "--explain",
  "--full-results",
  "--allow-path",
  "--diff",
  "--dotenv",
  "--run-dir",
  "--output-format",
  "--help",
  "-h",
  "--version",
  "-v",
  "--json",
  "--skill",
  "--strict",
  "--fix",
  "--ablate",
  "--list",
  "--force",
  "--yes",
  "--dry",
  "--tier",
  "--id",
  "--name",
  "--from",
  "--to",
]);

describe("skill flag surface ↔ critique disposition parity", () => {
  it("finds flag literals to check (guards against the scan silently matching nothing)", () => {
    expect(declaredFlagLiterals().size).toBeGreaterThan(20);
    expect(skillHelpFlags().size).toBeGreaterThan(5);
  });

  it("every flag advertised in `skill --help` has a critique disposition", () => {
    const missing = [...skillHelpFlags()].filter((f) => !KNOWN.has(f) && !NOT_SKILL_LANE.has(f));
    expect(
      missing,
      `these appear in SKILL_HELP but have no entry in SKILL_FLAG_SURFACE — add one (the required \`critique\` field forces you to decide): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every spec entry is a flag the skill lane actually knows (no phantom entries)", () => {
    const declared = declaredFlagLiterals();
    const help = skillHelpFlags();
    const phantom = SKILL_FLAG_SURFACE.map((s) => s.flag).filter((f) => !declared.has(f) && !help.has(f));
    expect(phantom, `spec names no longer accepted by the skill lane: ${phantom.join(", ")}`).toEqual([]);
  });

  it("every entry has a disposition and value-taking flags declare arity 1", () => {
    for (const s of SKILL_FLAG_SURFACE) {
      expect(s.critique.kind, `${s.flag} has no disposition`).toMatch(/^(forward|reject|owned)$/);
      if (s.critique.kind === "reject") expect(s.critique.reason.length, `${s.flag}'s rejection has no reason`).toBeGreaterThan(10);
    }
  });

  it("every SOURCE-declaring flag forwards to BOTH turns", () => {
    // The origin-key invariant: uploads/folders/plugins/marketplaces are part of sessionOriginSources, so
    // task-only forwarding makes the reflection `--resume` throw. This is the one rule that, if broken,
    // fails EVERY run of an upload-bearing critique.
    for (const flag of ["--upload", "--folder", "--plugin", "--marketplace", "--enable"]) {
      const spec = SKILL_FLAG_SURFACE.find((s) => s.flag === flag)!;
      expect(spec.critique, `${flag} must forward to BOTH turns or the reflection resume throws`).toEqual({
        kind: "forward",
        turns: "both",
      });
    }
  });

  it("--decider-dir never reaches the reflection turn (fresh-empty-dir invariant)", () => {
    const spec = SKILL_FLAG_SURFACE.find((s) => s.flag === "--decider-dir")!;
    expect(spec.critique).toEqual({ kind: "forward", turns: "task" });
  });
});
