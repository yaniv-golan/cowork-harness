import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The guest firewall must only ever meet a provisioned guest: `vmInit` enforces readiness, and what keeps
// that sufficient is that spawnMicroVm applies the firewall only AFTER vmInit has returned. Lima, staging
// and the manifest captures are stubbed; the firewall stub throws so the spawn stops before any process.
const calls: string[] = [];
const vmInit = vi.fn();
vi.mock("../src/runtime/lima.js", async (orig) => ({
  ...(await orig<typeof import("../src/runtime/lima.js")>()),
  vmInit: (...a: any[]) => vmInit(...a),
  applyGuestFirewall: () => {
    calls.push("firewall");
    throw new Error("stop-here");
  },
}));
vi.mock("../src/runtime/stage.js", async (orig) => ({
  ...(await orig<typeof import("../src/runtime/stage.js")>()),
  stageWorkspace: () => {
    calls.push("stage");
    return { mcpStaged: false };
  },
}));
vi.mock("../src/run/pre-run-manifest.js", async (orig) => ({
  ...(await orig<typeof import("../src/run/pre-run-manifest.js")>()),
  capturePreRunManifest: () => calls.push("manifest"),
}));
vi.mock("../src/run/input-host-paths.js", async (orig) => ({
  ...(await orig<typeof import("../src/run/input-host-paths.js")>()),
  captureInputHostPathCorpus: () => calls.push("corpus"),
}));

import { spawnMicroVm } from "../src/runtime/microvm.js";
import { loadBaseline } from "../src/baseline.js";

const baseline = loadBaseline("latest");
const plan = { mounts: [], resume: false } as any;

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "stub-not-a-real-token"); // past the spawn's credential backstop
  calls.length = 0;
  vmInit.mockReset();
  delete process.env.COWORK_HARNESS_LOCKDOWN;
});

describe("spawnMicroVm ordering", () => {
  it("applies the guest firewall only after vmInit has returned", () => {
    vmInit.mockImplementation(() => {
      calls.push("vmInit");
      return { instance: "cowork-vm-order", status: "Running" };
    });
    expect(() => spawnMicroVm({} as any, baseline, plan, "/tmp/unused-out", "local_order", { proxyPort: 1 })).toThrow(
      /guest firewall failed/,
    );
    expect(calls[0]).toBe("vmInit");
    expect(calls.indexOf("firewall")).toBeGreaterThan(0);
  });

  it("never applies the firewall when vmInit refuses the VM", () => {
    vmInit.mockImplementation(() => {
      calls.push("vmInit");
      throw new Error("microvm cowork-vm-order never finished provisioning (x)");
    });
    expect(() => spawnMicroVm({} as any, baseline, plan, "/tmp/unused-out", "local_order", { proxyPort: 1 })).toThrow(
      /never finished provisioning/,
    );
    expect(calls).toEqual(["vmInit"]);
  });
});
