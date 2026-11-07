import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildFingerprint, fingerprintSkillDrift, CASSETTE_VERSION, requiredVersionFor } from "../src/run/cassette.js";
import { jcs1HashedContent } from "../src/run/skill-hash.js";
import type { Fingerprint } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";

// The jcs1 hash format: every fingerprint declares it, the read boundary enforces it, and a kept run from
// before it is reported as not comparable rather than as source drift.

const CLI = resolve("dist/cli.js");
const EPOCH = requiredVersionFor({}); // the stamped floor, read from source rather than duplicated
const LIVE_BASELINE = loadBaseline("latest").appVersion;
/** The recorded `initialize` request every real cassette's `controlOut` starts with. */
const INIT_LINE = JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });

/** A plugin root whose manifest key order is NOT canonical. */
function unsortedRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "epoch-"));
  mkdirSync(join(d, ".claude-plugin"), { recursive: true });
  mkdirSync(join(d, "skills", "s"), { recursive: true });
  writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"skills":"./skills","name":"p","version":"1"}');
  writeFileSync(join(d, "skills", "s", "SKILL.md"), "# s\n");
  return d;
}

describe("jcs1 manifest digests", () => {
  it("are key-order insensitive", () => {
    const a = Buffer.from('{"name":"p","skills":"./s","version":"1"}');
    const b = Buffer.from('{"skills":"./s","name":"p","version":"1"}');
    expect(jcs1HashedContent(a, "claude-manifest")).toBe(jcs1HashedContent(b, "claude-manifest"));
  });
});

describe("hashFormat is stamped on EVERY fingerprint return path", () => {
  // `buildFingerprint` returns early twice before the main object. A v12 fingerprint that omits
  // `hashFormat` violates the read-boundary invariant and would fail its own load — so a baseline-only or
  // read-error recording has to carry it exactly like a full one.
  it("including a ZERO-ROOT session, which returns before any hashing happens", () => {
    const d = mkdtempSync(join(tmpdir(), "epoch-zero-"));
    const sessionPath = join(d, "session.yaml");
    writeFileSync(sessionPath, "skills:\n  local: []\n");
    const fp = buildFingerprint(sessionPath, "1.0.0", d);
    expect(fp.skillHash).toBeUndefined(); // nothing to hash…
    expect(fp.hashFormat).toBe("jcs1"); // …but the format is still declared
  });

  it("and on a normal recording", () => {
    const d = unsortedRoot();
    const sessionPath = join(d, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ${d}\n`);
    expect(buildFingerprint(sessionPath, "1.0.0", d).hashFormat).toBe("jcs1");
  });
});

describe("verify-run — a kept RunResult has no version, so the format IS the discriminator", () => {
  const base: Fingerprint = { baseline: "1.0.0", skillHash: "aaa", hashFormat: "jcs1" };

  it("reports the FORMAT change, never 'the source changed'", () => {
    // Without this the epoch reads as source drift on every run kept before it — false, and with no hint
    // about what to do. There is no `cassetteVersion` here to route it anywhere else.
    const drift = fingerprintSkillDrift({ ...base, hashFormat: undefined }, { ...base, skillHash: "bbb" });
    expect(drift).toMatch(/hash format/);
    expect(drift).not.toMatch(/source changed/);
  });

  it("treats ABSENT as a run kept before jcs1 — not comparable, never as current", () => {
    expect(fingerprintSkillDrift({ ...base, hashFormat: undefined }, base)).toMatch(/recorded before hash format 'jcs1'/);
  });

  it("reports an UNKNOWN format loudly rather than coercing it to either side", () => {
    const drift = fingerprintSkillDrift({ ...base, hashFormat: "jcs2" as "jcs1" }, base);
    expect(drift).toMatch(/unrecognized hash format 'jcs2'/);
  });

  it("still reports genuine source drift when the formats agree", () => {
    expect(fingerprintSkillDrift(base, { ...base, skillHash: "bbb" })).toMatch(/source changed/);
  });
});

describe.skipIf(!existsSync(CLI))("the version/format invariant is enforced at the READ boundary", () => {
  it("rejects a current-version cassette whose fingerprint omits hashFormat", () => {
    const dir = mkdtempSync(join(tmpdir(), "epoch-inv-"));
    const file = join(dir, "c.cassette.json");
    writeFileSync(
      file,
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION,
        scenario: { name: "c", baseline: "latest", session: "s.yaml", fidelity: "container", prompt: "hi", answers: [] },
        events: [],
        controlOut: [INIT_LINE],
        userVisibleRoots: ["outputs"],
        fingerprint: { baseline: "latest", skillHash: "abc" }, // stamped current, but says nothing about format
      }),
    );
    const r = spawnSync("node", [CLI, "replay", file], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/hashFormat/);
  });
});

describe("sharedHash is recorded only for a scoped fingerprint", () => {
  it("present when scoped over plugin-roots, absent unscoped", () => {
    const d = unsortedRoot();
    writeFileSync(join(d, "session.yaml"), `skills:\n  local:\n    - ${d}\n`);
    expect(buildFingerprint(join(d, "session.yaml"), LIVE_BASELINE, d, ["s"]).sharedHash).toBeTruthy();
    expect(buildFingerprint(join(d, "session.yaml"), LIVE_BASELINE, d).sharedHash).toBeUndefined();
  });
});

describe.skipIf(!existsSync(CLI))("an unconsumed --session must never look successful", () => {
  const vc = (args: string[]) => spawnSync("node", [CLI, "verify-cassettes", ...args], { encoding: "utf8" });

  it("--allow-empty does not swallow a bad --session", () => {
    // `--allow-empty` returned ok:true before any --session check, skipping the directory refusal, the
    // "not a session file" gate and the announcement together. `--skip-staleness --session` is refused for
    // exactly this reason: an override that is never consumed must not report success.
    const empty = mkdtempSync(join(tmpdir(), "vc-empty-"));
    const r = vc([empty, "--session", "/no/such.yaml", "--allow-empty"]);
    expect(r.status).not.toBe(0);
  });

  it("refusing an inline cassette emits NO success notice first", () => {
    // Announcing before the refusal printed "override in effect: … -> <dirs>" directly above "this cassette
    // records an inline scenario, which has no session file to override" — a self-contradiction in two
    // consecutive lines.
    const dir = mkdtempSync(join(tmpdir(), "vc-inline-"));
    const sessionPath = join(dir, "s.yaml");
    writeFileSync(sessionPath, "skills:\n  local: []\n");
    const file = join(dir, "c.cassette.json");
    writeFileSync(
      file,
      JSON.stringify({
        cassetteVersion: EPOCH,
        scenario: { name: "c", baseline: LIVE_BASELINE, session: "(inline)", fidelity: "container", prompt: "hi", answers: [] },
        events: [],
        controlOut: [INIT_LINE],
        userVisibleRoots: ["outputs"],
        fingerprint: { baseline: LIVE_BASELINE, hashFormat: "jcs1", skillHash: "abc" },
      }),
    );
    const r = vc([file, "--session", sessionPath]);
    const all = `${r.stdout}${r.stderr}`;
    expect(all).toMatch(/inline scenario/);
    expect(all).not.toMatch(/override in effect/); // the contradiction
  });
});
