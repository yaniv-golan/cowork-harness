// A declared input path that does not exist is an authoring error, and every lane must refuse it before it
// creates a run dir or spends on an earlier item:
//  - `chat` resolves its inputs before it creates its run dir, so a missing skill folder, `--upload` or
//    `--folder` leaves nothing behind;
//  - `run <dir/>` checks every scenario's input paths before the first scenario runs, and one refusal
//    names every offender;
//  - a `tool_not_called` the scenario's tier can never violate is refused before the run dir exists too,
//    and on a directory before the first scenario runs;
//  - `record <dir/>` refuses them before its first spawn, and `record <dir/> --dry-run` lists them under
//    `refusals[]`: exit 2 when any item names a baseline that resolves nowhere, else exit 1.
//
// Token-free throughout. COWORK_HARNESS_FORBID_SPAWN is set, so a check that is missing ends at the spawn
// guard (after the run dir exists), never at a real agent. Every call runs from a temp cwd with a temp runs
// root, so a leftover run dir is observable and the shell cannot supply a model the test did not choose.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
/** A stand-in credential for a protocol run that must reach the spawn (refused there by COWORK_HARNESS_FORBID_SPAWN, so
 *  the value is never sent): without one the protocol credential pre-flight answers first. */
const STUB_CREDENTIAL = { CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" };
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

function envelope(stdout: string): { ok?: boolean; results?: unknown[]; error?: { category?: string; message?: string; hint?: string } } {
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
  // chat refuses a tier with no credential before resolving its inputs, so these carry a stub one.
  const CHAT_ENV = { COWORK_HARNESS_MODEL: "claude-sonnet-5", ...STUB_CREDENTIAL };

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
    const r = cli(["run", "sc/s.yaml"], d, { ...STUB_CREDENTIAL, COWORK_HARNESS_SOFT_MISSING: "1" });
    expect(r.all).toMatch(SPAWN_GUARD);
    const upToGuard = r.stderr.slice(0, r.stderr.search(SPAWN_GUARD));
    expect(upToGuard.match(/missing source excluded/g) ?? []).toHaveLength(1);
  });

  it("--ablate-skill drops a missing plugin before the pre-check, as the run does", () => {
    // Green before and after: ablation removes the plugin from the session the run resolves, so its path is
    // never checked. The pre-check must ablate the same way, or it refuses a run that would have proceeded.
    const d = fixture();
    writeFileSync(join(d, "sc", "p.yaml"), SCENARIO("p", "../no-plugin.yaml"));
    const r = cli(["run", "sc/", "--ablate-skill"], d, STUB_CREDENTIAL);
    expect(r.all).toMatch(SPAWN_GUARD);
  });

  it("--ablate-skill still refuses a missing folder (ablation removes skill discovery only)", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["run", "sc/", "--ablate-skill", "--output-format", "json"], d, STUB_CREDENTIAL);
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

describe.skipIf(!can)("record <dir/> --dry-run refuses missing input paths", () => {
  type Doc = { ok: boolean; refusals: { file: string; message: string }[]; inputErrors?: unknown };

  function twoFiles(): string {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    return d;
  }

  it("JSON: the missing path is a refusal (exit 1, ok false), and the old key is gone", () => {
    const d = twoFiles();
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.ok).toBe(false);
    expect(doc.refusals).toHaveLength(1);
    expect(doc.refusals[0].file).toMatch(/b\.yaml$/);
    expect(doc.refusals[0].message).toMatch(MISSING_MOUNT);
    expect(doc).not.toHaveProperty("inputErrors");
  });

  it("text: a refused line names the file and the missing path, and survives --quiet", () => {
    const d = twoFiles();
    for (const flags of [[], ["--quiet"]]) {
      const r = cli(["record", "sc/", "--dry-run", ...flags], d);
      expect(r.code, r.all).toBe(1);
      expect(r.stderr).toMatch(/✗ refused: .*b\.yaml: mount source\(s\) not found/);
    }
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
  });
});

