import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rehashExitCode } from "../src/run/cassette.js";

/**
 * `rehash`'s exit codes now that it is check-only: `0` when every cassette is current, `1` when any is not.
 * (`4`, partial migration, is no longer produced — nothing migrates.) Proved through the real CLI too: a
 * mapping test proves what the FUNCTION returns, not what the command exits with.
 */

const CLI = resolve("dist/cli.js");
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("rehashExitCode — the mapping", () => {
  it("0 when nothing failed, 1 when anything did", () => {
    expect(rehashExitCode({ errors: 0 })).toBe(0);
    expect(rehashExitCode({ errors: 1 })).toBe(1);
    expect(rehashExitCode({ errors: 22 })).toBe(1);
  });
});

describe.skipIf(!existsSync(CLI))("the CLI emits them", () => {
  it("exits 0 when every cassette is already current (the committed examples)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-clean-"));
    cpSync("examples", join(d, "examples"), { recursive: true });
    const r = run(["rehash", join(d, "examples", "replays")]);
    expect(r.code, r.out).toBe(0);
  });

  it("exits 1 when a current cassette sits beside one that is not — never 4", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-mixed-"));
    cpSync("examples", join(d, "examples"), { recursive: true });
    const dir = join(d, "examples", "replays");
    writeFileSync(join(dir, "broken.cassette.json"), JSON.stringify({ cassetteVersion: 11, scenario: {} }));
    const r = run(["rehash", dir]);
    expect(r.out).toMatch(/rehash: 1 require a re-record, \d+ current/);
    expect(r.code, r.out).toBe(1);
  });

  it("prints the summary BEFORE the per-file lines", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-order-"));
    writeFileSync(join(d, "broken.cassette.json"), JSON.stringify({ cassetteVersion: 11, scenario: {} }));
    const r = run(["rehash", d]);
    const summary = r.out.indexOf("rehash:");
    const perFile = r.out.indexOf("broken.cassette.json");
    expect(summary, r.out).toBeGreaterThanOrEqual(0);
    expect(perFile, r.out).toBeGreaterThanOrEqual(0);
    expect(summary, "the summary must come first — these counts ARE the decision").toBeLessThan(perFile);
  });
});
