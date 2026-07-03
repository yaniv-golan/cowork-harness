import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// CLI-level coverage for `diff`'s baseline mode (E7). The pure differ/changelog logic is unit-tested
// in test/baseline-diff.test.ts; this covers the command wiring — arg parsing, loadBaseline error
// handling, exit codes, --output-format. Fixtures per the plan's own guidance: freeze two small copies
// under test/fixtures/, never golden-test against live baselines/*.json (they churn every sync).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const FIXTURE_A = resolve("test/fixtures/baselines/desktop-fixture-a.json");
const FIXTURE_B = resolve("test/fixtures/baselines/desktop-fixture-b.json");
const CASSETTE = resolve("examples/replays/example-pdf-skill.cassette.json");

function run(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!can)("cli: diff (baseline mode, E7)", () => {
  it("exits 1 and lists differences for two different baselines", () => {
    const r = run(["diff", FIXTURE_A, FIXTURE_B]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("appVersion");
    expect(r.stdout).toContain("1.0.0-fixture-a");
    expect(r.stdout).toContain("1.0.0-fixture-b");
  });

  it("exits 0 and prints 'No differences.' for a baseline diffed against itself", () => {
    const r = run(["diff", FIXTURE_A, FIXTURE_A]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No differences.");
  });

  it("--changelog renders prose instead of the raw path-diff", () => {
    const r = run(["diff", FIXTURE_A, FIXTURE_B, "--changelog"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Desktop version bumped");
    expect(r.stdout).toContain("Annotations");
  });

  it("--output-format json emits a structured envelope with identical/entries", () => {
    const r = run(["diff", FIXTURE_A, FIXTURE_B, "--output-format", "json"]);
    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope).toMatchObject({ tool: "cowork-harness", command: "diff", kind: "baseline", identical: false });
    expect(Array.isArray(envelope.entries)).toBe(true);
    expect(envelope.entries.length).toBeGreaterThan(0);
  });

  it("an unresolvable baseline name is a usage error (exit 2), not a crash", () => {
    const r = run(["diff", "desktop-this-does-not-exist", FIXTURE_B]);
    expect(r.code).toBe(2);
  });

  it("requires exactly two positionals", () => {
    const r = run(["diff", FIXTURE_A]);
    expect(r.code).toBe(2);
  });

  it("`diff --help` prints usage and exits 0", () => {
    const r = run(["diff", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain("usage: diff");
  });
});

describe.skipIf(!can)("cli: diff (cassette/run mode, E2)", () => {
  it("a cassette self-diff is identical (§9 lesson 1 checkpoint, at the CLI layer)", () => {
    const r = run(["diff", CASSETTE, CASSETTE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("identical");
  });

  it("rejects mixing a baseline with a cassette — baselines only pair with baselines", () => {
    const r = run(["diff", FIXTURE_A, CASSETTE]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain("baselines only pair with baselines");
  });

  it("--changelog is rejected outside baseline mode (not silently ignored)", () => {
    const r = run(["diff", CASSETTE, CASSETTE, "--changelog"]);
    expect(r.code).toBe(2);
  });

  it("--output-format json emits identical:true with all four views for a self-diff", () => {
    const r = run(["diff", CASSETTE, CASSETTE, "--output-format", "json"]);
    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope).toMatchObject({ tool: "cowork-harness", command: "diff", kinds: ["cassette", "cassette"], identical: true });
    expect(envelope.views).toHaveProperty("tools");
    expect(envelope.views).toHaveProperty("transcript");
    expect(envelope.views).toHaveProperty("meta");
  });

  it("detects kind by CONTENT, not just the .cassette.json filename suffix — regression for a real bug " +
    "found during manual smoke-testing: a cassette-shaped file with a different name used to be silently " +
    "misread as a run's events.jsonl (one giant malformed line), producing an empty tool list instead of " +
    "an error", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cowork-diff-cli-"));
    const renamed = join(tmpDir, "not-named-like-a-cassette.json");
    copyFileSync(CASSETTE, renamed);
    const r = run(["diff", CASSETTE, renamed]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("identical");
  });

  it("detects a genuinely mutated tool call (renamed tool) as a real removed+added pair, not a false-identical", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cowork-diff-cli-"));
    const cassette = JSON.parse(readFileSync(CASSETTE, "utf8"));
    cassette.events = cassette.events.map((line: string) => {
      const ev = JSON.parse(line);
      if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_use" && block.name === "Skill") block.name = "MutatedToolName";
        }
      }
      return JSON.stringify(ev);
    });
    const mutated = join(tmpDir, "mutated.cassette.json");
    writeFileSync(mutated, JSON.stringify(cassette));
    const r = run(["diff", CASSETTE, mutated]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Skill");
    expect(r.stdout).toContain("MutatedToolName");
  });

  it("`--view tools` restricts text output to the tools section only", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cowork-diff-cli-"));
    const cassette = JSON.parse(readFileSync(CASSETTE, "utf8"));
    cassette.events = cassette.events.map((line: string) => {
      const ev = JSON.parse(line);
      if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "tool_use" && block.name === "Skill") block.name = "MutatedToolName";
        }
      }
      return JSON.stringify(ev);
    });
    const mutated = join(tmpDir, "mutated.cassette.json");
    writeFileSync(mutated, JSON.stringify(cassette));
    const r = run(["diff", CASSETTE, mutated, "--view", "tools"]);
    expect(r.stdout).toContain("tools:");
    expect(r.stdout).not.toContain("transcript:");
    expect(r.stdout).not.toContain("meta:");
  });

  it("rejects an invalid --view value", () => {
    const r = run(["diff", CASSETTE, CASSETTE, "--view", "bogus"]);
    expect(r.code).toBe(2);
  });
});
