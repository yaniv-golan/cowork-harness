import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// analyze-skill --runtime installs process-wide uncaughtException/unhandledRejection listeners while it drives a page,
// to record the page's own throws as crashes and rethrow anything that is clearly the harness's. An exit request is
// neither: those listeners must leave it to the CLI's process-level handler, which exits with its code. Rethrowing it
// from inside a listener would end the process with Node's exit 7 instead.
const RUNTIME = resolve("dist/run/analyze-artifact-runtime.js");
const EXIT = resolve("dist/run/exit.js");
const can = existsSync(RUNTIME) && existsSync(EXIT) && existsSync(resolve("node_modules/jsdom"));

describe.skipIf(!can)("an exit request while the artifact runtime's listeners are installed", () => {
  it("exits with the request's code, not 7, and prints no stack", () => {
    const src = `
      import * as X from ${JSON.stringify(pathToFileURL(EXIT).href)};
      import { confirmArtifactRuntime } from ${JSON.stringify(pathToFileURL(RUNTIME).href)};
      X.installExitHandlers({ sweep() {}, warn: (l) => process.stderr.write(l) });
      // Raised from a callback once the runtime's own listeners are on (after its jsdom import), while it drives the page.
      const poll = setInterval(() => {
        if (process.listenerCount("uncaughtException") < 2) return;
        clearInterval(poll);
        process.stderr.write("listeners-on\\n");
        X.exitWith(4);
      }, 5);
      await confirmArtifactRuntime("/tmp/v.html", "<!DOCTYPE html><html><body><button id='s'>Save</button><script>document.getElementById('s').addEventListener('click',function(){fetch('/api/x',{method:'POST'});});</script></body></html>");
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 60_000 });
    expect(r.stderr, "the request was raised before the runtime's listeners were installed").toContain("listeners-on");
    expect(r.status, r.stderr).toBe(4);
    expect(r.stderr).not.toMatch(/ExitRequested|\n\s+at /);
  }, 90_000);
});
