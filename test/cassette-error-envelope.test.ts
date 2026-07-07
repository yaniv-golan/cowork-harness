import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

// #49: cassette.ts commands (record/replay/verify-cassettes/rehash) must emit the shared JSON ERROR
// envelope on --output-format json error paths — not bare plain text — matching the error-path invariant
// the CI guard now enforces for src/run/cassette.ts.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function runJson(args: string[]): { status: number | null; env: any } {
  const r = spawnSync("node", [CLI, ...args, "--output-format", "json"], { encoding: "utf8" });
  let env: any;
  try {
    env = JSON.parse(r.stdout.trim());
  } catch {
    env = { PARSE_ERROR: r.stdout };
  }
  return { status: r.status, env };
}

describe.skipIf(!can)("#49 cassette.ts error-envelope conformance (--output-format json)", () => {
  it("rehash: a non-directory target emits a JSON error envelope on stdout, exit 2", () => {
    const { status, env } = runJson(["rehash", "/no/such/dir/xyz"]);
    expect(status).toBe(2);
    expect(env.tool).toBe("cowork-harness");
    expect(env.command).toBe("rehash");
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBeTruthy();
    expect(env.error?.message).toMatch(/not a directory/);
  });

  it("replay: a missing positional emits a JSON usage-error envelope", () => {
    const { status, env } = runJson(["replay"]);
    expect(status).toBe(2);
    expect(env.command).toBe("replay");
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/usage: replay/);
  });

  it("verify-cassettes: a missing positional emits a JSON usage-error envelope", () => {
    const { status, env } = runJson(["verify-cassettes"]);
    expect(status).toBe(2);
    expect(env.command).toBe("verify-cassettes");
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/usage: verify-cassettes/);
  });

  it("record: a missing positional emits a JSON usage-error envelope", () => {
    const { status, env } = runJson(["record"]);
    expect(status).toBe(2);
    expect(env.command).toBe("record");
    expect(env.ok).toBe(false);
    expect(env.error?.category).toBe("usage");
    expect(env.error?.message).toMatch(/usage: record/);
  });
});
