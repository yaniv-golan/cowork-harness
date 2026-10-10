import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { containedRealPath } from "../boundary-paths.js";
import { BoundaryError } from "../errors.js";
import { gitCpFilter, gitModeEnabled } from "../run/skill-files.js";
import type { LaunchPlan, Mount } from "../session.js";
import { isExecInfraError } from "../hostloop/workspace-handler.js";
import { makeRemoteDevicesHandler, type DeviceExec } from "../hostloop/remote-devices-handler.js";
import type { McpHandler } from "../hostloop/workspace-handler.js";
import type { DeviceBridgeRecord, InfraErrorSource } from "../types.js";
import { makeInfraEmitters, startHostLoopSidecar } from "./hostloop.js";
import { HARDENING, proxyEnvVars } from "./argv.js";

/**
 * The device container behind `device_bridge: true`. Production runs device_bash in the Mac's Cowork VM as a
 * per-task user, with the connected folders at `$HOME/mnt/<folder-name>`. The harness runs it in a keep-alive
 * container on the run's egress network, whose home is a tree under the run's own work directory holding COPIES
 * of the folders. Nothing it binds is a folder's host path, so device_bash never touches the user's real files.
 * That also means a delete inside the container succeeds where production refuses it until the user allows
 * deletion; the harness detects deletes after the run, as on every tier.
 */

const pexec = promisify(execFile);

/** The plan the AGENT's container is built from: under `device_bridge` the connected folders belong to the
 *  device container, and the agent's own container gets none of them, as a cloud task's container has none. */
export function agentPlanFor(scenario: { device_bridge?: true }, plan: LaunchPlan): LaunchPlan {
  return scenario.device_bridge === true ? { ...plan, mounts: plan.mounts.filter((mt) => mt.kind !== "folder") } : plan;
}

/** One connected folder as the device container holds it. */
export interface DeviceFolder {
  /** The folder's name under `$HOME/mnt/`: its mount's last segment. */
  name: string;
  mode: Mount["mode"];
  /** Where the copy comes from. Read by staging only; never bound into the container. */
  source: Mount;
}

/** Production's per-task VM user: `rcw-` + the session id, lowercased, without a `cse_`/`session_` prefix,
 *  alphanumerics only (`shared` when nothing is left), cut at 32 characters. Also the home's last segment. */
export function deviceVmUser(sessionId: string): string {
  const id = sessionId
    .toLowerCase()
    .replace(/^(cse|session)_/, "")
    .replace(/[^a-z0-9]/g, "");
  return `rcw-${id || "shared"}`.slice(0, 32);
}

export function deviceFolders(mounts: ReadonlyArray<Mount>): DeviceFolder[] {
  return mounts.filter((m) => m.kind === "folder").map((m) => ({ name: basename(m.mountPath), mode: m.mode, source: m }));
}

/** Copy each folder into `<deviceHost>/mnt/<name>`, with the same symlink and git-set rules as the agent's own
 *  staging (stage.ts). */
export function stageDeviceFolders(folders: ReadonlyArray<DeviceFolder>, deviceHost: string): void {
  const mntHost = join(deviceHost, "mnt");
  mkdirSync(mntHost, { recursive: true });
  const mntHostReal = realpathSync(mntHost);
  for (const f of folders) {
    const dest = join(mntHost, f.name);
    if (!containedRealPath(mntHostReal, dirname(dest)))
      throw new BoundaryError(`cowork-harness: device folder "${f.name}" resolves outside the device tree (symlink escape)`);
    const src = f.source.hostPath;
    if (!existsSync(src)) throw new Error(`cowork-harness: mount source vanished after plan validation: ${src} -> ${f.name}`);
    const filter = f.source.stageFilter ?? (gitModeEnabled() ? gitCpFilter(src) : null);
    cpSync(src, dest, { recursive: true, dereference: false, ...(filter ? { filter } : {}) });
  }
}

/** The device user's home, as the container sees it. */
export function deviceHome(sessionId: string): string {
  return `/sessions/${deviceVmUser(sessionId)}`;
}

/** Production's git settings for a shell over a writable connected folder. */
const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.checkStat",
  GIT_CONFIG_VALUE_0: "minimal",
};

export function deviceContainerArgv(i: {
  name: string;
  image: string;
  network: string;
  egressProxy: string;
  /** The device tree under the run's work directory; staged by stageDeviceFolders. */
  deviceHost: string;
  sessionId: string;
  folders: ReadonlyArray<DeviceFolder>;
}): string[] {
  const home = deviceHome(i.sessionId);
  const env: Record<string, string> = {
    ...proxyEnvVars(i.egressProxy),
    HOME: home,
    ...(i.folders.some((f) => f.mode !== "r") ? GIT_ENV : {}),
  };
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    i.name,
    "--platform",
    "linux/arm64",
    "--network",
    i.network,
    ...HARDENING,
    "-w",
    home,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-v",
    `${i.deviceHost}:${home}`,
    ...i.folders.filter((f) => f.mode === "r").flatMap((f) => ["-v", `${i.deviceHost}/mnt/${f.name}:${home}/mnt/${f.name}:ro`]),
    i.image,
    "sleep",
    "infinity",
  ];
}

