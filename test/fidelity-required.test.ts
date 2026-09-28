// `fidelity:` is REQUIRED on an authored scenario (4.0.0). Before that it defaulted to `container` with a
// deprecation warning; the default modelled the VM loop while production runs the host loop, so an omitted
// key silently measured the wrong lane.
//
// What this pins, in one place:
//  - the loader refuses a scenario without the key, with a remedy that names the tiers to add, and still
//    reports every OTHER schema issue in the same pass (one round trip, not two);
//  - a non-scenario YAML (no `prompt:`) is not told to add `fidelity:`;
//  - `executeScenario` refuses a fidelity-less object from a library caller before any work;
//  - `run`, `record --dry-run` (single file and directory) and `lint` inherit the refusal;
//  - replay of an existing cassette is unaffected, and each of the three paths that read the on-disk
//    sibling names the tier the cassette recorded, not a generic default;
//  - `verify-cassettes` reports a schema-rejected recorded source as UNVERIFIABLE (it can no longer run the
//    drift check, and "cannot verify" is not green), while a YAML syntax break stays a note.
//
// Token-free throughout: nothing spawns an agent.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UsageError } from "../src/errors.js";
import { executeScenario, loadScenarioPure } from "../src/run/execute.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-fid-req-"));
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "1", ...env },
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", all: (r.stdout || "") + (r.stderr || "") };
}

const NO_TIER = "name: s\nprompt: hi\nassert:\n  - result: success\n";

