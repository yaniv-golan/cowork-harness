import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import * as hostloop from "../src/runtime/hostloop.js";
import * as sidecarMod from "../src/egress/sidecar.js";

// The hostloop tier runs a workspace sidecar: a `cowork-hl-*` container started by an attached `docker run`
// client, on the egress sidecar's `cowork-int-*` network. A signal must reap all three. The network can only go
// once the container is gone (`network rm` fails while a container is attached), so the sidecar's removal runs
// in the "container" phase, before the egress sidecar's "network" phase. The client is killed too: a SIGINT to
// the process group reaches it, it forwards the signal to a keep-alive PID 1 that ignores it, and it stays.
//
// Each case runs a small script against the REAL source (via tsx) in a child node process, the way
// termination-handler.test.ts does, with COWORK_CONTAINER_RUNTIME pointed at a fake runtime that records its
// argv (the way egress-proxy-image-env.test.ts does). The fake models the attachment: `network rm` of the
// internal network fails while the sidecar container has not been removed. With FAKE_RM_FAILS_ONCE=1 the
// first `rm -f` of the sidecar container fails. An attached `run` (the sidecar client) sleeps, so only an
// explicit kill ends it.

const POSIX = process.platform !== "win32";
const SIDECAR = JSON.stringify(resolve("src/egress/sidecar.ts"));
const HOSTLOOP = JSON.stringify(resolve("src/runtime/hostloop.ts"));

const FAKE_RUNTIME = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RUNTIME_LOG"
if [ "$1" = "inspect" ] && [ "$3" = "{{.State.Running}}" ]; then echo true; fi
if [ "$1" = "run" ] && [ "$2" != "-d" ]; then echo $$ > "$FAKE_RUNTIME_CLIENT_PID"; exec sleep 600; fi
case "$1 $2 $3" in
  "rm -f cowork-hl-"*)
    if [ "$FAKE_RM_FAILS_ONCE" = "1" ] && [ ! -e "$FAKE_STATE.failed" ]; then
      : > "$FAKE_STATE.failed"; echo "Error response from daemon: removal of container is already in progress" >&2; exit 1
    fi
    : > "$FAKE_STATE.hl-gone" ;;
  "network rm cowork-int-"*)
    if [ ! -e "$FAKE_STATE.hl-gone" ]; then echo "Error response from daemon: error while removing network: network has active endpoints" >&2; exit 1; fi ;;
esac
exit 0
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Outcome {
  status: number | null;
  stderr: string;
  argv: string[];
  clientPid: number;
  clientSurvived: boolean;
  out: string;
}

/** Run `body` (after the egress sidecar and the hostloop sidecar have been started as `eg` / `hl`) in a child
 *  node process against the fake runtime. The script sees `runner`, `eg`, `start()`, `clientUp()`, `note()` and
 *  `PIDFILE` (the fake client's pid file). */
