// A declared input path that does not exist is an authoring error, and every lane must refuse it before it
// creates a run dir or spends on an earlier item:
//  - `chat` resolves its inputs before it creates its run dir, so a missing skill folder, `--upload` or
//    `--folder` leaves nothing behind;
//  - `run <dir/>` checks every scenario's input paths before the first scenario runs, and one refusal
//    names every offender;
//  - a `tool_not_called` the scenario's tier can never violate is refused before the run dir exists too,
//    and on a directory before the first scenario runs;
//  - `record <dir/> --dry-run` reports a scenario whose input path is missing under `inputErrors[]`
//    (advisory: the exit code and `ok` are unchanged until the next major).
//
// Token-free throughout. COWORK_HARNESS_FORBID_SPAWN is set, so a check that is missing ends at the spawn
// guard (after the run dir exists), never at a real agent. Every call runs from a temp cwd with a temp runs
// root, so a leftover run dir is observable and the shell cannot supply a model the test did not choose.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

const SPAWN_GUARD = /COWORK_HARNESS_FORBID_SPAWN is set/;
const MISSING_MOUNT = /mount source\(s\) not found/;

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-src-preflight-"));
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const runs = join(cwd, ".runs");
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 120_000,
    env: {
      ...process.env,
      COWORK_HARNESS_FORBID_SPAWN: "1",
      COWORK_HARNESS_RUNS_DIR: runs,
      COWORK_HARNESS_MODEL: "",
      COWORK_HARNESS_SOFT_MISSING: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", all: (r.stdout || "") + (r.stderr || ""), runs };
}

/** Did anything land under the runs root? A refusal that fires before the run starts leaves it empty. */
function runDirsUnder(runs: string): string[] {
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter((n) => !n.startsWith("."));
}

function envelope(stdout: string): { ok?: boolean; results?: unknown[]; error?: { category?: string; message?: string } } {
  return JSON.parse(stdout);
}

const SCENARIO = (name: string, session: string, extra = "") =>
  `name: ${name}\nprompt: hi\nfidelity: protocol\nsession: ${session}\nassert:\n  - result: success\n${extra}`;
const MODEL = "model: claude-sonnet-5\n";

/** A workspace with a good session, sessions naming a missing folder / upload / plugin / skill, and an
 *  empty `sc/` directory for the scenarios. */
function fixture(): string {
  const d = work();
  mkdirSync(join(d, "sc"));
  writeFileSync(join(d, "ok.yaml"), MODEL);
  writeFileSync(join(d, "no-folder.yaml"), `${MODEL}folders:\n  - from: ./nope\n`);
  writeFileSync(join(d, "no-upload.yaml"), `${MODEL}uploads:\n  - ./nope.csv\n`);
  writeFileSync(join(d, "no-plugin.yaml"), `${MODEL}plugins:\n  local_plugins:\n    - ./nope-plugin\n`);
  writeFileSync(join(d, "no-skill.yaml"), `${MODEL}skills:\n  local:\n    - ./nope-skill\n`);
  return d;
}

