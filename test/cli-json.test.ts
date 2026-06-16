import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Exercises the built CLI's --output-format json envelope + exit codes. Token-free and spawn-free
// (usage/boundary fail before any agent spawn; replay is deterministic). Needs `dist/cli.js`
// (the `ci` script builds before testing); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-cli-")); // isolated cwd so no stray .env is loaded
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
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

  it("#3 — invalid --on-unanswered value → usage error fail|prompt|first, exit 2", () => {
    const r = run(["skill", "./x", "hi", "--on-unanswered", "banana", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/must be fail\|prompt\|first/);
  });

  it("#2 — invalid --output-format value → exit 2 (not silently treated as text)", () => {
    const r = run(["skill", "./x", "hi", "--output-format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--output-format must be/);
  });

  it("#6 — invalid --fidelity → usage (not internal), exit 2", () => {
    const r = run(["skill", "./x", "hi", "--fidelity", "bogus", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage"); // was `internal` (Zod throw → top-level catch)
    expect(r.json?.error?.message).toMatch(/--fidelity must be one of/);
  });

  it("#5 — extra skill positional → usage error, exit 2", () => {
    const r = run(["skill", "./x", "hi", "stray-extra", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/unexpected extra argument/);
  });

  it("#14 — decide with both --decider-llm and --decider-cmd → usage conflict, exit 2", () => {
    const r = run(["decide", "--decider-llm", "--decider-cmd", "cat", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/conflicts with --decider-cmd/);
  });

  it("#13 — decide rejects --decider-dir loudly (not silently ignored), exit 2", () => {
    const r = run(["decide", "--decider-dir", "/tmp/x", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/does not support --decider-dir/);
  });

  it("#11 — vm with an invalid subcommand exits non-zero (not 0)", () => {
    const r = run(["vm", "bogus-subcommand"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage: vm/);
  });

  it("#4 — --dotenv with a command name as its value is rejected, exit 2", () => {
    const r = run(["--dotenv", "run", "x.yaml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dotenv requires a path/);
  });

  it("#4 — --dotenv with a missing file fails (not silently ignored), exit 2", () => {
    const r = run(["--dotenv", "/no/such/file.env", "list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--dotenv file not found/);
  });

  it("--on-unanswered llm (the LLM decider's CLI flag is --decider-llm) → usage error redirecting to --decider-llm, exit 2", () => {
    // The LLM decider has two spellings: --decider-llm on the CLI and on_unanswered: llm in scenario YAML.
    // The bare --on-unanswered llm CLI flag is rejected at resolvePolicy to keep deciders in the --decider-*
    // family (and on `run` it would silently degrade to fail). (Issue 2)
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
      // #49: the scripted choice must be an offered option — declare it (a real gate would offer it).
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

  it("boundary error → category 'boundary', exit 2 (protocol + expect_denied)", () => {
    const { cwd } = run(["--version"]); // borrow a temp cwd
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "b.yaml", "name: b\nbaseline: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\nexpect_denied: [evil.com]\n");
    const r = spawnSync("node", [CLI, "run", "b.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.category).toBe("boundary");
  });

  it("deprecated scenario field `profile:` still parses (back-compat alias) + warns on stderr", () => {
    // `profile:` was renamed to `baseline:`; the preprocess alias accepts it for one minor with a warning.
    const { cwd } = run(["--version"]);
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "b.yaml", "name: b\nprofile: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\nexpect_denied: [evil.com]\n");
    const r = spawnSync("node", [CLI, "run", "b.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(2); // still reaches the boundary check (the alias mapped profile→baseline)
    expect(JSON.parse(r.stdout).error.category).toBe("boundary");
    expect(r.stderr).toMatch(/`profile:` is deprecated/); // the deprecation warning fired
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
    const r = spawnSync("node", [CLI, "replay", "--cassette", "c.cassette.json", "--output-format", "json"], {
      encoding: "utf8",
      cwd: r0.cwd,
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.command).toBe("replay");
    expect(j.ok).toBe(true);
    expect(j.results).toHaveLength(1);
  });

  it("replay text mode emits NOTHING to stdout (footer → stderr)", () => {
    const r0 = run(["--version"]);
    writeIn(r0.cwd, "c.cassette.json", JSON.stringify(cassette([{ result: "success" }])));
    const r = spawnSync("node", [CLI, "replay", "--cassette", "c.cassette.json"], { encoding: "utf8", cwd: r0.cwd });
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("✓"); // footer on stderr
  });

  it("--version prints to stdout, exit 0", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