/** device_bash's runner: a fresh `bash -c` in the device container, starting in $HOME. A Docker or container
 *  failure comes back as `infraError`, never as the command's exit. */
export function makeDeviceExec(runner: string, containerName: string, home: string): DeviceExec {
  return async (command, timeoutMs) => {
    try {
      const { stdout, stderr } = await pexec(runner, ["exec", "-w", home, containerName, "bash", "-c", command], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { exitCode: 0, output: (stdout ?? "") + (stderr ?? "") };
    } catch (e: any) {
      // Node reports its own timeout kill as `killed` with no exit code; every other kill carries a string code.
      const timedOut = e?.killed === true && e?.code == null;
      if (timedOut) return { exitCode: 124, output: `${e.stdout ?? ""}${e.stderr ?? ""}Command timed out after ${timeoutMs / 1000}s` };
      if (isExecInfraError(e)) return { infraError: [e.message, (e.stderr ?? "").trim()].filter(Boolean).join(": ") || String(e) };
      return { exitCode: typeof e?.code === "number" ? e.code : 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  };
}

/** The model-visible names of the tools the bridge serves, advertised and pre-approved (production pre-approves
 *  them: run S showed no permission card for a device_bash call). */
export const DEVICE_BRIDGE_TOOLS = ["mcp__remote-devices__device_bash", "mcp__remote-devices__get_device_info"];

/**
 * Stage the device tree, start the device container, and build the `remote-devices` bundle that serves against
 * it. The container is registered for signal-time removal the moment it starts (the same registry phase as the
 * host-loop sidecar, before the egress network is removed). The caller tears it down after the agent:
 * `markTearingDown()` first, so the forced exit does not read as a crash, then removal.
 */
export function startDeviceBridge(p: {
  runner: string;
  image: string;
  network: string;
  egressProxy: string;
  outDir: string;
  sessionId: string;
  runToken?: string;
  mounts: ReadonlyArray<Mount>;
  appVersion: string;
  /** A resumed turn reuses the device tree as the first turn left it, as the agent's own tree is reused. */
  resume: boolean;
}): {
  containerName: string;
  bundle: { servers: string[]; handle: McpHandler };
  tools: string[];
  infraErrors: { source: InfraErrorSource; message: string }[];
  markTearingDown: () => void;
  deregister: () => void;
  reapNow: () => boolean;
} {
  const deviceHost = join(resolve(p.outDir), "work", "device");
  const folders = deviceFolders(p.mounts);
  if (!p.resume) stageDeviceFolders(folders, deviceHost);
  else mkdirSync(join(deviceHost, "mnt"), { recursive: true });
  const containerName = `cowork-dev-${p.runToken ?? p.sessionId}`;
  const infraErrors: { source: InfraErrorSource; message: string }[] = [];
  const { logSidecarInfra, logExecInfra } = makeInfraEmitters(p.outDir, infraErrors, { sidecar: "device-container", exec: "device-exec" });
  const argv = deviceContainerArgv({
    name: containerName,
    image: p.image,
    network: p.network,
    egressProxy: p.egressProxy,
    deviceHost,
    sessionId: p.sessionId,
    folders,
  });
  const started = startHostLoopSidecar({ runner: p.runner, argv, containerName, logInfra: logSidecarInfra });
  const handle = makeRemoteDevicesHandler({
    folderNames: folders.map((f) => f.name),
    appVersion: p.appVersion,
    exec: makeDeviceExec(p.runner, containerName, deviceHome(p.sessionId)),
    onInfraError: logExecInfra,
  });
  return {
    containerName,
    bundle: { servers: ["remote-devices"], handle },
    tools: DEVICE_BRIDGE_TOOLS,
    infraErrors,
    markTearingDown: started.markTearingDown,
    deregister: started.deregister,
    reapNow: started.reapNow,
  };
}

/** The record a device_bridge run carries (`RunResult.deviceBridge`): what it served and how, and every known
 *  divergence from production. Derived from the launch plan's folders by name and mode, never their paths. */
export function deviceBridgeRecord(mounts: ReadonlyArray<Mount>): DeviceBridgeRecord {
  return {
    served: ["device_bash", "get_device_info"],
    alwaysLoad: ["device_bash"],
    measuredOn: "2.31226.1",
    egress: "allowlist",
    folders: deviceFolders(mounts).map((f) => ({ name: f.name, mode: f.mode })),
    divergences: ["delete-not-refused", "egress-allowlist", "description-paraphrase", "device-paths-tilde", "device-tools-unserved"],
  };
}
