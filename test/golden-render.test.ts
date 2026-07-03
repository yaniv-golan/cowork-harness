import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { diffBaselines, renderChangelog } from "../src/sync/baseline-diff.js";

// Golden snapshot suite for the two DIFF RENDERERS (E7 changelog, E2 run/cassette text view) — the
// full-output complement to the per-branch substring assertions in test/baseline-diff.test.ts and
// test/cli-diff.test.ts. Substring tests prove each prose branch exists; only a whole-output snapshot
// catches section ordering, spacing, and composition drift. The changelog especially is a PUBLISHABLE
// artifact (the per-release "weather report" feed), so its full rendering is a contract, not cosmetics.
// Bless intentional changes via `npm run test:golden:update` (same workflow as test/golden.test.ts).
//
// Inputs are frozen fixtures only — the committed cassette and test/fixtures/baselines/ copies — never
// live baselines/*.json (they churn every sync and would rot the snapshot).

const FIXTURE_A = resolve("test/fixtures/baselines/desktop-fixture-a.json");
const FIXTURE_B = resolve("test/fixtures/baselines/desktop-fixture-b.json");
const CASSETTE = resolve("examples/replays/example-pdf-skill.cassette.json");

describe("golden — E7 changelog rendering (full output)", () => {
  const a = JSON.parse(readFileSync(FIXTURE_A, "utf8"));
  const b = JSON.parse(readFileSync(FIXTURE_B, "utf8"));

  it("renderChangelog over the frozen fixture pair", () => {
    expect(renderChangelog(diffBaselines(a, b))).toMatchSnapshot();
  });
});

// The E2 text renderer (renderDiffText) is private to cli.ts, so its golden runs through the real CLI —
// which is also the stronger test (§9 lesson 2: real command output over synthetic fixtures). The
// mutation is deterministic (rename one tool in a copy of the committed cassette), so stdout is stable.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

describe.skipIf(!can)("golden — E2 diff text rendering (full CLI output)", () => {
  it("`diff <cassette> <mutated-copy>` renders all four view sections", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cowork-golden-diff-"));
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
    const r = spawnSync("node", [CLI, "diff", CASSETTE, mutated], { encoding: "utf8" });
    expect(r.status).toBe(1); // differing
    expect(r.stdout).toMatchSnapshot();
  });
});
