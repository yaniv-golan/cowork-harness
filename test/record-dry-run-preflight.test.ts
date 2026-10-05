import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// `record --dry-run` is the DOCUMENTED token-free validation path — SKILL.md ("to check that a scenario
// loads without spending"), docs/scenario.md ("runs the real loader"), docs/cassette.md ("preview + REAL
// loader check"), README ("the token-free way to check whether a scenario still loads"). A consumer who
// follows that advice — including in a CI "scenario load check" step — must not be told a scenario is
// fine and then have the real `record` refuse it.
//
// That principle is already written down three lines from the code under test, on the budget gate:
// "A dry run whose whole job is 'tell me what this would do before I spend' must not report clean and
// then be refused for real — that is a false preview, and it is free to check." Both scenario-level
// refusals below are free to check (pure functions over the parsed scenario), so the same rule applies.
//
// Reported by a founder-skills consumer against 1.20.0-unreleased: the contradiction refusal shipped on
// the execution path only, and `record --dry-run` — the one non-opt-in place they'd hit it — exited 0.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function tmpWork() {
  return mkdtempSync(join(tmpdir(), "rec-dry-preflight-"));
}
function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      COWORK_HARNESS_RUNS_DIR: join(mkdtempSync(join(tmpdir(), "rec-dry-runs-")), "runs"),
      // A run must resolve a model (4.0.0), and that refusal precedes the ones this file is about.
      COWORK_HARNESS_MODEL: "claude-sonnet-5",
      ...extraEnv,
      // A PLACEHOLDER credential, and it spends nothing. `record`'s auth guard (cassette.ts) sits ABOVE
      // the single-file arm, so on the real path — with no token in the environment — every pre-spend
      // refusal is preempted by "no model credentials" (exit 2) and the refusal never runs. That is the
      // state in CI, which sets no token; locally this repo's gitignored `.env` supplies one, so without
      // this line the real-vs-preview comparison below passes here and FAILS in CI. The guard is
      // presence-only and every case in this file is refused or previewed before any spawn, so a dummy
      // value cannot reach the API.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "placeholder-not-used-no-spawn-in-this-suite",
    },
  });
  return { code: r.status, all: (r.stdout ?? "") + (r.stderr ?? "") };
}

const CONTRADICTORY = (name: string) =>
  `name: ${name}\nprompt: hi\nfidelity: protocol\nassert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n`;
const PROMPT_POLICY = (name: string) =>
  `name: ${name}\nprompt: hi\nfidelity: protocol\non_unanswered: prompt\nassert:\n  - result: success\n`;
const CLEAN = (name: string) => `name: ${name}\nprompt: hi\nfidelity: protocol\nassert:\n  - result: success\n`;

