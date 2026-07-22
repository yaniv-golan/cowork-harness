import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// THREE COMMANDS THAT FAILED SILENTLY ON A PRE-LAYOUT DIR.
//
// Each was found by running the SAME command against the same fixtures on both sides of the per-turn
// layout change and diffing the behaviour — not by reading the code, which looked right. All three were
// correctly-shaped seam calls that resolve to nothing on a legacy dir, and "nothing" reads as "no
// difference" / "no verdict" / "nothing to index". A silent false-green in a gate command is worse than
// the pre-layout behaviour it replaced.

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

/** A pre-layout run dir: artifacts at the root, no `turns/`. */
function legacyDir(root: string, scenario: string, id: string, opts: { result: string; fidelity: string }): string {
  const d = join(root, scenario, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "result.json"),
    JSON.stringify({
      scenario,
      result: opts.result,
      effectiveFidelity: opts.fidelity,
      baseline: "latest",
      assertions: [],
      verdict: { pass: opts.result === "success" },
    }),
  );
  writeFileSync(join(d, "run.jsonl"), `{"t":"transcript","text":"${opts.result}"}`);
  writeFileSync(join(d, "events.jsonl"), `{"type":"tool_use","name":"Bash","input":{"command":"ls"}}\n`);
  writeFileSync(join(d, "status.json"), JSON.stringify({ startedAt: "2026-07-20T10:00:00.000Z" }));
  return d;
}

function turnsDir(root: string, scenario: string, id: string, opts: { result: string }): string {
  const d = join(root, scenario, id, "turns", "1");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "result.json"),
    JSON.stringify({ scenario, result: opts.result, turn: 1, verdict: { pass: opts.result === "success" } }),
  );
  writeFileSync(join(d, "run.jsonl"), `{"t":"transcript"}`);
  const run = join(root, scenario, id);
  writeFileSync(join(run, "events.jsonl"), "");
  writeFileSync(join(run, "status.json"), JSON.stringify({ startedAt: "2026-07-20T12:00:00.000Z" }));
  return run;
}

describe.skipIf(!can)("diff refuses a pre-layout dir instead of calling two different runs identical", () => {
  it("does not report two genuinely different legacy runs as identical", () => {
    // Reproduced against the pre-layout build: it exited 1 and reported both deltas. After the layout
    // change `latestTurn` returns undefined, `?? 1` resolves to a turns/1 that does not exist, and BOTH
    // transcript and meta come back empty — so diff prints "identical" and exits 0. diff is the
    // regression gate; a false green here is the worst possible failure in this command.
    const root = mkdtempSync(join(tmpdir(), "diff-legacy-"));
    const a = legacyDir(root, "scn", "sess-a", { result: "success", fidelity: "protocol" });
    const b = legacyDir(root, "scn", "sess-b", { result: "failure", fidelity: "container" });
    const r = spawnSync("node", [CLI, "diff", a, b], { encoding: "utf8" });
    const all = `${r.stdout}${r.stderr}`;
    expect(all, "two different runs were reported as identical").not.toMatch(/^identical$/m);
    expect(r.status, "a pre-layout dir must not produce a silent pass").not.toBe(0);
    expect(all).toMatch(/pre-layout|legacy|migrate/i);
    rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!can)("status --latest-for refuses rather than silently selecting the wrong run", () => {
  it("does not report a PASS for a scenario whose newest run FAILED", () => {
    // The subtler half. On a legacy dir the recency signal falls back from run-END (result mtime) to
    // run-START (status.json), which changes WHICH run is selected — so `.verdict.pass` flipped from
    // false to true. Same disk, same command, exit 0 both ways, no warning. A CI script gating on
    // .verdict.pass reads a green light for a failing run.
    const root = mkdtempSync(join(tmpdir(), "latest-legacy-"));
    const legacy = legacyDir(root, "scn", "sess-legacy", { result: "failure", fidelity: "protocol" });
    turnsDir(root, "scn", "sess-current", { result: "success" });
    // The legacy run FINISHED last, so it is genuinely the latest.
    utimesSync(
      join(legacy, "result.json"),
      new Date("2026-07-20T16:00:00Z").getTime() / 1000,
      new Date("2026-07-20T16:00:00Z").getTime() / 1000,
    );

    const r = spawnSync("node", [CLI, "status", "--latest-for", "scn", "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root },
    });
    const all = `${r.stdout}${r.stderr}`;
    expect(all, "reported a PASS while the newest run failed").not.toMatch(/"pass"\s*:\s*true/);
    expect(r.status, "a pre-layout candidate must not yield a confident answer").not.toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!can)("stats --reindex reports what it could not index", () => {
  it("does not silently drop a pre-layout run from the index", () => {
    // --reindex is documented as the one-time migration for pre-index runs, i.e. aimed squarely at the
    // legacy population. Dropping those silently while printing a confident "reindexed N run(s)" defeats
    // the command's entire purpose.
    const root = mkdtempSync(join(tmpdir(), "reindex-legacy-"));
    legacyDir(root, "scn", "sess-legacy", { result: "success", fidelity: "protocol" });
    turnsDir(root, "scn", "sess-current", { result: "success" });

    const r = spawnSync("node", [CLI, "stats", "--reindex"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root },
    });
    const all = `${r.stdout}${r.stderr}`;
    expect(all, "a skipped pre-layout run was never mentioned").toMatch(/skipped|unmigrated|pre-layout|legacy/i);
    expect(all, "the remedy was not named").toMatch(/migrate-run-dir/);
    rmSync(root, { recursive: true, force: true });
  });
});
