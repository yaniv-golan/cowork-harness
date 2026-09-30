import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compareBaselineVersions, listBaselineNames } from "../src/baseline.js";

// `list` must print the committed baselines oldest -> newest by VERSION (not readdir order, which is
// lexical on APFS and hash order on ext4), and mark the one `latest` resolves to: a stderr line in text
// mode (stdout stays bare filenames, one per line) and `latest: true` on exactly one JSON entry.
// The expected newest file is computed from `listBaselineNames()`, never hard-coded, so adding a baseline
// does not break this test. Needs `dist/cli.js` (the `ci` script builds before testing).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-list-")); // isolated cwd so no stray .env is loaded
  return spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
}

const latestFile = () => `${listBaselineNames()[0]}.json`;

describe.skipIf(!can)("list ordering and latest marker", () => {
  it("text mode prints baselines in ascending version order, bare filenames on stdout", () => {
    const r = run(["list"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l).toMatch(/^desktop-[0-9.]+\.json$/);
    for (let i = 1; i < lines.length; i++) {
      expect(compareBaselineVersions(lines[i - 1], lines[i]), `${lines[i - 1]} before ${lines[i]}`).toBeLessThan(0);
    }
    // The concrete pair readdir gets wrong on a lexical filesystem.
    if (lines.includes("desktop-1.24012.9.json") && lines.includes("desktop-1.24012.11.json")) {
      expect(lines.indexOf("desktop-1.24012.9.json")).toBeLessThan(lines.indexOf("desktop-1.24012.11.json"));
    }
    expect(lines[lines.length - 1]).toBe(latestFile());
  });

  it("text mode names the latest baseline on stderr, not stdout", () => {
    const r = run(["list"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`latest → ${latestFile()}`);
    expect(r.stdout).not.toContain("latest");
  });

  it("JSON mode is ascending and marks exactly the latest entry with latest: true", () => {
    const r = run(["list", "--output-format", "json"]);
    expect(r.status).toBe(0);
    const arr = JSON.parse(r.stdout) as Array<{ file: string; name: string; latest?: boolean }>;
    expect(Array.isArray(arr)).toBe(true);
    for (let i = 1; i < arr.length; i++) expect(compareBaselineVersions(arr[i - 1].file, arr[i].file)).toBeLessThan(0);
    const marked = arr.filter((e) => e.latest === true);
    expect(marked.map((e) => e.file)).toEqual([latestFile()]);
    // Additive only: non-latest entries carry no `latest` key at all.
    for (const e of arr) if (e.file !== latestFile()) expect("latest" in e).toBe(false);
  });
});
