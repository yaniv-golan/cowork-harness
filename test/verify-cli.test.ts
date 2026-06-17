import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Exercises the built `verify-cassettes` CLI gate exit codes. Token/agent-free. Needs dist/cli.js
// (the `ci` script builds before testing); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const cassette = (events: string[]) => ({
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
  events,
});

describe.skipIf(!can)("verify-cassettes CLI gate", () => {
  it("clean cassette → exit 0", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    writeFileSync(join(d, "ok.cassette.json"), JSON.stringify(cassette([JSON.stringify({ type: "result", subtype: "success" })])));
    const r = run(["verify-cassettes", join(d, "ok.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
  });

  it("a planted email → exit 1 (gate fails)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    const r = run(["verify-cassettes", join(d, "leak.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
  });

  it("--allow suppresses the finding → exit 0", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    const r = run(["verify-cassettes", join(d, "leak.cassette.json"), "--allow", "evil\\.com", "--output-format", "json"], d);
    expect(r.code).toBe(0);
  });

  it("a directory with no cassettes → loud non-zero (exit 2), not a vacuous pass", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const r = run(["verify-cassettes", d], d);
    expect(r.code).toBe(2);
  });
});
