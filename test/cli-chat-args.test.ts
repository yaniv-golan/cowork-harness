import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// chat arg-parsing guards. Every case here exits on a parse/usage error BEFORE any agent or
// Docker spawn, so the suite stays token-free and spawn-free. Needs dist/cli.js (the `ci` script builds
// first); skips cleanly otherwise. chat prints usage/errors to stderr (see `log` in chat.ts).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function chat(args: string[], env?: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), "cc-chat-"));
  const r = spawnSync("node", [CLI, "chat", ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stderr || "") + (r.stdout || ""), stderr: r.stderr || "" };
}

// Every option the chat parser consumes — the help-completeness contract asserts each appears.
const CHAT_FLAGS = ["--raw", "--verbose", "--fidelity", "--model", "--upload", "--folder", "--plugin"];

describe.skipIf(!can)("chat arg guards", () => {
  // ── extra positionals ──
  it("folder-only is accepted by the parser (does not error on arg count)", () => {
    // We can't run the full REPL (would spawn), but an extra-positional error must NOT fire for one
    // positional. Assert the message we'd emit for >2 positionals is absent. (Spawn is avoided because
    // a single positional with a non-existent folder still proceeds to spawn — so we instead test the
    // negative via the >2 case below; here we just confirm <folder> alone is not an arg-count error.)
    const r = chat(["./skill", "--fidelity", "bogus-tier"]); // forces an early exit on fidelity, not arg-count
    expect(r.stderr).not.toMatch(/takes at most/);
  });

  it("folder + prompt (two positionals) is not an arg-count error", () => {
    const r = chat(["./skill", "hello there", "--fidelity", "bogus-tier"]);
    expect(r.stderr).not.toMatch(/takes at most/);
  });

  it("a third positional is rejected with a usage error, exit 2", () => {
    const r = chat(["./skill", "the prompt", "stray-extra"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/takes at most/);
    expect(r.stderr).toMatch(/stray-extra/);
  });

  // ── --upload/--folder/--plugin reject empty + flag-looking values ──
  for (const flag of ["--upload", "--folder", "--plugin"]) {
    it(`${flag} rejects a following flag-looking value, exit 2`, () => {
      const r = chat(["./skill", flag, "--verbose"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/flag-looking|requires/);
    });

    it(`${flag} rejects an empty value, exit 2`, () => {
      const r = chat(["./skill", flag, ""]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/non-empty/);
    });

    it(`${flag} with no following token is a usage error, exit 2`, () => {
      const r = chat(["./skill", flag]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/requires/);
    });
  }

  // ── COWORK_HARNESS_FIDELITY parsed through the tier schema, rejected loudly when invalid ──
  it("an invalid COWORK_HARNESS_FIDELITY is rejected loudly (not silently → container), exit 2", () => {
    const r = chat(["./skill"], { COWORK_HARNESS_FIDELITY: "bogus" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/COWORK_HARNESS_FIDELITY must be/);
  });

  it("COWORK_HARNESS_FIDELITY=microvm is rejected with a not-supported note, exit 2", () => {
    const r = chat(["./skill"], { COWORK_HARNESS_FIDELITY: "microvm" });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/COWORK_HARNESS_FIDELITY must be/);
    expect(r.stderr).toMatch(/not supported in chat/);
  });

  it("the --fidelity flag still rejects an invalid tier, exit 2", () => {
    const r = chat(["./skill", "--fidelity", "microvm"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--fidelity must be/);
  });

  // ── --raw rejects file/sandbox-fidelity options (no longer silently ignored) ──
  it("--raw with --upload is rejected loudly (was silently ignored), exit 2", () => {
    const r = chat(["./skill", "--raw", "--upload", "f.csv"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--raw does not support/);
    expect(r.stderr).toMatch(/--upload/);
  });

  it("--raw with --folder is rejected, exit 2", () => {
    const r = chat(["./skill", "--raw", "--folder", "./repo"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--raw does not support/);
  });

  it("--raw with --fidelity is rejected (cannot honor fidelity in native mode), exit 2", () => {
    const r = chat(["./skill", "--raw", "--fidelity", "protocol"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--raw does not support/);
    expect(r.stderr).toMatch(/--fidelity/);
  });

  it("--raw with --plugin is rejected (the message lists every ignored option)", () => {
    const r = chat(["./skill", "--raw", "--plugin", "./p"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--raw does not support/);
    expect(r.stderr).toMatch(/--plugin/);
  });

  // ── usage/help lists every parsed option (generated from the same spec) ──
  it("the runtime usage (printed on a missing folder) lists every parsed option, incl. --plugin", () => {
    const r = chat([]); // no folder → prints chatUsage()
    expect(r.code).toBe(2);
    for (const flag of CHAT_FLAGS) {
      // --verbose / --raw appear verbatim; value flags appear as `[--flag ...]`. Match the flag name.
      expect(r.stderr).toContain(flag);
    }
  });

  it("`chat --help` documents every parsed option, incl. --plugin", () => {
    const r = chat(["--help"]);
    expect(r.code).toBe(0);
    for (const flag of CHAT_FLAGS) {
      expect(r.out).toContain(flag);
    }
  });
});
