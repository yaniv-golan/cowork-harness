import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `replay` and `verify-cassettes` write nothing to stdout in text mode, by design: text is for humans and is
// not a contract. Their --help must point a script at the JSON envelope instead, including the env var that
// turns it on for a whole CI job. Help text itself is uncovered, so this checks the pointer loosely.
const CLI = resolve("dist/cli.js");

function help(cmd: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "cc-help-"));
  const r = spawnSync("node", [CLI, cmd, "--help"], { encoding: "utf8", cwd });
  return r.stdout + r.stderr;
}

describe.skipIf(!existsSync(CLI))("replay / verify-cassettes --help name the scriptable success signal", () => {
  it.each(["replay", "verify-cassettes"])("%s --help names COWORK_HARNESS_OUTPUT_FORMAT=json and the `.ok` field", (cmd) => {
    const h = help(cmd);
    expect(h).toContain("COWORK_HARNESS_OUTPUT_FORMAT=json");
    expect(h).toMatch(/jq -e '?\.ok'?/);
    expect(h).toMatch(/nothing to stdout/i);
  });
});
