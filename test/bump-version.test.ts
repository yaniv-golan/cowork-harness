import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rewriteFileContent, parseArgs, TARGET_FILES } from "../scripts/bump-version.js";

describe("parseArgs", () => {
  it("accepts a bare X.Y.Z version and defaults to dry-run", () => {
    expect(parseArgs(["0.34.0"])).toEqual({ version: "0.34.0", write: false });
  });

  it("recognizes --write", () => {
    expect(parseArgs(["0.34.0", "--write"])).toEqual({ version: "0.34.0", write: true });
    expect(parseArgs(["--write", "0.34.0"])).toEqual({ version: "0.34.0", write: true });
  });

  it("rejects a missing version", () => {
    expect(() => parseArgs([])).toThrow(/expected an X\.Y\.Z version/);
  });

  it("rejects a non-semver token", () => {
    expect(() => parseArgs(["latest"])).toThrow(/expected an X\.Y\.Z version/);
    expect(() => parseArgs(["v0.34.0"])).toThrow(/expected an X\.Y\.Z version/);
    expect(() => parseArgs(["0.34"])).toThrow(/expected an X\.Y\.Z version/);
  });

  it("does not treat --dry-run as the version (no such flag exists — dry-run is the default)", () => {
    // Regression guard for the trap the plan's adversarial review caught: npm swallows --dry-run
    // unless forwarded with `--`, so a naive implementation could silently do a real bump. This repo's
    // script has no --dry-run flag at all; dry-run is simply the absence of --write.
    expect(parseArgs(["0.34.0", "--dry-run"])).toEqual({ version: "0.34.0", write: false });
  });
});

describe("rewriteFileContent — JSON version fields", () => {
  it("bumps package.json's top-level version key only", () => {
    const before = ["{", '  "name": "cowork-harness",', '  "version": "0.33.0",', '  "license": "MIT"', "}", ""].join("\n");
    const after = rewriteFileContent("package.json", before, "0.34.0");
    expect(after).toContain('"version": "0.34.0"');
    expect(after).not.toContain("0.33.0");
  });

  it("bumps marketplace.json's plugins[0].version", () => {
    const before = JSON.stringify({ plugins: [{ name: "cowork-harness", version: "0.33.0" }] }, null, 2);
    const after = rewriteFileContent(".claude-plugin/marketplace.json", before, "0.34.0");
    expect(JSON.parse(after).plugins[0].version).toBe("0.34.0");
  });

  it("bumps plugin.json's version field", () => {
    const before = JSON.stringify({ name: "cowork-harness", version: "0.33.0" }, null, 2);
    const after = rewriteFileContent(".claude/skills/cowork-harness/.claude-plugin/plugin.json", before, "0.34.0");
    expect(JSON.parse(after).version).toBe("0.34.0");
  });
});

describe("rewriteFileContent — floors", () => {
  it("bumps a cowork-harness@>=X.Y.Z floor", () => {
    const before = 'install once with `npm i -g "cowork-harness@>=0.33.0"`.';
    const after = rewriteFileContent(".claude/skills/cowork-harness/references/ci-recipe.md", before, "0.34.0");
    expect(after).toContain("cowork-harness@>=0.34.0");
    expect(after).not.toContain("0.33.0");
  });

  it("bumps a bare `@>=X.Y.Z` floor in README.md (no cowork-harness prefix)", () => {
    const before = "The companion skill's `@>=0.33.0` floor guidance applies to ad-hoc CLI installs, not this input.";
    const after = rewriteFileContent("README.md", before, "0.34.0");
    expect(after).toContain("`@>=0.34.0`");
    expect(after).not.toContain("0.33.0");
  });

  it("bumps both a cowork-harness@>=X.Y.Z floor and a bare @>=X.Y.Z floor in the same README.md content", () => {
    const before =
      'From a global install (`npm i -g "cowork-harness@>=0.33.0"`)... ' +
      "the companion skill's `@>=0.33.0` floor guidance applies to ad-hoc CLI installs.";
    const after = rewriteFileContent("README.md", before, "0.34.0");
    expect(after).toContain("cowork-harness@>=0.34.0");
    expect(after).toContain("`@>=0.34.0`");
    expect(after).not.toContain("0.33.0");
  });

  it("does NOT touch an unrelated bare-looking floor outside README.md's rewrite rule", () => {
    // examples/replays/README.md only gets the cowork-harness@>=X.Y.Z rule (per the plan's table);
    // a bare `@>=X` there (which doesn't currently occur, but hypothetically) should survive.
    const before = 'npm i -g "cowork-harness@>=0.33.0", or a bare `@>=0.33.0` mention.';
    const after = rewriteFileContent("examples/replays/README.md", before, "0.34.0");
    expect(after).toContain("cowork-harness@>=0.34.0");
    expect(after).toContain("`@>=0.33.0`"); // bare form untouched — not in this file's rule set
  });
});

