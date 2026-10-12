import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { containedRealPath } from "../boundary-paths.js";
import { BoundaryError } from "../errors.js";
import { gitCpFilter, gitModeEnabled } from "../run/skill-files.js";
import type { LaunchPlan, Mount } from "../session.js";
import { formatExecDuration, isExecInfraError } from "../hostloop/workspace-handler.js";
import { makeRemoteDevicesHandler, type DeviceExec } from "../hostloop/remote-devices-handler.js";
import type { McpHandler } from "../hostloop/workspace-handler.js";
import type { DeviceBridgeRecord, InfraErrorSource } from "../types.js";
import { makeInfraEmitters, startHostLoopSidecar } from "./hostloop.js";
import { HARDENING, proxyEnvVars } from "./argv.js";
import { removeContainer } from "../egress/sidecar.js";
import { DELETE_GRANT_TOOL } from "../decide/decider.js";
import { deviceTreeListing, probeIdentityReliable, treeDeletes, type TreeEntry } from "./device-tree.js";
export { treeDeletes, type TreeEntry } from "./device-tree.js";

/**
 * The device container behind `device_bridge: true`. Production runs device_bash in the Mac's Cowork VM as a
 * per-task user, with the connected folders at `$HOME/mnt/<folder-name>`. The harness runs it in a keep-alive
 * container on the run's egress network, whose home is a tree under the run's own work directory holding COPIES
 * of the folders. Nothing it binds is a folder's host path, so device_bash never touches the user's real files.
 * That also means a delete inside the container succeeds where production refuses it until the user allows
 * deletion; the harness reports it after the run, from the command text and from a before/after walk of the
 * device tree (deviceTreeDeletes).
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
    if (!existsSync(f.source.hostPath))
      throw new Error(`cowork-harness: mount source vanished after plan validation: ${f.source.hostPath} -> ${f.name}`);
    // The folder itself, not a link to it: a symlinked source copied as-is would leave a link to the user's real
    // folder in the device tree, and a read-only folder's nested bind would then mount the real folder.
    const src = realpathSync(f.source.hostPath);
    const filter = f.source.stageFilter ?? (gitModeEnabled() ? gitCpFilter(src) : null);
    cpSync(src, dest, { recursive: true, dereference: false, ...(filter ? { filter } : {}) });
  }
}

/** Docker resolves a bind source on the HOST. Before a start (a resumed turn above all, which reuses the tree a
 *  previous turn's commands could change), every bind source must be a real directory inside the device tree: `mnt`
 *  and each read-only folder's copy. A symlink there would bind its target, any host path. */
export function assertDeviceBindSources(deviceHost: string, folders: ReadonlyArray<DeviceFolder>): void {
  const root = realpathSync(deviceHost);
  const check = (rel: string): void => {
    const p = join(deviceHost, rel);
    let real: string | undefined;
    try {
      real = lstatSync(p).isDirectory() ? realpathSync(p) : undefined;
    } catch {
      real = undefined;
    }
    if (real !== join(root, rel))
      throw new BoundaryError(`cowork-harness: device_bridge: ${rel} is not a directory inside the device tree; refusing to bind it`);
  };
  check("mnt");
  for (const f of folders) if (f.mode === "r") check(join("mnt", f.name));
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
    // mnt as a mount point of its own: a command cannot rename or replace it, so a read-only folder's bind source
    // below stays the directory staging wrote.
    "-v",
    `${i.deviceHost}/mnt:${home}/mnt`,
    ...i.folders.filter((f) => f.mode === "r").flatMap((f) => ["-v", `${i.deviceHost}/mnt/${f.name}:${home}/mnt/${f.name}:ro`]),
    i.image,
    "sleep",
    "infinity",
  ];
}

/** device_bash's runner: a fresh `bash -c` in the device container, starting in $HOME. A Docker or container
 *  failure comes back as `infraError`, never as the command's exit. */
