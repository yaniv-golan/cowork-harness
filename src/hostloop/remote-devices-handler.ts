import type { McpHandler, McpResult } from "./workspace-handler.js";

/**
 * The `remote-devices` sdk-MCP server, driver-side, served only under `device_bridge: true` (lane: remote,
 * fidelity: container). A cloud Cowork task reaches the user's computer through this server; the harness serves
 * two of its tools:
 *
 * - `device_bash`: production runs the command in the Mac's Cowork VM as a per-task user, with the connected
 *   folders at `$HOME/mnt/<folder-name>`. The harness runs it in a second container holding COPIES of the folders
 *   (the caller's `exec`), so a command never touches the user's real files.
 * - `get_device_info`: served and never graded. Production lists the folders by their paths on the Mac; the
 *   harness spells each as `~/<folder-name>`, a device path in production's own grammar ("~ is the user's home
 *   folder on this device") that carries no host path into the transcript.
 *
 * Measured on Desktop 2.31226.1: `device_bash` carries `anthropic/alwaysLoad` on its own definition;
 * `get_device_info`'s definition carries none, so the agent may defer it behind ToolSearch, as production does.
 * The rest of production's device tools (device_list_dir, stage/commit, the folder and delete requests) are not
 * served, so the description below leaves them out rather than send the model to a tool that is not there.
 */

/** Production's per-call limit when the bridge advertises no longer one: default and maximum are both 45 s. */
export const DEVICE_BASH_TIMEOUT_MS = 45_000;
/** Output beyond this many characters is cut, with production's notice appended. */
export const DEVICE_BASH_OUTPUT_CAP = 262_144;
/** The production description branch this paraphrase was written against: the timeout fixed at 45 s, and no
 *  folder-request tool (baseline 2.31226.1 `cloud.remoteDevicesDescriptions`, device_bash, branch eeb00304cc27). */
export const DEVICE_BASH_DESC_WRITTEN_AGAINST = "8f32de420a98ff55b7559e1858e78878439572d4414670642ae6b9a39dbf5a1e";

export const DEVICE_BASH_DESC =
  "Run a shell command in a Linux workspace on the user's machine, which holds the folders the user connected to " +
  "this task. This is NOT your own container, where the `Bash` tool runs.\n\n" +
  "Connected folders are mounted at `$HOME/mnt/<folder-name>`; `ls $HOME/mnt/` lists them. Nothing else on the " +
  "user's machine is reachable. Network goes only through a proxy that allows the account's allowlisted host " +
  "names; any other connection fails.\n\n" +
  "When a connected folder is involved, work here: read, search, edit in place and reorganize files with the " +
  "shell. Each call is capped at 45s.";

const COMMAND_DESC =
  "Shell command to execute (passed to bash -c). Each call is a fresh `bash -c` with no cwd/env carried between " +
  "calls, only files. Anchor paths at `$HOME` (e.g. `$HOME/mnt/<folder-name>`); the shell starts in $HOME. " +
  "Anything outside mnt/ is invisible to the user. Edit files in place (sed -i, awk or a short python " +
  "read-modify-write), never by re-typing a file's content from tool output.";

export const DEVICE_BASH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: COMMAND_DESC },
    timeout_ms: {
      type: "integer",
      exclusiveMinimum: 0,
      maximum: DEVICE_BASH_TIMEOUT_MS,
      description: `Timeout in milliseconds. Default ${DEVICE_BASH_TIMEOUT_MS}.`,
    },
  },
  required: ["command"],
};

const GET_DEVICE_INFO_DESC =
  "Returns this device's runtime details (platform, arch, app version, device name) and `connectedFolders`: the " +
  "folders the user attached to this session.";

/** What the device container reported for one command: its exit and combined output, or an infrastructure
 *  failure (the container or Docker itself), which must never read as the command's own exit. */
/** device_request_delete_permission's input, as production's schema states it: 1–8 connected folder roots, and an
 *  optional one-sentence reason shown with the prompt. */
export const DELETE_GRANT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 8,
      description:
        "Connected folder roots on this device (from get_device_info.connectedFolders) to enable file deletion in, granted together by one user approval. Deletion applies to each folder's whole subtree for the rest of this session. List only the folders the task needs.",
    },
    reason: {
      type: "string",
      maxLength: 500,
      description: "One short sentence shown to the user with the permission prompt, explaining why deletion is needed.",
    },
  },
  required: ["paths"],
} as const;

/** A paraphrase of production's description: when to ask, what a grant covers, and what to do after a decline. */
export const DELETE_GRANT_DESC =
  "Ask the user for permission to delete files in one or more of this session's connected folders on this device. " +
  "Call this when a delete (rm, rmdir, unlink) in device_bash fails with 'Operation not permitted', instead of telling " +
  "the user deletion is impossible. The user sees a permission prompt listing the folders, and only a person's answer " +
  "grants it. A grant enables deletion in each listed folder's whole subtree for the rest of this session, from your " +
  "next device_bash call. Pass the connected folder roots exactly as get_device_info.connectedFolders lists them, not " +
  "files or subfolders. Ask once, for the fewest folders the task needs, and pass `reason`. If the user declines, " +
  "don't ask again: move the files into a _to_delete/ subfolder of the same folder and tell the user, so they can " +
  "delete it themselves.";

export type DeviceExecResult = { exitCode: number; output: string } | { infraError: string };
export type DeviceExec = (command: string, timeoutMs: number) => Promise<DeviceExecResult>;