describe.skipIf(!can)("input pre-checks: baselines, --repeat, hints and the budget path", () => {
  type Doc = {
    ok: boolean;
    refusals: { file: string; message: string; hint?: string }[];
  };

  it("record <dir/> --dry-run: a baseline that fails to LOAD is a refusal (exit 1, payload)", () => {
    // The directory preview must not crash on one file; the real record refuses it, so it is listed.
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.ok).toBe(false);
    expect(doc.refusals).toHaveLength(1);
    expect(doc.refusals[0].file).toMatch(/m\.yaml$/);
    expect(doc.refusals[0].message).toMatch(/does not load: .*JSON/);
  });

  it("record <file> --dry-run: a baseline file that fails to LOAD is refused as a usage error", () => {
    // Pin: a single-file preview must not green what the real record refuses.
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["record", "sc/m.yaml", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).not.toBe(0);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/does not load: not valid JSON/);
  });

  it("run <dir/>: a baseline file that fails to LOAD is refused by the pre-check, before the first scenario", () => {
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.category).toBe("usage");
    expect(envelope(r.stdout).error?.message).toMatch(/m\.yaml: .*does not load/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("record <dir/> --dry-run: a baseline NAME that resolves nowhere exits 2, hint carried", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../ok.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const doc = JSON.parse(r.stdout) as Doc;
    expect(doc.ok).toBe(false);
    expect(doc.refusals).toHaveLength(1);
    expect(doc.refusals[0].file).toMatch(/u\.yaml$/);
    expect(doc.refusals[0].message).toMatch(/no-such-baseline/);
    expect(typeof doc.refusals[0].hint).toBe("string");
  });

  it("record <dir/> --dry-run: an unknown name outranks every other refusal", () => {
    const d = fixture();
    writeFileSync(join(d, "unpinned.yaml"), "folders: []\n");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../no-folder.yaml"));
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../unpinned.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    const messages = (JSON.parse(r.stdout) as Doc).refusals.map((x) => x.message).join("\n");
    expect(messages).toMatch(MISSING_MOUNT);
    expect(messages).toMatch(/no model is pinned/);
    expect(messages).toMatch(/no-such-baseline/);
  });

  it("record <file> --dry-run: a baseline NAME that resolves nowhere exits 2, as the real record does", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../ok.yaml", "baseline: no-such-baseline\n"));
    const dry = cli(["record", "sc/u.yaml", "--dry-run", "--output-format", "json"], d);
    const real = cli(["record", "sc/u.yaml", "--out", join(d, "u.cassette.json"), "--output-format", "json"], d, STUB_CREDENTIAL);
    expect([dry.code, real.code], dry.all + real.all).toEqual([2, 2]);
    expect(envelope(dry.stdout).error?.message).toBe(envelope(real.stdout).error?.message);
    expect(runDirsUnder(real.runs)).toEqual([]);
  });

  it("record <file> --dry-run: an unknown name outranks the model refusal", () => {
    const d = fixture();
    writeFileSync(join(d, "unpinned.yaml"), "folders: []\n");
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../unpinned.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/u.yaml", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.message).toMatch(/no-such-baseline/);
    expect(typeof envelope(r.stdout).error?.hint).toBe("string");
  });

  it("real record <file>: an unknown name outranks the model refusal, before anything is spawned", () => {
    const d = fixture();
    writeFileSync(join(d, "unpinned.yaml"), "folders: []\n");
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../unpinned.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/u.yaml", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.message).toMatch(/no-such-baseline/);
    expect(typeof envelope(r.stdout).error?.hint).toBe("string");
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it.each([
    ["run", ["run", "sc/o.yaml"]],
    ["record --dry-run", ["record", "sc/o.yaml", "--dry-run"]],
    ["real record", ["record", "sc/o.yaml"]],
  ])("%s: a baseline below the oldest committed one exits 2, by name and by file", (_n, argv) => {
    const d = fixture();
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "baselines", "desktop-1.14271.0.json"), "utf8"));
    writeFileSync(join(d, "old.json"), JSON.stringify({ ...raw, appVersion: "1.13576.1" }));
    for (const baseline of ["desktop-1.13576.1", join(d, "old.json")]) {
      writeFileSync(join(d, "sc", "o.yaml"), SCENARIO("o", "../ok.yaml", `baseline: ${baseline}\n`));
      const r = cli([...argv, "--output-format", "json"], d, STUB_CREDENTIAL);
      expect(r.all).not.toMatch(SPAWN_GUARD);
      expect(r.code, r.all).toBe(2);
      expect(envelope(r.stdout).error?.message).toMatch(/older than desktop-/);
      expect(runDirsUnder(r.runs)).toEqual([]);
    }
  });

  it("real record <dir/>: every unknown name is refused with exit 2 before anything is spawned", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../ok.yaml", "baseline: no-such-baseline\n"));
    writeFileSync(join(d, "sc", "c.yaml"), SCENARIO("c", "../ok.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const msg = envelope(r.stdout).error?.message ?? "";
    expect(msg).toMatch(/b\.yaml: .*no-such-baseline/);
    expect(msg).toMatch(/c\.yaml: .*no-such-baseline/);
    expect(msg).not.toMatch(/a\.yaml/);
    expect(envelope(r.stdout).error?.hint).toBeUndefined();
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("real record <dir/>: an unknown name outranks the model refusal", () => {
    const d = fixture();
    writeFileSync(join(d, "unpinned.yaml"), "folders: []\n");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../unpinned.yaml"));
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../ok.yaml", "baseline: no-such-baseline\n"));
    const r = cli(["record", "sc/", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.message).toMatch(/u\.yaml: .*no-such-baseline/);
    expect(typeof envelope(r.stdout).error?.hint).toBe("string");
  });

  it("real record <dir/>: a missing input path is refused with exit 1 before anything is spawned", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["record", "sc/", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    expect(envelope(r.stdout).error?.message).toMatch(/b\.yaml: mount source\(s\) not found/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("real record <dir/>: an unreadable session file is refused with exit 1 before anything is spawned", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../gone.yaml"));
    const r = cli(["record", "sc/", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    expect(envelope(r.stdout).error?.message).toMatch(/b\.yaml: session file not found/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("real record <dir/>: a tier-vacuous assertion is refused with exit 1 before anything is spawned", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(
      join(d, "sc", "v.yaml"),
      `name: v\nprompt: hi\nfidelity: hostloop\nsession: ../ok.yaml\nassert:\n  - tool_not_called: NotebookEdit\n`,
    );
    const r = cli(["record", "sc/", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    expect(envelope(r.stdout).error?.message).toMatch(/v\.yaml: .*tool_not_called/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("real record <dir/>: a baseline file that does not load is refused with exit 1 before anything is spawned", () => {
    const d = fixture();
    writeFileSync(join(d, "bad-baseline.json"), "{not json");
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../ok.yaml", `baseline: ${join(d, "bad-baseline.json")}\n`));
    const r = cli(["record", "sc/", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    expect(envelope(r.stdout).error?.message).toMatch(/m\.yaml: .*does not load/);
    expect(runDirsUnder(r.runs)).toEqual([]);
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

  it("run --repeat refuses a missing input path before the first run: exit 2, no run dir", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../no-folder.yaml"));
    const r = cli(["run", "sc/b.yaml", "--repeat", "2", "--output-format", "json"], d, STUB_CREDENTIAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    expect(envelope(r.stdout).error?.category).toBe("usage");
    expect(envelope(r.stdout).error?.message).toMatch(MISSING_MOUNT);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("run --repeat refuses an unknown baseline name and a vacuous assertion the same way", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "../ok.yaml", "baseline: no-such-baseline\n"));
    writeFileSync(
      join(d, "sc", "v.yaml"),
      `name: v\nprompt: hi\nfidelity: hostloop\nsession: ../ok.yaml\nassert:\n  - tool_not_called: NotebookEdit\n`,
    );
    for (const [file, why] of [
      ["sc/u.yaml", /no-such-baseline/],
      ["sc/v.yaml", /can never be violated/],
    ] as const) {
      const r = cli(["run", file, "--repeat", "2", "--output-format", "json"], d, STUB_CREDENTIAL);
      expect(r.all).not.toMatch(SPAWN_GUARD);
      expect(r.code, r.all).toBe(2);
      expect(envelope(r.stdout).error?.message).toMatch(why);
      expect(runDirsUnder(r.runs)).toEqual([]);
    }
  });

  it("record <dir/> --dry-run: input refusals survive the budget refusal on stderr", () => {
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
    expect(r.stderr).toMatch(/✗ refused: .*b\.yaml: mount source\(s\) not found/);
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

  it("record <dir/> --dry-run refuses it (exit 1, ok false)", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const doc = JSON.parse(r.stdout) as { ok: boolean; refusals: { file: string; message: string }[] };
    expect(doc.ok).toBe(false);
    expect(doc.refusals).toHaveLength(1);
    expect(doc.refusals[0].file).toMatch(/v\.yaml$/);
    expect(doc.refusals[0].message).toMatch(/can never be violated/);
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

  it("record <file> --dry-run refuses it (exit 1), and the refusal survives --quiet", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "v.yaml"), VACUOUS("v"));
    const json = cli(["record", "sc/v.yaml", "--dry-run", "--output-format", "json"], d);
    expect(json.code, json.all).toBe(1);
    expect(envelope(json.stdout).ok).toBe(false);
    expect(envelope(json.stdout).error?.message).toMatch(/can never be violated/);
    const text = cli(["record", "sc/v.yaml", "--dry-run", "--quiet"], d);
    expect(text.code, text.all).toBe(1);
    expect(text.stderr).toMatch(/can never be violated/);
  });

  it("record <file> --dry-run with an unreadable session AND a vacuous assertion names the session, as the real record does", () => {
    const d = fixture();
    writeFileSync(
      join(d, "sc", "sv.yaml"),
      `name: sv\nprompt: hi\nfidelity: hostloop\nsession: ../gone.yaml\nassert:\n  - tool_not_called: NotebookEdit\n`,
    );
    const r = cli(["record", "sc/sv.yaml", "--dry-run", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    expect(envelope(r.stdout).error?.message).toMatch(/^record: session file not found/);
  });
});

// A `session:` file that is not there is an input-path error like any other: `run` refuses it as a usage
// error before a run dir exists (it was a raw ENOENT, category `internal`), `run <dir/>` refuses the batch
// before its first scenario runs, and both `record --dry-run` arms refuse it with exit 1.
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

  it("record <file> --dry-run: refused with exit 1, and the refusal survives --quiet", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../gone.yaml"));
    const r = cli(["record", "sc/m.yaml", "--dry-run", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    expect(envelope(r.stdout).ok).toBe(false);
    expect(envelope(r.stdout).error?.message).toMatch(/^record: session file not found: .*gone\.yaml/);
    const text = cli(["record", "sc/m.yaml", "--dry-run", "--model", "claude-sonnet-5", "--quiet"], d);
    expect(text.code, text.all).toBe(1);
    expect(text.stderr).toMatch(/session file not found/);
  });

  it("real record <file>: refused (exit 1, usage) with the clean message, no run dir", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "m.yaml"), SCENARIO("m", "../gone.yaml"));
    const r = cli(
      ["record", "sc/m.yaml", "--model", "claude-sonnet-5", "--out", join(d, "m.cassette.json"), "--output-format", "json"],
      d,
      {
        CLAUDE_CODE_OAUTH_TOKEN: "dummy",
      },
    );
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/^record: session file not found: .*gone\.yaml/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("record <dir/> --dry-run: refused with exit 1", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "a.yaml"), SCENARIO("a", "../ok.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), SCENARIO("b", "../gone.yaml"));
    const r = cli(["record", "sc/", "--dry-run", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const doc = JSON.parse(r.stdout) as { ok: boolean; refusals: { file: string; message: string }[] };
    expect(doc.ok).toBe(false);
    expect(doc.refusals).toHaveLength(1);
    expect(doc.refusals[0].file).toMatch(/b\.yaml$/);
    expect(doc.refusals[0].message).toMatch(NOT_FOUND);
  });

  it("`~<user>` session: record --dry-run and the real record both refuse it (usage)", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "u.yaml"), SCENARIO("u", "~someone-else/s.yaml"));
    const dry = cli(["record", "sc/u.yaml", "--dry-run", "--model", "claude-sonnet-5", "--output-format", "json"], d);
    expect(dry.code, dry.all).toBe(1);
    expect(envelope(dry.stdout).error?.message).toMatch(/another user's home directory/);
    expect(dry.all).not.toMatch(/expandUserPath:/);
    const real = cli(
      ["record", "sc/u.yaml", "--model", "claude-sonnet-5", "--out", join(d, "u.cassette.json"), "--output-format", "json"],
      d,
      {
        CLAUDE_CODE_OAUTH_TOKEN: "dummy",
      },
    );
    expect(real.code, real.all).toBe(1);
    expect(envelope(real.stdout).error?.category).toBe("usage");
    expect(envelope(real.stdout).error?.message).toMatch(/another user's home directory/);
    expect(real.all).not.toMatch(/expandUserPath:/);
    expect(runDirsUnder(real.runs)).toEqual([]);
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
    const r = cli(["run", "sc/t.yaml", "--output-format", "json"], d, { ...STUB_CREDENTIAL, HOME: d });
    expect(r.all).toMatch(SPAWN_GUARD);
    expect(r.all).not.toMatch(/ENOENT|session file not found/);
  });
});

describe.skipIf(!can)("a cassette recorded against a baseline this version no longer ships", () => {
  const STALE = "baseline moved 1.13576.1";
  const retiredCassette = (cowork = false): string => {
    const d = work();
    mkdirSync(join(d, "replays"));
    cpSync(resolve("examples/sessions"), join(d, "sessions"), { recursive: true });
    const cassette = JSON.parse(readFileSync(resolve("examples/replays/hostloop-computer-links.cassette.json"), "utf8"));
    cassette.scenario.baseline = "desktop-1.13576.1";
    cassette.fingerprint.baseline = "1.13576.1";
    if (cowork) {
      cassette.scenario.fidelity = "cowork";
      cassette.effectiveFidelity = "hostloop";
    }
    writeFileSync(join(d, "replays", "x.cassette.json"), JSON.stringify(cassette));
    return join(d, "replays");
  };

  it("replay still replays it and warns that it is stale", () => {
    const r = cli(["replay", "x.cassette.json", "--output-format", "json"], retiredCassette());
    expect(r.code, r.all).toBe(0);
    expect(r.stderr).toContain(STALE);
  });

  it("verify-cassettes fails it as stale", () => {
    const r = cli(["verify-cassettes", "x.cassette.json", "--output-format", "json"], retiredCassette());
    expect(r.code, r.all).toBe(1);
    expect(JSON.parse(r.stdout).results[0].staleness.join("\n")).toContain(STALE);
  });

  it("verify-cassettes says a cowork cassette's pin is below the oldest baseline, which a merely old pin is not", () => {
    const r = cli(["verify-cassettes", "x.cassette.json", "--output-format", "json"], retiredCassette(true));
    expect(r.code, r.all).toBe(1);
    expect(JSON.parse(r.stdout).results[0].unverifiable.join("\n")).toContain("older than desktop-");
  });
});
