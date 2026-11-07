import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// analyze-skill --runtime installs process-wide uncaughtException/unhandledRejection listeners while it drives a page,
// to record the page's own throws as crashes and rethrow anything that is clearly the harness's. An exit request is
// neither: those listeners must leave it to the CLI's process-level handler, which exits with its code.
//
// The listeners rethrow only an error whose stack points at the harness (the runtime module, or a test directory) and
// has no page frame. Rethrowing from inside a listener ends the process with Node's exit 7. So:
//  - the control proves that premise: a plain error raised from a script under a `test/` directory exits 7;
//  - the request raised from that same place exits with its own code, so the listener stepped aside;
//  - a request raised from an ordinary stack (which a listener would otherwise record) leaves no crash behind.
const RUNTIME = resolve("dist/run/analyze-artifact-runtime.js");
const EXIT = resolve("dist/run/exit.js");
const can = existsSync(RUNTIME) && existsSync(EXIT) && existsSync(resolve("node_modules/jsdom"));

const PAGE =
  "<!DOCTYPE html><html><body><button id='s'>Save</button><script>document.getElementById('s').addEventListener('click',function(){fetch('/api/x',{method:'POST'});});</script></body></html>";

/** A module that installs the CLI's exit handlers, drives the runtime over PAGE, and once the runtime's own listeners
 *  are on (the count reaches 2) runs `raise` from a timer callback. */
function script(raise: string, opts: { cliHandlers: boolean } = { cliHandlers: true }): string {
  return `
    import * as X from ${JSON.stringify(pathToFileURL(EXIT).href)};
    import { confirmArtifactRuntime } from ${JSON.stringify(pathToFileURL(RUNTIME).href)};
    ${opts.cliHandlers ? "X.installExitHandlers({ sweep() {}, warn: (l) => process.stderr.write(l) });" : "process.on('uncaughtException', () => {}); process.on('unhandledRejection', () => {});"}
    const poll = setInterval(() => {
      if (process.listenerCount("uncaughtException") < 2) return;
      clearInterval(poll);
      process.stderr.write("listeners-on\\n");
      ${raise}
    }, 5);
    const v = await confirmArtifactRuntime("/tmp/v.html", ${JSON.stringify(PAGE)});
    process.stdout.write(JSON.stringify(v));
  `;
}

/** Run a module from `<tmp>/<sub>/raise.mjs`; `sub` = "test" gives every frame in it a harness-shaped path. */
function runFrom(sub: string, src: string) {
  const dir = mkdtempSync(join(tmpdir(), "exit-artifact-"));
  try {
    mkdirSync(join(dir, sub));
    const file = join(dir, sub, "raise.mjs");
    writeFileSync(file, src);
    return spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!can)("an exit request while the artifact runtime's listeners are installed", () => {
  it("control: a plain error from a harness-shaped stack is rethrown by the runtime's listener, ending with exit 7", () => {
    const r = runFrom("test", script('throw new Error("harness-fault");'));
    expect(r.stderr, "raised before the runtime's listeners were installed").toContain("listeners-on");
    expect(r.status, r.stderr).toBe(7);
    expect(r.stderr).toContain("harness-fault");
  }, 90_000);

  it("a request from the same harness-shaped stack exits with its own code, not 7, and prints no stack", () => {
    const r = runFrom("test", script("X.exitWith(4);"));
    expect(r.stderr, "raised before the runtime's listeners were installed").toContain("listeners-on");
    expect(r.status, r.stderr).toBe(4);
    expect(r.stderr).not.toMatch(/ExitRequested|\n\s+at /);
  }, 90_000);

  it("a request from an ordinary stack is not recorded as a page crash", () => {
    // Stand-in listeners that keep the process alive, so the runtime finishes and its verdict can be read. A plain
    // error raised the same way IS recorded (the first case below), so an empty record is not empty by construction.
    const recorded = runFrom("page", script('throw new Error("page-fault");', { cliHandlers: false }));
    expect(recorded.status, recorded.stderr).toBe(0);
    expect(recorded.stdout).toContain("page-fault");

    const r = runFrom("page", script("throw new X.ExitRequested(4);", { cliHandlers: false }));
    expect(r.stderr, "raised before the runtime's listeners were installed").toContain("listeners-on");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).not.toContain("exit requested");
  }, 120_000);
});
