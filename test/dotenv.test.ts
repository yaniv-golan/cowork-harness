import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv } from "../src/dotenv.js";

const KEYS = ["CC_TEST_A", "CC_TEST_B", "CC_TEST_QUOTED", "CC_TEST_EXPORT", "CC_TEST_COMMENTHASH"];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

function envFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-env-"));
  const f = join(dir, ".env");
  writeFileSync(f, body);
  return f;
}

describe("loadDotenv", () => {
  it("loads KEY=VALUE, strips quotes/comments/export, and reports loaded keys", () => {
    const f = envFile(
      [
        "# a comment",
        "CC_TEST_A=plain",
        "export CC_TEST_EXPORT=exported",
        'CC_TEST_QUOTED="quoted value"',
        "CC_TEST_COMMENTHASH=val   # trailing comment",
        "",
      ].join("\n"),
    );
    const loaded = loadDotenv(f);
    expect(process.env.CC_TEST_A).toBe("plain");
    expect(process.env.CC_TEST_EXPORT).toBe("exported");
    expect(process.env.CC_TEST_QUOTED).toBe("quoted value");
    expect(process.env.CC_TEST_COMMENTHASH).toBe("val");
    expect(loaded.sort()).toEqual(["CC_TEST_A", "CC_TEST_COMMENTHASH", "CC_TEST_EXPORT", "CC_TEST_QUOTED"]);
  });

  it("does NOT overwrite an already-set process.env var (exported wins)", () => {
    process.env.CC_TEST_B = "from-shell";
    const loaded = loadDotenv(envFile("CC_TEST_B=from-file"));
    expect(process.env.CC_TEST_B).toBe("from-shell");
    expect(loaded).not.toContain("CC_TEST_B");
  });

  it("skips empty values so a blank template line is harmless / append still works", () => {
    const loaded = loadDotenv(envFile("CC_TEST_A=\nCC_TEST_A=real\n"));
    expect(process.env.CC_TEST_A).toBe("real"); // blank line skipped, real value wins
    expect(loaded).toEqual(["CC_TEST_A"]);
  });

  it("returns [] for a missing file", () => {
    expect(loadDotenv("/nonexistent/.env")).toEqual([]);
  });
});