describe("the loader refuses a scenario without `fidelity:`", () => {
  it("throws a UsageError whose message keeps the `invalid scenario <path>:` prefix and names the fix", () => {
    const d = work();
    const f = join(d, "s.yaml");
    writeFileSync(f, NO_TIER);
    let err: unknown;
    try {
      loadScenarioPure(f);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    const msg = (err as Error).message;
    expect(msg.startsWith(`invalid scenario ${f}: `), "stripScenarioPrefix and the dry-run listing key on this prefix").toBe(true);
    expect(msg).toMatch(/`fidelity:` is required/);
    expect(msg, "must offer the pre-4.0 behaviour").toMatch(/fidelity: container/);
    expect(msg, "must offer the production-matching tier").toMatch(/fidelity: hostloop/);
  });

  it("reports the other schema issues in the same pass, after the remedy", () => {
    const d = work();
    const f = join(d, "s.yaml");
    writeFileSync(f, NO_TIER + "bogus_key: 1\n");
    let msg = "";
    try {
      loadScenarioPure(f);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/`fidelity:` is required/);
    expect(msg, "a second issue must not cost a second round trip").toMatch(/bogus_key/);
    expect(msg.indexOf("fidelity:")).toBeLessThan(msg.indexOf("bogus_key"));
  });

  it("does not tell a non-scenario YAML (no `prompt:`) to add `fidelity:`", () => {
    const d = work();
    const f = join(d, "session.yaml");
    writeFileSync(f, "model: claude-sonnet-5\n");
    let msg = "";
    try {
      loadScenarioPure(f);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/invalid scenario/);
    expect(msg).not.toMatch(/`fidelity:` is required/);
  });

  it("loads the same file once the key is present", () => {
    const d = work();
    const f = join(d, "s.yaml");
    writeFileSync(f, NO_TIER + "fidelity: container\n");
    expect(loadScenarioPure(f).fidelity).toBe("container");
  });
});

describe("executeScenario refuses a scenario object without `fidelity`", () => {
  // Library callers and `record --rerecord-stale --from-embedded` (a hand-built snapshot) reach
  // executeScenario without the loader. The bogus baseline is an ORDERING probe: loadBaseline throws on it
  // a few lines later, so getting the fidelity refusal back proves the check ran first.
  const noTier = {
    name: "no-tier",
    prompt: "hi",
    baseline: "desktop-0.0.0-does-not-exist",
    session: "(inline)",
    assert: [{ result: "success" }],
  } as unknown as Parameters<typeof executeScenario>[0];

  it("rejects with a UsageError naming the key, not with the later baseline failure, and writes no run dir", async () => {
    const runs = work();
    const prev = process.env.COWORK_HARNESS_RUNS_DIR;
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    try {
      const err = await executeScenario(noTier).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toMatch(/fidelity/);
      expect(readdirSync(runs), "refused before any run dir exists").toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev;
    }
  });
});

describe.skipIf(!can)("commands inherit the refusal", () => {
  it("`run` exits 2, category usage, names `fidelity: container`, and creates no run dir", () => {
    const d = work();
    const runs = join(d, "runs");
    mkdirSync(runs);
    writeFileSync(join(d, "s.yaml"), NO_TIER);
    const r = cli(["run", "s.yaml", "--output-format", "json"], d, { COWORK_HARNESS_RUNS_DIR: runs });
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout.trim());
    expect(env.error.category).toBe("usage");
    expect(env.error.message).toMatch(/fidelity: container/);
    expect(readdirSync(runs), "refused before any run dir exists").toEqual([]);
  });

  it("`run <dir/>` loads every file before running any: a tierless file refuses the batch before a valid one runs", () => {
    // Loading lazily, per file, ran (and paid for) the earlier files and then exited 2 on the tierless one,
    // dropping their results from the envelope. `a.yaml` sorts first and is valid, so a run dir under the
    // runs root is the evidence that it started.
    const d = work();
    const runs = join(d, "runs");
    mkdirSync(runs);
    const corpus = join(d, "corpus");
    mkdirSync(corpus);
    writeFileSync(join(corpus, "a.yaml"), NO_TIER.replace("name: s", "name: a") + "fidelity: container\n");
    writeFileSync(join(corpus, "b.yaml"), NO_TIER.replace("name: s", "name: b"));
    const r = cli(["run", corpus, "--output-format", "json"], d, { COWORK_HARNESS_RUNS_DIR: runs });
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout.trim());
    expect(env.error.category).toBe("usage");
    expect(env.error.message).toMatch(/b\.yaml/);
    expect(r.stderr, "the spawn guard must not have been reached").not.toMatch(/COWORK_HARNESS_FORBID_SPAWN is set/);
    expect(readdirSync(runs), "nothing ran").toEqual([]);
  });

  it("`record <file> --dry-run` exits 2 (did not load)", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), NO_TIER);
    const r = cli(["record", "s.yaml", "--dry-run"], d);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/`fidelity:` is required/);
  });

  it("`record <dir/> --dry-run` lists the file as broken and exits 1", () => {
    const d = work();
    const corpus = join(d, "corpus");
    mkdirSync(corpus);
    writeFileSync(join(corpus, "a.yaml"), NO_TIER.replace("name: s", "name: a") + "fidelity: container\n");
    writeFileSync(join(corpus, "b.yaml"), NO_TIER.replace("name: s", "name: b"));
    const r = cli(["record", corpus, "--dry-run"], d);
    expect(r.code).toBe(1);
    const line = r.stderr.split("\n").find((l) => l.startsWith("✗ broken:")) ?? "";
    expect(line).toMatch(/b\.yaml/);
    expect(line).toMatch(/`fidelity:` is required/);
  });

  it.skipIf(!havePython)("`lint` reports ERROR scenario-invalid whose fix names the tier (exit 1 without --strict)", () => {
    const d = work();
    const f = join(d, "s.yaml");
    writeFileSync(f, NO_TIER);
    const r = cli(["lint", f, "--output-format", "json"], d);
    expect(r.code).toBe(1);
    const findings = JSON.parse(r.stdout.trim()).findings as { rule: string; severity: string; message: string; fix: string }[];
    const loader = findings.filter((x) => x.rule === "scenario-invalid");
    expect(loader).toHaveLength(1);
    expect(loader[0].severity).toBe("ERROR");
    expect(loader[0].message).toMatch(/fidelity/);
    expect(loader[0].fix, "the remedy, not the generic 'fix the value / not a scenario' text").toMatch(/fidelity: container/);
    expect(loader[0].fix).not.toMatch(/not a scenario/);
    // The long remedy says which lane each tier models, so the choice is informed, not a guess.
    expect(loader[0].fix, "must offer the auto-picking tier").toMatch(/fidelity: cowork/);
    expect(loader[0].fix, "must cite the gate, so the production claim is checkable").toMatch(/1143815894/);
    expect(loader[0].fix, "must warn that a cassette's tier is fixed").toMatch(/re-record/);
  });
});

// A synthetic cassette with a persisted source `s.yaml` beside it (`scenarioSource: "s.yaml"` resolves
// `via: "persisted"`). The frozen tier is `hostloop` on purpose: a generic "add `fidelity: container`" would
// be the WRONG advice for this cassette (it is a recording-shaping change), so the text must name hostloop.
function cassetteDir(frozen: Record<string, unknown> = { fidelity: "hostloop" }): string {
  const d = work();
  writeFileSync(
    join(d, "c.cassette.json"),
    JSON.stringify({
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
        ...frozen,
      },
      scenarioSource: "s.yaml",
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    }),
  );
  return d;
}
const SIBLING_NO_TIER = "prompt: hi\nassert:\n  - result: success\n";