describe("rewriteFileContent — SKILL.md", () => {
  const SKILL_MD = ".claude/skills/cowork-harness/SKILL.md";

  function fixture(): string {
    return [
      "---",
      "name: cowork-harness",
      "description: some description",
      "metadata:",
      "  author: cowork-harness",
      "  version: 0.33.0",
      "  tracks-harness: cowork-harness 0.33.0 (baseline desktop-1.20186.1)",
      "---",
      "",
      "# cowork-harness",
      "",
      "> **Version note:** the facts and `file:line` pointers here track `cowork-harness 0.33.0`",
      "> (baseline `desktop-1.20186.1`). If your checkout is newer, prefer the live `--help`.",
      "",
      "- **CLI on PATH, recent enough?** Run `cowork-harness --version` — this skill needs **≥ 0.33.0**. " +
        'If missing, run `npx "cowork-harness@>=0.33.0" <cmd>` or `npm i -g "cowork-harness@>=0.33.0"`. ' +
        "**Pin `@>=0.33.0`, never `@latest`** — the floor fails loud.",
      "",
      "  What the ≥ 0.33.0 floor gates, by release:",
      "",
      "  - **0.33.0:** the redacted marker + debug.thinking_display escape hatch.",
      "",
      "the loop 0.33.0's observability is built for triage.",
      "",
    ].join("\n");
  }

  it("bumps the frontmatter version: line", () => {
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toMatch(/^\s*version:\s*0\.34\.0\s*$/m);
  });

  it("bumps the tracks-harness version token but leaves the baseline token untouched", () => {
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toContain("tracks-harness: cowork-harness 0.34.0 (baseline desktop-1.20186.1)");
  });

  it("bumps the Version note track `cowork-harness X.Y.Z` mention", () => {
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toContain("track `cowork-harness 0.34.0`");
  });

  it("bumps the needs **≥ X.Y.Z** sentence", () => {
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toContain("needs **≥ 0.34.0**");
  });

  it("bumps the What the ≥ X.Y.Z floor gates heading", () => {
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toContain("What the ≥ 0.34.0 floor gates");
  });

  it("bumps every cowork-harness@>=X.Y.Z floor", () => {
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toContain('npx "cowork-harness@>=0.34.0" <cmd>');
    expect(after).toContain('npm i -g "cowork-harness@>=0.34.0"');
  });

  it("bumps the bare `Pin `@>=X.Y.Z`` floor (no cowork-harness prefix) — the gap that shipped stale in 1.0.0", () => {
    // Regression: SKILL.md's `Pin `@>=X`` is a bare floor with no `cowork-harness` prefix, so
    // bumpHarnessFloors misses it and check:versions (which reads only the first cowork-harness@>=
    // match) can't see it. It rotted from 0.33.0 through 1.0.0 until bumpBareFloors was wired into
    // the SKILL.md case too.
    const after = rewriteFileContent(SKILL_MD, fixture(), "0.34.0");
    expect(after).toContain("Pin `@>=0.34.0`");
    expect(after).not.toContain("Pin `@>=0.33.0`");
  });

  it("CRITICAL: leaves a `- **<from-version>:** …` release-note bullet completely unchanged", () => {
    // This is the real regression a naive old->new replace causes: the bullet CONTAINS the
    // bump-from version ("0.33.0"), so it can only survive if the rewrite is pattern-scoped to the
    // surrounding context (tracks-harness:, needs **≥**, cowork-harness@>=, etc.) rather than a blind
    // substring swap of every "0.33.0" occurrence.
    const before = fixture();
    const after = rewriteFileContent(SKILL_MD, before, "0.34.0");
    expect(after).toContain("- **0.33.0:** the redacted marker + debug.thinking_display escape hatch.");
  });

  it('CRITICAL: leaves "the loop <from-version>\'s observability" prose completely unchanged', () => {
    const before = fixture();
    const after = rewriteFileContent(SKILL_MD, before, "0.34.0");
    expect(after).toContain("the loop 0.33.0's observability is built for triage.");
  });

  it("no-op bump (same version) leaves content byte-identical", () => {
    const before = fixture();
    const after = rewriteFileContent(SKILL_MD, before, "0.33.0");
    expect(after).toBe(before);
  });
});

