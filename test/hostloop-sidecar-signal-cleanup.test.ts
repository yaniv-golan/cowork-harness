import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import * as hostloop from "../src/runtime/hostloop.js";

// The hostloop tier runs a workspace sidecar: a `cowork-hl-*` container started by an attached `docker run`
// client, on the egress sidecar's `cowork-int-*` network. A signal must reap all three. The network can only go
// once the container is gone (`network rm` fails while a container is attached), so the sidecar's removal runs
// in the "container" phase, before the egress sidecar's "network" phase. The client is killed too: a SIGINT to
// the process group reaches it, it forwards the signal to a keep-alive PID 1 that ignores it, and it stays.
//
// Each signal case runs a small script against the REAL source (via tsx) in a child node process, the way
// termination-handler.test.ts does, with COWORK_CONTAINER_RUNTIME pointed at a fake runtime that records its
// argv (the way egress-proxy-image-env.test.ts does). An attached `run` (the sidecar client) sleeps, so only an
// explicit kill ends it.

const POSIX = process.platform !== "win32";
const SIDECAR = JSON.stringify(resolve("src/egress/sidecar.ts"));
const HOSTLOOP = JSON.stringify(resolve("src/runtime/hostloop.ts"));

const FAKE_RUNTIME = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_RUNTIME_LOG"
if [ "$1" = "inspect" ] && [ "$3" = "{{.State.Running}}" ]; then echo true; fi
if [ "$1" = "run" ] && [ "$2" != "-d" ]; then echo $$ > "$FAKE_RUNTIME_CLIENT_PID"; exec sleep 600; fi
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

async function signalRun(
  sig: NodeJS.Signals,
): Promise<{ status: number | null; stderr: string; argv: string[]; clientPid: number; clientSurvived: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "hl-sidecar-signal-"));
  const runtime = join(dir, "fake-runtime");
  writeFileSync(runtime, FAKE_RUNTIME);
  chmodSync(runtime, 0o755);
  const log = join(dir, "argv.log");
  const pidFile = join(dir, "client.pid");
  const script = join(dir, "harness.mts");
  writeFileSync(
    script,
    `
      import { startEgressSidecar } from ${SIDECAR};
      import { startHostLoopSidecar } from ${HOSTLOOP};
      import { existsSync } from "node:fs";
      const runner = process.env.COWORK_CONTAINER_RUNTIME;
      const eg = startEgressSidecar([], ${JSON.stringify(join(dir, "out"))}, "t1");
      startHostLoopSidecar({
        runner,
        argv: ["run", "--rm", "-i", "--name", "cowork-hl-t1", "--network", eg.network, "img", "sleep", "infinity"],
        containerName: "cowork-hl-t1",
        logInfra: () => {},
      });
      const wait = setInterval(() => {
        if (existsSync(${JSON.stringify(pidFile)})) {
          clearInterval(wait);
          process.kill(process.pid, ${JSON.stringify(sig)});
        }
      }, 20);
      setTimeout(() => {}, 30_000);
    `,
  );
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.COWORK_CONTAINER_RUNTIME = runtime;
    env.FAKE_RUNTIME_LOG = log;
    env.FAKE_RUNTIME_CLIENT_PID = pidFile;
    const proc = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "pipe"], env });
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
    return { status, stderr, argv, clientPid, clientSurvived };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(POSIX)("hostloop workspace sidecar: a signal reaps the container, its client and the network", () => {
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    it(`${sig}: rm -f the sidecar container, then rm its network; the docker run client is killed`, async () => {
      const r = await signalRun(sig);
      expect(r.status, r.stderr).toBe(code);
      const rmContainer = r.argv.indexOf("rm -f cowork-hl-t1");
      const rmNetwork = r.argv.indexOf("network rm cowork-int-t1");
      expect(rmContainer, r.argv.join("\n")).toBeGreaterThan(-1);
      expect(rmNetwork, r.argv.join("\n")).toBeGreaterThan(rmContainer);
      expect(Number.isFinite(r.clientPid), "precondition: the fake client started").toBe(true);
      expect(r.clientSurvived, "the docker run client survived the signal").toBe(false);
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

// The normal path must keep its signal-time thunks registered until it has removed the container itself. It
// awaits the agent's stop sequence first (seconds at hostloop); a signal that lands there drains the registry
// and exits before the normal path reaches its own `rm -f`, so a thunk dropped earlier is a thunk that never runs.
describe("wiring", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  it("spawnHostLoop starts its sidecar through startHostLoopSidecar (which registers the reap)", () => {
    const s = src("runtime/hostloop.ts");
    expect(s).toMatch(/startHostLoopSidecar\(\{\s*runner,\s*argv: sidecarArgs/);
    expect(s).not.toMatch(/spawn\(runner, sidecarArgs/);
  });
  for (const file of ["run/execute.ts", "run/chat.ts"])
    it(`${file} drops the signal-time thunks only after its own rm -f of the container`, () => {
      const s = src(file);
      const rm = s.indexOf('spawnSync(runner, ["rm", "-f", containerName]');
      const reap = s.indexOf("await reapAgentOnTeardown(");
      const dereg = s.indexOf("deregisterContainerReap?.();");
      const deregHl = s.indexOf("deregisterHostLoopSidecarReap?.();");
      expect(rm).toBeGreaterThan(-1);
      expect(reap).toBeGreaterThan(-1);
      expect(rm).toBeGreaterThan(reap);
      expect(dereg).toBeGreaterThan(rm);
      expect(deregHl).toBeGreaterThan(rm);
    });
});
