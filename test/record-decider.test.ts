import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { cassetteAuthoring } from "../src/run/cassette.js";

// `record` can answer gates live (--decider-dir / --decider-llm / --on-unanswered) and stamps
// non-deterministic authoring on the cassette. These tests cover (a) the up-front validation that rejects
// ambiguous/unsupported flag combos before a paid run starts, and (b) the pure provenance-stamp helper.
// A full live-record provenance integration (a gate actually answered via the channel → authoring stamped)
// needs a model token and is exercised by the live lane, not here.

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe.skipIf(!can)("record live-decider flag validation", () => {
  it("--intent without --decider-llm → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "rd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["record", "s.yaml", "--intent", "test the thing"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--intent requires --decider-llm/);
  });

  it("--decider-llm + --decider-dir (mutually exclusive terminals) → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "rd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["record", "s.yaml", "--decider-llm", "--decider-dir", join(d, "gates")], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/mutually exclusive terminals/);
  });

  it("--decider-llm + --on-unanswered (llm forces the terminal) → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "rd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["record", "s.yaml", "--decider-llm", "--on-unanswered", "first"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--decider-llm conflicts with --on-unanswered/);
  });

  it("--rerecord-stale + a live decider → exit 2 (re-records at the default policy)", () => {
    const d = mkdtempSync(join(tmpdir(), "rd-"));
    const r = run(["record", "s.yaml", "--rerecord-stale", "--decider-llm"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--rerecord-stale cannot be combined/);
  });

  it("--decider-dir on a DIRECTORY batch → exit 2 (single scenario only)", () => {
    const d = mkdtempSync(join(tmpdir(), "rd-"));
    writeFileSync(join(d, "a.yaml"), "prompt: hi\n");
    const r = run(["record", d, "--decider-dir", join(d, "gates")], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/single interactive recording/);
  });

  it("--on-unanswered prompt is rejected by the enum (determinism) → exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "rd-"));
    writeFileSync(join(d, "s.yaml"), "prompt: hi\n");
    const r = run(["record", "s.yaml", "--on-unanswered", "prompt"], d);
    expect(r.code).toBe(2);
  });
});

describe("cassetteAuthoring — provenance stamp is usage-based, not flag-based", () => {
  it("a non-deterministic run (a gate actually answered live) IS stamped with the channel", () => {
    expect(cassetteAuthoring(true, "decider-dir")).toEqual({ nonDeterministic: true, channel: "decider-dir" });
    expect(cassetteAuthoring(true, "decider-llm")).toEqual({ nonDeterministic: true, channel: "decider-llm" });
  });

  it("a present-but-UNUSED decider (scripted answers covered every gate) is NOT stamped", () => {
    // result.nonDeterministic is false → deterministic authoring even though --decider-dir was passed.
    expect(cassetteAuthoring(false, "decider-dir")).toBeUndefined();
  });

  it("a plain deterministic record (no channel, not flagged) is NOT stamped", () => {
    expect(cassetteAuthoring(undefined, undefined)).toBeUndefined();
    expect(cassetteAuthoring(false, undefined)).toBeUndefined();
  });

  it("non-determinism with no channel (e.g. --on-unanswered first auto-pick) is stamped without a channel", () => {
    expect(cassetteAuthoring(true, undefined)).toEqual({ nonDeterministic: true, channel: undefined });
  });
});
