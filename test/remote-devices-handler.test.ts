// The `remote-devices` SDK-MCP server the harness serves under `device_bridge: true`: device_bash (commands run in
// the device container) and get_device_info. The command runner is injected, so these tests pin the protocol shape
// and the result format without Docker; the container side is tested with the device container itself.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVICE_BASH_DESC_WRITTEN_AGAINST,
  DEVICE_BASH_OUTPUT_CAP,
  DEVICE_BASH_TIMEOUT_MS,
  type DeviceExec,
  makeRemoteDevicesHandler,
} from "../src/hostloop/remote-devices-handler.js";
import { hostPathLeaked } from "../src/run/execute.js";

type Call = { command: string; timeoutMs: number };
function handler(exec: DeviceExec = async () => ({ exitCode: 0, output: "ok\n" }), folders = ["proj"]) {
  const calls: Call[] = [];
  const h = makeRemoteDevicesHandler({
    folderNames: folders,
    appVersion: "2.31226.1",
    exec: async (command, timeoutMs) => {
      calls.push({ command, timeoutMs });
      return exec(command, timeoutMs);
    },
  });
  return { h, calls };
}
const call = async (h: ReturnType<typeof handler>["h"], name: string, args: unknown) =>
  (await h("remote-devices", { method: "tools/call", params: { name, arguments: args } })) as any;

describe("remote-devices: tools/list", () => {
  it("serves device_bash (alwaysLoad) and get_device_info (deferred, as production registers it)", async () => {
    const { h } = handler();
    const { result } = (await h("remote-devices", { method: "tools/list" })) as any;
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["device_bash", "get_device_info"]);
    expect(byName.device_bash._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(byName.get_device_info._meta).toBeUndefined();
    expect(byName.get_device_info.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("device_bash takes a required command and an optional positive timeout_ms capped at 45 s", async () => {
    const { h } = handler();
    const { result } = (await h("remote-devices", { method: "tools/list" })) as any;
    const s = result.tools.find((t: any) => t.name === "device_bash").inputSchema;
    expect(Object.keys(s.properties).sort()).toEqual(["command", "timeout_ms"]);
    expect(s.required).toEqual(["command"]);
    expect(s.properties.command.type).toBe("string");
    expect(s.properties.timeout_ms).toMatchObject({ type: "integer", exclusiveMinimum: 0, maximum: 45000 });
  });

  it("the description names no device tool the harness does not serve", async () => {
    const { h } = handler();
    const { result } = (await h("remote-devices", { method: "tools/list" })) as any;
    const text = result.tools.map((t: any) => `${t.description}\n${JSON.stringify(t.inputSchema)}`).join("\n");
    for (const unserved of ["device_list_dir", "device_stage_files", "device_commit_files", "device_request", "SendUserFile"])
      expect(text, unserved).not.toContain(unserved);
  });
});

describe("remote-devices: device_bash results", () => {
  it("runs the command as given, with the default timeout, and returns its output as one text item", async () => {
    const { h, calls } = handler(async () => ({ exitCode: 0, output: "hello\n" }));
    const r = await call(h, "device_bash", { command: "echo hello" });
    expect(calls).toEqual([{ command: "echo hello", timeoutMs: DEVICE_BASH_TIMEOUT_MS }]);
    expect(r.result).toEqual({ content: [{ type: "text", text: "hello\n" }] });
  });

  it("an empty output reads (no output)", async () => {
    const { h } = handler(async () => ({ exitCode: 0, output: "" }));
    expect((await call(h, "device_bash", { command: "true" })).result.content[0].text).toBe("(no output)");
  });

  it("a non-zero exit is an error result that leads with its exit code", async () => {
    const { h } = handler(async () => ({ exitCode: 2, output: "ls: cannot access 'x'\n" }));
    const r = await call(h, "device_bash", { command: "ls x" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content).toHaveLength(1);
    expect(r.result.content[0].text).toBe("Exit code 2\nls: cannot access 'x'\n");
  });

  it("cuts the output at the production cap and says so", async () => {
    const { h } = handler(async () => ({ exitCode: 0, output: "a".repeat(DEVICE_BASH_OUTPUT_CAP + 10) }));
    const text = (await call(h, "device_bash", { command: "yes" })).result.content[0].text;
    expect(text).toBe("a".repeat(DEVICE_BASH_OUTPUT_CAP) + `\n[output truncated at ${DEVICE_BASH_OUTPUT_CAP} chars]`);
  });

  it("passes a requested timeout through and clamps one above the cap", async () => {
    const { h, calls } = handler();
    await call(h, "device_bash", { command: "a", timeout_ms: 1000 });
    await call(h, "device_bash", { command: "b", timeout_ms: 999999 });
    expect(calls.map((c) => c.timeoutMs)).toEqual([1000, DEVICE_BASH_TIMEOUT_MS]);
  });

  it("an infrastructure failure never reads as the command's exit", async () => {
    const infra: string[] = [];
    const h = makeRemoteDevicesHandler({
      folderNames: ["proj"],
      appVersion: "2.31226.1",
      exec: async () => ({ infraError: "Error response from daemon: No such container: x" }),
      onInfraError: (m) => infra.push(m),
    });
    const r = await call(h, "device_bash", { command: "ls" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).not.toMatch(/Exit code|daemon/);
    expect(infra).toEqual(["Error response from daemon: No such container: x"]);
  });

  it("a missing or non-string command is an input error and runs nothing", async () => {
    const { h, calls } = handler();
    for (const args of [{}, { command: 3 }, { command: "" }]) {
      const r = await call(h, "device_bash", args);
      expect(r.result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});

describe("remote-devices: get_device_info", () => {
  it("returns one text item of pretty JSON with connectedFolders as device paths that are not host paths", async () => {
    const { h } = handler(undefined, ["proj", "notes"]);
    const r = await call(h, "get_device_info", {});
    expect(r.result.content).toHaveLength(1);
    const text = r.result.content[0].text as string;
    const info = JSON.parse(text);
    expect(text).toBe(JSON.stringify(info, null, 2));
    expect(info.connectedFolders).toEqual(["~/proj", "~/notes"]);
    expect(info).toMatchObject({ platform: "darwin", appVersion: "2.31226.1" });
    expect(typeof info.deviceName).toBe("string");
    expect(hostPathLeaked(text)).toBe(false);
  });

  it("an unknown tool is refused", async () => {
    const { h } = handler();
    expect((await call(h, "device_list_dir", { path: "~" })).result.isError).toBe(true);
  });
});

describe("device_bash description drift", () => {
  // The harness description is a paraphrase of one production branch: timeout fixed at 45 s, and no folder-request
  // tool. It was written against the branch fingerprint below. When the newest baseline no longer carries that
  // fingerprint, production's text moved: re-read it and re-pin.
  it("the pinned production branch is still present in the newest baseline", () => {
    const dir = join(process.cwd(), "baselines");
    const versions = readdirSync(dir)
      .map((f) => /^desktop-(\d+)\.(\d+)\.(\d+)\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => +a[1] - +b[1] || +a[2] - +b[2] || +a[3] - +b[3]);
    const newest = JSON.parse(readFileSync(join(dir, versions[versions.length - 1][0]), "utf8"));
    const shas = (newest.cloud?.remoteDevicesDescriptions ?? []).filter((d: any) => d.name === "device_bash").map((d: any) => d.sha256);
    expect(shas).toContain(DEVICE_BASH_DESC_WRITTEN_AGAINST);
  });
});