export function makeDeviceExec(runner: string, containerName: string, home: string, ready?: () => Promise<void>): DeviceExec {
  return async (command, timeoutMs) => {
    await ready?.();
    const startedAt = Date.now();
    // `timeout` runs INSIDE the container, so a command that outlives its limit is stopped there, as production stops
    // it in the VM; killing only the `docker exec` client would leave it running. Node's own timeout is a backstop.
    const argv = ["exec", "-w", home, containerName, "timeout", "-k", "2", String(timeoutMs / 1000), "bash", "-c", command];
    const timedOutNotice = (out: string) =>
      `${out}${out && !out.endsWith("\n") ? "\n" : ""}Command timed out after ${formatExecDuration(timeoutMs)}`;
    try {
      const { stdout, stderr } = await pexec(runner, argv, { encoding: "utf8", timeout: timeoutMs + 5000, maxBuffer: READ_BUFFER });
      return { exitCode: 0, output: (stdout ?? "") + (stderr ?? "") };
    } catch (e: any) {
      const out = (e?.stdout ?? "") + (e?.stderr ?? "");
      // More output than the read buffer: the handler cuts it at production's cap anyway. Node stops reading and the
      // `docker exec` client, but the command itself runs on in the container until its time limit, so its exit is
      // not known; it reads as a success whose output was cut.
      if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { exitCode: 0, output: out };
      // `timeout`'s own exit (124, or 137 once -k had to kill), once the limit has passed; or Node's backstop.
      const limitPassed = Date.now() - startedAt >= timeoutMs * 0.95;
      if ((limitPassed && (e?.code === 124 || e?.code === 137)) || (e?.killed === true && e?.code == null))
        return { exitCode: 124, output: timedOutNotice(out) };
      if (isExecInfraError(e)) return { infraError: [e.message, (e.stderr ?? "").trim()].filter(Boolean).join(": ") || String(e) };
      return { exitCode: typeof e?.code === "number" ? e.code : 1, output: out };
    }
  };
}

/** Comfortably past production's 262,144-character cap, which the handler applies. */
const READ_BUFFER = 8 * 1024 * 1024;

const DEVICE_TREE_FILE = "device-tree-pre-run.json";
/** How long teardown lets an already-accepted create land before its last removal. */
const TEARDOWN_SETTLE_MS = 750;

/** Resolves once the container runs, or after `limitMs` (an exec then reports what is wrong). Under load `docker
 *  run` can take seconds to create it, and a command sent before then fails as "No such container". */
async function waitRunning(runner: string, containerName: string, limitMs = 60_000): Promise<void> {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    try {
      const { stdout } = await pexec(runner, ["inspect", "-f", "{{.State.Running}}", containerName], { encoding: "utf8" });
      if (stdout.trim() === "true") return;
    } catch {
      /* not created yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Record the device tree as staged, before the run, for deviceTreeDeletes, with the probe's verdict on whether its
 *  filesystem keeps identities apart. Probed beside `mnt`, never in it, so the probe file is not listed. */
export function recordDeviceTree(outDir: string): void {
  const deviceHost = join(resolve(outDir), "work", "device");
  const listing: DeviceTreeFile = { identityReliable: probeIdentityReliable(deviceHost), entries: deviceTreeListing(deviceHost) };
  writeFileSync(join(outDir, DEVICE_TREE_FILE), JSON.stringify(listing));
}

/** The recorded listing. A listing written before the probe (a flat map) counts as unreliable. */
type DeviceTreeFile = { identityReliable: boolean; entries: Record<string, TreeEntry | string> };

/** The recorded listing's verdict on whether its filesystem keeps identities apart: false for a listing written
 *  before the probe, undefined without a listing. */
export function deviceTreeIdentityReliable(outDir: string): boolean | undefined {
  const recorded = readDeviceTree(outDir);
  return recorded?.identityReliable;
}

function readDeviceTree(outDir: string): DeviceTreeFile | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(outDir, DEVICE_TREE_FILE), "utf8"));
    return typeof raw.identityReliable === "boolean" && raw.entries ? raw : { identityReliable: false, entries: raw };
  } catch {
    return undefined;
  }
}

/** Entries the run removed from a folder copy, by any means (`rm`, `find -delete`, `rmdir`, a script): the staged
 *  listing compared with the tree after the run (`treeDeletes`). Production refuses each of these until the user allows
 *  deletion. Nothing without a recorded listing: no evidence, no claim. */
export function deviceTreeDeletes(
  outDir: string,
  /** The delete-denied (`rw`) folders (deniedDeviceFolders): a folder that allows deletes (`rwd`) is not counted. */
  denied: ReadonlyArray<{ name: string; mountPath: string }>,
): { mount: string; command: string }[] {
  const recorded = readDeviceTree(outDir);
  if (!recorded) return [];
  return treeDeletes(recorded.entries, deviceTreeListing(join(resolve(outDir), "work", "device")), denied, recorded.identityReliable);
}

