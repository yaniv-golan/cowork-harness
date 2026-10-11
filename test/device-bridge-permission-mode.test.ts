// device_bridge's permission mode. A production cloud task under the composer's Manual choice reports `acceptEdits`
// to its hooks, so a bridge run whose session names no mode runs in acceptEdits. A session that names one, `default`
// included, keeps it. Read off the plan the real builder returns and the argv the agent is spawned with.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import { agentArgs } from "../src/runtime/argv.js";
import { deviceBridgeRecord } from "../src/runtime/device-container.js";
import { buildLaunchPlan, loadSession, type LaunchPlan } from "../src/session.js";

const baseline = loadBaseline("latest");
const plan = (session: Record<string, unknown>, deviceBridge: boolean): LaunchPlan =>
  buildLaunchPlan(loadSession(session), baseline, mkdtempSync(join(tmpdir(), "dbpm-")), "container", false, "remote", undefined, {
    deviceBridge,
  });
const flag = (p: LaunchPlan) => {
  const argv = agentArgs(baseline, p, { mntRoot: "/sessions/x/mnt" } as never);
  return argv[argv.indexOf("--permission-mode") + 1];
};

describe("device_bridge permission mode", () => {
  it("runs in acceptEdits when the session names no mode", () => {
    const p = plan({}, true);
    expect(p.permissionMode).toBe("acceptEdits");
    expect(flag(p)).toBe("acceptEdits");
  });
  it("keeps an explicit `default`", () => {
    expect(flag(plan({ permission_mode: "default" }, true))).toBe("default");
  });
  it.each(["plan", "bypassPermissions", "acceptEdits"])("keeps an explicit %s", (mode) => {
    expect(flag(plan({ permission_mode: mode }, true))).toBe(mode);
  });
  it("leaves a run without the bridge on `default`", () => {
    expect(flag(plan({}, false))).toBe("default");
  });
});

describe("the record names the mode and where it came from", () => {
  it("bridge default", () => {
    const r = deviceBridgeRecord([], "included", plan({}, true));
    expect(r.permissionMode).toBe("acceptEdits");
    expect(r.permissionModeSource).toBe("bridge-default");
  });
  it("session", () => {
    const r = deviceBridgeRecord([], "included", plan({ permission_mode: "default" }, true));
    expect(r.permissionMode).toBe("default");
    expect(r.permissionModeSource).toBe("session");
  });
});

describe("wiring", () => {
  const src = readFileSync(new URL("../src/run/execute.ts", import.meta.url), "utf8");
  it("executeScenario tells the plan builder about the bridge", () => {
    expect(src).toMatch(/launchSources, \{\s*deviceBridge: scenario\.device_bridge === true,?\s*\}\);/);
  });
  it("both result sites record the plan's mode", () => {
    expect(src.split("deviceBridgeRecord(plan.mounts, bridgeNote, plan, bridgeGrants())").length - 1).toBe(2);
  });
});

describe("the record's egress follows the session", () => {
  it("an allowlist session records allowlist, with the divergence", () => {
    const r = deviceBridgeRecord([], "included", plan({}, true));
    expect(r.egress).toBe("allowlist");
    expect(r.divergences).toContain("egress-allowlist");
  });
  it("egress.unrestricted records unrestricted, without the divergence", () => {
    const r = deviceBridgeRecord([], "included", plan({ egress: { unrestricted: true } }, true));
    expect(r.egress).toBe("unrestricted");
    expect(r.divergences).not.toContain("egress-allowlist");
  });
});

describe("the record refuses a mode source a bridge run cannot have", () => {
  it.each(["default", undefined])("source %s throws", (source) => {
    expect(() =>
      deviceBridgeRecord([], "included", {
        permissionMode: "default",
        permissionModeSource: source as "default" | undefined,
        egressAllow: [],
      }),
    ).toThrow(/permissionModeSource/);
  });
});
