import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { computeContentSig } from "../src/run/skill-hash.js";

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function makeSkillDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-skill-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(d, rel);
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return d;
}

describe("computeContentSig", () => {
  it("returns undefined for empty dirs array", () => {
    expect(computeContentSig([])).toBeUndefined();
  });

  it("returns a hex string for a non-empty dir", () => {
    const d = makeSkillDir({ "index.ts": "export const x = 1;" });
    const sig = computeContentSig([d]);
    expect(typeof sig).toBe("string");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same content = same sig", () => {
    const d1 = makeSkillDir({ "a.ts": "hello" });
    const d2 = makeSkillDir({ "a.ts": "hello" });
    expect(computeContentSig([d1])).toBe(computeContentSig([d2]));
  });

  it("changes when file content changes", () => {
    const d = makeSkillDir({ "a.ts": "v1" });
    const before = computeContentSig([d]);
    writeFileSync(join(d, "a.ts"), "v2");
    expect(computeContentSig([d])).not.toBe(before);
  });

  it("changes when a file is added", () => {
    const d = makeSkillDir({ "a.ts": "hello" });
    const before = computeContentSig([d]);
    writeFileSync(join(d, "b.ts"), "world");
    expect(computeContentSig([d])).not.toBe(before);
  });

  it("excludes .git dirs", () => {
    const d = makeSkillDir({ "index.ts": "x" });
    const before = computeContentSig([d]);
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main");
    expect(computeContentSig([d])).toBe(before);
  });

  it("excludes *.cassette.json files", () => {
    const d = makeSkillDir({ "index.ts": "x" });
    const before = computeContentSig([d]);
    writeFileSync(join(d, "my-scenario.cassette.json"), "{}");
    expect(computeContentSig([d])).toBe(before);
  });

  it("does NOT exclude files that match hashIgnore patterns (algorithm-independent)", () => {
    // A file that would be excluded by hashIgnore is still counted in contentSig.
    const d = makeSkillDir({ "index.ts": "x", "tests/spec.ts": "test" });
    const withTest = computeContentSig([d]);
    const withoutTest = computeContentSig([makeSkillDir({ "index.ts": "x" })]);
    expect(withTest).not.toBe(withoutTest);
  });

  it("v6: STRIPS plugin.json version (unified with skillHash — a version-only bump is not a content change)", () => {
    const plugin = JSON.stringify({ name: "my-plugin", version: "1.0.0", mcpServers: {} });
    const d1 = makeSkillDir({ "plugin.json": plugin });
    const d2 = makeSkillDir({ "plugin.json": plugin.replace('"1.0.0"', '"2.0.0"') });
    // contentSig now ignores the version (matches skillHash) → a pure version bump does NOT block rehash.
    expect(computeContentSig([d1])).toBe(computeContentSig([d2]));
    // a real behavior field (mcpServers) still changes it
    const d3 = makeSkillDir({ "plugin.json": JSON.stringify({ name: "my-plugin", version: "1.0.0", mcpServers: { x: {} } }) });
    expect(computeContentSig([d1])).not.toBe(computeContentSig([d3]));
  });
});

describe.skipIf(!can)("rehash CLI", () => {
  it("usage: rehash with no argument exits 2", () => {
    const r = spawnSync("node", [CLI, "rehash"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage.*rehash/i);
  });

  it("rehash on an empty dir exits 0 with 'nothing to migrate' message", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-rehash-"));
    const r = spawnSync("node", [CLI, "rehash", dir], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/nothing to migrate/);
  });

  it("rehash on a cassette without contentSig reports 're-record' and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-rehash-"));
    const body = {
      cassetteVersion: 2,
      scenario: {
        name: "s",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      fingerprint: { baseline: "1.0.0", skillHash: "aabbccdd" },
      // No contentSig — pre-v3 cassette
    };
    writeFileSync(join(dir, "s.cassette.json"), JSON.stringify(body));
    const r = spawnSync("node", [CLI, "rehash", dir], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/re-record/i);
  });

  // Note: the full migrate happy-path (contentSig matches + baseline matches live → action:migrated)
  // requires knowing the live baseline at test time (from loadBaseline("latest").appVersion), making
  // it an integration test beyond the token-free scope of this plan. The core comparison logic is
  // covered by the computeContentSig unit tests above (determinism + change-detection). The
  // content-mismatch CLI path is tested below.
  it("rehash --output-format json reports action:skipped when baseline drifted (JSON output shape)", () => {
    const skillDir = makeSkillDir({ "index.ts": "export const x = 1;" });
    const sig = computeContentSig([skillDir]);
    const dir = mkdtempSync(join(tmpdir(), "cwh-rehash-"));
    const body = {
      cassetteVersion: 2,
      scenario: {
        name: "s",
        baseline: "not-a-real-baseline",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      fingerprint: { baseline: "not-a-real-baseline", skillHash: "aabbccdd", contentSig: sig },
    };
    writeFileSync(join(dir, "s.cassette.json"), JSON.stringify(body));
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    // Exits 0 (skipped is not an error); baseline mismatch causes skip, not error
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.command).toBe("rehash");
    expect(out.results[0].action).toBe("skipped");
    expect(out.results[0].reason).toMatch(/baseline drifted/i);
  });
});