/** The folders production refuses deletes in until the user allows them: mode `rw` (`rwd` is delete-approved,
 *  `r` is read-only and mounted so). Matches deleteDeniedRootsFromPlan's folder rule. */
export function deniedDeviceFolders(mounts: ReadonlyArray<Mount>): { name: string; mountPath: string }[] {
  return deviceFolders(mounts)
    .filter((f) => f.mode === "rw")
    .map((f) => ({ name: f.name, mountPath: f.source.mountPath }));
}

/** The model-visible names of the tools the bridge serves, advertised and pre-approved (production pre-approves
 *  them: a captured cloud task showed no permission card for a device_bash call). */
export const DEVICE_BRIDGE_TOOLS = ["mcp__remote-devices__device_bash", "mcp__remote-devices__get_device_info"];
/** The device tools the bridge advertises but does not pre-approve: production marks the delete card as needing a
 *  person, so the agent asks first and the scenario's answer decides it. */
export const DEVICE_BRIDGE_ASK_TOOLS = [DELETE_GRANT_TOOL];

/** Where a run keeps its delete grants: `<outDir>/device-ctl/grants`, one folder name per line, in grant order. A
 *  resumed turn reads the same file, so a grant lasts the session, as production's does. */
const grantsFile = (outDir: string): string => join(resolve(outDir), "device-ctl", "grants");

