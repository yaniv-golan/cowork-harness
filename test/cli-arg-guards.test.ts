import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Structural guard (built incrementally as commands migrate to parseArgs): every migrated command must
// reject an unknown flag and an extra positional with exit 2, and must not mistake a value-flag's value
// for the target. Needs dist/cli.js (the `ci` script builds first); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout + r.stderr };
}

const cassette = () =>
  JSON.stringify({
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: [JSON.stringify({ type: "result", subtype: "success" })],
  });

describe.skipIf(!can)("CLI arg guards — migrated commands fail loud", () => {
  it("record: unknown flag → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["record", "s.yaml", "--typo"], d).code).toBe(2);
  });

  it("record: --output-format value is not read as a 2nd positional", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    const r = run(["record", "missing.yaml", "--output-format", "json"], d);
    expect(r.out).not.toMatch(/got 2/); // it failed for a real reason, not the multi-positional mis-parse
  });

  it("record: --out with a flag-looking value → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    expect(run(["record", "s.yaml", "--out", "--no-redact"], d).code).toBe(2);
  });

  it("verify-cassettes: --output-format value is not read as the target", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    // `verify-cassettes <dir> --output-format json` must scan the dir, not treat `json` as the target.
    const r = run(["verify-cassettes", d, "--output-format", "json"], d);
    expect(r.code).toBe(0);
  });

  it("verify-cassettes: extra positional → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    expect(run(["verify-cassettes", join(d, "ok.cassette.json"), "extra.cassette.json"], d).code).toBe(2);
  });

  it("verify-cassettes: unknown flag → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    expect(run(["verify-cassettes", join(d, "ok.cassette.json"), "--typo"], d).code).toBe(2);
  });

  it("decide: --decider-cmd with a flag-looking value → exit 2 (not swallowing the next flag)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    expect(run(["decide", "--decider-cmd", "--question", "confirm?"], d).code).toBe(2);
  });

  it("replay: a directory of cassettes is replayed", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "a.cassette.json"), cassette());
    writeFileSync(join(d, "b.cassette.json"), cassette());
    expect(run(["replay", d, "--output-format", "json"], d).code).toBe(0);
  });

  it("replay: an empty directory is a loud non-zero (no vacuous pass)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    expect(run(["replay", d], d).code).toBe(2);
  });

  it("replay: a cassette missing the optional `assert` key does not crash (readCassette normalizes it)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    const noAssert = JSON.stringify({
      scenario: { name: "c", baseline: "latest", session: "(inline)", fidelity: "container", prompt: "hi", answers: [], expect_denied: [] },
      events: [JSON.stringify({ type: "result", subtype: "success" })],
    });
    writeFileSync(join(d, "a.cassette.json"), noAssert);
    const r = run(["replay", join(d, "a.cassette.json"), "--output-format", "json"], d);
    expect(r.out).not.toMatch(/Cannot read properties of undefined/); // no NPE
    expect(r.code).toBe(0);
  });

  it("replay: an unreadable cassette in a dir does not yield ok:true (no false green)", () => {
    const d = mkdtempSync(join(tmpdir(), "g-"));
    writeFileSync(join(d, "ok.cassette.json"), cassette());
    writeFileSync(join(d, "bad.cassette.json"), "{ not valid json");
    const r = run(["replay", d, "--output-format", "json"], d);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/"ok":false/);
  });
});
