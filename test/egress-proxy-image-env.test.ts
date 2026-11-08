import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Which image the egress sidecar actually runs, observed through the sidecar path itself rather than a
// resolver unit test. The CLI statically imports the sidecar module (cli → chat → sidecar) and only then
// loads `.env` inside main(), so a value read at module-load time is fixed before `.env` is applied: the
// sidecar would ignore a `.env` COWORK_PROXY_IMAGE that `doctor` honours. Each case runs in a child node
// process against the REAL source (via tsx) in that same order — static import first, `.env` second —
// with COWORK_HARNESS_CONTAINER_RUNTIME pointed at a fake runtime that records its argv and reports the proxy as
// running. No Docker, no network. With FAKE_RUNTIME_NO_IMAGE=1 the fake reports the image as absent, so the
// sidecar takes its `build -t` branch too.

const POSIX = process.platform !== "win32";
const SIDECAR = JSON.stringify(resolve("src/egress/sidecar.ts"));
const DOTENV = JSON.stringify(resolve("src/dotenv.ts"));

const FAKE_RUNTIME = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RUNTIME_LOG"
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$FAKE_RUNTIME_NO_IMAGE" = "1" ]; then exit 1; fi
if [ "$1" = "inspect" ] && [ "$3" = "{{.State.Running}}" ]; then echo true; fi
exit 0
`;

/** The image-building branch COPYs the shipped dist/egress, and throws before `build` when it is absent. */
const DIST_PROXY = existsSync(resolve("dist/egress/proxy.js"));

interface Seen {
  inspect?: string;
  build?: string;
  run?: string;
}

/** Run startEgressSidecar in a child process and return the image ref it passed to `image inspect`,
 *  `build -t` (only when `noImage`) and `run -d`. `dotenv` (when given) is written to a file the child
 *  loads AFTER importing the sidecar. */
function sidecarImage(opts: { env: Record<string, string | undefined>; dotenv?: string; noImage?: boolean }): Seen {
  const dir = mkdtempSync(join(tmpdir(), "proxy-image-"));
  try {
    const runtime = join(dir, "fake-runtime");
    writeFileSync(runtime, FAKE_RUNTIME);
    chmodSync(runtime, 0o755);
    const log = join(dir, "argv.log");
    const envFile = join(dir, ".env");
    if (opts.dotenv !== undefined) writeFileSync(envFile, opts.dotenv);
    const script = join(dir, "harness.mts");
    writeFileSync(
      script,
      `
        import { startEgressSidecar } from ${SIDECAR};
        import { loadDotenv } from ${DOTENV};
        loadDotenv(${JSON.stringify(envFile)});
        const s = startEgressSidecar([], ${JSON.stringify(join(dir, "out"))}, "t1");
        s.teardown();
      `,
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "COWORK_PROXY_IMAGE") env[k] = v;
    for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;
    env.COWORK_HARNESS_CONTAINER_RUNTIME = runtime;
    env.FAKE_RUNTIME_LOG = log;
    if (opts.noImage) env.FAKE_RUNTIME_NO_IMAGE = "1";
    const r = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 20_000, env });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(log), "the fake runtime was never invoked").toBe(true);
    const lines = readFileSync(log, "utf8").split("\n");
    // `image inspect <ref>` — the ref is the last token (may be empty when an empty ref is passed through).
    const inspectLine = lines.find((l) => l.startsWith("image inspect"));
    const buildLine = lines.find((l) => l.startsWith("build -t "));
    const runLine = lines.find((l) => l.startsWith("run -d "));
    const seen: Seen = {
      inspect: inspectLine === undefined ? undefined : inspectLine.slice("image inspect".length).trim(),
      run: runLine === undefined ? undefined : runLine.trim().split(" ").pop(),
    };
    if (buildLine !== undefined) seen.build = buildLine.split(" ")[2];
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(POSIX)("egress sidecar honours COWORK_PROXY_IMAGE at use time", () => {
  // The default's exact value is pinned by the resolver's unit tests (test/agent-image.test.ts); here it is
  // only required to be a proxy tag, so this file needs nothing new from src/ and a red names the
  // behaviour, not a missing export.
  let unset: Seen | undefined;
  const unsetOnce = () => (unset ??= sidecarImage({ env: {} }));

  it("unset → the default proxy tag", () => {
    const got = unsetOnce();
    expect(got.inspect).toMatch(/^cowork-egress-proxy:\d+$/);
    expect(got.run).toBe(got.inspect);
  });

  it("set in the environment → that value", () => {
    const got = sidecarImage({ env: { COWORK_PROXY_IMAGE: "my-proxy:env" } });
    expect(got).toEqual({ inspect: "my-proxy:env", run: "my-proxy:env" });
  });

  it("set only in a .env loaded AFTER the sidecar module was imported → that value", () => {
    const got = sidecarImage({ env: {}, dotenv: "COWORK_PROXY_IMAGE=my-proxy:dotenv\n" });
    expect(got).toEqual({ inspect: "my-proxy:dotenv", run: "my-proxy:dotenv" });
  });

  it("an empty or blank value falls back to the default, never an empty image ref", () => {
    const want = unsetOnce();
    expect(want.inspect).toMatch(/^cowork-egress-proxy:\d+$/);
    expect(sidecarImage({ env: { COWORK_PROXY_IMAGE: "" } })).toEqual(want);
    expect(sidecarImage({ env: { COWORK_PROXY_IMAGE: "   " } })).toEqual(want);
  });

  // CI's unit-test shards and the `npm run ci` floor both build before testing, so this runs there; it
  // skips (visibly, by this name) only in a checkout that has not been built.
  it.skipIf(!DIST_PROXY)("image absent → `build -t` gets the .env value too (skipped when dist/egress/proxy.js is not built)", () => {
    const got = sidecarImage({ env: {}, dotenv: "COWORK_PROXY_IMAGE=my-proxy:dotenv\n", noImage: true });
    expect(got).toEqual({ inspect: "my-proxy:dotenv", build: "my-proxy:dotenv", run: "my-proxy:dotenv" });
  });
});
