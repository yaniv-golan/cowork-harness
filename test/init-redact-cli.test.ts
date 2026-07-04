import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `init-redact` copies the packaged reference .cowork-redact.json into the cwd — the copy is
// load-bearing (loadRedactionPolicy never searches the package dir). Token/agent-free; needs dist/cli.js
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

describe.skipIf(!can)("init-redact CLI", () => {
  it("copies the reference template into the cwd (a valid policy with patterns) → exit 0", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ir-"));
    const r = run(["init-redact"], d);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(d, ".cowork-redact.json"), "utf8"));
    expect(written.patterns.length).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/Review and tailor/);
  });

  it("refuses to overwrite an existing policy without --force (exit 2, loud)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ir-"));
    writeFileSync(join(d, ".cowork-redact.json"), JSON.stringify({ patterns: [{ regex: "tailored", label: "x" }] }));
    const r = run(["init-redact"], d);
    expect(r.code).toBe(2);
    // the tailored policy survived
    expect(readFileSync(join(d, ".cowork-redact.json"), "utf8")).toMatch(/tailored/);
  });

  it("--force overwrites; --output-format json emits an envelope", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ir-"));
    writeFileSync(join(d, ".cowork-redact.json"), "{}");
    const r = run(["init-redact", "--force", "--output-format", "json"], d);
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.path).toMatch(/\.cowork-redact\.json$/);
  });

  it("rejects positional arguments (exit 2)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ir-"));
    const r = run(["init-redact", "somewhere"], d);
    expect(r.code).toBe(2);
  });
});
