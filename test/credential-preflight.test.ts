// A scenario with no credential its tier hands the agent is refused before anything runs, on every lane that drives
// the agent: `run` (file, directory, matrix, `legs:`), `skill`, `record` (whose own guard refuses ANY tier with no
// credential at all, before its other checks) and `chat`. `critique` gets doctor's check for its own tier. Every tier
// takes CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY; ANTHROPIC_AUTH_TOKEN reaches the agent at protocol only, so an
// ANTHROPIC_AUTH_TOKEN-only setup is refused at every other tier. A batch names each tier's scenarios in one refusal.
// The check runs LAST among the pre-spend refusals, so a missing model is still reported as that, and `--dry-run`
// (which spends nothing) is not refused.
//
// Token-free: every call blanks the three credential variables, sets COWORK_HARNESS_FORBID_SPAWN (a missing check
// ends at the spawn guard, never at an agent), and runs from a temp cwd under a temp HOME, so neither a ./.env nor
// the operator's own files can supply a credential the test did not choose.
import { describe, it, expect, afterEach, vi } from "vitest";
import { credentialPreflight } from "../src/run/execute.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";
import { spawnHostLoop } from "../src/runtime/hostloop.js";
import { spawnContainer } from "../src/runtime/container.js";
import { spawnMicroVm } from "../src/runtime/microvm.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const REFUSAL = "fidelity protocol needs a credential in the environment (env / .env)";
const refusalAt = (tier: string) => `fidelity ${tier} needs a credential in the environment (env / .env)`;
const AUTH_TOKEN_ONLY = "only ANTHROPIC_AUTH_TOKEN is set, and it reaches the agent at fidelity protocol only";
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