/** The folders granted so far in this run's session. */
export function readDeviceGrants(outDir: string): string[] {
  try {
    return readFileSync(grantsFile(outDir), "utf8")
      .split("\n")
      .filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** Add folders to the grants file. Written to a temp file and renamed inside the same directory, so a reader never
 *  sees half a file. */
export function writeDeviceGrant(outDir: string, folders: ReadonlyArray<string>): void {
  const all = readDeviceGrants(outDir);
  for (const f of folders) if (!all.includes(f)) all.push(f);
  const file = grantsFile(outDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, all.map((f) => `${f}\n`).join(""));
  renameSync(tmp, file);
}

/** Who answered a delete grant. `script` is a scenario answer, `decider` an
 *  LLM or external decider, `human` an interactive prompt, `bypassPermissions` no card at all (that mode shows none). */
// No on_unanswered value grants: `fail` ends the run and `first` declines, so neither ever answers an Allow.
export type DeleteGrantAnswer = "script" | "decider" | "human" | "bypassPermissions";
export interface DeleteGrant {
  folders: string[];
  answeredBy: DeleteGrantAnswer;
  turn: number;
}
const ANSWERED_BY: Partial<Record<string, DeleteGrantAnswer>> = {
  scripted: "script",
  llm: "decider",
  external: "decider",
  human: "human",
};

/** The grants a turn made, each with who answered it. The agent asks before each call, so the run's allow answers
 *  for the delete card and the handler's calls line up in order: the n-th allow permitted the n-th call. A call the
 *  handler refused (a bad path) grants nothing. Under bypassPermissions the agent asks nothing. */
export function deleteGrantsOf(
  decisions: ReadonlyArray<{ name?: string; decision?: string; by?: string }>,
  calls: ReadonlyArray<{ folders: string[]; ok: boolean }>,
  permissionMode: string,
  turn: number,
): DeleteGrant[] {
  if (permissionMode === "bypassPermissions")
    return calls.filter((c) => c.ok).map((c) => ({ folders: [...c.folders], answeredBy: "bypassPermissions", turn }));
  const allows = decisions.filter((d) => d.name === DELETE_GRANT_TOOL && d.decision === "allow");
  const out: DeleteGrant[] = [];
  calls.forEach((c, i) => {
    const by = allows[i]?.by;
    const answeredBy = by === undefined ? undefined : ANSWERED_BY[by];
    if (c.ok && answeredBy) out.push({ folders: [...c.folders], answeredBy, turn });
  });
  return out;
}

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
  /** Pre-approved device tools. */
  tools: string[];
  /** Device tools advertised for the agent to ask about (the delete card). */
  askTools: string[];
  /** Every delete-card call this turn, accepted or refused, in order. */
  grantCalls: () => ReadonlyArray<{ folders: string[]; ok: boolean }>;
  /** The folder copies, for the input host-path corpus: they are the user's input, as the agent's staged mounts are. */
  inputRoots: string[];
  infraErrors: { source: InfraErrorSource; message: string }[];
  markTearingDown: () => void;
  deregister: () => void;
  reapNow: () => boolean;
  /** The run's teardown: mark, remove, stop the `docker run` client, wait for it to exit, then remove again after a
   *  short settle (a create the daemon already accepted can land after the client is gone). True when the container
   *  is gone; only then is the signal-time reap released. */
  teardown: () => Promise<boolean>;
  /** Whether the `docker run` client has been stopped (for tests). */
  clientExited: () => boolean;
} {
  const deviceHost = join(resolve(p.outDir), "work", "device");
  const folders = deviceFolders(p.mounts);
  if (!p.resume) stageDeviceFolders(folders, deviceHost);
  else if (!existsSync(join(deviceHost, "mnt"))) mkdirSync(join(deviceHost, "mnt"), { recursive: true });
  // Before anything reads the tree: a refused start must not have walked a link's target.
  assertDeviceBindSources(deviceHost, folders);
  // Every turn compares against the tree as it found it: a resumed turn must not report the first turn's deletes.
  recordDeviceTree(p.outDir);
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
  // A container left under this name (a teardown that ran before a slow create finished) would make the start fail.
  removeContainer(p.runner, containerName);
  const started = startHostLoopSidecar({
    runner: p.runner,
    argv,
    containerName,
    logInfra: logSidecarInfra,
    label: "device_bridge container",
  });
  let running: Promise<void> | undefined;
  const grantCalls: Array<{ folders: string[]; ok: boolean }> = [];
  const handle = makeRemoteDevicesHandler({
    folders: folders.map((f) => ({ name: f.name, mode: f.mode })),
    onGrant: (granted) => writeDeviceGrant(p.outDir, granted),
    onGrantCall: (c) => void grantCalls.push(c),
    appVersion: p.appVersion,
    exec: makeDeviceExec(p.runner, containerName, deviceHome(p.sessionId), () => (running ??= waitRunning(p.runner, containerName))),
    onInfraError: logExecInfra,
  });
  return {
    containerName,
    bundle: { servers: ["remote-devices"], handle },
    tools: DEVICE_BRIDGE_TOOLS,
    askTools: DEVICE_BRIDGE_ASK_TOOLS,
    grantCalls: () => grantCalls,
    inputRoots: folders.map((f) => join(deviceHost, "mnt", f.name)),
    infraErrors,
    markTearingDown: started.markTearingDown,
    deregister: started.deregister,
    reapNow: started.reapNow,
    teardown: async () => {
      started.markTearingDown();
      started.reapNow();
      const child = started.child;
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((done) => {
          const t = setTimeout(done, 5_000);
          child.once("exit", () => {
            clearTimeout(t);
            done();
          });
        });
      await new Promise((r) => setTimeout(r, TEARDOWN_SETTLE_MS));
      const gone = removeContainer(p.runner, containerName);
      if (gone) started.deregister();
      return gone;
    },
    clientExited: () => started.child.killed || started.child.exitCode !== null || started.child.signalCode !== null,
  };
}

/** The record a device_bridge run carries (`RunResult.deviceBridge`): what it served and how, and every known
 *  divergence from production. Derived from the launch plan's folders by name and mode, never their paths. */
/** The maintainer control: COWORK_HARNESS_DEVICE_BRIDGE_NOTE=off leaves the bridge's prompt note out. */
export function deviceBridgeNoteMode(env: Record<string, string | undefined> = process.env): "included" | "omitted" {
  return env.COWORK_HARNESS_DEVICE_BRIDGE_NOTE === "off" ? "omitted" : "included";
}

export function deviceBridgeRecord(
  mounts: ReadonlyArray<Mount>,
  promptNote: "included" | "omitted" = "included",
  plan: Pick<LaunchPlan, "permissionMode" | "permissionModeSource" | "egressAllow"> = {
    permissionMode: "acceptEdits",
    permissionModeSource: "bridge-default",
    egressAllow: [],
  },
  /** This turn's delete grants (`deleteGrantsOf`). */
  grants: ReadonlyArray<DeleteGrant> = [],
  /** The probe's verdict on the device tree's filesystem (`deviceTreeIdentityReliable`); undefined without a listing. */
  identityReliable?: boolean,
): DeviceBridgeRecord {
  // `egress.unrestricted` resolves to `*`, which the run's proxy passes through: production's pass-through branch.
  const unrestricted = plan.egressAllow.includes("*");
  // A bridge plan resolves its mode from the session or from the bridge default; anything else is a wiring bug.
  const source = plan.permissionModeSource;
  if (source !== "session" && source !== "bridge-default")
    throw new Error(`deviceBridgeRecord: permissionModeSource ${String(source)} is not a device_bridge plan's`);
  return {
    served: ["device_bash", "get_device_info", "device_request_delete_permission"],
    alwaysLoad: ["device_bash", "device_request_delete_permission"],
    measuredOn: "2.31226.1",
    promptNoteBasis: "model-report",
    promptNote,
    permissionMode: plan.permissionMode,
    permissionModeSource: source,
    egress: unrestricted ? "unrestricted" : "allowlist",
    // Nothing refuses a delete in the device copy yet: a delete is reported after the run, as `delete-not-refused`
    // says. `enforced` is reserved for the release that refuses it in place.
    deleteRefusal: "reported",
    grants: grants.map((g) => ({ ...g, folders: [...g.folders] })),
    folders: deviceFolders(mounts).map((f) => ({ name: f.name, mode: f.mode })),
    divergences: [
      "delete-not-refused",
      ...(unrestricted ? [] : ["egress-allowlist"]),
      "description-paraphrase",
      "device-paths-tilde",
      "device-tools-unserved",
      "shell-user",
      "device-network-shared",
      // A declined card reaches the agent as the harness's own deny text; production's has not been captured.
      "decline-text",
      // A grant no card asked for: bypassPermissions shows none, as production's skip-all-approvals mode may.
      ...(grants.some((g) => g.answeredBy === "bypassPermissions") ? ["grant-without-prompt"] : []),
      // The tree's filesystem can give a new file a deleted one's identity, so a rename counts only with unchanged
      // bytes: a rename followed by an edit is reported as a delete.
      ...(identityReliable === false ? ["rename-reads-as-delete"] : []),
    ],
  };
}

/** A segment that may hold `*` / `?`, as a whole-segment regex. */
function segmentMatches(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return re.test(name);
}

/** Under `device_bridge` the folders live in the device container and grading reads the agent's tree, which holds
 *  none of them: `file_exists` would fail on a file device_bash wrote and pass on one the agent made in its own
 *  container, and `input_unmodified` would cover nothing. Refused before the run; the message says what to use. */
export function deviceBridgeFolderAssertRefusal(
  scenario: { device_bridge?: true; assert?: ReadonlyArray<Record<string, unknown>> },
  folderNames: ReadonlyArray<string>,
): string | undefined {
  if (scenario.device_bridge !== true || folderNames.length === 0) return undefined;
  const hits: string[] = [];
  for (const a of scenario.assert ?? []) {
    const fe = a.file_exists;
    const paths: Array<[string, string]> = [];
    if (typeof fe === "string") paths.push(["file_exists", fe]);
    else if (fe && typeof fe === "object" && typeof (fe as { path?: unknown }).path === "string")
      paths.push(["file_exists", (fe as { path: string }).path]);
    const iu = a.input_unmodified;
    for (const p of typeof iu === "string" ? [iu] : Array.isArray(iu) ? iu : [])
      if (typeof p === "string") paths.push(["input_unmodified", p]);
    for (const [key, p] of paths) {
      const first = p.replace(/^\.\//, "").split("/")[0];
      const folder = folderNames.find((n) => segmentMatches(first, n));
      if (folder !== undefined) hits.push(`${key}: ${p} (connected folder "${folder}")`);
    }
  }
  if (!hits.length) return undefined;
  return (
    `device_bridge: the connected folders live in the device container, and file assertions read the agent's own ` +
    `container, which holds none of them, so these would grade the wrong tree: ${hits.join("; ")}. Assert on the ` +
    `device_bash call instead (tool_called: {tool: mcp__remote-devices__device_bash, result: {matches: …}}), or on ` +
    `the transcript.`
  );
}