async function runWithSidecars(body: string, env: Record<string, string> = {}): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "hl-sidecar-signal-"));
  const runtime = join(dir, "fake-runtime");
  writeFileSync(runtime, FAKE_RUNTIME);
  chmodSync(runtime, 0o755);
  const log = join(dir, "argv.log");
  const pidFile = join(dir, "client.pid");
  const outFile = join(dir, "out.txt");
  const script = join(dir, "harness.mts");
  writeFileSync(
    script,
    `
      import { startEgressSidecar, removeContainerThenRelease } from ${SIDECAR};
      import { startHostLoopSidecar, reapSidecarOnThrow } from ${HOSTLOOP};
      import { existsSync, appendFileSync } from "node:fs";
      const runner = process.env.COWORK_CONTAINER_RUNTIME;
      const PIDFILE = ${JSON.stringify(pidFile)};
      const note = (s) => appendFileSync(${JSON.stringify(outFile)}, s + "\\n");
      const eg = startEgressSidecar([], ${JSON.stringify(join(dir, "out"))}, "t1");
      const start = () => startHostLoopSidecar({
        runner,
        argv: ["run", "--rm", "-i", "--name", "cowork-hl-t1", "--network", eg.network, "img", "sleep", "infinity"],
        containerName: "cowork-hl-t1",
        logInfra: () => {},
      });
      const clientUp = () => new Promise((res) => {
        const t = setInterval(() => { if (existsSync(PIDFILE)) { clearInterval(t); res(undefined); } }, 20);
      });
      ${body}
      setTimeout(() => {}, 30_000);
    `,
  );
  try {
    const procEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) procEnv[k] = v;
    Object.assign(procEnv, env, {
      COWORK_CONTAINER_RUNTIME: runtime,
      FAKE_RUNTIME_LOG: log,
      FAKE_RUNTIME_CLIENT_PID: pidFile,
      FAKE_STATE: join(dir, "state"),
    });
    const proc = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe"], env: procEnv });
    let stderr = "";
    proc.stderr!.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const status = await new Promise<number | null>((res) => proc.on("exit", (c) => res(c)));
    clearTimeout(killer);
    const clientPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
    // the client is SIGKILLed synchronously before exit; give the kernel a beat to reap it
    for (let i = 0; i < 20 && Number.isFinite(clientPid) && alive(clientPid); i++) await new Promise((r) => setTimeout(r, 50));
    const argv = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    // Observed BEFORE the leak guard below kills a survivor, so the guard cannot turn a red into a green.
    const clientSurvived = Number.isFinite(clientPid) && alive(clientPid);
    if (clientSurvived) process.kill(clientPid, "SIGKILL"); // a red test leaks nothing
    const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    return { status, stderr, argv, clientPid, clientSurvived, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RM_HL = "rm -f cowork-hl-t1";
const RM_NET = "network rm cowork-int-t1";
const indexesOf = (argv: string[], line: string) => argv.flatMap((l, i) => (l === line ? [i] : []));

describe.runIf(POSIX)("hostloop workspace sidecar: a signal reaps the container, its client and the network", () => {
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    it(`${sig}: rm -f the sidecar container, then rm its network; the docker run client is killed`, async () => {
      const r = await runWithSidecars(`start(); await clientUp(); process.kill(process.pid, ${JSON.stringify(sig)});`);
      expect(r.status, r.stderr).toBe(code);
      const rmContainer = r.argv.indexOf(RM_HL);
      const rmNetwork = r.argv.indexOf(RM_NET);
      expect(rmContainer, r.argv.join("\n")).toBeGreaterThan(-1);
      expect(rmNetwork, r.argv.join("\n")).toBeGreaterThan(rmContainer);
      expect(Number.isFinite(r.clientPid), "precondition: the fake client started").toBe(true);
      expect(r.clientSurvived, "the docker run client survived the signal").toBe(false);
    });
});

// The normal path de-registers the signal-time thunks only once its own `rm -f` has succeeded. A removal that
// fails (or a teardown that throws before reaching it) leaves them registered, and a later signal or the process
// exit reaps the container and then its network.
describe.runIf(POSIX)("a failed normal-path removal stays registered", () => {
  const teardown = `
    const hl = start(); await clientUp();
    note("removed=" + removeContainerThenRelease(runner, "cowork-hl-t1", [hl.deregister]));
    eg.teardown();
  `;

  it("control: a successful removal de-registers — nothing is reaped again at exit", async () => {
    const r = await runWithSidecars(`${teardown} process.exit(0);`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toContain("removed=true");
    expect(indexesOf(r.argv, RM_HL), r.argv.join("\n")).toHaveLength(1);
    expect(indexesOf(r.argv, RM_NET), r.argv.join("\n")).toHaveLength(1);
    expect(r.stderr).not.toContain("left registered at exit");
  });

  it("rm -f fails once: the process exit removes the container, then the network", async () => {
    const r = await runWithSidecars(`${teardown} process.exit(0);`, { FAKE_RM_FAILS_ONCE: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toContain("removed=false");
    const rms = indexesOf(r.argv, RM_HL);
    const nets = indexesOf(r.argv, RM_NET);
    expect(rms, r.argv.join("\n")).toHaveLength(2);
    expect(nets, r.argv.join("\n")).toHaveLength(2); // the teardown's (refused: still attached), then the exit's
    expect(nets[1]).toBeGreaterThan(rms[1]);
    expect(r.stderr).toContain("left registered at exit");
    expect(r.clientSurvived, "the docker run client survived").toBe(false);
  });

  it("rm -f fails once: a later signal removes the container, then the network", async () => {
    const r = await runWithSidecars(`${teardown} process.kill(process.pid, "SIGINT");`, { FAKE_RM_FAILS_ONCE: "1" });
    expect(r.status, r.stderr).toBe(130);
    const rms = indexesOf(r.argv, RM_HL);
    const nets = indexesOf(r.argv, RM_NET);
    expect(rms, r.argv.join("\n")).toHaveLength(2);
    expect(nets.at(-1)!, r.argv.join("\n")).toBeGreaterThan(rms[1]);
    expect(r.clientSurvived, "the docker run client survived").toBe(false);
  });

  it("a teardown that throws before its rm -f: the exit still reaps", async () => {
    const r = await runWithSidecars(`start(); await clientUp(); process.exit(0);`);
    expect(r.status, r.stderr).toBe(0);
    const rms = indexesOf(r.argv, RM_HL);
    expect(rms, r.argv.join("\n")).toHaveLength(1);
    expect(r.argv.lastIndexOf(RM_NET)).toBeGreaterThan(rms[0]);
    expect(r.clientSurvived, "the docker run client survived").toBe(false);
  });
});

// spawnHostLoop throwing after it started the sidecar: the caller never learns the container name, so its
// teardown cannot remove it. reapSidecarOnThrow reaps it at once and drops the registration.
describe.runIf(POSIX)("spawnHostLoop throwing after the sidecar started", () => {
  it("reaps the sidecar before rethrowing, and leaves nothing registered", async () => {
    const r = await runWithSidecars(`
      try {
        reapSidecarOnThrow((track) => {
          track(start());
          // wait (synchronously) for the client, so the reap meets a running one
          while (!existsSync(PIDFILE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          throw new Error("boom");
        });
      } catch (e) { note("threw=" + e.message); }
      process.exit(0);
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toContain("threw=boom");
    expect(indexesOf(r.argv, RM_HL), r.argv.join("\n")).toHaveLength(1);
    expect(r.clientSurvived, "the docker run client survived").toBe(false);
    // the only thing left registered at exit is the egress sidecar this script never tore down
    expect(r.stderr).toContain("reaping 1 egress resource(s) left registered at exit");
  });
});

describe("reapSidecarOnThrow", () => {
  it("reaps everything tracked, newest first, and rethrows the original error even if a reap throws", () => {
    const log: string[] = [];
    expect(() =>
      (hostloop as any).reapSidecarOnThrow((track: any) => {
        track({ reapNow: () => void log.push("agent") });
        track({
          reapNow: () => {
            log.push("sidecar");
            throw new Error("reap failed");
          },
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(log).toEqual(["sidecar", "agent"]);
  });
  it("reaps nothing when spawn returns", () => {
    const log: string[] = [];
    expect((hostloop as any).reapSidecarOnThrow((track: any) => (track({ reapNow: () => void log.push("x") }), 7))).toBe(7);
    expect(log).toEqual([]);
  });
});

describe("makeHostLoopSidecarReap — the signal-time thunk", () => {
  it("marks tearing down, removes the container, then kills the client", () => {
    const log: string[] = [];
    const run = (hostloop as any).makeHostLoopSidecarReap({
      markTearingDown: () => log.push("mark"),
      containerName: "cowork-hl-x",
      rm: (n: string) => log.push(`rm ${n}`),
      kill: (s: NodeJS.Signals) => log.push(`kill ${s}`),
    });
    run();
    expect(log).toEqual(["mark", "rm cowork-hl-x", "kill SIGKILL"]);
  });
});

// "Gone" means docker said so about the container or network itself. Any other failure that happens to say
// "not found" — a missing docker CONTEXT, an endpoint — leaves the thing in place, so the cleanup must stay.
describe("alreadyGone — what counts as removed", () => {
  const gone = (status: number, stderr: string) => (sidecarMod as any).alreadyGone({ status, stderr, stdout: "" });
  it("exit 0, and docker's or podman's own container/network not-found messages, are gone", () => {
    expect(gone(0, "")).toBe(true);
    expect(gone(1, "Error response from daemon: No such container: cowork-hl-x")).toBe(true);
    expect(gone(1, "Error response from daemon: network cowork-int-x not found")).toBe(true);
    expect(gone(1, 'Error: no container with name or ID "cowork-hl-x" found: no such container')).toBe(true);
    expect(gone(1, "Error: unable to find network with name or ID cowork-int-x: network not found")).toBe(true);
  });
  it("a docker context error, an endpoint error or an attached network are NOT gone", () => {
    expect(gone(1, 'context "x": context not found: open /Users/a/.docker/contexts/meta/x/meta.json: no such file or directory')).toBe(
      false,
    );
    expect(gone(1, "error during connect: endpoint not found")).toBe(false);
    expect(gone(1, "Error response from daemon: error while removing network: network cowork-int-x has active endpoints")).toBe(false);
  });
});

describe.runIf(POSIX)("a context error on removal keeps the cleanup registered", () => {
  it("removeContainerThenRelease reports failure and does not de-register", () => {
    const dir = mkdtempSync(join(tmpdir(), "hl-ctx-"));
    try {
      const runtime = join(dir, "fake-runtime");
      writeFileSync(
        runtime,
        `#!/bin/sh\necho 'context "gone": context not found: open /Users/a/.docker/contexts/meta/x/meta.json: no such file or directory' >&2\nexit 1\n`,
      );
      chmodSync(runtime, 0o755);
      let dropped = 0;
      const orig = process.stderr.write;
      (process.stderr as any).write = () => true;
      try {
        expect((sidecarMod as any).removeContainerThenRelease(runtime, "cowork-hl-x", [() => void dropped++])).toBe(false);
      } finally {
        (process.stderr as any).write = orig;
      }
      expect(dropped).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("removeContainerThenRelease", () => {
  it("de-registers only after a successful removal; nothing to remove counts as success", async () => {
    const { removeContainerThenRelease } = await import("../src/egress/sidecar.js");
    let dropped = 0;
    const d = () => void dropped++;
    const quiet = () => {};
    const origWrite = process.stderr.write;
    (process.stderr as any).write = quiet;
    try {
      expect(removeContainerThenRelease("x", "c", [d, undefined], () => false)).toBe(false);
      expect(dropped).toBe(0);
      expect(removeContainerThenRelease("x", "c", [d, d], () => true)).toBe(true);
      expect(dropped).toBe(2);
      expect(removeContainerThenRelease("x", undefined, [d], () => false)).toBe(true);
      expect(dropped).toBe(3);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });
});

// The normal path must keep its signal-time thunks registered until it has removed the container itself. It
// awaits the agent's stop sequence first (seconds at hostloop); a signal that lands there drains the registry
// and exits before the normal path reaches its own `rm -f`, so a thunk dropped earlier is a thunk that never runs.
// The pin is on every USE of the two de-register handles, not on one spelling of the call: each may appear only
// where it is declared, where it is assigned, and as an argument of the one release call — so an early
// de-register, however it is spelled (`?.()`, `if (d) d()`, an alias), adds a use and fails.
describe("wiring", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  it("spawnHostLoop starts its sidecar through startHostLoopSidecar, tracked for a throw", () => {
    const s = src("runtime/hostloop.ts");
    expect(s).toMatch(/startHostLoopSidecar\(\{\s*runner,\s*argv: sidecarArgs[\s\S]{0,120}\}\);\s*trackOnThrow\(hlSidecar\);/);
    expect(s).toMatch(/return reapSidecarOnThrow\(\(track\) => spawnHostLoopTracked\(/);
    expect(s).toMatch(/agentSpawnOptions\([\s\S]{0,200}\);\s*\/\/[^\n]*\n\s*trackOnThrow\(\{/);
    expect(s).not.toMatch(/spawn\(runner, sidecarArgs/);
  });
  const RELEASE = "removeContainerThenRelease(runner, containerName, [deregisterContainerReap, deregisterHostLoopSidecarReap]);";
  const allowed: Record<string, RegExp[]> = {
    "run/execute.ts": [
      /let deregisterContainerReap: \(\(\) => void\) \| undefined;/g,
      /deregisterContainerReap = registerCleanup\(\{/g,
      /let deregisterHostLoopSidecarReap: \(\(\) => void\) \| undefined;/g,
      /deregisterHostLoopSidecarReap = hl\.deregisterSidecarReap;/g,
    ],
    "run/chat.ts": [
      /const deregisterContainerReap = sidecar\s*\?\s*registerCleanup\(\{/g,
      /let deregisterHostLoopSidecarReap: \(\(\) => void\) \| undefined;/g,
      /deregisterHostLoopSidecarReap = hl\.deregisterSidecarReap;/g,
    ],
  };
  /** Every way `code` breaks the rule, or [] when it holds. Comments are blanked IN PLACE (block and line,
   *  outside string literals), not dropped by the line: `/* early *\/ deregisterContainerReap?.();` is code. */
  const handleUseProblems = (raw: string, file: string): string[] => {
    const code = stripComments(raw);
    const problems: string[] = [];
    const reap = code.indexOf("await reapAgentOnTeardown(");
    const release = code.indexOf(RELEASE);
    if (reap < 0) problems.push("no agent stop");
    if (release < 0 || release < reap) problems.push("the release call is missing or before the agent stop");
    if (code.split(RELEASE).length !== 2) problems.push("not exactly one release call");
    let rest = code.replace(RELEASE, "");
    for (const re of allowed[file]) {
      const before = rest;
      rest = rest.replace(re, "");
      if (rest === before) problems.push(`missing declaration/assignment ${re}`);
    }
    for (const l of rest.split("\n"))
      if (/\bderegister(ContainerReap|HostLoopSidecarReap)\b/.test(l)) problems.push(`stray use: ${l.trim()}`);
    return problems;
  };
  for (const file of ["run/execute.ts", "run/chat.ts"]) {
    it(`${file} uses the de-register handles only in the release call, after the agent stop`, () => {
      expect(handleUseProblems(src(file), file)).toEqual([]);
    });
    for (const [name, dodge] of [
      ["a block comment leading the line", "/* early */ deregisterContainerReap?.();"],
      ["a line comment above it", "// early\n deregisterContainerReap?.();"],
      ["a guarded call", "if (deregisterContainerReap) deregisterContainerReap();"],
      ["an alias", "const d = deregisterHostLoopSidecarReap; d?.();"],
    ] as const)
      it(`${file}: an early de-register behind ${name} is caught`, () => {
        const s = src(file);
        const at = s.indexOf("await reapAgentOnTeardown(");
        const lineStart = s.lastIndexOf("\n", at) + 1;
        const mutated = s.slice(0, lineStart) + dodge + "\n" + s.slice(lineStart);
        expect(handleUseProblems(mutated, file).some((p) => p.startsWith("stray use"))).toBe(true);
      });
  }
  it("stripComments blanks comments in place and leaves strings alone", () => {
    expect(stripComments("a /* x */ b // y\nc \"/* not */\" '// no' `/*t*/`")).toBe("a         b     \nc \"/* not */\" '// no' `/*t*/`");
    expect(stripComments("a /* multi\nline */ b")).toBe("a         \n        b");
  });
});

/** Replace every comment (block or line, outside a string or template literal) with spaces, keeping newlines,
 *  so positions and line structure survive. A test-side helper: good enough for this repo's sources. */
function stripComments(code: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += code[++i] ?? "";
      } else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
    } else out += c;
  }
  return out;
}