describe.skipIf(!can)("record --dry-run — scenario-level refusals (no false preview)", () => {
  it("refuses a statically unsatisfiable scenario, single file", () => {
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    const r = cli(["record", join(w, "c.yaml"), "--dry-run"]);
    expect(r.code, "dry-run must not green a scenario the real record refuses").not.toBe(0);
    expect(r.all).toMatch(/no run can satisfy/);
  });

  it("agrees with the real record path — both refuse the same scenario", () => {
    // The precedence claim in one assertion: if these ever disagree, the dry run is a false preview
    // again, whichever direction it drifts.
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    const dry = cli(["record", join(w, "c.yaml"), "--dry-run"]);
    const real = cli(["record", join(w, "c.yaml"), "--out", join(w, "c.cassette.json")]);
    expect(dry.code).not.toBe(0);
    expect(real.code).not.toBe(0);
    // The EXIT CODE is part of "agrees with the real record path". `.not.toBe(0)` on both sides passed
    // for months while the preview answered 2 and the real command answered 1 — so a consumer wrapping
    // `--dry-run` could not tell a scenario refused for policy from one with a schema error (which
    // legitimately exits 2, and still does; see the sibling test below).
    expect(dry.code, "the preview must give the code the real record gives").toBe(real.code);
    expect(existsSync(join(w, "c.cassette.json")), "the real path must not have written a cassette").toBe(false);
  });

  it("answers the same code for a broken scenario on every arm, flags included", () => {
    // The table this pins used to read 1 / 2 / 2: `record broken.yaml` exited 1, and exited 2 if you
    // happened to pass an unrelated cost-cap flag, because the parse ran in two places under two
    // different catches. Nothing decided that. `--max-budget-usd` is the row that would have caught the
    // class, so it is the row that must stay.
    const w = tmpWork();
    writeFileSync(join(w, "broken.yaml"), CLEAN("broken").replace("assert:", "assert:\n  - not_a_real_key: true"));
    const f = join(w, "broken.yaml");
    expect(cli(["record", f]).code, "no flags").toBe(2);
    expect(cli(["record", f, "--max-budget-usd", "1"]).code, "an unrelated flag must not change the answer").toBe(2);
    expect(cli(["record", f, "--dry-run"]).code, "the preview").toBe(2);
    // A file that is simply absent is not a parse failure, and does not report as one.
    const missing = cli(["record", join(w, "nope.yaml")]);
    expect(missing.code).toBe(2);
    expect(missing.all).toMatch(/scenario path not found/);
  });

  it("a directory of all-broken files exits 1 on BOTH arms; an empty directory exits 2 on both", () => {
    // "broken" is not "nothing". The real arm used to answer `no scenarios discovered` (exit 2) for a
    // directory whose files all fail to load — the wrong description, and disagreeing with the preview
    // (1) on precisely the corpus-wide-schema-break case where the two get compared.
    // NOTE both dirs here are unrunnable by construction (all-broken / empty), so neither arm spawns.
    const w = tmpWork();
    const allBroken = join(w, "allbroken");
    const empty = join(w, "empty");
    mkdirSync(allBroken);
    mkdirSync(empty);
    for (const n of ["b1.yaml", "b2.yaml"])
      writeFileSync(join(allBroken, n), CLEAN("b").replace("assert:", "assert:\n  - not_a_real_key: true"));
    const real = cli(["record", allBroken]);
    expect(real.code, "all-broken, real path").toBe(1);
    expect(real.all).toMatch(/no loadable scenarios/);
    expect(cli(["record", allBroken, "--dry-run"]).code, "all-broken, preview").toBe(1);
    expect(cli(["record", empty]).code, "empty dir, real path").toBe(2);
    expect(cli(["record", empty, "--dry-run"]).code, "empty dir, preview").toBe(2);
  });

  it("writes the --decider-dir terminal marker on EVERY pre-spend exit, existing dir or not", () => {
    // A `gates --follow` watcher hangs without {done:true}. `fileChannel` guarantees it via an exit
    // handler, but it is opened AFTER the pre-spend guards, so each guard above it used to strand a
    // watcher. Fixing them one at a time is how this was missed twice: the budget gate moved next to the
    // other refusals without picking up the write, and a per-site write assumed the dir already existed.
    const w = tmpWork();
    writeFileSync(join(w, "broken.yaml"), CLEAN("broken").replace("assert:", "assert:\n  - not_a_real_key: true"));
    const marker = (dir: string) => existsSync(join(dir, "done.json"));

    const existing = join(w, "d-existing");
    mkdirSync(existing);
    expect(cli(["record", join(w, "broken.yaml"), "--decider-dir", existing]).code).toBe(2);
    expect(marker(existing), "load failure, dir already there").toBe(true);

    // NOT pre-created: `fileChannel` mkdirs, so a watcher's dir may legitimately not exist yet.
    const absent = join(w, "d-absent");
    expect(cli(["record", join(w, "nope.yaml"), "--decider-dir", absent]).code).toBe(2);
    expect(marker(absent), "missing scenario, dir not pre-created").toBe(true);

    // The reported case: a --max-budget-usd refusal, which needs priced history to fire at all.
    const runs = mkdtempSync(join(tmpdir(), "rec-budget-runs-"));
    writeFileSync(join(w, "ok.yaml"), CLEAN("budget-probe"));
    writeFileSync(
      join(runs, "index.jsonl"),
      JSON.stringify({
        v: 1,
        ts: "2026-08-30T00:00:00Z",
        command: "record",
        scenario: "budget-probe",
        slug: "budget-probe",
        runId: "x1",
        fidelity: "protocol",
        baseline: "latest",
        result: "success",
        pass: true,
        signals: [],
        partial: false,
        nonDeterministic: false,
        outDir: "/tmp/x1",
        costUsd: 5,
        git: { branch: "main", sha: "abc" },
      }) + "\n",
    );
    const budget = join(w, "d-budget");
    const r = cli(
      ["record", join(w, "ok.yaml"), "--out", join(w, "b.cassette.json"), "--max-budget-usd", "0.01", "--decider-dir", budget],
      {
        COWORK_HARNESS_RUNS_DIR: runs,
      },
    );
    expect(r.all, "the budget gate must be what refused (not some earlier guard)").toMatch(/refused before spending/);
    expect(marker(budget), "budget refusal").toBe(true);
  });

  it("the PREVIEW arm summarises an all-broken directory too — it is the arm CI runs", () => {
    // The real arm got this summary first; the directory dry-run is what ci-recipe.md teaches and what
    // this repo's own workflow calls, and it printed one parser dump per file with nothing saying that
    // NOTHING loaded. Survives --quiet, like the ✗ broken: lines: it is the failure, not the preview.
    const w = tmpWork();
    const dir = join(w, "allbroken");
    mkdirSync(dir);
    for (const n of ["b1.yaml", "b2.yaml", "b3.yaml"])
      writeFileSync(join(dir, n), CLEAN("b").replace("assert:", "assert:\n  - not_a_real_key: true"));
    const r = cli(["record", dir, "--dry-run", "--quiet"]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/no loadable scenarios under .* — all 3 file\(s\) failed to load/);
  });

  it("separates a policy refusal (1) from a schema error (2)", () => {
    // Both used to exit 2, which is what made `record <file> --dry-run` unusable as a "does this load?"
    // check on any corpus where the refusal is routine.
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    writeFileSync(join(w, "broken.yaml"), CLEAN("broken").replace("assert:", "assert:\n  - not_a_real_key: true"));
    expect(cli(["record", join(w, "c.yaml"), "--dry-run"]).code, "a pre-spend refusal").toBe(1);
    const bad = cli(["record", join(w, "broken.yaml"), "--dry-run"]);
    expect(bad.code, "a scenario the loader rejects").toBe(2);
    expect(bad.all).toMatch(/not_a_real_key/);
  });

  it("still greens a clean scenario (the refusal is not a blanket non-zero)", () => {
    const w = tmpWork();
    writeFileSync(join(w, "ok.yaml"), CLEAN("ok"));
    expect(cli(["record", join(w, "ok.yaml"), "--dry-run"]).code).toBe(0);
  });

  it("reports EVERY offender in a batch, not just the first", () => {
    // A dry run over N scenarios exists to learn about all N in one pass. Aborting at the first bad file
    // turns a 24-scenario preflight into 24 sequential round trips — the failure mode the consumer hit
    // from the other side (a contradiction in #18 aborting a paid batch mid-flight).
    const w = tmpWork();
    writeFileSync(join(w, "a-contra.yaml"), CONTRADICTORY("a-contra"));
    writeFileSync(join(w, "b-ok.yaml"), CLEAN("b-ok"));
    writeFileSync(join(w, "c-contra.yaml"), CONTRADICTORY("c-contra"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.code).not.toBe(0);
    expect(r.all, "first offender missing").toMatch(/a-contra/);
    expect(r.all, "second offender missing — the batch stopped early").toMatch(/c-contra/);
  });

  it("greens a batch where every scenario is clean", () => {
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("a"));
    writeFileSync(join(w, "b.yaml"), CLEAN("b"));
    expect(cli(["record", w, "--dry-run"]).code).toBe(0);
  });

  it("refuses on_unanswered: prompt in a BATCH dry-run too", () => {
    // The single-file dry-run arm has always run promptPolicyRejection; the batch arm never did, so the
    // same scenario greened in a directory and was refused per-scenario by the real record. Fixing the
    // contradiction gap without this one would leave an arbitrary split: batch dry-run checking one
    // scenario-level refusal but not its sibling.
    const w = tmpWork();
    writeFileSync(join(w, "p.yaml"), PROMPT_POLICY("prompty"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/on_unanswered: prompt/);
  });

  it("--quiet suppresses the preview but never a refusal", () => {
    // --quiet's contract is "silent on success, loud on failure" (docs/cassette.md). A muted refusal
    // would make the CI-shaped invocation the one that hides the finding.
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    const r = cli(["record", w, "--dry-run", "--quiet"]);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/no run can satisfy/);
  });
});

