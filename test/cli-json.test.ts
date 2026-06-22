import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { VERDICT_MODIFIER_KEYS } from "../src/types.js";

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

  it.skipIf(process.platform !== "darwin")("#11 — vm with an invalid subcommand exits non-zero (not 0)", () => {
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

  it("boundary error → category 'boundary', exit 3 (protocol + expect_denied)", () => {
    const { cwd } = run(["--version"]); // borrow a temp cwd
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "b.yaml", "name: b\nbaseline: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\nexpect_denied: [evil.com]\n");
    const r = spawnSync("node", [CLI, "run", "b.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(3); // R7: boundary violations → exit 3 (integrity, not usage)
    expect(JSON.parse(r.stdout).error.category).toBe("boundary");
  });

  it("deprecated scenario field `profile:` still parses (back-compat alias) + warns on stderr", () => {
    // `profile:` was renamed to `baseline:`; the preprocess alias accepts it for one minor with a warning.
    const { cwd } = run(["--version"]);
    writeIn(cwd, "sess.yaml", "permission_mode: default\n");
    writeIn(cwd, "b.yaml", "name: b\nprofile: latest\nsession: ./sess.yaml\nfidelity: protocol\nprompt: hi\nexpect_denied: [evil.com]\n");
    const r = spawnSync("node", [CLI, "run", "b.yaml", "--output-format=json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(3); // R7: boundary → exit 3; alias still mapped profile→baseline
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
  // `allow_l0_plugin_divergence` fell through (it had no assert.ts noop branch).
  it.each([...VERDICT_MODIFIER_KEYS])(
    "a standalone %s assertion replays green with no filesystem-skip warning",
    (modifier) => {
      const r0 = run(["--version"]); // borrow a temp cwd
      writeIn(r0.cwd, "c.cassette.json", JSON.stringify(cassette([{ [modifier]: true }])));
      const r = spawnSync("node", [CLI, "replay", "c.cassette.json", "--output-format", "json"], {
        encoding: "utf8",
        cwd: r0.cwd,
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)?.ok).toBe(true); // no-op verdict modifier → green
      expect(r.stderr).not.toMatch(/skipped \d+ filesystem/); // not misclassified as a filesystem/egress skip
    },
  );

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

  it("trace rejects more than one of --tools/--gates/--dispatches (exit 2)", () => {
    const r = run(["trace", "somerun", "--tools", "--gates", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/mutually exclusive/);
  });

  it("trace rejects extra positionals (exit 2)", () => {
    const r = run(["trace", "run-a", "run-b", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/takes a single/);
  });

  it("scaffold rejects an invalid --output-format value (exit 2)", () => {
    const r = run(["scaffold", "--from-run", "someid", "--output-format", "xml"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--output-format must be/);
  });

  it("scaffold --from-run with a flag-looking value is a usage error (exit 2)", () => {
    const r = run(["scaffold", "--from-run", "--out", "x.yaml", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(r.json?.error?.category).toBe("usage");
    expect(r.json?.error?.message).toMatch(/--from-run requires a run id/);
  });

  it("scaffold --out with a flag-looking value is a usage error (exit 2)", () => {
    const r = run(["scaffold", "--from-run", "someid", "--out", "--output-format", "json"]);
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
      $schema: "https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/cassette.v2.json",
      generator: "cowork-harness",
      cassetteVersion: 2,
      ...cassette([]),
    };
    writeIn(cwd, "s.cassette.json", JSON.stringify(body));
    const r = spawnSync("node", [CLI, "replay", "s.cassette.json"], { encoding: "utf8", cwd });
    expect(r.status).toBe(0);
  });
});
