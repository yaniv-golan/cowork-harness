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
    throw e;
  }

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
      d(runner, ["rm", "-f", proxyName], true);
      d(runner, ["network", "rm", intNet], true);
      d(runner, ["network", "rm", outNet], true);
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
    process.stderr.write(`::warning:: [egress] proxy log line is not valid JSON — dropping: ${line.slice(0, 200)}\n`);
    return null;
  }
  // Valid JSON that isn't a non-null object (e.g. `null`, a number, an array) would throw on the
  // field reads below, OUTSIDE the parse catch — crashing collect() at teardown. Drop it loudly.
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    process.stderr.write(`::warning:: [egress] proxy log line is not a JSON object — dropping: ${line.slice(0, 200)}\n`);
    return null;
  }
  const host = String(o.host);
  if (o.decision !== "allow" && o.decision !== "deny") {
    process.stderr.write(`::warning:: [egress] unknown decision "${o.decision}" for host ${host} — dropping (not coercing to allow)\n`);
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
    process.stderr.write(`::warning:: [egress] dist/egress missing — running \`npm run build\` before the proxy image build\n`);
    const built = spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
    if (built.status !== 0) throw new Error("failed to build dist/ for the egress proxy image (npm run build)");
  }
  const build = spawnSync(runner, ["build", "-t", PROXY_IMAGE, "-f", join(repoRoot, "docker", "Dockerfile.proxy"), repoRoot], {
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error(`failed to build ${PROXY_IMAGE}`);
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
