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
  cassetteVersion: 9,
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

  it("--allow suppresses the finding (whole-token match) → exit 0", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    // An allow must match the WHOLE finding token. `eve@evil.com` yields BOTH an email token
    // (`eve@evil.com`) and a domain token (`evil.com`), so suppressing the cassette needs a whole-token
    // allow for each class.
    const r = run(
      ["verify-cassettes", join(d, "leak.cassette.json"), "--allow", "eve@evil\\.com", "--allow", "evil\\.com", "--output-format", "json"],
      d,
    );
    expect(r.code).toBe(0);
  });

  it("the old --allow-file spelling is hard-removed → exit 2 unknown-flag error (loud removal, no deprecation window)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    const patternsFile = join(d, "allow.txt");
    writeFileSync(patternsFile, "eve@evil\\.com\nevil\\.com\n");
    const r = run(["verify-cassettes", join(d, "leak.cassette.json"), "--allow-file", patternsFile], d);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown flag: --allow-file/);
  });

  it("--allow-patterns-file <file> loads all-class patterns from a version-controlled file → exit 0", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    const patternsFile = join(d, "allow.txt");
    // one pattern per line; blank lines and `#` comments are ignored; both the email AND domain
    // tokens need a whole-token match to clear the cassette (same rule as --allow).
    writeFileSync(patternsFile, "# reviewed synthetic addresses\neve@evil\\.com\n\nevil\\.com\n");
    const r = run(["verify-cassettes", join(d, "leak.cassette.json"), "--allow-patterns-file", patternsFile, "--output-format", "json"], d);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
  });

  it("a bare-DOMAIN allow does NOT suppress an EMAIL finding (no cross-class bleed) → still exit 1", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    // Pre-fix, `--allow evil\.com` substring-matched inside the email and silently cleared it. Now it can't.
    const r = run(["verify-cassettes", join(d, "leak.cassette.json"), "--allow", "evil\\.com", "--output-format", "json"], d);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
  });

  it("a directory with no cassettes → loud non-zero (exit 2), not a vacuous pass", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const r = run(["verify-cassettes", d], d);
    expect(r.code).toBe(2);
  });

  it("--skip-privacy + --skip-staleness together → exit 2 (they'd check nothing — no silent green)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    writeFileSync(join(d, "ok.cassette.json"), JSON.stringify(cassette([JSON.stringify({ type: "result", subtype: "success" })])));
    const r = run(["verify-cassettes", join(d, "ok.cassette.json"), "--skip-privacy", "--skip-staleness"], d);
    expect(r.code).toBe(2);
  });

  // The non-failing `notes` channel. A pre-effectiveFidelity cassette with an EXPLICIT tier is
  // statically knowable → exit 0 with an informational note in the envelope (never a silent skip,
  // never a spurious red). A `fidelity: cowork` one is baseline-dependent → loud unverifiable-tier,
  // exit 3 (could not verify, not a confirmed finding).
  it("pre-effectiveFidelity + explicit tier → exit 0, note surfaced in the JSON envelope", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    writeFileSync(join(d, "old.cassette.json"), JSON.stringify(cassette([JSON.stringify({ type: "result", subtype: "success" })])));
    const r = run(["verify-cassettes", join(d, "old.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.results[0].notes).toHaveLength(1);
    expect(r.json.results[0].notes[0]).toMatch(/statically knowable/);
  });

  it("pre-effectiveFidelity + fidelity: cowork → unverifiable-tier staleness, exit 3 (could not verify), landed in the `unverifiable` bucket", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "result", subtype: "success" })]);
    (c.scenario as { fidelity: string }).fidelity = "cowork";
    writeFileSync(join(d, "cw.cassette.json"), JSON.stringify(c));
    const r = run(["verify-cassettes", join(d, "cw.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(3);
    expect(r.json.ok).toBe(false);
    expect(r.json.results[0].staleness).toHaveLength(0);
    expect(r.json.results[0].unverifiable.join(" ")).toMatch(/predates effectiveFidelity/);
  });

  it("a malformed cassette is TALLIED (exit 3, could not verify), not a crash — clean siblings still verified", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    writeFileSync(join(d, "ok.cassette.json"), JSON.stringify(cassette([JSON.stringify({ type: "result", subtype: "success" })])));
    writeFileSync(join(d, "junk.cassette.json"), "{ this is not valid json");
    const r = run(["verify-cassettes", d, "--output-format", "json"], d);
    expect(r.code).toBe(3);
    expect(r.json.ok).toBe(false);
    expect(JSON.stringify(r.json)).toMatch(/invalid cassette JSON|unreadable/);
  });

  it("a genuine baseline DRIFT cassette (fingerprint.baseline stale) → exit 1 (verified & failed), landed in the `staleness` bucket, NOT `unverifiable`", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "result", subtype: "success" })]) as Record<string, unknown>;
    // A stale, non-live baseline appVersion — genuine `class: "baseline"` drift, not `unverifiable-baseline`
    // (the live baseline itself always loads fine in this repo's test env).
    c.fingerprint = { baseline: "0.0.0-does-not-exist" };
    writeFileSync(join(d, "drift.cassette.json"), JSON.stringify(c));
    const r = run(["verify-cassettes", join(d, "drift.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.results[0].staleness.join(" ")).toMatch(/baseline moved/);
    expect(r.json.results[0].unverifiable).toHaveLength(0);
  });

  it("a cassette from a NEWER harness version → exit 3 (could not verify), landed in the `version` bucket", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "result", subtype: "success" })]) as Record<string, unknown>;
    c.cassetteVersion = 9999;
    writeFileSync(join(d, "future.cassette.json"), JSON.stringify(c));
    const r = run(["verify-cassettes", join(d, "future.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(3);
    expect(r.json.ok).toBe(false);
    expect(r.json.results[0].version.length).toBeGreaterThan(0);
    expect(r.json.results[0].error).toBeUndefined();
  });

  it("a planted PII finding → exit 1 (verified & failed), landed in the `findings` bucket — reverting the class split would flip this back too", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const c = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    const r = run(["verify-cassettes", join(d, "leak.cassette.json"), "--output-format", "json"], d);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.json.results[0].findings.length).toBeGreaterThan(0);
  });

  it("a real finding AND an unverifiable cassette in the SAME run → exit 1 wins (a real finding is the stronger signal)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-vc-"));
    const leak = cassette([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } })]);
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(leak));
    const future = cassette([JSON.stringify({ type: "result", subtype: "success" })]) as Record<string, unknown>;
    future.cassetteVersion = 9999;
    writeFileSync(join(d, "future.cassette.json"), JSON.stringify(future));
    const r = run(["verify-cassettes", d, "--output-format", "json"], d);
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    const byFile = Object.fromEntries(r.json.results.map((res: any) => [res.file.split("/").pop(), res]));
    expect(byFile["leak.cassette.json"].findings.length).toBeGreaterThan(0);
    expect(byFile["future.cassette.json"].version.length).toBeGreaterThan(0);
  });
});
