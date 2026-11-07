// A run that resolves no model is refused (4.0.0). Before that it warned and ran on whatever model the
// local agent binary defaulted to, which made the run's model, and so the system prompt the agent is
// given, a property of the machine rather than of the scenario.
//
// The model resolves from, in order: `--model` (or a matrix `models:` axis), the session's `model:`, then
// `COWORK_HARNESS_MODEL`. When none names one, every lane that would drive the agent refuses before it
// spends or creates a run dir:
//  - `run` (file, directory, matrix) exits 2 (usage); a directory or matrix refuses before the FIRST
//    scenario or cell runs;
//  - `skill` / `probe-dispatch` exit 2 before staging; `skill --dry-run` does not refuse, it prints
//    `model: null`;
//  - `record` (file, directory, `--rerecord-stale`, and `--dry-run` on a file or directory) exits 1, the
//    code of its other pre-spend refusals of a scenario that loaded;
//  - `chat` and `chat --raw` exit 2;
//  - `critique` exits 2 before its task turn; `--corpus-only` is unaffected.
//
// Token-free throughout. COWORK_HARNESS_FORBID_SPAWN is set, so a check that is missing ends at the spawn
// guard (a different error, after the run dir exists), never at a real agent. Every CLI call clears
// COWORK_HARNESS_MODEL (an empty value counts as unset) and runs from a temp cwd, so neither the shell nor a
// `./.env` can supply a model the test did not choose.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UsageError } from "../src/errors.js";
import { executeScenario } from "../src/run/execute.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

const CLI = resolve("dist/cli.js");
/** A stand-in credential for a protocol run that must reach the spawn (refused there by COWORK_HARNESS_FORBID_SPAWN, so
 *  the value is never sent): without one the protocol credential pre-flight answers first. */
const STUB_CREDENTIAL = { CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" };
const can = existsSync(CLI);

const SPAWN_GUARD = /COWORK_HARNESS_FORBID_SPAWN is set/;
/** The refusal names all three channels, so the reader can pick the one that fits. */
function expectNamesChannels(text: string): void {
  expect(text).toMatch(/`model:`/);
  expect(text).toMatch(/--model/);
  expect(text).toMatch(/COWORK_HARNESS_MODEL/);
}

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-model-req-"));
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
  const out: string[] = [];
  for (const name of readdirSync(runs)) if (!name.startsWith(".")) out.push(name);
  return out;
}

/** A scenario with an inline session: nothing in it pins a model. */
const UNPINNED = (name: string) => `name: ${name}\nprompt: hi\nfidelity: protocol\nassert:\n  - result: success\n`;
/** A scenario whose session file declares `model:`. */
const PINNED = (name: string) =>
  `name: ${name}\nprompt: hi\nfidelity: protocol\nsession: pinned-session.yaml\nassert:\n  - result: success\n`;
const PINNED_SESSION = "model: claude-sonnet-5\n";

function envelope(stdout: string): { ok?: boolean; error?: { category?: string; message?: string } } {
  return JSON.parse(stdout);
}