describe.skipIf(!can)("credential pre-flight", () => {
  it("run <dir/>: one refusal (exit 2) per tier names that tier's scenarios, before any runs", () => {
    const d = work({ alpha: "protocol", beta: "protocol", gamma: "container" });
    const r = cli(["run", "sc/"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`scenarios alpha, beta: ${REFUSAL}`);
    expect(r.all).toContain(`scenario "gamma": ${refusalAt("container")}`);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  it("ANTHROPIC_AUTH_TOKEN alone passes at protocol and is refused at container and hostloop, with the reason", () => {
    const d = work({ alpha: "protocol", gamma: "container", delta: "hostloop" });
    const env = { ANTHROPIC_AUTH_TOKEN: "stub-not-a-real-credential" };
    expect(cli(["run", "sc/alpha.yaml"], d, env).all).toMatch(SPAWN_GUARD);
    for (const [name, tier] of [
      ["gamma", "container"],
      ["delta", "hostloop"],
    ]) {
      const r = cli(["run", `sc/${name}.yaml`], d, env);
      expect(r.code, r.all).toBe(2);
      expect(r.all).toContain(`scenario "${name}": ${refusalAt(tier)} — ${AUTH_TOKEN_ONLY}`);
      expect(r.all).toContain("agent_env.passthrough");
      expect(r.all).not.toMatch(SPAWN_GUARD);
    }
  });

  it("run <file>: names the one scenario", () => {
    const d = work({ alpha: "protocol" });
    const r = cli(["run", "sc/alpha.yaml"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`scenario "alpha": ${REFUSAL}`);
  });

  it("a container scenario is asked for a credential too, and either kind passes there", () => {
    const d = work({ gamma: "container" });
    expect(cli(["run", "sc/"], d).all).toContain(refusalAt("container"));
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"])
      expect(cli(["run", "sc/"], d, { [key]: "stub-not-a-real-credential" }).all, key).not.toContain(refusalAt("container"));
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

  it("chat at container (its default): refused (exit 2) before the run dir exists", () => {
    const d = work({});
    mkdirSync(join(d, "sk"));
    writeFileSync(join(d, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
    const r = cli(["chat", "sk", "--model", "claude-sonnet-5"], d, { ANTHROPIC_AUTH_TOKEN: "stub-not-a-real-credential" });
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`this \`chat\` session: ${refusalAt("container")} — ${AUTH_TOKEN_ONLY}`);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  it("record at container with ANTHROPIC_AUTH_TOKEN alone: past the any-credential guard, refused by the tier check (exit 2, as every credential refusal)", () => {
    const d = work({ gamma: "container" });
    for (const target of ["sc/", "sc/gamma.yaml"]) {
      const r = cli(["record", target], d, { ANTHROPIC_AUTH_TOKEN: "stub-not-a-real-credential" });
      expect(r.code, r.all).toBe(2);
      expect(r.all).toContain(`record: scenario "gamma": ${refusalAt("container")} — ${AUTH_TOKEN_ONLY}`);
      expect(r.all).not.toMatch(SPAWN_GUARD);
    }
  });

  it("critique (container, its default): doctor's check for its tier refuses (exit 2) before the task turn", () => {
    const d = work({});
    mkdirSync(join(d, "sk"));
    writeFileSync(join(d, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
    const r = cli(["critique", "sk", "--prompt", "do the thing", "--model", "claude-sonnet-5"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain("critique: no usable agent credential for fidelity container");
    expect(r.all).toMatch(/looked in: the environment; \.\/\.env \(/);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });

  // The refusal lists where the CLI looked, highest precedence first: the environment, a --dotenv (given AFTER the
  // subcommand here, so the per-command path records it too), ./.env, the install's .env. Proves main() and the
  // per-command loader actually record their sources — a stub probe alone would pass without either.
  it("a missing credential names where it looked, a trailing --dotenv first among the files", () => {
    const d = work({ alpha: "protocol" });
    writeFileSync(join(d, "empty.env"), "# no credential here\n");
    for (const args of [
      ["run", "sc/alpha.yaml", "--dotenv", "empty.env"],
      ["record", "sc/alpha.yaml", "--dotenv", "empty.env"],
    ]) {
      const r = cli(args, d);
      expect(r.code, r.all).toBe(2);
      const looked = r.all.match(/looked in: ([^)]*\)[^)]*\)[^)]*\))/)?.[1] ?? "";
      expect(looked, `${args[0]}: ${r.all}`).toMatch(
        /^the environment; --dotenv \S*empty\.env; \.\/\.env \(\S*\.env, no such file\); the install's \.env \(\S*\.env/,
      );
      // the pointer at a file comes after the list, the Keychain note after both
      const at = (t: string) => r.all.indexOf(t);
      expect(at("--dotenv <path>"), args[0]).toBeGreaterThan(at("looked in:"));
      expect(r.all.lastIndexOf("Keychain"), args[0]).toBeGreaterThan(at("--dotenv <path>"));
    }
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

  it("record --rerecord-stale: ANTHROPIC_AUTH_TOKEN alone is refused (exit 2) before the first re-record", () => {
    const d = work({});
    const cassette = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "st",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      fingerprint: { baseline: "0.0.0-ancient", hashFormat: "jcs1" },
    };
    writeFileSync(join(d, "sc", "st.cassette.json"), JSON.stringify(cassette));
    writeFileSync(
      join(d, "sc", "st.yaml"),
      "name: st\nfidelity: container\nsession: ../session.yaml\nprompt: hi\nassert:\n  - result: success\n",
    );
    const r = cli(["record", "--rerecord-stale", "sc"], d, { ANTHROPIC_AUTH_TOKEN: "stub-not-a-real-credential" });
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`record: scenario "st": ${refusalAt("container")} — ${AUTH_TOKEN_ONLY}`);
    expect(r.all).not.toMatch(SPAWN_GUARD);
  });

  it("probe-dispatch (hostloop by default): ANTHROPIC_AUTH_TOKEN alone is refused (exit 2) before staging", () => {
    const d = work({});
    mkdirSync(join(d, "sk"));
    writeFileSync(join(d, "sk", "SKILL.md"), "---\nname: sk\ndescription: a stub skill\n---\nbody\n");
    const r = cli(["probe-dispatch", "sk", "hi", "--model", "claude-sonnet-5"], d, { ANTHROPIC_AUTH_TOKEN: "stub-not-a-real-credential" });
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain(`${refusalAt("hostloop")} — ${AUTH_TOKEN_ONLY}`);
    expect(r.all).not.toMatch(SPAWN_GUARD);
    expect(existsSync(join(d, ".runs"))).toBe(false);
  });
});

describe("credentialPreflight: a scenario with no fidelity", () => {
  it("throws instead of skipping its check", () => {
    expect(() => credentialPreflight([{ name: "x" }], () => ({ status: "ok" }) as never)).toThrow(/scenario "x" has no fidelity/);
  });
});

describe("every tier's spawn re-checks the credential (the backstop for a launcher with no pre-flight)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["hostloop", () => spawnHostLoop({ name: "bk" } as never, {} as never, {} as never, "/nonexistent", "sid")],
    ["container", () => spawnContainer({ name: "bk" } as never, {} as never, {} as never, "/nonexistent", "sid", {})],
    ["microvm", () => spawnMicroVm({ name: "bk" } as never, {} as never, {} as never, "/nonexistent", "sid")],
  ])("%s: ANTHROPIC_AUTH_TOKEN alone throws the tier's refusal before anything starts", (tier, spawn) => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "stub-not-a-real-credential");
    expect(spawn).toThrow(`bk: ${refusalAt(tier)} — ${AUTH_TOKEN_ONLY}`);
  });
});
