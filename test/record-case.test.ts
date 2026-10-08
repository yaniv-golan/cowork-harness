import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectDiscovered } from "../src/run/cassette.js";
import { UsageError } from "../src/errors.js";
import { CLI, POSIX, exited, makeStubFixture, spawnCli } from "./helpers/stub-agent.js";

// `record <dir> --case <stem>`: the named scenarios are the batch. Every check after discovery, the dry-run
// estimate and the `--max-budget-usd` pre-flight cover them only, so re-recording one scenario of a large corpus is
// priced as that one scenario, not as the whole directory. Token-free: the dry-run and the refusals never spawn, and
// the real-arm test drives a stub agent.
const can = existsSync(CLI);
const PINNED = { COWORK_HARNESS_MODEL: "claude-sonnet-5" };

/** A priced run in the history `stats --reindex` indexes (the shape test/record-max-budget.test.ts seeds). */
function seedRun(root: string, scenario: string, costUsd: number) {
  const dir = join(root, scenario, "local_1");
  mkdirSync(join(dir, "turns", "1"), { recursive: true });
  writeFileSync(
    join(dir, "turns", "1", "result.json"),
    JSON.stringify({
      scenario,
      fidelity: "container",
      baseline: "desktop-1.18286.0",
      result: "success",
      decisions: [],
      egress: [],
      assertions: [],
      outDir: dir,
      cost: { usd: costUsd },
    }),
  );
}
const scenarioYaml = (name?: string) =>
  `${name ? `name: ${name}\n` : ""}prompt: "do the thing"\nfidelity: protocol\nassert:\n  - result: success\n`;

function cli(args: string[], root: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root, ...PINNED } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const json = (s: string) => JSON.parse(s.split("\n").find((l) => l.startsWith("{"))!);

/** a $0.50, b $0.40, c $0.30 of history; the scenarios take their name from the file stem. */
function corpus() {
  const root = mkdtempSync(join(tmpdir(), "rec-case-runs-"));
  const work = mkdtempSync(join(tmpdir(), "rec-case-work-"));
  for (const [stem, cost] of [
    ["a", 0.5],
    ["b", 0.4],
    ["c", 0.3],
  ] as const) {
    seedRun(root, stem, cost);
    writeFileSync(join(work, `${stem}.yaml`), scenarioYaml());
  }
  cli(["stats", "--reindex"], root);
  return { root, work };
}

describe.skipIf(!can)("record <dir> --case: the budget pre-flight prices the named scenarios only", () => {
  it("the whole dir is refused at a cap that one named scenario fits under (the control)", () => {
    const { root, work } = corpus();
    const whole = cli(["record", work, "--dry-run", "--max-budget-usd", "0.6"], root);
    expect(whole.code).toBe(1);
    expect(whole.all).toMatch(/refused before spending/);
    expect(whole.all).toMatch(/batch of 3 scenario\(s\)/);

    const one = cli(["record", work, "--case", "a", "--dry-run", "--max-budget-usd", "0.6", "--output-format", "json"], root);
    expect(one.code, one.all).toBe(0);
    const p = json(one.out);
    expect(p.ok).toBe(true);
    expect(p.cases).toEqual(["a"]);
    expect(p.scenarios).toEqual([join(work, "a.yaml")]);
    expect(p.estimatedCostUsd).toBeCloseTo(0.5);
  });

  it("two named scenarios are priced at their sum, and refused when it is over the cap", () => {
    const { root, work } = corpus();
    const r = cli(["record", work, "--case", "a", "--case", "b", "--dry-run", "--max-budget-usd", "0.6", "--output-format", "json"], root);
    expect(r.code).toBe(1);
    const e = json(r.out);
    expect(e.ok).toBe(false);
    expect(e.error.message).toMatch(/batch of 2 scenario\(s\)/);
    expect(e.cases).toEqual(["a", "b"]);
    // b and c together ($0.70) fit a $0.75 cap that the whole dir ($1.20) does not.
    expect(cli(["record", work, "--case", "b", "--case", "c", "--dry-run", "--max-budget-usd", "0.75"], root).code).toBe(0);
  });

  it("text mode says how many files were selected", () => {
    const { root, work } = corpus();
    const r = cli(["record", work, "--case", "c", "--dry-run"], root);
    expect(r.code, r.all).toBe(0);
    expect(r.err).toMatch(/--case: 1 of 3 scenario file\(s\) selected/);
    expect(r.err).toMatch(/1 scenario\(s\) in/);
  });
});

