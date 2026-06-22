import { warn } from "../io.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-run egress sidecar — the default-deny boundary that the container actually
 * routes through, so L1 egress decisions are REAL (not an in-process host proxy the
 * container can't reach). Topology mirrors Cowork's gVisor allowlist:
 *
 *   cowork-int-<id>  (--internal)  agent + proxy; NO route off-box
 *   cowork-out-<id>  (normal)      proxy only; its path to allowlisted hosts
 *
 * The agent reaches the proxy by name on the internal net; the proxy is the sole
 * egress. Decisions are written to a bind-mounted log the CLI reads back.
 */
export interface EgressSidecar {
  proxyUrl: string; // e.g. http://cowork-proxy-<id>:8080
  network: string; // internal network the agent must join
  collect(): Array<{ host: string; decision: "allow" | "deny" }>;
  teardown(): void;
}

const PROXY_IMAGE = process.env.COWORK_PROXY_IMAGE ?? "cowork-egress-proxy:1";

// 2a: a process-level cleanup registry so a Ctrl-C (SIGINT/SIGTERM) mid-run reaps in-flight egress resources
// instead of orphaning them (the per-run `finally` paths don't run when the process is killed by a signal).
// Entries are PHASED: "container" thunks run BEFORE "network" thunks — `network rm` fails while a container is
// still attached (the error is swallowed with no retry), so a network-first handler would leak the network.
type CleanupPhase = "container" | "network";
interface CleanupEntry {
  phase: CleanupPhase;
  run: () => void;
}
const cleanupRegistry = new Set<CleanupEntry>();
let signalHandlerInstalled = false;

/** Register a signal-time cleanup thunk; returns a de-register fn to call from the normal `finally` path
 *  (so a clean exit doesn't double-run it — and `teardown()`/`rm -f` are idempotent regardless). */
export function registerCleanup(entry: CleanupEntry): () => void {
  cleanupRegistry.add(entry);
  installSignalHandlerOnce();
  return () => cleanupRegistry.delete(entry);
}

/** Drain all registered cleanups in phase order — "container" thunks BEFORE "network" thunks (load-bearing:
 *  `network rm` fails while a container is still attached). Returns the number of thunks run. Exported for
 *  tests; the signal handler calls this then exits. */
export function drainCleanups(): number {
  const entries = [...cleanupRegistry];
  for (const e of entries) if (e.phase === "container") tryRun(e.run);
  for (const e of entries) if (e.phase === "network") tryRun(e.run);
  return entries.length;
}

function installSignalHandlerOnce() {
  if (signalHandlerInstalled) return;
  signalHandlerInstalled = true;
  const handler = (sig: NodeJS.Signals) => {
    const n = cleanupRegistry.size;
    if (n) warn(`::warning:: [cleanup] ${sig} — reaping ${n} in-flight egress resource(s) before exit\n`);
    drainCleanups();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

function tryRun(fn: () => void) {
  try {
    fn();
  } catch {
    /* best-effort during signal teardown */
  }
}

export function startEgressSidecar(allow: string[], outDir: string, runId: string): EgressSidecar {
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";
  const intNet = `cowork-int-${runId}`;
  const outNet = `cowork-out-${runId}`;
  const proxyName = `cowork-proxy-${runId}`;
  const logDir = join(resolve(outDir), "proxy");
  mkdirSync(logDir, { recursive: true });
  const logFileHost = join(logDir, "egress.log");

  ensureProxyImage(runner);

  // #37: create the two networks and the proxy container in sequence, tracking each created
  // resource so a mid-sequence failure (image start, network connect) rolls back the rest
  // instead of orphaning networks/containers. Undo runs in reverse (container before networks).
  const rollback: Array<() => void> = [];
  try {
    d(runner, ["network", "create", "--internal", intNet]);
    rollback.push(() => d(runner, ["network", "rm", intNet], true));
    d(runner, ["network", "create", outNet]);
    rollback.push(() => d(runner, ["network", "rm", outNet], true));

    // Proxy on the internal net first (so the agent can resolve it), then also wire
    // it to the external net so it alone can reach allowlisted hosts.
    d(runner, [
      "run",
      "-d",
      "--name",
      proxyName,
      "--network",
      intNet,
      "-e",
      `COWORK_ALLOW=${allow.join(",")}`,
      "-e",
      "COWORK_PROXY_LOG=/log/egress.log",
      "-v",
      `${logDir}:/log`,
      PROXY_IMAGE,
    ]);
    rollback.push(() => d(runner, ["rm", "-f", proxyName], true));
    d(runner, ["network", "connect", outNet, proxyName]);
    // `run -d` returns once the container is CREATED, not once the proxy is accepting. A proxy that
    // crashes on boot would otherwise surface only as the agent's first egress hanging/refused. Confirm
    // the container is actually running before handing out the proxy URL (the catch below rolls back).
    waitProxyRunning(runner, proxyName);
  } catch (e) {
    for (const undo of rollback.reverse()) undo();
    // 6e: re-frame Docker's opaque address-pool-exhaustion error (which surfaces at create, connect, OR
    // `run --network`) into an actionable diagnosis — it reads as a "leak" but is concurrency pressure;
    // each run reaps its own networks on exit. Rollback above already ran, so this only changes the message.
    throw reframeEgressError(e);
  }

  const reap = () => {
    d(runner, ["rm", "-f", proxyName], true); // proxy container before its networks (attached)
    d(runner, ["network", "rm", intNet], true);
    d(runner, ["network", "rm", outNet], true);
  };
  // 2a: cover Ctrl-C — reap this run's proxy+networks on a signal too. Registered as the "network" phase so a
  // caller-registered agent-container reap ("container" phase) runs first (network rm needs the container gone).
  const deregister = registerCleanup({ phase: "network", run: reap });

  return {
    proxyUrl: `http://${proxyName}:8080`,
    network: intNet,
    collect() {
      if (!existsSync(logFileHost)) return [];
      return readFileSync(logFileHost, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(parseEgressLine)
        .filter((x): x is { host: string; decision: "allow" | "deny" } => x !== null);
    },
    teardown() {
      deregister();
      reap();
    },
  };
}

/**
 * Parse one egress log line into a typed decision, or `null` if it must be dropped.
 *
 * #43: previously this (a) silently swallowed an unparseable line and (b) coerced any
 * unknown/missing `decision` to "allow" via `o.decision === "deny" ? "deny" : "allow"` —
 * a silent false-green that could mask a real deny. Now both failure modes emit a
 * `::warning::` and DROP the line; we never invent an "allow" from corrupt input.
 */
export function parseEgressLine(line: string): { host: string; decision: "allow" | "deny" } | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    warn(`::warning:: [egress] proxy log line is not valid JSON — dropping: ${line.slice(0, 200)}\n`);
    return null;
  }
  // Valid JSON that isn't a non-null object (e.g. `null`, a number, an array) would throw on the
  // field reads below, OUTSIDE the parse catch — crashing collect() at teardown. Drop it loudly.
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    warn(`::warning:: [egress] proxy log line is not a JSON object — dropping: ${line.slice(0, 200)}\n`);
    return null;
  }
  if (typeof o.host !== "string" || !o.host) {
    warn(`::warning:: [egress] proxy log line missing or non-string host — dropping: ${line.slice(0, 200)}\n`);
    return null;
  }
  const host = o.host;
  if (o.decision !== "allow" && o.decision !== "deny") {
    warn(`::warning:: [egress] unknown decision "${o.decision}" for host ${host} — dropping (not coercing to allow)\n`);
    return null;
  }
  return { host, decision: o.decision };
}

function ensureProxyImage(runner: string) {
  const have = spawnSync(runner, ["image", "inspect", PROXY_IMAGE], { stdio: "ignore" });
  if (have.status === 0) return;
  // Build from the repo (Dockerfile.proxy). Context is the repo root. #39: use fileURLToPath, not
  // `.pathname`, so an install path with spaces / URL-escaped chars yields a valid build context.
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  // #38: Dockerfile.proxy COPYs the SHIPPED dist/egress; running from source (tsx) before
  // `npm run build` leaves it absent, so the image build would fail confusingly. Build dist/ first.
  if (!existsSync(join(repoRoot, "dist", "egress", "proxy.js"))) {
    warn(`::warning:: [egress] dist/egress missing — running \`npm run build\` before the proxy image build\n`);
    const built = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (built.status !== 0) throw new Error("failed to build dist/ for the egress proxy image (npm run build)");
  }
  const build = spawnSync(runner, ["build", "-t", PROXY_IMAGE, "-f", join(repoRoot, "docker", "Dockerfile.proxy"), repoRoot], {
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error(`failed to build ${PROXY_IMAGE}`);
}

/** 6e: turn Docker's `all predefined address pools have been fully subnetted` (and its connect/run
 *  variants) into a self-answering message — it is NOT a leak (each run reaps its own networks on exit),
 *  it is concurrency pressure against the daemon's address pool. Any non-matching error passes through. */
export function reframeEgressError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  // Match Docker's two canonical pool-exhaustion messages without over-matching unrelated docker errors:
  //   "all predefined address pools have been fully subnetted"
  //   "could not find an available, non-overlapping IPv4 address pool among the defaults to assign ..."
  const poolExhausted = /address pool/i.test(msg) && /predefined|available|non-overlapping|subnet|defaults|exhaust/i.test(msg);
  if (poolExhausted) {
    return new Error(
      "egress network create failed — Docker address pool exhausted. This is concurrency pressure " +
        "(live runs × 2 networks each), NOT a leak: each run reaps its own networks on exit. Orphans only " +
        "persist from SIGKILL'd runs → `docker network prune`. For higher parallelism, widen the daemon " +
        `\`default-address-pools\`. (original: ${msg.slice(0, 200)})`,
    );
  }
  return e;
}

function d(runner: string, args: string[], ignoreError = false) {
  const r = spawnSync(runner, args, { encoding: "utf8" });
  if (r.status !== 0 && !ignoreError) {
    throw new Error(`${runner} ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  }
}

/** Poll the proxy container's running state (bounded, ~3s). Returns on the first observed `true`;
 *  a container that fails to start or crashes on boot never reports running → throws so the caller rolls
 *  back instead of handing the agent a dead proxy. (A fuller in-container health probe needs the live lane.) */
function waitProxyRunning(runner: string, name: string) {
  for (let i = 0; i < 16; i++) {
    spawnSync("sh", ["-c", "sleep 0.2"]); // brief settle between samples
    const r = spawnSync(runner, ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
    if (r.status === 0 && (r.stdout ?? "").trim() === "true") return;
  }
  throw new Error(
    `[egress] proxy container ${name} is not running after start — it likely crashed on boot (see \`${runner} logs ${name}\`)`,
  );
}
