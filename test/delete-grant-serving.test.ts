// The device bridge serves production's delete card, `device_request_delete_permission`. The handler validates the
// request as production does (connected folder roots only, 1–8 of them, no read-only folder), records each grant,
// and the run's record names who answered. In this release nothing yet refuses a delete in the device copy, so the
// record says `deleteRefusal: "reported"` and keeps `delete-not-refused`.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRemoteDevicesHandler } from "../src/hostloop/remote-devices-handler.js";
import {
  DEVICE_BRIDGE_ASK_TOOLS,
  DEVICE_BRIDGE_TOOLS,
  deleteGrantsOf,
  deviceBridgeRecord,
  readDeviceGrants,
  writeDeviceGrant,
} from "../src/runtime/device-container.js";
import { DELETE_GRANT_TOOL } from "../src/decide/decider.js";
import type { Mount } from "../src/session.js";

const exec = async () => ({ exitCode: 0, output: "" });
type Call = { folders: string[] };
const handler = (granted: Call[] = []) =>
  makeRemoteDevicesHandler({
    folders: [
      { name: "notes", mode: "rw" },
      { name: "ref", mode: "r" },
      { name: "tidy", mode: "rwd" },
    ],
    appVersion: "2.31226.1",
    exec,
    onGrant: (folders) => void granted.push({ folders }),
  });
const call = async (h: ReturnType<typeof handler>, args: unknown) =>
  (
    (await h("remote-devices", {
      method: "tools/call",
      params: { name: "device_request_delete_permission", arguments: args },
    } as never)) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    }
  ).result;

describe("the delete card's tool definition", () => {
  it("is listed with production's schema, alwaysLoad and requiresUserInteraction", async () => {
    const r = ((await handler()("remote-devices", { method: "tools/list" } as never)) as { result: { tools: Array<Record<string, any>> } })
      .result;
    const t = r.tools.find((x) => x.name === "device_request_delete_permission")!;
    expect(t).toBeDefined();
    expect(t.inputSchema.required).toEqual(["paths"]);
    expect(t.inputSchema.properties.paths).toMatchObject({ type: "array", minItems: 1, maxItems: 8, items: { type: "string" } });
    expect(t.inputSchema.properties.reason).toMatchObject({ type: "string", maxLength: 500 });
    expect(t._meta).toEqual({ "anthropic/requiresUserInteraction": true, "anthropic/alwaysLoad": true });
  });
  it("is advertised but not pre-approved: the agent asks, so a person answers", () => {
    expect(DEVICE_BRIDGE_ASK_TOOLS).toEqual([DELETE_GRANT_TOOL]);
    expect(DEVICE_BRIDGE_TOOLS).not.toContain(DELETE_GRANT_TOOL);
    const src = readFileSync(new URL("../src/runtime/container.ts", import.meta.url), "utf8");
    const allowed = src.slice(src.indexOf("extraAllowedTools:"), src.indexOf("\n", src.indexOf("extraAllowedTools:")));
    const advertised = src.slice(src.indexOf("extraTools:"), src.indexOf("\n", src.indexOf("extraTools:")));
    expect(advertised).toContain("device?.askTools");
    expect(allowed).not.toContain("askTools");
  });
});