describe.skipIf(!can)("record <dir> --case: selection errors are usage errors, before any spend", () => {
  it("an unknown stem names it and lists the cases (exit 2)", () => {
    const { root, work } = corpus();
    const r = cli(["record", work, "--case", "zzz", "--dry-run", "--max-budget-usd", "5"], root);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/no case matches "zzz"\. Cases: a, b, c/);
    // Same rule on the real arm, before the credential guard would matter: no spend either way.
    expect(cli(["record", work, "--case", "zzz"], root).code).toBe(2);
  });

  it("a stem that names a YAML file with no `prompt:` says it is not a scenario", () => {
    const { root, work } = corpus();
    writeFileSync(join(work, "session.yaml"), "permission_mode: default\n");
    const r = cli(["record", work, "--case", "session", "--dry-run"], root);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/session\.yaml is not a scenario/);
  });

  it("the scenario's `name:` is not a selector: the file stem is", () => {
    const { root, work } = corpus();
    writeFileSync(join(work, "d.yaml"), scenarioYaml("Delta"));
    expect(cli(["record", work, "--case", "Delta", "--dry-run"], root).code).toBe(2);
    expect(cli(["record", work, "--case", "d", "--dry-run"], root).code).toBe(0);
  });

  it("a stem that is not path-safe matches as typed and by its path-safe id", () => {
    const { root, work } = corpus();
    writeFileSync(join(work, "beta two.yaml"), scenarioYaml());
    const typed = cli(["record", work, "--case", "beta two", "--dry-run", "--output-format", "json"], root);
    expect(typed.code, typed.all).toBe(0);
    expect(json(typed.out).scenarios).toEqual([join(work, "beta two.yaml")]);
    const id = /beta_two-[0-9a-f]{8}/.exec(cli(["record", work, "--case", "nope", "--dry-run"], root).all)![0];
    expect(cli(["record", work, "--case", id, "--dry-run"], root).code).toBe(0);
  });

  it("refuses --case with a single scenario file, a missing path, or --rerecord-stale (exit 2)", () => {
    const { root, work } = corpus();
    const file = cli(["record", join(work, "a.yaml"), "--case", "a", "--dry-run"], root);
    expect(file.code).toBe(2);
    expect(file.all).toMatch(/is a single scenario, so drop --case/);
    const missing = cli(["record", join(work, "nope"), "--case", "a"], root);
    expect(missing.code).toBe(2);
    expect(missing.all).toMatch(/is not a directory/);
    const stale = cli(["record", work, "--case", "a", "--rerecord-stale", "--dry-run"], root);
    expect(stale.code).toBe(2);
    expect(stale.all).toMatch(/cannot be combined with --rerecord-stale/);
  });
});

describe.skipIf(!can)("record <dir> --case: files that do not load", () => {
  it("an unselected broken file no longer fails the run; a selected one does", () => {
    const { root, work } = corpus();
    writeFileSync(join(work, "broken.yaml"), 'prompt: "x"\nfidelity: nonsense\n');
    expect(cli(["record", work, "--dry-run"], root).code).toBe(1);
    expect(cli(["record", work, "--case", "a", "--dry-run"], root).code).toBe(0);
    const sel = cli(["record", work, "--case", "broken", "--dry-run"], root);
    expect(sel.code).toBe(1);
    expect(sel.all).toMatch(/broken\.yaml/);
  });
});

describe("selectDiscovered", () => {
  const disc = { scenarios: ["/d/a.yaml", "/d/c.yml"], skipped: ["/d/s.yaml"], broken: [{ file: "/d/b.yaml", error: "bad" }] };
  it("returns the discovery unchanged with no selectors", () => {
    expect(selectDiscovered(disc, [])).toBe(disc);
  });
  it("keeps the selected scenarios and broken files, in discovery order, and drops the skipped list", () => {
    expect(selectDiscovered(disc, ["c", "b", "a", "c"])).toEqual({
      scenarios: ["/d/a.yaml", "/d/c.yml"],
      skipped: [],
      broken: [{ file: "/d/b.yaml", error: "bad" }],
    });
    expect(selectDiscovered(disc, ["c"])).toEqual({ scenarios: ["/d/c.yml"], skipped: [], broken: [] });
  });
  it("throws a UsageError naming an unknown selector or a non-scenario file", () => {
    expect(() => selectDiscovered(disc, ["x"])).toThrow(UsageError);
    expect(() => selectDiscovered(disc, ["x"])).toThrow(/no case matches "x"\. Cases: a, c, b/);
    expect(() => selectDiscovered(disc, ["s"])).toThrow(/\/d\/s\.yaml is not a scenario/);
  });
});

// The real (paid) arm, driven by a stub agent: the cap that refuses the whole directory lets the named scenario
// through, and only that scenario is recorded.
const RESULT_STUB = [
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"stub","num_turns":1,"total_cost_usd":0.0123,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  "cat >/dev/null",
].join("\n");
const STUB_SCENARIO = "baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n";

describe.runIf(POSIX && can)("record <dir> --case on the real arm (stub agent)", () => {
  it("records only the named scenario, under a cap the whole dir is refused at", async () => {
    const f = makeStubFixture(RESULT_STUB, { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" });
    try {
      const dir = join(f.cwd, "scenarios");
      mkdirSync(dir);
      for (const [stem, cost] of [
        ["a", 0.5],
        ["b", 0.4],
      ] as const) {
        writeFileSync(join(dir, `${stem}.yaml`), STUB_SCENARIO);
        seedRun(f.runsDir, stem, cost);
      }
      expect((await exited(spawnCli(f, ["stats", "--reindex"]), 25_000)).code).toBe(0);
      const run = async (args: string[]) => {
        const c = spawnCli(f, ["record", dir, ...args, "--max-budget-usd", "0.6", "--output-format", "json"]);
        const r = await exited(c, 60_000);
        return { ...r, stdout: c.stdoutText(), stderr: c.stderrText() };
      };

      const whole = await run([]);
      expect(whole.code).toBe(1);
      expect(JSON.parse(whole.stdout).error.message).toMatch(/refused before spending/);
      expect(existsSync(join(f.cwd, "cassettes"))).toBe(false);

      const one = await run(["--case", "b"]);
      expect(one.code, one.stderr).toBe(0);
      const env = JSON.parse(one.stdout);
      expect(env.cases).toEqual(["b"]);
      expect(env.items.map((i: { file: string; status: string }) => [i.file, i.status])).toEqual([[join(dir, "b.yaml"), "recorded"]]);
      expect(readdirSync(join(f.cwd, "cassettes"))).toEqual(["b.cassette.json"]);
    } finally {
      f.cleanup();
    }
  }, 120_000);
});
