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
export type DeviceExecResult = { exitCode: number; output: string } | { infraError: string };
export type DeviceExec = (command: string, timeoutMs: number) => Promise<DeviceExecResult>;

const text = (t: string, isError = false): McpResult => ({
  result: isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] },
});

export function makeRemoteDevicesHandler(opts: {
  /** The connected folders' mount names, as they appear under `$HOME/mnt/` in the device container. */
  folderNames: string[];
  /** The baseline's Desktop version, reported as get_device_info's appVersion. */
  appVersion: string;
  exec: DeviceExec;
  onInfraError?: (message: string) => void;
}): McpHandler {
  const { folderNames, appVersion, exec, onInfraError } = opts;
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