describe("the delete card's handler", () => {
  it("grants a connected read-write folder, by its get_device_info spelling", async () => {
    const granted: Call[] = [];
    const r = await call(handler(granted), { paths: ["~/notes"], reason: "remove a draft" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toMatch(/deletion is now enabled/i);
    expect(granted).toEqual([{ folders: ["notes"] }]);
  });
  it.each([
    [{ paths: ["~/notes/sub"] }, /connected folder root/],
    [{ paths: ["~/elsewhere"] }, /connected folder root/],
    [{ paths: ["/Users/x/notes"] }, /connected folder root/],
    [{ paths: ["~/ref"] }, /read-only/],
    [{ paths: [] }, /1 to 8/],
    [{ paths: Array.from({ length: 9 }, () => "~/notes") }, /1 to 8/],
    [{ paths: ["~/notes"], reason: "x".repeat(501) }, /reason/],
    [{}, /1 to 8/],
  ])("refuses %j with an error result and grants nothing", async (args, msg) => {
    const granted: Call[] = [];
    const r = await call(handler(granted), args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(msg);
    expect(granted).toEqual([]);
  });
});

describe("the grants file", () => {
  it("is written atomically under the run dir and read back, de-duplicated, in grant order", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-grants-"));
    expect(readDeviceGrants(d)).toEqual([]);
    writeDeviceGrant(d, ["notes"]);
    writeDeviceGrant(d, ["tidy", "notes"]);
    expect(readDeviceGrants(d)).toEqual(["notes", "tidy"]);
    expect(existsSync(join(d, "device-ctl", "grants"))).toBe(true);
    expect(readFileSync(join(d, "device-ctl", "grants"), "utf8")).toBe("notes\ntidy\n");
  });
});

describe("who answered each grant", () => {
  const allow = (by: string) => ({ kind: "tool", name: DELETE_GRANT_TOOL, decision: "allow", by });
  const deny = (by: string) => ({ kind: "tool", name: DELETE_GRANT_TOOL, decision: "deny", by });
  it("pairs each answered allow with the handler call it permitted, in order", () => {
    const calls = [
      { folders: ["notes"], ok: true },
      { folders: ["ref"], ok: false },
      { folders: ["tidy"], ok: true },
    ];
    const g = deleteGrantsOf([allow("scripted"), deny("first"), allow("llm"), allow("human")] as never, calls, "acceptEdits", 1);
    expect(g).toEqual([
      { folders: ["notes"], answeredBy: "script", turn: 1 },
      { folders: ["tidy"], answeredBy: "human", turn: 1 },
    ]);
  });
  it("under bypassPermissions no card is shown, so each grant is answered by the mode", () => {
    expect(deleteGrantsOf([], [{ folders: ["notes"], ok: true }], "bypassPermissions", 2)).toEqual([
      { folders: ["notes"], answeredBy: "bypassPermissions", turn: 2 },
    ]);
  });
});

describe("RunResult.deviceBridge in this release", () => {
  const mounts: Mount[] = [{ hostPath: "/x/n", mountPath: "notes", mode: "rw", kind: "folder" }];
  const plan = { permissionMode: "acceptEdits", permissionModeSource: "bridge-default" as const, egressAllow: [] };
  it("serves the card, reports deletes rather than refusing them, and says a decline's text is the harness's", () => {
    const r = deviceBridgeRecord(mounts, "included", plan, []);
    expect(r.served).toEqual(["device_bash", "get_device_info", "device_request_delete_permission"]);
    expect(r.alwaysLoad).toEqual(["device_bash", "device_request_delete_permission"]);
    expect(r.deleteRefusal).toBe("reported");
    expect(r.grants).toEqual([]);
    expect(r.divergences).toContain("delete-not-refused");
    expect(r.divergences).toContain("decline-text");
    expect(r.divergences).not.toContain("grant-without-prompt");
  });
  it("a tree listed on a filesystem that can reuse identities adds rename-reads-as-delete; a reliable one does not", () => {
    expect(deviceBridgeRecord(mounts, "included", plan, [], false).divergences).toContain("rename-reads-as-delete");
    expect(deviceBridgeRecord(mounts, "included", plan, [], true).divergences).not.toContain("rename-reads-as-delete");
    expect(deviceBridgeRecord(mounts, "included", plan, []).divergences).not.toContain("rename-reads-as-delete");
  });
  it("a grant given with no card shown adds grant-without-prompt", () => {
    const r = deviceBridgeRecord(mounts, "included", plan, [{ folders: ["notes"], answeredBy: "bypassPermissions", turn: 1 }]);
    expect(r.divergences).toContain("grant-without-prompt");
  });
});