describe("rewriteFileContent — references/*.md Tracks stamp", () => {
  it("bumps the Tracks `cowork-harness X.Y.Z` stamp in scenario-schema.md", () => {
    const before =
      "Self-contained reference for authoring `cowork-harness` scenarios. Tracks `cowork-harness 0.33.0`\n(baseline `desktop-1.20186.1`).";
    const after = rewriteFileContent(".claude/skills/cowork-harness/references/scenario-schema.md", before, "0.34.0");
    expect(after).toContain("Tracks `cowork-harness 0.34.0`");
    expect(after).toContain("desktop-1.20186.1"); // baseline mention untouched
  });

  it("bumps the Tracks stamp in fidelity-and-answers.md", () => {
    const before = "Self-contained reference. Tracks `cowork-harness 0.33.0` (baseline `desktop-1.20186.1`).";
    const after = rewriteFileContent(".claude/skills/cowork-harness/references/fidelity-and-answers.md", before, "0.34.0");
    expect(after).toContain("Tracks `cowork-harness 0.34.0`");
  });
});

describe("rewriteFileContent — ci-recipe.md", () => {
  const CI_RECIPE = ".claude/skills/cowork-harness/references/ci-recipe.md";

  it("bumps the Tracks stamp, the version example, and every floor", () => {
    const before = [
      "Self-contained reference. Tracks `cowork-harness 0.33.0` (baseline `desktop-1.20186.1`).",
      "",
      'release; pin an exact version (e.g. `version: "0.33.0"`) for reproducible CI.',
      "",
      '- run: npm i -g "cowork-harness@>=0.33.0"',
    ].join("\n");
    const after = rewriteFileContent(CI_RECIPE, before, "0.34.0");
    expect(after).toContain("Tracks `cowork-harness 0.34.0`");
    expect(after).toContain('e.g. `version: "0.34.0"`');
    expect(after).toContain("cowork-harness@>=0.34.0");
    expect(after).not.toContain("0.33.0");
  });
});

describe("rewriteFileContent — unregistered file", () => {
  it("throws for a file with no rewrite rule", () => {
    expect(() => rewriteFileContent("CHANGELOG.md", "## [0.33.0]", "0.34.0")).toThrow(/no rewrite rule registered/);
  });
});

describe("TARGET_FILES", () => {
  it("lists every file the plan's P3 table calls out, and nothing else", () => {
    expect(TARGET_FILES).toEqual([
      "package.json",
      ".claude-plugin/marketplace.json",
      ".claude/skills/cowork-harness/.claude-plugin/plugin.json",
      ".claude/skills/cowork-harness/SKILL.md",
      ".claude/skills/cowork-harness/references/scenario-schema.md",
      ".claude/skills/cowork-harness/references/fidelity-and-answers.md",
      ".claude/skills/cowork-harness/references/task-recipes.md",
      ".claude/skills/cowork-harness/references/ci-recipe.md",
      "examples/replays/README.md",
      "README.md",
    ]);
  });

  it("every target file has a working rewrite rule (does not throw) on trivial content", () => {
    for (const file of TARGET_FILES) {
      expect(() => rewriteFileContent(file, "no version here", "0.34.0")).not.toThrow();
    }
  });

  it("bumps the Tracks stamp in each reference file's REAL committed content — synthetic fixtures once hid a line-wrapped stamp the space-literal regex could not match", () => {
    const stampRefs = [
      ".claude/skills/cowork-harness/references/scenario-schema.md",
      ".claude/skills/cowork-harness/references/fidelity-and-answers.md",
      ".claude/skills/cowork-harness/references/task-recipes.md",
      ".claude/skills/cowork-harness/references/ci-recipe.md",
    ];
    for (const file of stampRefs) {
      const real = readFileSync(resolve(file), "utf8");
      const next = rewriteFileContent(file, real, "9.9.9");
      expect(next, `${file}: bump was a no-op on the real content`).toContain("Tracks `cowork-harness 9.9.9`");
      expect(next).not.toMatch(/Tracks `cowork-harness \d+\.\d+\.\d+`.*Tracks `cowork-harness (?!9\.9\.9)/s);
    }
  });
});
