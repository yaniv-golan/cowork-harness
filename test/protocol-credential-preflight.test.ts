// A protocol scenario with no credential in the environment is refused before anything runs, on every lane that
// drives the agent: `run` (file, directory, matrix, `legs:`), `skill`, and `record` (whose own guard refuses ANY tier with no
// credential in the environment, before its other checks; for protocol that is the same predicate), and `chat`.
// `critique`, which never runs at protocol, gets doctor's check for its own tier. A batch names every
// protocol scenario in one refusal and none of the others. The check runs LAST among the pre-spend refusals, so a
// missing model is still reported as that, and `--dry-run` (which spends nothing) is not refused.
//
// Token-free: every call blanks the three credential variables, sets COWORK_HARNESS_FORBID_SPAWN (a missing check
// ends at the spawn guard, never at an agent), and runs from a temp cwd under a temp HOME, so neither a ./.env nor
// the operator's own files can supply a credential the test did not choose.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const REFUSAL = "fidelity protocol needs a credential in the environment (env / .env)";
const SPAWN_GUARD = /COWORK_HARNESS_FORBID_SPAWN is set/;

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: cwd,
      COWORK_HARNESS_FORBID_SPAWN: "1",
      COWORK_HARNESS_RUNS_DIR: join(cwd, ".runs"),
      COWORK_HARNESS_MODEL: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ...env,
    },
  });
  return { code: r.status, all: (r.stdout || "") + (r.stderr || "") };
}

/** A work dir holding a pinned session and the named scenarios (`name` → fidelity). */
function work(scenarios: Record<string, string>, model = true): string {
  const d = mkdtempSync(join(tmpdir(), "cred-preflight-"));
  writeFileSync(join(d, "session.yaml"), model ? "model: claude-sonnet-5\n" : "permission_mode: default\n");
  mkdirSync(join(d, "sc"));
  for (const [name, fidelity] of Object.entries(scenarios))
    writeFileSync(
      join(d, "sc", `${name}.yaml`),
      `name: ${name}\nfidelity: ${fidelity}\nsession: ../session.yaml\nprompt: hi\nassert:\n  - result: success\n`,
    );
  return d;
}

describe.skipIf(!can)("protocol credential pre-flight", () => {
  it("run <dir/>: one refusal (exit 2) names every protocol scenario and no other, before any runs", () => {
    const d = work({ alpha: "protocol", beta: "protocol", gamma: "container" });
    const r = cli(["run", "sc/"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`scenarios alpha, beta: ${REFUSAL}`);
    expect(r.all).not.toMatch(/gamma/);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  it("run <file>: names the one scenario", () => {
    const d = work({ alpha: "protocol" });
    const r = cli(["run", "sc/alpha.yaml"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`scenario "alpha": ${REFUSAL}`);
  });

  it("a directory with no protocol scenario is not asked for one", () => {
    const d = work({ gamma: "container" });
    expect(cli(["run", "sc/"], d).all).not.toContain(REFUSAL);
  });

  it("a missing model is reported first: the credential check runs last", () => {
    const d = work({ alpha: "protocol" }, false);
    const r = cli(["run", "sc/alpha.yaml"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toMatch(/no model/i);
    expect(r.all).not.toContain(REFUSAL);
  });

  it("any one credential kind passes the check (the run goes on to the spawn guard)", () => {
    const d = work({ alpha: "protocol" });
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      const r = cli(["run", "sc/alpha.yaml"], d, { [key]: "stub-not-a-real-credential" });
      expect(r.all, key).toMatch(SPAWN_GUARD);
      expect(r.all, key).not.toContain(REFUSAL);
    }
  });

  it("run --matrix: refused before the first cell", () => {
    const d = work({ alpha: "protocol" });
    writeFileSync(join(d, "m.yaml"), "models: [claude-sonnet-5, claude-opus-4-8]\n");
    const r = cli(["run", "sc/alpha.yaml", "--matrix", "m.yaml"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(REFUSAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
  });

  it("skill --fidelity protocol: refused before staging; --dry-run is not", () => {
    const d = work({});
    mkdirSync(join(d, "sk"));
    writeFileSync(join(d, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
    const r = cli(["skill", "sk", "hi", "--fidelity", "protocol", "--model", "claude-sonnet-5"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(REFUSAL);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    const dry = cli(["skill", "sk", "hi", "--fidelity", "protocol", "--model", "claude-sonnet-5", "--dry-run"], d);
    expect(dry.code, dry.all).toBe(0);
  });

  it("run <legs.yaml>: refused before the scenario root or any status.json exists", () => {
    const d = work({});
    writeFileSync(
      join(d, "sc", "legs.yaml"),
      "name: legs\nfidelity: protocol\nsession: ../session.yaml\nlegs:\n  - id: a\n    prompt: one\n  - id: b\n    prompt: two\n",
    );
    const r = cli(["run", "sc/legs.yaml"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`scenario "legs": ${REFUSAL}`);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  it("record <legs.yaml>: the all-tier guard refuses before any leg runs, at every tier", () => {
    for (const fidelity of ["protocol", "container"]) {
      const d = work({});
      writeFileSync(
        join(d, "sc", "legs.yaml"),
        `name: legs\nfidelity: ${fidelity}\nsession: ../session.yaml\nlegs:\n  - id: a\n    prompt: one\n  - id: b\n    prompt: two\n`,
      );
      const r = cli(["record", "sc/legs.yaml"], d);
      expect(r.code, `${fidelity}: ${r.all}`).toBe(2);
      expect(r.all).toContain("record: no model credentials");
      expect(r.all).not.toMatch(SPAWN_GUARD);
      expect(existsSync(join(d, ".runs")), fidelity).toBe(false);
      const dry = cli(["record", "sc/legs.yaml", "--dry-run"], d);
      expect(dry.all, fidelity).not.toContain("no model credentials");
    }
  });

  it("chat --fidelity protocol: refused (exit 2) before the run dir exists, and the agent never starts", () => {
    const d = work({});
    mkdirSync(join(d, "sk"));
    writeFileSync(join(d, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
    const r = cli(["chat", "sk", "--fidelity", "protocol", "--model", "claude-sonnet-5"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`this \`chat\` session: ${REFUSAL}`);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  it("critique (container, its default): doctor's check for its tier refuses (exit 2) before the task turn", () => {
    const d = work({});
    mkdirSync(join(d, "sk"));
    writeFileSync(join(d, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
    const r = cli(["critique", "sk", "--prompt", "do the thing", "--model", "claude-sonnet-5"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain("critique: no usable agent credential for fidelity container");
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  it("record: its all-tier guard refuses first (exit 2, nothing spawned); --dry-run is not refused", () => {
    const d = work({ alpha: "protocol", gamma: "container" });
    for (const target of ["sc/", "sc/alpha.yaml"]) {
      const r = cli(["record", target], d);
      expect(r.code, r.all).toBe(2);
      expect(r.all).toContain("record: no model credentials");
      expect(r.all).not.toMatch(SPAWN_GUARD);
    }
    const dry = cli(["record", "sc/", "--dry-run"], d);
    expect(dry.all).not.toContain("no model credentials");
    expect(dry.all).not.toContain(REFUSAL);
  });
});
