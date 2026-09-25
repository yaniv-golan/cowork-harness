import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { VERDICT_MODIFIER_KEYS } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

// Exercises the built CLI's --output-format json envelope + exit codes. Token-free and spawn-free
// (usage/boundary fail before any agent spawn; replay is deterministic). Needs `dist/cli.js`
// (the `ci` script builds before testing); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], env?: NodeJS.ProcessEnv) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-cli-")); // isolated cwd so no stray .env is loaded
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, ...(env ? { env: { ...process.env, ...env } } : {}) });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json, cwd };
}
function writeIn(cwd: string, name: string, body: string) {
  writeFileSync(join(cwd, name), body);
}
const cassette = (assert: unknown[], text = "hello there", controlOut?: string[]) => ({
  cassetteVersion: CASSETTE_VERSION,
  scenario: {
    name: "c",
    baseline: "latest",
    session: "(inline)",
    fidelity: "container",
    prompt: "hi",
    answers: [],
    expect_denied: [],
    assert,
  },
  events: [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ],
  ...(controlOut !== undefined ? { controlOut } : {}),
});

describe.skipIf(!can)("cli --output-format json envelope + exit codes", () => {
  it("usage error → {ok:false, error:{category:'usage'}}, exit 2", () => {
    const r = run(["skill", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.ok).toBe(false);
    expect(r.json?.error?.category).toBe("usage");
  });

  // #44-48: success JSON output carries the shared payload envelope frame (tool/version/command/ok/error).
  // `assertions --list` is the cheapest to exercise (static, no run dir); its data field (assertions[]) is
  // preserved alongside the frame.
  it("assertions --list --json carries the shared envelope frame + preserves its payload", () => {
    const r = run(["assertions", "--list", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.tool).toBe("cowork-harness");
    expect(typeof r.json?.version).toBe("string");
    expect(r.json?.command).toBe("assertions");
    expect(r.json?.ok).toBe(true);
    expect(r.json?.error).toBeNull();
    expect(Array.isArray(r.json?.assertions)).toBe(true); // payload field preserved
    expect(r.json.assertions.some((a: any) => a.key === "file_exists")).toBe(true);
  });

  it("--resume without --session-id → usage error, exit 2", () => {
    const r = run(["skill", "./x", "hi", "--resume", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--resume requires --session-id/);
  });

  it("--on-unanswered external (removed) → usage error redirecting to --decider-dir, exit 2", () => {
    // The stdio channel was removed; the redirect must fire at resolvePolicy (the choke point both
    // run and skill pass through) so it can't silently degrade to `fail` and pass a no-gate run green.
    const r = run(["skill", "./x", "hi", "--on-unanswered", "external", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--on-unanswered external was removed/);
    expect(r.json?.error?.message).toMatch(/--decider-dir/);
  });

  it("invalid --on-unanswered value → usage error fail|prompt|first, exit 2", () => {
    const r = run(["skill", "./x", "hi", "--on-unanswered", "banana", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/must be fail\|prompt\|first/);
  });

  it("invalid --output-format value → exit 2 (not silently treated as text)", () => {
    const r = run(["skill", "./x", "hi", "--output-format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--output-format must be/);
  });

  it("invalid --fidelity → usage (not internal), exit 2", () => {
    const r = run(["skill", "./x", "hi", "--fidelity", "bogus", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage"); // was `internal` (Zod throw → top-level catch)
    expect(r.json?.error?.message).toMatch(/--fidelity must be one of/);
  });

  it("extra skill positional → usage error, exit 2", () => {
    const r = run(["skill", "./x", "hi", "stray-extra", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/unexpected extra argument/);
  });

  it("decide with both --decider-llm and --decider-cmd → usage conflict, exit 2", () => {
    const r = run(["decide", "--decider-llm", "--decider-cmd", "cat", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/conflicts with --decider-cmd/);
  });

  it("decide --decider-dir surfaces a dirty dir as a json error envelope, exit 2", () => {
    // `decide` used to REJECT --decider-dir outright; it now rehearses the in-band channel for real.
    // Use a DIRTY dir deliberately: it exercises the production fresh-dir guard and returns immediately.
    // A fresh dir would (correctly) block on the rendezvous until answered — see decide-in-band.test.ts
    // for the round trip, and never invoke this path unanswered in a test.
    const dir = mkdtempSync(join(tmpdir(), "cli-json-decide-"));
    writeFileSync(join(dir, "req-1.json"), "{}\n");
    const r = run(["decide", "--decider-dir", dir, "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("runtime");
    expect(r.json?.error?.message).toMatch(/use a fresh, empty directory per run/);
  });

  it.skipIf(process.platform !== "darwin")("vm with an invalid subcommand exits non-zero (not 0)", () => {
    const r = run(["vm", "bogus-subcommand"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: vm/);
  });

  // Every entry point that feeds a user-supplied baseline name to loadBaseline used to let its bare
  // readFileSync ENOENT escape: category `internal` (a stack trace in text mode), or a usage error whose
  // message was the raw ENOENT with no list. loadBaseline now throws a UsageError naming the valid
  // baselines, so each fails as usage, exit 2. All fail before any agent spawn or Docker call.
  describe("an unknown baseline is a usage error at every entry point", () => {
    const UNKNOWN = /no baseline named "desktop-0\.0\.0" — a baseline is `latest`/;
    const scenarioIn = (cwd: string) => {
      const session = resolve("examples/sessions/protocol-smoke.yaml");
      writeIn(cwd, "s.yaml", `name: s\nsession: ${session}\nfidelity: protocol\nbaseline: desktop-0.0.0\nprompt: hi\n`);
      return join(cwd, "s.yaml");
    };
    const expectUnknown = (r: ReturnType<typeof run>) => {
      expect(r.code).toBe(2);
      expect(r.json?.error?.category).toBe("usage");
      expect(r.json?.error?.message).toMatch(UNKNOWN);
      expect(r.json?.error?.hint).toMatch(/^valid baselines \(newest first\): desktop-\d/);
    };

    it("boundary-check <unknown>", () => expectUnknown(run(["boundary-check", "desktop-0.0.0", "--output-format", "json"])));

    it("boundary-check <unknown> (text) prints the message, not a stack trace", () => {
      const r = run(["boundary-check", "desktop-0.0.0"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(UNKNOWN);
      expect(r.stderr).not.toMatch(/ENOENT|\n\s+at /);
    });

    it("diff <unknown> <baseline> carries the valid baselines as its hint", () =>
      expectUnknown(run(["diff", "desktop-0.0.0", "desktop-2.9939.2", "--output-format", "json"])));

    it("run <scenario with an unknown baseline:>", () => {
      const cwd = mkdtempSync(join(tmpdir(), "cc-bl-"));
      expectUnknown(run(["run", scenarioIn(cwd), "--output-format", "json"]));
    });

    it("record <scenario with an unknown baseline:> exits 2, not record's general 1", () => {
      const cwd = mkdtempSync(join(tmpdir(), "cc-bl-"));
      // record's auth guard runs before the baseline loads, so give it a token: whether one is present
      // otherwise depends on the machine (the CLI auto-loads its install dir's .env). Nothing spawns —
      // the run fails on the baseline first.
      const r = run(["record", scenarioIn(cwd), "--out", join(cwd, "c.json"), "--output-format", "json"], {
        CLAUDE_CODE_OAUTH_TOKEN: "test-not-a-real-token",
      });
      expect(r.json?.error?.message).toMatch(/^record: no baseline named "desktop-0\.0\.0"/);
      expect(r.code).toBe(2);
      expect(r.json?.error?.hint).toMatch(/^valid baselines/);
      expect(existsSync(join(cwd, "c.json"))).toBe(false);
    });

    it("run --matrix with an unknown baselines: axis reports the clean message on the cell", () => {
      const cwd = mkdtempSync(join(tmpdir(), "cc-bl-"));
      const s = scenarioIn(cwd);
      writeIn(cwd, "m.yaml", "baselines: [desktop-0.0.0]\n");
      const r = run(["run", s, "--matrix", join(cwd, "m.yaml"), "--output-format", "json"]);
      expect(r.code).toBe(1); // a failing cell fails the matrix run — the matrix contract, unchanged
      expect(r.json?.matrix?.cells?.[0]?.error).toMatch(UNKNOWN);
    });
  });

  // The positional is a BASELINE. Passing the VM name that `vm status` prints used to reach
  // loadBaseline's bare readFileSync and crash with a raw ENOENT stack trace. Every subcommand must
  // fail before touching Lima, with a usage envelope that says what the argument is.
  for (const sub of ["init", "status", "delete", "prune"]) {
    it.skipIf(process.platform !== "darwin")(`vm ${sub} <vm-name> → usage envelope, exit 2, no stack trace`, () => {
      const r = run(["vm", sub, "cowork-vm-deadbeef", "--output-format", "json"]);
      expect(r.code).toBe(2);
      expect(r.json?.ok).toBe(false);
      expect(r.json?.error?.category).toBe("usage");
      expect(r.json?.error?.message).toMatch(/is a VM name, not a baseline/);
      expect(r.json?.error?.hint).toMatch(/desktop-\d/);
      expect(r.stderr).not.toMatch(/ENOENT|\n\s+at /);
    });

    it.skipIf(process.platform !== "darwin")(`vm ${sub} <unknown baseline> (text) → usage message listing baselines, exit 2`, () => {
      const r = run(["vm", sub, "desktop-0.0.0"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/no baseline named "desktop-0\.0\.0"/);
      expect(r.stderr).toMatch(/desktop-\d/);
      expect(r.stderr).not.toMatch(/ENOENT|\n\s+at /);
    });
  }

  it("--dotenv with a command name as its value is rejected, exit 2", () => {
    const r = run(["--dotenv", "run", "x.yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dotenv requires a path/);
  });

  it("--dotenv with a missing file fails (not silently ignored), exit 2", () => {
    const r = run(["--dotenv", "/no/such/file.env", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dotenv file not found/);
  });

  it("--dotenv pointing at a DIRECTORY fails loud naming the path and cause, instead of silently falling through to cwd/.env", () => {
    // A directory passes the earlier `existsSync` guard (that only rejects a genuinely missing path),
    // so this exercises the deeper strict-read failure: readFileSync throws EISDIR, which must NOT be
    // swallowed and fall through to a lower-precedence .env.
    const cwd = mkdtempSync(join(tmpdir(), "cc-cli-"));
    writeIn(cwd, ".env", "CLAUDE_CODE_OAUTH_TOKEN=from-cwd-fallback\n");
    const dirAsDotenv = mkdtempSync(join(tmpdir(), "cc-dotenv-dir-"));
    const r = spawnSync("node", [CLI, "--dotenv", dirAsDotenv, "list"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--dotenv file could not be read/);
    expect(r.stderr).toContain(dirAsDotenv);
    // Must fail BEFORE loading (or confirming) any fallback source — no false "[env] loaded" line.
    expect(r.stdout + r.stderr).not.toMatch(/\[env\] loaded/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "--dotenv pointing at an unreadable file (chmod 000) fails loud, instead of silently falling through",
    () => {
      const cwd = mkdtempSync(join(tmpdir(), "cc-cli-"));
      writeIn(cwd, ".env", "CLAUDE_CODE_OAUTH_TOKEN=from-cwd-fallback\n");
      const unreadable = join(cwd, "locked.env");
      writeFileSync(unreadable, "CLAUDE_CODE_OAUTH_TOKEN=from-locked-file\n");
      chmodSync(unreadable, 0o000);
      try {
        const r = spawnSync("node", [CLI, "--dotenv", unreadable, "list"], { encoding: "utf8", cwd });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/--dotenv file could not be read/);
        expect(r.stderr).toContain(unreadable);
        expect(r.stdout + r.stderr).not.toMatch(/\[env\] loaded/);
      } finally {
        chmodSync(unreadable, 0o644);
      }
    },
  );

  it("--dotenv happy path: a valid explicit file loads cleanly, with its var named in the confirmation and no dotenv-failure text", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-cli-"));
    const explicit = join(cwd, "explicit.env");
    writeFileSync(explicit, "CC_EXPLICIT_TEST_VAR=from-explicit-file\n");
    const r = spawnSync("node", [CLI, "--dotenv", explicit, "list"], { encoding: "utf8", cwd });
    const combined = r.stdout + r.stderr;
    // Not asserting an exact "loaded N var(s)" count: the package-root .env fallback is this actual
    // repo's real .env (e.g. a live-lane CLAUDE_CODE_OAUTH_TOKEN), which legitimately also loads and
    // would make an exact count fragile/environment-dependent.
    expect(combined).toMatch(/\[env\] loaded [^\n]*CC_EXPLICIT_TEST_VAR/);
    expect(combined).not.toMatch(/--dotenv file could not be read/);
    expect(combined).not.toMatch(/--dotenv file not found/);
  });

  it("--on-unanswered llm (the LLM decider's CLI flag is --decider-llm) → usage error redirecting to --decider-llm, exit 2", () => {
    // The LLM decider has two spellings: --decider-llm on the CLI and on_unanswered: llm in scenario YAML.
    // The bare --on-unanswered llm CLI flag is rejected at resolvePolicy to keep deciders in the --decider-*
    // family (and on `run` it would silently degrade to fail).
    const r = run(["skill", "./x", "hi", "--on-unanswered", "llm", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--on-unanswered llm is not a user flag/);
    expect(r.json?.error?.message).toMatch(/--decider-llm/);
  });

  it("decide: a matching --answer rule → exit 0 (regex matches stochastic phrasing)", () => {
    const r = run([
      "decide",
      "--answer",
      "stage|seed|series=Series A",
      "--question",
      "Please confirm the seed stage",
      // the scripted choice must be an offered option — declare it (a real gate would offer it).
      "--option",
      "Series A",
      "--option",
      "Seed",
      "--output-format",
      "json",
    ]);
    expect(r.code).not.toBe(1);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.answer).toBe("Series A");
  });

  it("decide: no matching rule → exit 1 (would fall to on_unanswered)", () => {
    const r = run(["decide", "--answer", "format=Markdown", "--question", "confirm the stage?", "--output-format", "json"]);
    expect(r.code).toBe(1);
    expect(r.json?.matched).toBe(false);
  });

  it("boundary error → category 'boundary', exit 3 (protocol + expect_denied)", () => {
    const { cwd } = run(["--version"]); // borrow a temp cwd
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "b.yaml", "name: b\nbaseline: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\nexpect_denied: [evil.com]\n");
    const r = spawnSync("node", [CLI, "run", "b.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(3); // boundary violations → exit 3 (integrity, not usage)
    expect(JSON.parse(r.stdout).error.category).toBe("boundary");
  });

  it("retired scenario field `profile:` is rejected as an unknown key (no alias)", () => {
    // `profile:` was renamed to `baseline:` and the alias is gone — it now falls through to the
    // strictObject's unknown-key rejection. parseScenarioFile wraps the Zod throw in a UsageError,
    // so a scenario typo surfaces as category `usage` (a user mistake), not `internal` (a harness bug).
    const { cwd } = run(["--version"]);
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "b.yaml", "name: b\nprofile: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\nexpect_denied: [evil.com]\n");
    const r = spawnSync("node", [CLI, "run", "b.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.category).toBe("usage");
    // The MESSAGE is the compact clause — a Zod dump was never a good default for a human reading a
    // terminal, and in a batch it was ~15 lines per broken file. The machine-readable `code` moved to
    // `hint`, which is a contracted envelope field; `category` (asserted above) is the discriminator a
    // consumer should branch on, and SPEC.md explicitly disclaims grep-stability of message text.
    expect(JSON.parse(r.stdout).error.message).toMatch(/Unrecognized key/);
    expect(JSON.parse(r.stdout).error.message).toMatch(/"profile"/);
    expect(JSON.parse(r.stdout).error.message).toMatch(/b\.yaml/); // the message names the offending file
    expect(JSON.parse(r.stdout).error.message).not.toMatch(/"code":/); // no JSON scaffolding in the message
    expect(JSON.parse(r.stdout).error.hint).toMatch(/unrecognized_keys/); // …the full issue array, still reachable
  });

  it("run on a non-existent scenario path → clean usage error, exit 2 (not a raw ENOENT stack)", () => {
    const r = run(["run", "does-not-exist.yaml", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/not found/);
  });

  it("run rejects an unexpected flag (e.g. --fidelity) loudly instead of silently dropping it, exit 2", () => {
    // `run` takes fidelity from the scenario's `fidelity:` field, never a flag; passing --fidelity used
    // to be a silent no-op. The guard fires BEFORE the existsSync check, so a bogus path still surfaces
    // the flag error (not "not found") — this is what lets the test stay token-free with a fake path.
    const r = run(["run", "x.yaml", "--fidelity", "microvm", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/unexpected argument/);
    expect(r.json?.error?.message).toMatch(/--fidelity microvm/);
  });

  it("run rejects a scenario whose YAML sets on_unanswered: prompt (would hang non-TTY CI), exit 2", () => {
    const { cwd } = run(["--version"]);
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "p.yaml", "name: p\nbaseline: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\non_unanswered: prompt\n");
    const r = spawnSync("node", [CLI, "run", "p.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.category).toBe("usage");
    expect(JSON.parse(r.stdout).error.message).toMatch(/on_unanswered: prompt/);
  });

  it("replay → {command:'replay', ok:true, results:[1]}, exit 0", () => {
    const r0 = run(["--version"]);
    writeIn(r0.cwd, "c.cassette.json", JSON.stringify(cassette([{ transcript_contains: "hello" }, { result: "success" }])));
    const r = spawnSync("node", [CLI, "replay", "c.cassette.json", "--output-format", "json"], {
      encoding: "utf8",
      cwd: r0.cwd,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.command).toBe("replay");
    expect(j.ok).toBe(true);
    expect(j.results).toHaveLength(1);
  });

  // replayErrorResult (cassette.ts) is a private synthetic-result producer invoked only from cmdReplay
  // when readCassette can't even parse the file — the ONE lane with genuinely no recoverable
  // Cassette.environment to read execution provenance from. cmdReplay always process.exit()s, so this
  // has to go through the built CLI (like the other cmdReplay-wiring tests in this file), not an
  // in-process call.
  it("replay of an unreadable cassette → synthetic error result with execution: undefined (not a false 'local' claim)", () => {
    const r0 = run(["--version"]);
    writeIn(r0.cwd, "bad.cassette.json", "{ this is not valid json");
    const r = spawnSync("node", [CLI, "replay", "bad.cassette.json", "--output-format", "json"], {
      encoding: "utf8",
      cwd: r0.cwd,
    });
    expect(r.status).toBe(2);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(false);
    expect(j.results).toHaveLength(1);
    expect(j.results[0].result).toBe("error");
    expect(j.results[0].execution).toBeUndefined();
  });

  it("replay text mode emits NOTHING to stdout (footer → stderr)", () => {
    const r0 = run(["--version"]);
    writeIn(r0.cwd, "c.cassette.json", JSON.stringify(cassette([{ result: "success" }])));
    const r = spawnSync("node", [CLI, "replay", "c.cassette.json"], { encoding: "utf8", cwd: r0.cwd });
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("✓"); // footer on stderr
  });

  it("--version prints to stdout, exit 0", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("skill --marketplace with no --enable → usage error (nothing would load), exit 2", () => {
    const r = run(["skill", "--marketplace", "./some-mkt", "hi", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--marketplace requires at least one --enable/);
  });

  it("skill --intent without --decider-llm → usage error, exit 2", () => {
    const r = run(["skill", "./x", "hi", "--intent", "test the thing", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.message).toMatch(/--intent requires --decider-llm/);
  });

  it("skill --decider-llm with an explicit --on-unanswered → usage error (conflict), exit 2", () => {
    const r = run(["skill", "./x", "hi", "--decider-llm", "--on-unanswered", "fail", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.message).toMatch(/--decider-llm conflicts with --on-unanswered/);
  });

  it("answer --gate with a non-positive integer → usage error, exit 2", () => {
    const r = run(["answer", ".", "--gate", "-1", "--choose", "Yes", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.message).toMatch(/--gate must be a positive integer/);
  });

  it("record rejects extra scenario positionals (exit 2)", () => {
    const r = run(["record", "a.yaml", "b.yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/record takes a single scenario/);
  });

  it("record: no token → exit 2 with a clear auth-guard message (before any agent spawn)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-auth-"));
    writeIn(cwd, "s.yaml", "prompt: hi\nfidelity: container\nbaseline: latest\n");
    // Set all three auth vars to empty string so loadDotenv can't overwrite them
    // (loadDotenv skips keys already defined in process.env, even if empty).
    const r = spawnSync("node", [CLI, "record", "s.yaml"], {
      encoding: "utf8",
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].includes(k),
          ),
        ),
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no model credentials/);
    expect(r.stderr).toMatch(/CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
  });

  it("an invalid --output-format value is rejected by replay / trace / decide (exit 2)", () => {
    expect(run(["replay", "x.json", "--output-format", "xml"]).code).toBe(2);
    expect(run(["trace", "somerun", "--output-format", "xml"]).code).toBe(2);
    expect(run(["decide", "--output-format", "xml"]).code).toBe(2);
  });

  it("boundary-check rejects more than one baseline positional (exit 2)", () => {
    const r = run(["boundary-check", "a", "b"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/at most one baseline/);
  });

  // Every verdict modifier must (a) pass as a STANDALONE assertion (not "empty assertion") and (b) replay
  // green without being misclassified as a filesystem/egress skip. Covering all three guards the exact gap
  // `allow_l0_host_config_contamination` fell through (it had no assert.ts noop branch).
  it.each([...VERDICT_MODIFIER_KEYS])("a standalone %s assertion replays green with no filesystem-skip warning", (modifier) => {
    const r0 = run(["--version"]); // borrow a temp cwd
    // Not every modifier is `literal(true)` — `allow_delete_in` takes a non-empty array of mount names.
    // Encoding that here keeps the sweep honest rather than excluding the key from it.
    const value: unknown = modifier === "allow_delete_in" ? ["reports"] : true;
    writeIn(r0.cwd, "c.cassette.json", JSON.stringify(cassette([{ [modifier]: value }])));
    const r = spawnSync("node", [CLI, "replay", "c.cassette.json", "--output-format", "json"], {
      encoding: "utf8",
      cwd: r0.cwd,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)?.ok).toBe(true); // no-op verdict modifier → green
    expect(r.stderr).not.toMatch(/skipped \d+ filesystem/); // not misclassified as a filesystem/egress skip
  });

  it("record --dry-run: single scenario prints plan and exits 0", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-dryrun-"));
    // Include session: to avoid a parse error if parseScenarioFile has no default for that field.
    writeIn(cwd, "s.yaml", "prompt: hi\nfidelity: container\nbaseline: latest\nsession: inline\n");
    const r = spawnSync("node", [CLI, "record", "--dry-run", "s.yaml"], { encoding: "utf8", cwd });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/dry.run/i);
    expect(r.stderr).toMatch(/s\.yaml/);
  });

  it("record --dry-run: dir with broken scenario exits 1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-dryrun-"));
    writeIn(cwd, "broken.yaml", "prompt: x\nfidelity: not-a-real-tier\n");
    const r = spawnSync("node", [CLI, "record", "--dry-run", "."], { encoding: "utf8", cwd });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/broken/i);
  });

  it("record --dry-run: nothing discovered exits 2 (matching non-dry-run behaviour)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-dryrun-"));
    writeIn(cwd, "session.yaml", "skills:\n  local:\n    - ./s\n");
    const r = spawnSync("node", [CLI, "record", "--dry-run", "."], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
  });

  it("record --dry-run --rerecord-stale: rejected (conflict)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-dryrun-"));
    const r = spawnSync("node", [CLI, "record", "--dry-run", "--rerecord-stale", "."], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--dry-run.*--rerecord-stale|--rerecord-stale.*--dry-run/i);
  });

  it("answer --choose validates the label against the gate's options", () => {
    const r0 = run(["--version"]); // borrow a temp cwd
    writeIn(
      r0.cwd,
      "req-1.json",
      JSON.stringify({ id: "req-1", questions: [{ question: "Pick", options: [{ label: "Yes" }, { label: "No" }] }] }),
    );
    const bad = spawnSync("node", [CLI, "answer", r0.cwd, "--gate", "1", "--choose", "Maybe", "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout)?.error?.message).toMatch(/is not an option for gate 1/);
    // a valid label (and a case-insensitive variant, which the decider accepts) succeeds
    const ok = spawnSync("node", [CLI, "answer", r0.cwd, "--gate", "1", "--choose", "yes", "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
  });

  it("answer: repeated --choose answers a multiSelect gate (array resp); rejected on a single-select gate", () => {
    const r0 = run(["--version"]);
    // multiSelect gate → two --choose accumulate into an ARRAY in the resp (the on-wire shape normalize reads)
    writeIn(
      r0.cwd,
      "req-1.json",
      JSON.stringify({
        id: "req-1",
        questions: [{ question: "Pick", multiSelect: true, options: [{ label: "Auth" }, { label: "Billing" }] }],
      }),
    );
    const multi = spawnSync(
      "node",
      [CLI, "answer", r0.cwd, "--gate", "1", "--choose", "Auth", "--choose", "Billing", "--output-format", "json"],
      { encoding: "utf8" },
    );
    expect(multi.status).toBe(0);
    expect(JSON.parse(readFileSync(join(r0.cwd, "resp-1.json"), "utf8")).answers).toEqual({ Pick: ["Auth", "Billing"] });
    // single-select gate → two --choose is the old "only one allowed" error
    writeIn(
      r0.cwd,
      "req-2.json",
      JSON.stringify({ id: "req-2", questions: [{ question: "One", options: [{ label: "A" }, { label: "B" }] }] }),
    );
    const single = spawnSync("node", [CLI, "answer", r0.cwd, "--gate", "2", "--choose", "A", "--choose", "B", "--output-format", "json"], {
      encoding: "utf8",
    });
    expect(single.status).toBe(2);
    expect(JSON.parse(single.stdout)?.error?.message).toMatch(/--choose may only be specified once.*not a multiSelect/);
  });

  // ── CLI parsing-hygiene: per-command flag/positional validation + global --dotenv equals form ──

  it("gates reads the dir, not the --output-format value (exit 2 on the missing dir)", () => {
    // `gates --output-format json` (no dir) must report the missing directory, not try to stream a
    // directory literally named `json` (the old args.find(!startsWith--) idiom mistook `json` for the dir).
    const r = run(["gates", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/usage: gates/);
  });

  it("skill rejects --ablate-skill + --resume as incoherent (exit 2, before any spawn)", () => {
    // Ablation removes the skill; resume reuses the prior turn's staged skill — the combination would
    // silently still have the skill while stamping ablated:true. Must fail loud, pre-Docker.
    const folder = mkdtempSync(join(tmpdir(), "cc-ablate-"));
    mkdirSync(join(folder, ".claude-plugin"), { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), "---\nname: h\ndescription: h.\n---\n# h\n");
    const r = run(["skill", folder, "hi", "--session-id", "s1", "--resume", "--ablate-skill", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--ablate-skill cannot be combined with --resume/);
  });

  it("trace rejects the retired --tools/--gates/--dispatches aliases as unknown flags (exit 2, not silent)", () => {
    // The legacy view aliases were removed in favor of `--view <name>`. The old spellings must fail
    // LOUD (unknown flag, exit 2), never silently no-op into the default view.
    for (const alias of ["--tools", "--gates", "--dispatches"]) {
      const r = run(["trace", "somerun", alias, "--output-format", "json"]);
      expect(r.code, alias).toBe(2);
      expect(r.json?.error?.category, alias).toBe("usage");
      expect(r.json?.error?.message, alias).toMatch(new RegExp(`unknown flag: ${alias}`));
    }
  });

  it("trace rejects extra positionals (exit 2)", () => {
    const r = run(["trace", "run-a", "run-b", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/takes a single/);
  });

  it("scaffold rejects an invalid --output-format value (exit 2)", () => {
    const r = run(["scaffold", "someid", "--output-format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--output-format must be/);
  });

  it("scaffold --from-run is a removed alias — now an unknown flag (exit 2)", () => {
    const r = run(["scaffold", "--from-run", "someid", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/unknown flag: --from-run/);
  });

  it("scaffold --out with a flag-looking value is a usage error (exit 2)", () => {
    const r = run(["scaffold", "someid", "--out", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--out requires a file path/);
  });

  it("assertions --list rejects an invalid --output-format value (exit 2)", () => {
    const r = run(["assertions", "--list", "--output-format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--output-format must be/);
  });

  it("assertions --list rejects extra positionals (exit 2)", () => {
    const r = run(["assertions", "--list", "stray", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/no positional/);
  });

  it("assertions --list rejects an unknown flag (exit 2)", () => {
    const r = run(["assertions", "--list", "--bogus", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/unknown flag/);
  });

  it("decide rejects an unknown flag (exit 2)", () => {
    const r = run(["decide", "--bogus", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/unknown flag/);
  });

  it("decide rejects a stray positional (takes none) (exit 2)", () => {
    const r = run(["decide", "stray-positional", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/no positional/);
  });

  it("decide --intent without --decider-llm → usage error (exit 2)", () => {
    const r = run(["decide", "--intent", "test the thing", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--intent requires --decider-llm/);
  });

  it("decide --decider-llm combined with --answer → usage conflict (exit 2)", () => {
    const r = run(["decide", "--decider-llm", "--answer", "stage=Series A", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/conflicts with --answer/);
  });

  it.skipIf(process.platform !== "darwin")(
    "`vm status --output-format json` parses the flag (does not load a baseline named --output-format)",
    () => {
      // Pre-fix: loadBaseline(args[1]="--output-format") → ENOENT internal error. Now the flag parses and
      // an optional baseline is an independent positional; status emits the JSON envelope, exit 0.
      const r = run(["vm", "status", "--output-format", "json"]);
      expect(r.code).toBe(0);
      expect(r.json?.command).toBe("vm");
      expect(r.json?.subcommand).toBe("status");
      expect(r.json?.baseline?.name).toBe("latest");
      expect(typeof r.json?.status).toBe("string");
      expect(Array.isArray(r.json?.fidelity?.tiers)).toBe(true);
      expect(r.json?.fidelity?.tiers).toContain("container");
    },
  );

  it.skipIf(process.platform !== "darwin")("`vm status` (text) prints instance: status, exit 0", () => {
    const r = run(["vm", "status"]);
    expect(r.code).toBe(0);
    expect(r.json).toBeNull(); // text mode → nothing parses as JSON
    expect(r.stderr).toMatch(/:/); // `<instance>: <status>`
  });

  it.skipIf(process.platform !== "darwin")("`vm status latest` (explicit baseline) works in text mode", () => {
    const r = run(["vm", "status", "latest"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/:/);
  });

  it.skipIf(process.platform !== "darwin")("`vm status latest --output-format json` parses both the baseline and the flag", () => {
    const r = run(["vm", "status", "latest", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.subcommand).toBe("status");
    expect(r.json?.baseline?.name).toBe("latest");
  });

  it.skipIf(process.platform !== "darwin")("vm status JSON envelope carries baseline path/version, image hints, warnings", () => {
    const r = run(["vm", "status", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(typeof r.json?.baseline?.path).toBe("string");
    expect(typeof r.json?.baseline?.appVersion).toBe("string");
    expect(typeof r.json?.baseline?.agentVersion).toBe("string");
    expect(r.json?.image).toBeTruthy();
    expect(typeof r.json?.image?.guestOs).toBe("string");
    expect(Array.isArray(r.json?.warnings)).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")("vm validates the subcommand before touching the baseline (exit 2)", () => {
    // A bad subcommand with a stray second arg used to surface as a baseline-load error; it must now be
    // a clean `usage: vm` (the subcommand is checked before loadBaseline). macOS-only: on Linux the
    // platform guard fires first, which is also correct behaviour.
    const r = run(["vm", "bogus", "some-baseline"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: vm/);
  });

  it("boundary-check rejects an unknown flag instead of dropping it (exit 2)", () => {
    const r = run(["boundary-check", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown flag/);
  });

  it("boundary-check with a missing --session file → usage error (text mode), exit 2", () => {
    const r = run(["boundary-check", "--session", "/no/such/session.yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--session file not found/);
  });

  it("boundary-check with a missing --session file → JSON usage envelope (not a top-level internal error), exit 2", () => {
    const r = run(["boundary-check", "--session", "/no/such/session.yaml", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage"); // was an uncaught internal error before the fix
    expect(r.json?.error?.message).toMatch(/--session file not found/);
  });

  it("boundary-check with malformed --session YAML → usage error (text mode), exit 2", () => {
    const { cwd } = run(["--version"]);
    writeIn(cwd, "bad.yaml", "egress: [unterminated\n  : :\n"); // invalid YAML
    const r = spawnSync("node", [CLI, "boundary-check", "--session", "bad.yaml"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot parse --session/);
  });

  it("boundary-check with malformed --session YAML → JSON usage envelope, exit 2", () => {
    const { cwd } = run(["--version"]);
    writeIn(cwd, "bad.yaml", "egress: [unterminated\n  : :\n");
    const r = spawnSync("node", [CLI, "boundary-check", "--session", "bad.yaml", "--output-format", "json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    const j = JSON.parse(r.stdout);
    expect(j.error?.category).toBe("usage");
    expect(j.error?.message).toMatch(/cannot parse --session/);
  });

  it("global --dotenv=<path> equals form with a missing file fails (exit 2)", () => {
    // The equals form was missed by indexOf("--dotenv"): the whole token fell through to dispatch as the
    // command name. It must now apply the same existence guard as the space form.
    const r = run(["--dotenv=/no/such/file.env", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dotenv file not found/);
  });

  it("global --dotenv= with an empty value is a usage error (exit 2)", () => {
    const r = run(["--dotenv=", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dotenv requires a path/);
  });

  it("cassette carrying $schema and generator fields survives replay (forward-compat)", () => {
    // replay never rewrites the cassette file, so asserting file contents after replay
    // would only prove our own write was intact — a false-green. Instead, just verify
    // that replay exits 0 on a cassette that has these new fields, i.e. forward-compat.
    // Live verification that recordScenarioObject emits the fields belongs in the
    // live/integration test suite (requires a real record run).
    const cwd = mkdtempSync(join(tmpdir(), "cc-prov-"));
    const body = {
      ...cassette([]),
      $schema: "https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/cassette.v9.json",
      generator: "cowork-harness",
      cassetteVersion: 9,
    };
    writeIn(cwd, "s.cassette.json", JSON.stringify(body));
    const r = spawnSync("node", [CLI, "replay", "s.cassette.json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(0);
  });
});

// At the CLI seam: the unit test calls replayCassette() directly, so it can't catch a missing
// cmdReplay→replayCassette opt wiring (a real bug caught only at the binary). These spawn the built CLI.
describe.skipIf(!can)("replay staleness JSON + --fail-on-skill-drift (CLI wiring)", () => {
  const LIVE = loadBaseline("latest").appVersion;
  // A cassette stamped at CASSETTE_VERSION must declare the current hash format — the read boundary
  // rejects a stamp/format mismatch, since the version and the digests would be describing different
  // algorithms. Fixtures that hand-build a fingerprint have to say so too.
  const staleCassette = (fingerprint: object) => ({
    fingerprint: { hashFormat: "jcs1", ...fingerprint },
    ...cassette([{ result: "success" }]),
  });

  it("default replay surfaces class-tagged staleness[] but stays ok:true (exit 0)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-stale-"));
    writeIn(cwd, "b.cassette.json", JSON.stringify(staleCassette({ baseline: "0.0.0-stale-not-live" })));
    const r = spawnSync("node", [CLI, "replay", "b.cassette.json", "--output-format", "json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.results[0].staleness).toEqual([expect.objectContaining({ class: "baseline" })]);
    expect(j.results[0].skippedAssertions).toEqual({ full: 0, partial: 0 });
  });

  it("--fail-on-skill-drift fails on a skill class (exit 1) but not a baseline-only drift (exit 0)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-stale-"));
    writeIn(cwd, "b.cassette.json", JSON.stringify(staleCassette({ baseline: "0.0.0-stale-not-live" })));
    // skillHash set + unresolvable (inline) session + live baseline ⇒ a sole `unverifiable-skill` finding.
    writeIn(cwd, "s.cassette.json", JSON.stringify(staleCassette({ baseline: LIVE, skillHash: "deadbeef" })));
    const baselineOnly = spawnSync("node", [CLI, "replay", "b.cassette.json", "--fail-on-skill-drift"], { encoding: "utf8", cwd });
    expect(baselineOnly.status).toBe(0); // baseline drift is not skill-source drift
    const skillDrift = spawnSync("node", [CLI, "replay", "s.cassette.json", "--fail-on-skill-drift"], { encoding: "utf8", cwd });
    expect(skillDrift.status).toBe(1); // skill staleness unverifiable ⇒ not green under this gate
  });
});

// A JSON consumer parses stdout. Whether it GETS parseable stdout must not depend on where
// `--output-format json` sits in argv — but four validations inside takeCommonFlags' parse loop read
// `flags.output`, which is only populated once the loop has REACHED `--output-format`. Put the offending
// flag first and the same error came back as plain text, so the consumer's JSON.parse threw instead of
// reading a usage envelope. The loop's other error paths already used isJsonOutput(args), which scans
// all of argv (and falls back to COWORK_HARNESS_OUTPUT_FORMAT), so this was an inconsistency inside one
// function rather than a deliberate rule.
describe.skipIf(!can)("the usage envelope does not depend on --output-format's position in argv", () => {
  const LONG_LABEL = "x".repeat(201);
  const cases: { name: string; offending: string[] }[] = [
    { name: "--decider-cmd with a flag-looking value", offending: ["--decider-cmd", "-bad"] },
    { name: "--decider-dir with a flag-looking value", offending: ["--decider-dir", "-bad"] },
    { name: "--label containing a newline", offending: ["--label", "a\nb"] },
    { name: "--label over the length cap", offending: ["--label", LONG_LABEL] },
  ];

  for (const { name, offending } of cases) {
    it(`${name} → JSON envelope with --output-format AFTER it`, () => {
      const r = run(["skill", "./x", "hi", ...offending, "--output-format", "json"]);
      expect(r.code).toBe(2);
      expect(r.json, `expected a JSON envelope, got: ${r.stdout.trim().slice(0, 120)}`).toBeTruthy();
      expect(r.json.error.category).toBe("usage");
    });

    it(`${name} → same envelope with --output-format BEFORE it`, () => {
      const r = run(["skill", "./x", "hi", "--output-format", "json", ...offending]);
      expect(r.code).toBe(2);
      expect(r.json).toBeTruthy();
      expect(r.json.error.category).toBe("usage");
    });
  }

  // The env-var route must keep working with no flag present at all: isJsonOutput falls back to it, and
  // a regression here would silently drop env-only consumers back to plain text.
  it("COWORK_HARNESS_OUTPUT_FORMAT=json still yields an envelope with no --output-format flag", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-envfmt-"));
    const r = spawnSync("node", [CLI, "skill", "./x", "hi", "--decider-cmd", "-bad"], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, COWORK_HARNESS_OUTPUT_FORMAT: "json" },
    });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.category).toBe("usage");
  });
});

// Structural guard for the invariant the behavior tests above prove. The behavior tests cover the four
// validations that exist today; this one fails on a NEW `fail()` added to the same loop with the
// order-dependent predicate, which is how the original four got there.
describe("takeCommonFlags never decides JSON-ness from the half-parsed flags object", () => {
  it('no `flags.output === "json"` inside the parse loop', () => {
    const src = readFileSync(resolve("src/cli.ts"), "utf8");
    const start = src.indexOf("function takeCommonFlags(");
    expect(start, "takeCommonFlags not found — did it move or get renamed?").toBeGreaterThan(-1);
    // The function ends at the first line that is exactly "}" at column 0 after the declaration.
    const end = src.indexOf("\n}\n", start);
    expect(end, "could not find takeCommonFlags' closing brace").toBeGreaterThan(start);
    const body = src.slice(start, end);
    // Sanity: the slice really is the parser (guards against an anchor that silently matched nothing).
    expect(body).toContain('name === "--decider-cmd"');
    expect(body).toContain("isJsonOutput(args)");

    const offenders = body
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes('flags.output === "json"'));
    expect(
      offenders.map((o) => `+${o.n}: ${o.line}`),
      "use isJsonOutput(args): flags.output is not populated until the loop reaches --output-format, so this makes the error envelope depend on flag order",
    ).toEqual([]);
  });
});
