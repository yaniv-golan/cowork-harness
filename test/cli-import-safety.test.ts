import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/cli.ts runs the CLI only when it is the process's entry point. Several tests import it in-process for its pure
// helpers; at import it must not run `main()`, install the process-level exit handlers (they would swallow this
// worker's own errors), arm the exit fallback (it would kill this worker 5 s later), or set an exit code.
describe("importing src/cli.ts", () => {
  it("runs nothing: no listener, no exit code, no output", async () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
      exitCode: process.exitCode,
    };
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write");
    try {
      const mod = await import("../src/cli.js");
      expect(typeof mod.isCliEntry).toBe("function");
      expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
      expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
      expect(process.exitCode).toBe(before.exitCode);
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
      const { exitHandlersInstalled } = await import("../src/run/exit.js");
      expect(exitHandlersInstalled()).toBe(false);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("isCliEntry: true only for the module's own path (through a symlink too), false for anything else", async () => {
    const { isCliEntry } = await import("../src/cli.js");
    const self = resolve("src/cli.ts");
    expect(isCliEntry(self, self)).toBe(true);
    expect(isCliEntry(realpathSync(self), self)).toBe(true);
    // the npm bin is a symlink to the entry file
    const dir = mkdtempSync(join(tmpdir(), "cli-entry-"));
    try {
      symlinkSync(self, join(dir, "cowork-harness"));
      expect(isCliEntry(join(dir, "cowork-harness"), self)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(isCliEntry(undefined, self)).toBe(false);
    expect(isCliEntry("", self)).toBe(false);
    expect(isCliEntry(resolve("src/no-such-file.ts"), self)).toBe(false);
    expect(isCliEntry(resolve("node_modules/vitest/package.json"), self)).toBe(false);
  });
});

// The same entry rule in real processes: the source run through tsx is the entry, and an importer of the built
// module is not.
describe("the CLI entry in a real process", () => {
  it("`tsx src/cli.ts --help` runs the CLI and exits 0", () => {
    const tsx = resolve("node_modules/.bin/tsx");
    const r = spawnSync(tsx, ["src/cli.ts", "--help"], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/usage|Usage|cowork-harness/);
  }, 60_000);

  it.skipIf(!existsSync(resolve("dist/cli.js")))(
    "importing dist/cli.js prints nothing and installs no listener",
    () => {
      const src = `
      const before = process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
      const mod = await import(${JSON.stringify(pathToFileURL(resolve("dist/cli.js")).href)});
      const after = process.listenerCount("uncaughtException") + process.listenerCount("unhandledRejection");
      process.stderr.write(JSON.stringify({ entry: typeof mod.isCliEntry, added: after - before, exitCode: process.exitCode ?? null }));
    `;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      expect(JSON.parse(r.stderr)).toEqual({ entry: "function", added: 0, exitCode: null });
    },
    60_000,
  );
});