describe.skipIf(!can)("chat resolves its inputs before it creates a run dir", () => {
  const CHAT_ENV = { COWORK_HARNESS_MODEL: "claude-sonnet-5" };

  it("a missing --folder is refused (exit 2) with no run dir left behind", () => {
    const d = work();
    mkdirSync(join(d, "skill")); // an empty directory passes the positional's kind check
    const r = cli(["chat", "./skill", "--folder", "./nope"], d, CHAT_ENV);
    expect(r.code, r.all).toBe(2);
    expect(r.stderr).toMatch(MISSING_MOUNT);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("a missing skill folder is refused with no run dir left behind", () => {
    const d = work();
    const r = cli(["chat", "./missing-skill"], d, CHAT_ENV);
    expect(r.code, r.all).toBe(2);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("a missing --upload is refused with no run dir left behind", () => {
    const d = work();
    mkdirSync(join(d, "skill"));
    const r = cli(["chat", "./skill", "--upload", "./nope.csv"], d, CHAT_ENV);
    expect(r.code, r.all).toBe(2);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("positive control: valid inputs reach the spawn guard and DO leave a chat run dir", () => {
    // Proves the three refusals above are not vacuous: this instrument can observe a run dir.
    const d = work();
    mkdirSync(join(d, "skill"));
    const r = cli(["chat", "./skill"], d, CHAT_ENV);
    expect(r.all).toMatch(SPAWN_GUARD);
    expect(runDirsUnder(r.runs)).toEqual(["chat"]);
  });
});

describe.skipIf(!can)("run <dir/> checks every scenario's input paths before the first one runs", () => {
  it("a missing folder in the second scenario refuses the batch before the first runs", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/b\.yaml/);
    expect(env.error?.message).toMatch(MISSING_MOUNT);
    expect(env.error?.message).not.toMatch(/a\.yaml/);
    expect(env.results).toEqual([]);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("one refusal names every scenario with a missing path", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    writeFileSync(join(d, "sc", "c.yaml"), SCENARIO("c", "../no-upload.yaml"));
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const msg = envelope(r.stdout).error?.message ?? "";
    expect(msg).toMatch(/b\.yaml: /);
    expect(msg).toMatch(/c\.yaml: /);
    expect(msg).not.toMatch(/a\.yaml/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("a single file keeps the unprefixed message it has always had", () => {
    // Regression pin: green before and after. The pre-check must not add a file prefix for one file.
    const d = fixture();
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["run", "sc/b.yaml", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const msg = envelope(r.stdout).error?.message ?? "";
    expect(msg).toMatch(/^mount source\(s\) not found/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("under COWORK_HARNESS_SOFT_MISSING the exclusion warning prints once, not once per resolution", () => {
    // Regression guard, not a red: the count is 1 before this pre-check existed, and the pre-check resolves
    // the same sources a second time. Printing its warnings too would make it 2; the pre-check is quiet, so
    // it stays 1.
    const d = fixture();
    writeFileSync(join(d, "sc", "s.yaml"), SCENARIO("s", "../no-skill.yaml"));
    const r = cli(["run", "sc/s.yaml"], d, { COWORK_HARNESS_SOFT_MISSING: "1" });
    expect(r.all).toMatch(SPAWN_GUARD);
    const upToGuard = r.stderr.slice(0, r.stderr.search(SPAWN_GUARD));
    expect(upToGuard.match(/missing source excluded/g) ?? []).toHaveLength(1);
  });

  it("--ablate-skill drops a missing plugin before the pre-check, as the run does", () => {
    // Green before and after: ablation removes the plugin from the session the run resolves, so its path is
    // never checked. The pre-check must ablate the same way, or it refuses a run that would have proceeded.
    const d = fixture();
    writeFileSync(join(d, "sc", "p.yaml"), SCENARIO("p", "../no-plugin.yaml"));
    const r = cli(["run", "sc/", "--ablate-skill"], d);
    expect(r.all).toMatch(SPAWN_GUARD);
  });

  it("--ablate-skill still refuses a missing folder (ablation removes skill discovery only)", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["run", "sc/", "--ablate-skill", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.message).toMatch(MISSING_MOUNT);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });
});

describe.skipIf(!can)("a tier-vacuous tool_not_called is refused before the run dir exists", () => {
  const VACUOUS = (name: string) =>
    `name: ${name}\nprompt: hi\nfidelity: hostloop\nsession: ../ok.yaml\nassert:\n  - tool_not_called: NotebookEdit\n`;

  it("a single file: usage, no run dir", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const r = cli(["run", "sc/v.yaml", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/can never be violated at fidelity `hostloop`/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("a directory: refused before the first scenario runs", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.message).toMatch(/v\.yaml: .*can never be violated/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });
});

describe.skipIf(!can)("record <dir/> --dry-run reports missing input paths under inputErrors[]", () => {
  type Doc = { ok: boolean; refusals: { file: string; message: string }[]; inputErrors?: { file: string; message: string }[] };

  function twoFiles(): string {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    return d;
  }

  it("JSON: the missing path is listed under inputErrors[]; exit code and ok are unchanged", () => {
    const d = twoFiles();
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(0);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.ok).toBe(true);
    expect(doc.refusals).toEqual([]);
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].file).toMatch(/b\.yaml$/);
    expect(doc.inputErrors![0].message).toMatch(MISSING_MOUNT);
  });

  it("text: a warning line names the file and the missing path", () => {
    const d = twoFiles();
    const r = cli(["record", "sc/", "--dry-run"], d);
    expect(r.code, r.all).toBe(0);
    expect(r.stderr).toMatch(/⚠ input error: .*b\.yaml: mount source\(s\) not found/);
    expect(r.stderr).toMatch(/will fail on the real record\n/);
  });

  it("--quiet still prints the warning line", () => {
    const d = twoFiles();
    const r = cli(["record", "sc/", "--dry-run", "--quiet"], d);
    expect(r.stderr).toMatch(/⚠ input error: .*b\.yaml: mount source\(s\) not found/);
  });

  it("a file that is both unpinned and names a missing path reports the model refusal only", () => {
    // The real record stops at the model refusal first, so the preview reports one reason per file.
    const d = fixture();
    writeFileSync(join(d, "unpinned-no-folder.yaml"), `folders:\n  - from: ./nope\n`);
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../unpinned-no-folder.yaml"));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.refusals).toHaveLength(1);
    expect(doc.refusals[0].message).toMatch(/no model is pinned/);
    expect(doc.inputErrors ?? []).toEqual([]);
  });
});

describe.skipIf(!can)("input pre-checks: baselines, --repeat, hints and the budget path", () => {
  type Doc = {
    ok: boolean;
    refusals: { file: string; message: string }[];
    inputErrors?: { file: string; message: string; hint?: string }[];
  };

  it("record <dir/> --dry-run: a baseline that fails to LOAD is an inputErrors[] entry (exit 0, payload)", () => {
    // The directory preview must not crash on one file; the real record fails that item, so it is listed.
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(0);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.ok).toBe(true);
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].file).toMatch(/m\.yaml$/);
    expect(doc.inputErrors![0].message).toMatch(/does not load: .*JSON/);
  });

  it("record <file> --dry-run: a baseline that fails to LOAD fails as before (internal, exit 2)", () => {
    // Pin: a single-file preview must not green what the real record crashes on.
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["record", "sc/m.yaml", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("internal");
  });

  it("run <dir/>: a baseline that fails to LOAD is left to that scenario's turn, not the pre-check", () => {
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["run", "sc/"], d);
    expect(r.all).toMatch(SPAWN_GUARD); // `a` runs first; the pre-check did not throw on `m`
  });

  it("record <dir/> --dry-run: a baseline NAME that resolves nowhere is an inputErrors[] entry, hint carried", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../ok.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(0);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].file).toMatch(/u\.yaml$/);
    expect(doc.inputErrors![0].message).toMatch(/no-such-baseline/);
    expect(typeof doc.inputErrors![0].hint).toBe("string");
  });

  it("run <dir/>: every scenario whose baseline does not resolve is named, with its file prefix", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml", "baseline: no-such-baseline\n"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../ok.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const msg = envelope(r.stdout).error?.message ?? "";
    expect(msg).toMatch(/a\.yaml: .*no-such-baseline/);
    expect(msg).toMatch(/b\.yaml: .*no-such-baseline/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("run --repeat keeps its per-scenario rollup for a missing input path (exit 1, error null)", () => {
    // Pin: the batch pre-check does not apply under --repeat, whose accepted invocations report a failed
    // scenario in its rollup (stoppedEarly "error") rather than refusing up front.
    const d = fixture();
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["run", "sc/b.yaml", "--repeat", "2", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const doc = JSON.parse(r.stdout) as { rollups?: { stoppedEarly?: string }[]; error: unknown };
    expect(doc.error).toBeNull();
    expect(doc.rollups).toHaveLength(1);
    expect(doc.rollups![0].stoppedEarly).toBe("error");
  });

  it("record <dir/> --dry-run: input errors survive the budget refusal on stderr", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const runs = join(d, ".runs");
    mkdirSync(runs);
    writeFileSync(
      join(runs, "index.jsonl"),
      JSON.stringify({
        v: 1,
        ts: "2026-08-30T00:00:00Z",
        command: "record",
        scenario: "b",
        slug: "b",
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
    const r = cli(["record", "sc/", "--dry-run", "--max-budget-usd", "0.01", "--output-format", "json"], d);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.stderr).toMatch(/⚠ input error: .*b\.yaml: mount source\(s\) not found/);
  });
});

describe.skipIf(!can)("tier vacuity: the record lanes", () => {
  const VACUOUS = (name: string) =>
    `name: ${name}\nprompt: hi\nfidelity: hostloop\nsession: ../ok.yaml\nassert:\n  - tool_not_called: NotebookEdit\n`;

  it("real record <file> (no CLI pre-check) refuses it before the run dir exists", () => {
    // `record` reaches executeScenario with no batch pre-flight in front, so this pins the check's position
    // inside executeScenario itself: moved back after the run-dir mkdir, a run dir appears here.
    const d = fixture();
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const r = cli(["record", "sc/v.yaml", "--out", join(d, "v.cassette.json")], d, { CLAUDE_CODE_OAUTH_TOKEN: "dummy" });
    expect(r.all).toMatch(/can never be violated/);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("record <dir/> --dry-run lists it under inputErrors[] (exit and ok unchanged)", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(0);
    const doc = JSON.parse(r.stdout) as { ok: boolean; inputErrors?: { file: string; message: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].file).toMatch(/v\.yaml$/);
    expect(doc.inputErrors![0].message).toMatch(/can never be violated/);
  });

  it("record <file> --dry-run with a vacuous assertion AND a missing path refuses with the real record's message", () => {
    // executeScenario checks vacuity before input paths, so the real record names the vacuity. The preview
    // keeps its exit 1 for the missing path, and names the same reason.
    const d = fixture();
    writeFileSync(
      join(d, "sc", "vb.yaml"),
      `name: vb\nprompt: hi\nfidelity: hostloop\nsession: ../no-folder.yaml\nassert:\n  - tool_not_called: NotebookEdit\n`,
    );
    const dry = cli(["record", "sc/vb.yaml", "--dry-run", "--output-format", "json"], d);
    expect(dry.code, dry.all).toBe(1);
    const real = cli(["record", "sc/vb.yaml", "--out", join(d, "vb.cassette.json"), "--output-format", "json"], d, {
      CLAUDE_CODE_OAUTH_TOKEN: "dummy",
    });
    expect(real.all).not.toMatch(SPAWN_GUARD);
    const dryMsg = envelope(dry.stdout).error?.message ?? "";
    const realMsg = envelope(real.stdout).error?.message ?? "";
    expect(realMsg).toMatch(/can never be violated/);
    expect(dryMsg).toBe(realMsg);
    expect(envelope(dry.stdout).error?.category).toBe(envelope(real.stdout).error?.category);
  });

  it("record <file> --dry-run warns (inputErrors[] + a ⚠ line) and keeps exit 0", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const json = cli(["record", "sc/v.yaml", "--dry-run", "--output-format", "json"], d);
    expect(json.code, json.all).toBe(0);
    const doc = JSON.parse(json.stdout) as { ok: boolean; inputErrors?: { file: string; message: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].message).toMatch(/can never be violated/);
    const text = cli(["record", "sc/v.yaml", "--dry-run", "--quiet"], d);
    expect(text.code, text.all).toBe(0);
    expect(text.stderr).toMatch(/⚠ input error: .*v\.yaml: .*can never be violated/);
  });
});

// A `session:` file that is not there is an input-path error like any other: `run` refuses it as a usage
// error before a run dir exists (it was a raw ENOENT, category `internal`), `run <dir/>` refuses the batch
// before its first scenario runs, and both `record --dry-run` arms report it under `inputErrors[]` with the
// exit code and `ok` unchanged.
describe.skipIf(!can)("a missing session file is an input error on every lane", () => {
  const NOT_FOUND = /^session file not found: .*gone\.yaml/;

  it("run <file>: usage (exit 2) with a clean message, no run dir", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../gone.yaml"));
    const r = cli(["run", "sc/m.yaml", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(NOT_FOUND);
    expect(env.error?.message).not.toMatch(/ENOENT/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("run <dir/>: refused before the first scenario runs, naming the file", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../gone.yaml"));
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/b\.yaml: session file not found/);
    expect(env.error?.message).not.toMatch(/a\.yaml/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("record <file> --dry-run: reported under inputErrors[], exit 0 and ok unchanged", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../gone.yaml"));
    const r = cli(["record", "sc/m.yaml", "--dry-run", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(0);
    const doc = JSON.parse(r.stdout) as { ok: boolean; inputErrors?: { file: string; message: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].file).toMatch(/m\.yaml$/);
    expect(doc.inputErrors![0].message).toMatch(NOT_FOUND);
    const text = cli(["record", "sc/m.yaml", "--dry-run", "--model", "claude-sonnet-5", "--quiet"], d);
    expect(text.code, text.all).toBe(0);
    expect(text.stderr).toMatch(/⚠ input error: .*m\.yaml: session file not found/);
  });

  it("record <dir/> --dry-run: reported under inputErrors[], exit 0 and ok unchanged", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../gone.yaml"));
    const r = cli(["record", "sc/", "--dry-run", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(0);
    const doc = JSON.parse(r.stdout) as { ok: boolean; inputErrors?: { file: string; message: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.inputErrors).toHaveLength(1);
    expect(doc.inputErrors![0].file).toMatch(/b\.yaml$/);
    expect(doc.inputErrors![0].message).toMatch(NOT_FOUND);
  });

  it("run --matrix: one clean message, not a double prefix", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../gone.yaml"));
    writeFileSync(join(d, "matrix.yaml"), "models:\n  - claude-sonnet-5\n");
    const r = cli(["run", "sc/m.yaml", "--matrix", "matrix.yaml", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(NOT_FOUND);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("`~` in session: expands to the home directory (the file loads and the run reaches the spawn)", () => {
    const d = fixture();
    writeFileSync(join(d, "home-session.yaml"), MODEL);
    writeFileSync(join(d, "sc", "t.yaml"), SCENARIO("t", "~/home-session.yaml"));
    const r = cli(["run", "sc/t.yaml", "--output-format", "json"], d, { HOME: d });
    expect(r.all).toMatch(SPAWN_GUARD);
    expect(r.all).not.toMatch(/ENOENT|session file not found/);
  });
});