describe("executeScenario refuses a scenario that resolves no model", () => {
  const scenario = {
    name: "unpinned",
    prompt: "hi",
    baseline: "latest",
    session: "(inline)",
    fidelity: "protocol",
    answers: [],
    expect_denied: [],
    assert: [{ result: "success" }],
  } as unknown as Parameters<typeof executeScenario>[0];

  it("rejects with a UsageError naming the three channels, before any run dir exists", async () => {
    const runs = work();
    const prev = { runs: process.env.COWORK_HARNESS_RUNS_DIR, model: process.env.COWORK_HARNESS_MODEL };
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    delete process.env.COWORK_HARNESS_MODEL;
    try {
      const err = await executeScenario(scenario).catch((e: unknown) => e);
      expect((err as Error).message).not.toMatch(SPAWN_GUARD);
      expect(err).toBeInstanceOf(UsageError);
      expectNamesChannels((err as Error).message);
      expect(runDirsUnder(runs), "a refused run must not mint a run dir").toEqual([]);
    } finally {
      if (prev.runs === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev.runs;
      if (prev.model !== undefined) process.env.COWORK_HARNESS_MODEL = prev.model;
    }
  });
});

describe.skipIf(!can)("run", () => {
  it("a file that resolves no model exits 2 (usage) naming the channels, with no run dir", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    const r = cli(["run", "s.yaml", "--output-format", "json"], d);
    expect(r.stderr).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("usage");
    expectNamesChannels(env.error?.message ?? "");
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("each channel alone satisfies the check: --model, COWORK_HARNESS_MODEL, the session's model:", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    writeFileSync(join(d, "p.yaml"), PINNED("p"));
    writeFileSync(join(d, "pinned-session.yaml"), PINNED_SESSION);
    // Past the check, the run goes on to the spawn guard: that is the evidence it was not refused.
    for (const [args, env] of [
      [["run", "s.yaml", "--model", "claude-sonnet-5"], {}],
      [["run", "s.yaml"], { COWORK_HARNESS_MODEL: "claude-sonnet-5" }],
      [["run", "p.yaml"], {}],
    ] as [string[], Record<string, string>][]) {
      const r = cli(args, d, { ...STUB_CREDENTIAL, ...env });
      expect(r.all, args.join(" ")).toMatch(SPAWN_GUARD);
      expect(r.all, args.join(" ")).not.toMatch(/no model/i);
    }
  });

  it("a directory refuses before its FIRST scenario runs when a later one resolves no model", () => {
    const d = work();
    mkdirSync(join(d, "sc"));
    writeFileSync(join(d, "sc", "a.yaml"), PINNED("a").replace("pinned-session.yaml", "../pinned-session.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), UNPINNED("b"));
    writeFileSync(join(d, "pinned-session.yaml"), PINNED_SESSION);
    const r = cli(["run", "sc/", "--output-format", "json"], d);
    expect(r.stderr, "a.yaml must not have reached the spawn guard").not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/b\.yaml/);
    expect(env.error?.message).not.toMatch(/a\.yaml/);
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("--matrix: a `models:` axis pins every cell; without one, the matrix refuses before any cell", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    writeFileSync(join(d, "with-models.yaml"), "models: [claude-sonnet-5]\n");
    const ok = cli(["run", "s.yaml", "--matrix", "with-models.yaml"], d, STUB_CREDENTIAL);
    expect(ok.all).not.toMatch(/no model/i);
    expect(ok.all, "the cell ran as far as the spawn guard").toMatch(SPAWN_GUARD);

    // A fresh cwd, so the runs root the cell above wrote into is not the one checked below.
    const d2 = work();
    writeFileSync(join(d2, "s.yaml"), UNPINNED("s"));
    writeFileSync(join(d2, "no-models.yaml"), "baselines: [latest]\n");
    const refused = cli(["run", "s.yaml", "--matrix", "no-models.yaml", "--output-format", "json"], d2);
    expect(refused.all).not.toMatch(SPAWN_GUARD);
    expect(refused.code, refused.all).toBe(2);
    const env = envelope(refused.stdout);
    expect(env.error?.category).toBe("usage");
    expectNamesChannels(env.error?.message ?? "");
    expect(runDirsUnder(refused.runs)).toEqual([]);
  });
});

describe.skipIf(!can)("the model check comes before the budget pre-flight on every run arm", () => {
  // Priced history over the cap, so the budget gate WOULD refuse; the model refusal must answer first, as it
  // does on `run <file>`, `run <dir/>` and `record`.
  function pricedWork(): string {
    const d = work();
    const dir = join(d, ".runs", "s", "local_1");
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(
      join(dir, "turns", "1", "result.json"),
      JSON.stringify({
        scenario: "s",
        fidelity: "protocol",
        baseline: "desktop-1.18286.0",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: dir,
        cost: { usd: 9.5 },
      }),
    );
    cli(["stats", "--reindex"], d);
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    writeFileSync(join(d, "no-models.yaml"), "baselines: [latest]\n");
    return d;
  }

  for (const extra of [[], ["--matrix", "no-models.yaml"]]) {
    it(`run s.yaml ${extra.join(" ")} --max-budget-usd: the model refusal answers`, () => {
      const d = pricedWork();
      const r = cli(["run", "s.yaml", ...extra, "--max-budget-usd", "1.0", "--output-format", "json"], d);
      expect(r.code, r.all).toBe(2);
      const env = envelope(r.stdout);
      expect(env.error?.message).not.toMatch(/refused before spending/);
      expectNamesChannels(env.error?.message ?? "");
      // ...and the budget gate is armed: with a model, it is what refuses.
      const pinned = cli(["run", "s.yaml", ...extra, "--max-budget-usd", "1.0", "--model", "claude-sonnet-5"], d);
      expect(pinned.all).toMatch(/refused before spending/);
    });
  }
});

describe.skipIf(!can)("lanes that run no agent need no model", () => {
  it("replay and verify-cassettes of the committed examples succeed with COWORK_HARNESS_MODEL unset", () => {
    const d = work();
    const replays = resolve("examples/replays");
    const replay = cli(["replay", replays], d);
    expect(replay.all).not.toMatch(/no model is pinned/);
    expect(replay.code, replay.all).toBe(0);
    const verify = cli(["verify-cassettes", replays], d);
    expect(verify.all).not.toMatch(/no model is pinned/);
    expect(verify.code, verify.all).toBe(0);
  });
});

describe.skipIf(!can)("skill and probe-dispatch", () => {
  const plugin = (d: string) => {
    mkdirSync(join(d, "plugin"));
    writeFileSync(join(d, "plugin", "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
  };

  it("skill with no model exits 2 (usage) before staging, naming the channels", () => {
    const d = work();
    plugin(d);
    const r = cli(["skill", "./plugin", "hi", "--output-format", "json"], d);
    expect(r.stderr).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expectNamesChannels(env.error?.message ?? "");
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("skill --dry-run does not refuse: it prints `model: null`, or the model that resolved", () => {
    const d = work();
    plugin(d);
    const none = cli(["skill", "./plugin", "hi", "--dry-run"], d);
    expect(none.code, none.all).toBe(0);
    expect(JSON.parse(none.stdout).model).toBeNull();
    const flag = cli(["skill", "./plugin", "hi", "--dry-run", "--model", "claude-sonnet-5"], d);
    expect(JSON.parse(flag.stdout).model).toBe("claude-sonnet-5");
    const env = cli(["skill", "./plugin", "hi", "--dry-run"], d, { COWORK_HARNESS_MODEL: "claude-haiku-4-5" });
    expect(JSON.parse(env.stdout).model).toBe("claude-haiku-4-5");
  });

  it("probe-dispatch with no model exits 2 (usage) before staging", () => {
    const d = work();
    plugin(d);
    const r = cli(["probe-dispatch", "./plugin", "hi", "--output-format", "json"], d);
    expect(r.stderr).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(2);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expectNamesChannels(env.error?.message ?? "");
  });
});

describe.skipIf(!can)("chat", () => {
  it("chat and chat --raw with no model exit 2 before any run dir or docker work", () => {
    const d = work();
    mkdirSync(join(d, "plugin"));
    for (const args of [
      ["chat", "./plugin"],
      ["chat", "./plugin", "--raw"],
    ]) {
      const r = cli(args, d);
      expect(r.all, args.join(" ")).not.toMatch(SPAWN_GUARD);
      expect(r.code, args.join(" ") + "\n" + r.all).toBe(2);
      expectNamesChannels(r.all);
      expect(runDirsUnder(r.runs)).toEqual([]);
    }
  });
});

describe.skipIf(!can)("record", () => {
  const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: "dummy-token-never-used" };

  it("record <file> --dry-run exits 1 (like the real record), naming the channels", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    const r = cli(["record", "s.yaml", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const env = envelope(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("usage");
    expectNamesChannels(env.error?.message ?? "");
  });

  it("record <file> --dry-run passes the check with --model or COWORK_HARNESS_MODEL", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    expect(cli(["record", "s.yaml", "--dry-run", "--model", "claude-sonnet-5"], d).code).toBe(0);
    expect(cli(["record", "s.yaml", "--dry-run"], d, { COWORK_HARNESS_MODEL: "claude-sonnet-5" }).code).toBe(0);
  });

  it("record <dir/> --dry-run lists an unresolved file under refusals and exits 1", () => {
    const d = work();
    mkdirSync(join(d, "sc"));
    writeFileSync(join(d, "sc", "a.yaml"), PINNED("a").replace("pinned-session.yaml", "../pinned-session.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), UNPINNED("b"));
    writeFileSync(join(d, "pinned-session.yaml"), PINNED_SESSION);
    const r = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(1);
    const doc = JSON.parse(r.stdout) as { ok: boolean; refusals: { file: string; message: string }[] };
    expect(doc.ok).toBe(false);
    expect(doc.refusals.map((x) => x.file.replace(/.*\//, ""))).toEqual(["b.yaml"]);
    expectNamesChannels(doc.refusals[0].message);
    // --model applies batch-wide, as on the real record.
    expect(cli(["record", "sc/", "--dry-run", "--model", "claude-sonnet-5"], d).code).toBe(0);
  });

  it("a session that does not load is skipped by the dry-run model check, not refused for a model", () => {
    // The check opens the session only to read `model:`. A session that is missing on this machine is not
    // its question to answer (the real record reports it), so neither dry-run arm blames the model for it.
    const d = work();
    mkdirSync(join(d, "sc"));
    const missing = `name: m\nprompt: hi\nfidelity: protocol\nsession: ./no-such-session.yaml\nassert:\n  - result: success\n`;
    writeFileSync(join(d, "sc", "m.yaml"), missing);
    const file = cli(["record", "sc/m.yaml", "--dry-run"], d);
    expect(file.all).not.toMatch(/no model is pinned/);
    const dir = cli(["record", "sc/", "--dry-run", "--output-format", "json"], d);
    const doc = JSON.parse(dir.stdout) as { refusals: { file: string; message: string }[] };
    expect(doc.refusals.filter((x) => /no model is pinned/.test(x.message))).toEqual([]);
  });

  it("record <file> (real) refuses with exit 1 before any run dir, naming the channels", () => {
    const d = work();
    writeFileSync(join(d, "s.yaml"), UNPINNED("s"));
    const r = cli(["record", "s.yaml", "--output-format", "json"], d, TOKEN);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expectNamesChannels(env.error?.message ?? "");
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("record <dir/> (real) refuses before its first spawn, naming the unresolved file", () => {
    const d = work();
    mkdirSync(join(d, "sc"));
    writeFileSync(join(d, "sc", "a.yaml"), PINNED("a").replace("pinned-session.yaml", "../pinned-session.yaml"));
    writeFileSync(join(d, "sc", "b.yaml"), UNPINNED("b"));
    writeFileSync(join(d, "pinned-session.yaml"), PINNED_SESSION);
    const r = cli(["record", "sc/", "--output-format", "json"], d, TOKEN);
    expect(r.all, "a.yaml must not have reached the spawn guard").not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/b\.yaml/);
    expectNamesChannels(env.error?.message ?? "");
    expect(runDirsUnder(r.runs)).toEqual([]);
  });

  it("record --rerecord-stale refuses before its first re-record when a source resolves no model", () => {
    const d = work();
    const cassette = (name: string) => ({
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name,
        baseline: "latest",
        session: "(inline)",
        fidelity: "protocol",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      fingerprint: { baseline: "0.0.0-ancient", hashFormat: "jcs1" },
    });
    writeFileSync(join(d, "a.cassette.json"), JSON.stringify(cassette("a")));
    writeFileSync(join(d, "b.cassette.json"), JSON.stringify(cassette("b")));
    writeFileSync(join(d, "a.yaml"), PINNED("a"));
    writeFileSync(join(d, "b.yaml"), UNPINNED("b"));
    writeFileSync(join(d, "pinned-session.yaml"), PINNED_SESSION);
    const r = cli(["record", "--rerecord-stale", d, "--output-format", "json"], d, TOKEN);
    expect(r.all, "a must not have reached the spawn guard").not.toMatch(SPAWN_GUARD);
    expect(r.code, r.all).toBe(1);
    const env = envelope(r.stdout);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/b\.yaml/);
    expectNamesChannels(env.error?.message ?? "");
    expect(runDirsUnder(r.runs)).toEqual([]);
  });
});

describe.skipIf(!can)("critique", () => {
  const skill = (d: string) => {
    mkdirSync(join(d, "skill"));
    writeFileSync(join(d, "skill", "SKILL.md"), "---\nname: s\ndescription: a test skill\n---\nDo the thing.\n");
  };

  it("with no model exits 2 before its task turn, naming the channels", () => {
    const d = work();
    skill(d);
    const r = cli(["critique", "./skill", "--prompt", "hi"], d);
    expect(r.all, "the task turn must not have started").not.toMatch(SPAWN_GUARD);
    expect(r.all).not.toMatch(/task turn/);
    expect(r.code, r.all).toBe(2);
    expectNamesChannels(r.stderr);
  });

  it("--corpus-only runs no turn, so it needs no model", () => {
    const d = work();
    skill(d);
    const r = cli(["critique", "./skill", "--corpus-only"], d);
    expect(r.all).not.toMatch(/COWORK_HARNESS_MODEL/);
    expect(r.code, r.all).toBe(0);
  });
});