describe.skipIf(!can)("replay of an existing cassette with a fidelity-less sibling", () => {
  it("default replay stays green and its notice names the tier the cassette recorded", () => {
    const d = cassetteDir();
    writeFileSync(join(d, "s.yaml"), SIBLING_NO_TIER);
    const r = cli(["replay", "c.cassette.json"], d);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/::notice:: \[replay\] .*s\.yaml/);
    expect(r.stderr).toMatch(/fidelity: hostloop/);
  });

  it("--assert-from is a tallied error (exit 2) whose message names the recorded tier", () => {
    const d = cassetteDir();
    writeFileSync(join(d, "s.yaml"), SIBLING_NO_TIER);
    const r = cli(["replay", "c.cassette.json", "--assert-from", "s.yaml"], d);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/fidelity: hostloop/);
    expect(r.stderr).not.toMatch(/drifted from the recording/);
  });

  it("a hand-built cassette whose frozen scenario lacks `fidelity` replays exactly as before", () => {
    const d = cassetteDir({});
    writeFileSync(join(d, "s.yaml"), SIBLING_NO_TIER + "fidelity: container\n");
    const r = cli(["replay", "c.cassette.json"], d);
    expect(r.code).toBe(0);
    expect(r.all).not.toMatch(/does not load/);
  });

  it("verify-cassettes reports the recorded source as unverifiable (exit 3), naming the recorded tier", () => {
    const d = cassetteDir();
    writeFileSync(join(d, "s.yaml"), SIBLING_NO_TIER);
    const r = cli(["verify-cassettes", "c.cassette.json", "--output-format", "json"], d);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout.trim());
    expect(env.ok).toBe(false);
    const res = env.results[0];
    expect(res.unverifiable.join("\n")).toMatch(/fidelity: hostloop/);
    expect(res.scenarioDrift, "not a drift: the check could not run").toEqual([]);
  });

  it("verify-cassettes keeps a YAML syntax break in the source as a non-failing note", () => {
    const d = cassetteDir();
    writeFileSync(join(d, "s.yaml"), "prompt: [unterminated\n");
    const r = cli(["verify-cassettes", "c.cassette.json", "--output-format", "json"], d);
    const env = JSON.parse(r.stdout.trim());
    expect(env.results[0].unverifiable).toEqual([]);
    expect(env.results[0].notes.join("\n")).toMatch(/prompt drift not checked/);
    expect(r.code).toBe(0);
  });
});

describe.skipIf(!can)("record --rerecord-stale over a fidelity-less recorded source", () => {
  // The generic remedy leads with `fidelity: container`. On a hostloop cassette that advice silently
  // switches the tier on the next record, so this path must name the tier the cassette recorded, like the
  // replay paths do. The cassette is made stale for free (a moved fingerprint baseline); the item fails
  // at the source load, before any spawn.
  it("names the tier the cassette recorded, not the generic container-first remedy", () => {
    const d = work();
    writeFileSync(
      join(d, "c.cassette.json"),
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION,
        fingerprint: { baseline: "desktop-0.0.1", hashFormat: "jcs1" },
        scenario: {
          name: "c",
          baseline: "latest",
          session: "(inline)",
          fidelity: "hostloop",
          prompt: "hi",
          answers: [],
          expect_denied: [],
          assert: [{ result: "success" }],
        },
        scenarioSource: "s.yaml",
        events: [JSON.stringify({ type: "result", subtype: "success" })],
      }),
    );
    writeFileSync(join(d, "s.yaml"), SIBLING_NO_TIER);
    const r = cli(["record", ".", "--rerecord-stale"], d, {
      COWORK_HARNESS_RUNS_DIR: join(d, "runs"),
      ANTHROPIC_API_KEY: "placeholder-not-used-no-spawn",
    });
    expect(r.code).toBe(1);
    const line = r.stderr.split("\n").find((l) => l.includes("✗") && l.includes("c.cassette.json")) ?? "";
    expect(line).toMatch(/fidelity: hostloop/);
    expect(line).not.toMatch(/fidelity: container/);
  });
});