const text = (t: string, isError = false): McpResult => ({
  result: isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] },
});

export function makeRemoteDevicesHandler(opts: {
  /** The connected folders, by their mount names under `$HOME/mnt/` in the device container, and their modes. */
  folders: ReadonlyArray<{ name: string; mode: "r" | "rw" | "rwd" }>;
  /** The baseline's Desktop version, reported as get_device_info's appVersion. */
  appVersion: string;
  exec: DeviceExec;
  onInfraError?: (message: string) => void;
  /** A delete grant the handler accepted, by folder name. Called only for a valid request; the agent asks for the
   *  card first, so a call here means the card was answered Allow (or no card is shown, under bypassPermissions). */
  onGrant?: (folders: string[]) => void;
  /** Every delete-card call, accepted or refused, in order: the run pairs them with its recorded answers. */
  onGrantCall?: (call: { folders: string[]; ok: boolean }) => void;
}): McpHandler {
  const { folders, appVersion, exec, onInfraError, onGrant, onGrantCall } = opts;
  const folderNames = folders.map((f) => f.name);
  const tools = [
    {
      name: "get_device_info",
      description: GET_DEVICE_INFO_DESC,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "device_bash",
      description: DEVICE_BASH_DESC,
      inputSchema: DEVICE_BASH_INPUT_SCHEMA,
      _meta: { "anthropic/alwaysLoad": true },
    },
    {
      name: "device_request_delete_permission",
      description: DELETE_GRANT_DESC,
      inputSchema: DELETE_GRANT_INPUT_SCHEMA,
      _meta: { "anthropic/requiresUserInteraction": true, "anthropic/alwaysLoad": true },
    },
  ];

  return async (_server, jr): Promise<McpResult> => {
    if (jr.method === "initialize")
      return {
        result: {
          protocolVersion: (jr.params && jr.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "remote-devices", version: "1.0.0" },
        },
      };
    if (jr.method === "tools/list") return { result: { tools } };
    if (jr.method !== "tools/call") return { result: {} };

    const name = jr.params?.name;
    const args = jr.params?.arguments ?? {};
    if (name === "get_device_info") {
      const info = {
        platform: "darwin",
        arch: "arm64",
        appVersion,
        deviceName: "cowork-harness device",
        connectedFolders: folderNames.map((n) => `~/${n}`),
        timestamp: new Date().toISOString(),
      };
      return text(JSON.stringify(info, null, 2));
    }
    if (name === "device_request_delete_permission") {
      // Production's checks, paraphrased: a request names whole connected folders, 1–8 of them, none read-only.
      const paths: unknown = args.paths;
      const refuse = (why: string, asked: string[] = []): McpResult => {
        onGrantCall?.({ folders: asked, ok: false });
        return text(why, true);
      };
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8 || !paths.every((p) => typeof p === "string"))
        return refuse("device_request_delete_permission input invalid: paths: 1 to 8 connected folder roots are required.");
      if (args.reason !== undefined && (typeof args.reason !== "string" || args.reason.length > 500))
        return refuse("device_request_delete_permission input invalid: reason: one sentence of at most 500 characters.");
      const asked: string[] = [];
      for (const p of paths as string[]) {
        const m = /^~\/([^/]+)\/?$/.exec(p);
        const folder = m ? folders.find((f) => f.name === m[1]) : undefined;
        if (!folder)
          return refuse(
            `${p} is not one of this session's connected folder roots on this device. Pass the exact connected folder roots (see get_device_info.connectedFolders); delete permission applies to a whole connected folder.`,
          );
        if (folder.mode === "r") return refuse(`${p} is connected read-only, so file deletion can't be enabled there.`);
        if (!asked.includes(folder.name)) asked.push(folder.name);
      }
      onGrant?.(asked);
      onGrantCall?.({ folders: asked, ok: true });
      const listed = asked.map((n) => JSON.stringify(`~/${n}`)).join(", ");
      return text(
        `File deletion is now enabled for the rest of this session in ${asked.length === 1 ? "this folder" : "these folders"} (including subfolders): ${listed}. device_bash picks this up on your next call, so rm, rmdir and unlink will work there. Deleted files can't be restored; delete only what the user asked for.`,
      );
    }
    if (name !== "device_bash") return text(`Unknown tool: ${name}`, true);

    const command = args.command;
    if (typeof command !== "string" || command === "")
      return text("device_bash input invalid: command: a non-empty string is required.", true);
    const requested = args.timeout_ms;
    const timeoutMs =
      typeof requested === "number" && Number.isInteger(requested) && requested > 0
        ? Math.min(requested, DEVICE_BASH_TIMEOUT_MS)
        : DEVICE_BASH_TIMEOUT_MS;

    const r = await exec(command, timeoutMs);
    if ("infraError" in r) {
      onInfraError?.(r.infraError);
      return text("device_bash failed in the device workspace.", true);
    }
    const out = r.output.length > 0 ? r.output : "(no output)";
    const capped =
      out.length > DEVICE_BASH_OUTPUT_CAP
        ? `${out.slice(0, DEVICE_BASH_OUTPUT_CAP)}\n[output truncated at ${DEVICE_BASH_OUTPUT_CAP} chars]`
        : out;
    return r.exitCode === 0 ? text(capped) : text(`Exit code ${r.exitCode}\n${capped}`, true);
  };
}
