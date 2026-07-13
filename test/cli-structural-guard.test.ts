import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Structural invariant: NO command silently accepts an unknown flag. Each command is invoked with
// otherwise-plausible arguments plus a bogus flag; a fail-loud command exits non-zero (2 for usage).
// This is the regression guard that keeps the "no silent-accept parsing" property from rotting.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout + r.stderr };
}

const BOGUS = "--zzz-definitely-not-a-real-flag";

// command → the positionals/flags it would otherwise accept (kept minimal + side-effect-free on the
// error path). The bogus flag must flip each to a non-zero exit.
const CASES: Array<[string, string[]]> = [
  ["record", ["s.yaml"]],
  ["replay", ["c.cassette.json"]],
  ["verify-cassettes", ["somedir"]],
  ["run", ["s.yaml"]],
  ["trace", ["some-run-id"]],
  ["diff", ["desktop-a", "desktop-b"]],
  ["assertions", ["--list"]],
  ["scaffold", ["some-run-id"]],
  ["decide", ["--question", "confirm?", "--option", "A"]],
  ["gates", ["somedir"]],
  ["boundary-check", []],
  ["vm", ["status"]],
  ["skill", ["./x", "hi"]],
  ["answer", ["somedir", "--gate", "1", "--choose", "X"]],
  ["stats", []],
  ["analyze-skill", ["SKILL.md"]],
  ["probe-dispatch", ["./x", "hi"]],
  ["chat", ["./x", "hi"]],
  ["doctor", []],
  ["init-redact", []],
  ["inspect", ["some-run-id"]],
  ["lint", ["s.yaml"]],
  ["lint-skill", ["s.yaml"]],
  ["list", []],
  ["prune", []],
  ["rehash", ["somedir"]],
  ["status", ["some-run-id"]],
  ["sync", []],
  ["verify-run", ["somedir", "s.yaml"]],
];

describe.skipIf(!can)("CLI structural guard — every command rejects an unknown flag", () => {
  for (const [cmd, base] of CASES) {
    it(`${cmd} rejects an unknown flag (exit non-zero)`, () => {
      const d = mkdtempSync(join(tmpdir(), "sg-"));
      writeFileSync(join(d, "s.yaml"), "prompt: hi\n"); // a plausible scenario for record/run
      const r = run([cmd, ...base, BOGUS], d);
      expect(r.code, `${cmd} silently accepted ${BOGUS} (out: ${r.out.slice(0, 200)})`).not.toBe(0);
    });
  }
});
