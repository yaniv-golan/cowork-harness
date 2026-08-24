import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { rehashExitCode, recomputeBothAlgos, CASSETTE_VERSION } from "../src/run/cassette.js";

/**
 * `rehash`'s exit codes — the mapping, and that the CLI actually emits them.
 *
 * Partial success used to be indistinguishable from total failure: `4 migrated, 18 failed` and
 * `0 migrated, 22 failed` both exited 1, while demanding opposite responses. The JSON envelope always
 * carried the split; a shell consumer reading only `$?` could not tell them apart.
 *
 * The unit cases below pin the mapping exhaustively. The end-to-end case matters more: a mapping test
 * proves what the FUNCTION returns, and this repo has shipped a stub that exited 0 where the real command
 * exited 3 — 22 green tests over a live fail-open. So the new code is also proved through a real CLI
 * invocation, on a fixture genuinely in the pre-epoch state rather than one hand-stamped to look like it.
 */

const CLI = resolve("dist/cli.js");
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("rehashExitCode — the mapping", () => {
  it("0 when nothing failed", () => {
    expect(rehashExitCode({ migrated: 0, errors: 0 })).toBe(0);
    expect(rehashExitCode({ migrated: 7, errors: 0 })).toBe(0);
  });

  it("4 when SOME migrated and some did not — the case that used to be indistinguishable", () => {
    expect(rehashExitCode({ migrated: 4, errors: 18 })).toBe(4);
    expect(rehashExitCode({ migrated: 1, errors: 1 })).toBe(4);
  });

  it("1 when nothing migrated and something failed", () => {
    expect(rehashExitCode({ migrated: 0, errors: 22 })).toBe(1);
    expect(rehashExitCode({ migrated: 0, errors: 1 })).toBe(1);
  });

  it("the two failing shapes are DIFFERENT codes — the whole point", () => {
    expect(rehashExitCode({ migrated: 4, errors: 18 })).not.toBe(rehashExitCode({ migrated: 0, errors: 22 }));
  });
});

describe.skipIf(!existsSync(CLI))("the CLI emits them", () => {
  /** A cassette genuinely in the PRE-EPOCH state: its fingerprint really is the legacy digest over the
   *  current tree, so `rehash` can prove it and migrate. Hand-stamping `cassetteVersion` alone does not
   *  work — the tool correctly refuses a v11 stamp carrying a v12-format fingerprint — so this recomputes
   *  the legacy digest with the same exported helper `rehash` itself uses. */
  const legacyCassetteDir = (): string | null => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-exit-"));
    cpSync("examples", join(d, "examples"), { recursive: true });
    const file = join(d, "examples", "replays", "example-pdf-skill.cassette.json");
    const c = JSON.parse(readFileSync(file, "utf8"));
    const sessionPath = c.scenario?.session;
    if (typeof sessionPath !== "string") return null;
    const both = recomputeBothAlgos(sessionPath, dirname(file), c.scenario?.skills, c.fingerprint?.baseline ?? "0.0.0");
    if (!both?.legacyHash) return null;
    c.cassetteVersion = CASSETTE_VERSION - 1;
    // `mode` must come from the SAME recompute as the digest. The committed example records `git` mode
    // (it lives in a checkout); this fixture does not, so the recompute is `raw`. Carrying the original's
    // `git` over a raw digest produces an internally inconsistent cassette, which `rehash` rightly refuses
    // with "recorded in 'git' file-set mode, now 'raw'". `git init`-ing the temp dir to make that refusal
    // go away would be changing the setup until the result agrees — the fixture is what was wrong.
    c.fingerprint = { ...c.fingerprint, skillHash: both.legacyHash, fileSigs: both.legacySigs, mode: both.mode };
    delete c.fingerprint.hashFormat; // absent == the pre-epoch format
    writeFileSync(file, JSON.stringify(c, null, 2));
    return join(d, "examples", "replays");
  };

  it("exits 0 when every cassette is already current", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-clean-"));
    cpSync("examples", join(d, "examples"), { recursive: true });
    const r = run(["rehash", join(d, "examples", "replays"), "--dry-run"]);
    expect(r.code, r.out).toBe(0);
  });

  it("exits 1 when nothing migrated and something failed", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-broken-"));
    writeFileSync(join(d, "broken.cassette.json"), JSON.stringify({ cassetteVersion: 11, scenario: {} }));
    const r = run(["rehash", d, "--dry-run"]);
    expect(r.code, r.out).toBe(1);
  });

  it("exits 4 on PARTIAL success — one migratable alongside one that cannot", () => {
    const dir = legacyCassetteDir();
    if (dir === null) return expect.fail("could not build a pre-epoch fixture — the helper's shape moved");
    // ...and one that cannot possibly migrate, in the same directory.
    writeFileSync(join(dir, "broken.cassette.json"), JSON.stringify({ cassetteVersion: 11, scenario: {} }));
    const r = run(["rehash", dir, "--dry-run"]);
    // Assert the TALLY, not just that the word appears: exit 4 requires migrated>0 AND errors>0, and a
    // weaker matcher would pass on a run that migrated nothing.
    expect(r.out, "expected exactly one migratable and one refusal").toMatch(/rehash: 1 migratable, 1 require a re-record/);
    expect(r.code, r.out).toBe(4);
  });

  it("prints the summary BEFORE the per-file lines", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rehash-order-"));
    writeFileSync(join(d, "broken.cassette.json"), JSON.stringify({ cassetteVersion: 11, scenario: {} }));
    const r = run(["rehash", d, "--dry-run"]);
    const summary = r.out.indexOf("rehash:");
    const perFile = r.out.indexOf("broken.cassette.json");
    expect(summary, r.out).toBeGreaterThanOrEqual(0);
    expect(perFile, r.out).toBeGreaterThanOrEqual(0);
    expect(summary, "the summary must come first — these counts ARE the decision").toBeLessThan(perFile);
  });
});
