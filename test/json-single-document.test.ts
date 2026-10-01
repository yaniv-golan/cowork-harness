import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Under `--output-format json`, stdout carries exactly ONE JSON document — never a payload followed by an
// error envelope, never a stray text line. A consumer reads stdout with one JSON.parse (the Action does);
// a second document either breaks that parse or, read line by line, lets the first (often green) one win.
//
// Each case drives a command's ERROR path, the side where a second write is most likely: a fail() after an
// out(), a throw reaching the top-level catch after a payload. Every argv here is token-free and spawns
// nothing. stdout is parsed WHOLE, not counted by lines: several commands print one pretty-printed
// multi-line document, and JSON.parse rejects anything after the first value.
//
// Deliberately absent: `gates <dir> --follow` is a JSONL stream, not a single document (its error paths
// are covered in gates-json-contract.test.ts); `chat` / `migrate-run-dir` / `prune` / `sync` do not accept
// --output-format.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

describe.skipIf(!can)("--output-format json — exactly one JSON document on stdout, every command's error path", () => {
  const work = mkdtempSync(join(tmpdir(), "json-one-doc-"));
  const runs = mkdtempSync(join(tmpdir(), "json-one-doc-runs-"));
  const empty = join(work, "empty");
  mkdirSync(empty);
  const broken = join(work, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "b.yaml"), `name: b\nprompt: "x"\nfidelity: protocol\nassert:\n  - not_a_real_key: true\n`);
  const missing = join(work, "does-not-exist");
  // A scenario that resolves no model (inline session, no --model, COWORK_HARNESS_MODEL cleared below): the
  // refusal is a fail() on every lane, and on `record` it must not follow a dry-run payload.
  const unpinned = join(work, "unpinned");
  mkdirSync(unpinned);
  writeFileSync(join(unpinned, "u.yaml"), `name: u\nprompt: "x"\nfidelity: protocol\nassert:\n  - result: success\n`);
  const plugin = join(work, "plugin");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");

  // [argv, expected exit]. Every row is an error path, so every document must say ok:false.
  const cases: [string[], number][] = [
    [["run", `${missing}.yaml`], 2],
    [["skill"], 2],
    [["probe-dispatch", missing, "hi", "--fidelity", "bogus"], 2],
    [["vm", "bogus"], 2],
    [["boundary-check", "a", "b"], 2],
    [["init-redact", "extra"], 2],
    [["list", "extra"], 2],
    [["stats", "--bogus"], 2],
    [["decide"], 2],
    [["status", missing], 2],
    [["answer"], 2],
    [["gates"], 2],
    [["verify-run"], 2],
    [["verify-run", missing, `${missing}.yaml`], 2],
    [["regrade"], 2],
    [["regrade", missing, "--scenario", `${missing}.yaml`], 2],
    [["fixture"], 2],
    [["fixture", "export", missing, "--out", `${missing}-out`], 2],
    [["assertions", "--list", "extra"], 2],
    [["trace", missing], 2],
    [["diff"], 2],
    [["inspect", missing], 2],
    [["scaffold", missing], 2],
    [["analyze-skill", missing], 2],
    [["record", `${missing}.yaml`, "--dry-run"], 2],
    [["record", `${missing}.yaml`], 2],
    [["record", broken, "--dry-run"], 1],
    [["record", empty, "--dry-run"], 2], // nothing discovered: the payload says ok:false, like the exit code
    [["record", "--rerecord-stale", "--dry-run", empty], 2], // the flag-combination refusal, not --rerecord-stale's own paths
    [["replay", missing], 2],
    [["replay", empty], 2],
    [["verify-cassettes", missing], 2],
    [["rehash", missing], 2],
    [["doctor", "--bogus"], 2],
    [["lint"], 2], // the TS wrapper's fallback envelope: python's usage error is not JSON on --json
    [["lint", join(broken, "b.yaml")], 1],
    [["lint-skill"], 2],
    [["run", join(unpinned, "u.yaml")], 2], // resolves no model
    [["run", unpinned], 2], // resolves no model: the directory pre-flight
    [["skill", plugin, "hi"], 2], // resolves no model
    [["probe-dispatch", plugin, "hi"], 2], // resolves no model
    [["record", join(unpinned, "u.yaml"), "--dry-run"], 1], // resolves no model
    [["record", unpinned, "--dry-run"], 1], // resolves no model: listed under refusals
    [["critique"], 2], // usage: no skill folder
    [["critique", missing, "--prompt", "hi"], 2], // the skill folder does not exist
    [["gates", missing], 2], // one pass over a directory that does not exist
    [["no-such-command"], 2],
  ];

  for (const [argv, code] of cases) {
    it(argv.map((a) => a.replace(work, "<tmp>")).join(" "), () => {
      const r = spawnSync("node", [CLI, ...argv, "--output-format", "json"], {
        encoding: "utf8",
        cwd: work,
        env: {
          ...process.env,
          COWORK_HARNESS_RUNS_DIR: runs,
          COWORK_HARNESS_MODEL: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      });
      const stdout = r.stdout ?? "";
      let doc: { ok?: unknown };
      try {
        doc = JSON.parse(stdout);
      } catch (e) {
        throw new Error(`stdout is not exactly one JSON document (${(e as Error).message}):\n${stdout}\nstderr:\n${r.stderr}`);
      }
      expect(doc.ok, stdout).toBe(false);
      expect(r.status, r.stderr).toBe(code);
    });
  }
});
