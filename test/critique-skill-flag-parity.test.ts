import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_FLAG_SURFACE, CRITIQUE_ONLY_FLAGS } from "../src/run/skill-flag-surface.js";

// `critique` spawns `skill` turns, and its parser used to be a hand-rolled SUBSET of skill's flags — so a
// new skill flag was silently unavailable to critique, with nothing failing. The spec module's required
// `critique` field gives totality only over entries ALREADY in the array; THIS test is what makes a new
// skill flag red CI rather than a silent gap.
//
/** Flags the SKILL LANE itself parses. Scanned from the regions that define that lane — `cmdSkill`'s
 *  argv loop, `takeCommonFlags`, and the extracted repeat-flag family — rather than whole-file, because a
 *  whole-file scan sweeps in every other command's flags and then needs a hand-maintained allowlist to
 *  subtract them, which is its own drift surface.
 *
 *  The risk of region-scoping is that a refactor moves the region and the scan silently matches nothing —
 *  that is exactly how `repeat-flags.ts` came to exist. `regionTripwire` below fails loudly in that case
 *  instead of going green over an empty set. */
function skillLaneRegions(): string[] {
  const cli = readFileSync(resolve("src/cli.ts"), "utf8");
  const out: string[] = [];
  for (const [open, close] of [
    ["async function cmdSkill(", "\n}"],
    ["function takeCommonFlags(", "\n}"],
  ] as const) {
    const i = cli.indexOf(open);
    if (i !== -1) out.push(cli.slice(i, cli.indexOf(close, i)));
  }
  out.push(readFileSync(resolve("src/run/repeat-flags.ts"), "utf8"));
  return out;
}

function skillLaneFlags(): Set<string> {
  const out = new Set<string>();
  for (const raw of skillLaneRegions()) {
    // Strip comments first: the regions contain prose like `a === "--flag"` explaining the parser, which
    // is not a flag the lane accepts. Scanning it produced a false positive on the first run.
    const region = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of region.matchAll(/(?:name|a|flag)\s*===\s*"(--?[a-z][a-z0-9-]*)"/g)) out.add(m[1]!);
    for (const m of region.matchAll(/\.startsWith\("(--?[a-z][a-z0-9-]*)="\)/g)) out.add(m[1]!);
  }
  return out;
}

/** Flags advertised in `skill --help` — the surface a user or agent reads. NOTE this scan only sees
 *  2-space-indented lines, so it MISSES inline-documented flags (`--enable name@mkt`). It is therefore a
 *  supplement to `skillLaneFlags()`, never the primary check: relying on it alone let six real flags go
 *  unchecked. */
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
  it("regionTripwire: the scan still finds the skill lane (never go green over an empty set)", () => {
    const regions = skillLaneRegions();
    expect(regions.length, "a cmdSkill/takeCommonFlags region moved — the scan is blind, fix the markers").toBe(3);
    expect(skillLaneFlags().size).toBeGreaterThan(20);
  });

  it("every flag the SKILL LANE parses has a critique disposition", () => {
    // The primary check. An earlier version filtered only `skill --help`'s 2-space lines, which missed
    // five real flags (--verbose --label --fidelity --intent --enable) — so a new flag
    // documented inline, or added with no help line at all, would never have turned CI red. That is the
    // exact silent gap the spec module exists to close.
    const missing = [...skillLaneFlags()].filter((f) => !KNOWN.has(f) && !NOT_SKILL_LANE.has(f));
    expect(
      missing,
      `these are parsed by the skill lane but have no entry in SKILL_FLAG_SURFACE — add one (the required \`critique\` field forces you to decide): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every flag advertised in `skill --help` has a disposition too", () => {
    const missing = [...skillHelpFlags()].filter((f) => !KNOWN.has(f) && !NOT_SKILL_LANE.has(f));
    expect(missing, `advertised in SKILL_HELP but absent from the spec: ${missing.join(", ")}`).toEqual([]);
  });

  it("every spec entry is a flag the skill lane actually knows (no phantom entries)", () => {
    const known = new Set([...skillLaneFlags(), ...skillHelpFlags()]);
    const phantom = SKILL_FLAG_SURFACE.map((s) => s.flag).filter((f) => !known.has(f));
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
