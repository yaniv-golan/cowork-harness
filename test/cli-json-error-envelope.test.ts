import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// This repo is pure ESM ("type": "module") — __dirname is undefined here and would throw a
// ReferenceError (an adversarial review pass caught this exact trap; see test/gate-provenance.test.ts's
// own comment on it). Use a cwd-relative resolve instead, matching test/cli-json.test.ts /
// test/cli-status.test.ts — vitest's cwd is the repo root.
const CLI = resolve("dist/cli.js");

/** Run the built CLI and capture stdout/stderr/exit code without throwing on nonzero exit. */
function run(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

describe("cli usage errors respect --output-format json", () => {
  it("doctor: bad --tier value emits a JSON error envelope, not bare stderr text", () => {
    const r = run(["doctor", "--tier", "nonsense", "--output-format", "json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("");
    const envelope = JSON.parse(r.stdout);
    expect(envelope).toMatchObject({ tool: "cowork-harness", command: "doctor", ok: false, error: { category: "usage" } });
  });

  it("status: missing run-dir argument emits a JSON error envelope", () => {
    const r = run(["status", "--output-format", "json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("");
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.category).toBe("usage");
  });

  it("verify-run: wrong positional count emits a JSON error envelope", () => {
    const r = run(["verify-run", "--output-format", "json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("");
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(false);
  });

  it("doctor: same bad --tier value still prints plain text without --output-format json", () => {
    const r = run(["doctor", "--tier", "nonsense"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--tier");
  });
});