describe.skipIf(!can)("record --dry-run — batch cost estimate", () => {
  // The estimate was computed and then discarded unless it happened to exceed a cap, so learning the
  // number required bisecting --max-budget-usd. It is a pure history lookup — free to report.
  it("reports the batch cost estimate without requiring --max-budget-usd", () => {
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("a"));
    writeFileSync(join(w, "b.yaml"), CLEAN("b"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.all, "no cost estimate on the passing path").toMatch(/estimate/i);
  });

  it("carries the estimate in the JSON payload", () => {
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("a"));
    const r = cli(["record", w, "--dry-run", "--output-format", "json"]);
    const payload = JSON.parse(r.all.slice(r.all.indexOf("{"), r.all.lastIndexOf("}") + 1));
    const body = payload.results?.[0] ?? payload;
    expect(body, "estimatedCostUsd missing from the dry-run payload").toHaveProperty("estimatedCostUsd");
    expect(body).toHaveProperty("unpricedScenarios");
  });

  it("says the estimate is a LOWER BOUND when scenarios have no priced history", () => {
    // An estimate summed over partially-unpriced history must never read as authoritative — an
    // unqualified "$0.00" on a fresh corpus is worse than no number at all.
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("never-run-before"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.all).toMatch(/lower bound/i);
  });
});
