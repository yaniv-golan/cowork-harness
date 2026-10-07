// The `agent` check's lane/supply clause: what Desktop staged vs what the newest baseline pins, driven through
// the DoctorProbe seam. It never changes the check's status and names versions only, never a path.
import { describe, it, expect, afterEach } from "vitest";
import { runDoctorChecks, laneSupplyClause, type DoctorProbe } from "../src/run/doctor.js";
import { loadBaseline } from "../src/baseline.js";

const PIN = loadBaseline("latest").agentVersion;
const LANE = "this harness models Cowork's local lane, which new Pro and Max tasks do not use from 2026-10-06";
const base: DoctorProbe = {
  nodeMajor: () => 22,
  platform: () => "darwin",
  arch: () => "arm64",
  runtimeName: () => "docker",
  runtimeAvailable: () => true,
  runtimeDaemonUp: () => true,
  limaAvailable: () => true,
  vmInstanceStatus: () => "Running",
  vmProvisioning: () => "ready",
  imageName: () => "cowork-agent-base:2",
  imagePresent: () => true,
  proxyImageName: () => "cowork-egress-proxy:3",
  proxyImagePresent: () => true,
  agentBinary: () => ({ ok: true, path: "/x/claude-code-vm/9.9.9/claude" }),
  hostAgentBinary: () => ({ ok: true, path: "/x/claude.app/Contents/MacOS/claude" }),
  hasToken: () => true,
  hasKeychainToken: () => false,
  worktreeEnv: () => null,
  baseline: () => ({ ok: true, version: "1.0.0" }),
};
const agentCheck = (staged: { version: string | null; elfExists: boolean } | null, ok = true) =>
  runDoctorChecks("container", {
    ...base,
    stagedVmAgent: () => staged,
    ...(ok ? {} : { agentBinary: () => ({ ok: false as const, error: "pinned binary not found" }) }),
  }).find((c) => c.id === "agent")!;

const saved = process.env.COWORK_AGENT_BINARY;
afterEach(() => {
  if (saved === undefined) delete process.env.COWORK_AGENT_BINARY;
  else process.env.COWORK_AGENT_BINARY = saved;
});

describe("laneSupplyClause", () => {
  it("staged = pin, ELF present → staged and pinned", () => {
    expect(laneSupplyClause({ version: "2.1.288", elfExists: true }, "2.1.288")).toBe(`agent 2.1.288 staged and pinned; ${LANE}`);
  });
  it("staged > pin → run sync (numeric compare: 2.1.300 > 2.1.288)", () => {
    expect(laneSupplyClause({ version: "2.1.300", elfExists: true }, "2.1.288")).toBe(
      `Desktop staged agent 2.1.300, newer than the pinned 2.1.288: run \`cowork-harness sync\`; ${LANE}`,
    );
  });
  it("staged < pin, or = pin with the ELF missing → not staged, may be withheld", () => {
    const notStaged = `agent 2.1.288 not staged by this Desktop (staging may be withheld by server policy, or no task has booted the VM since an update); ${LANE}`;
    expect(laneSupplyClause({ version: "2.1.286", elfExists: true }, "2.1.288")).toBe(notStaged);
    expect(laneSupplyClause({ version: "2.1.288", elfExists: false }, "2.1.288")).toBe(notStaged);
  });
  it("no .sdk-version → no staged VM agent found", () => {
    expect(laneSupplyClause({ version: null, elfExists: false }, "2.1.288")).toBe(`no staged VM agent found; ${LANE}`);
  });
});

describe("the agent check carries the clause through the DoctorProbe seam", () => {
  it("appends it to an ok detail without changing the status, and names no path", () => {
    delete process.env.COWORK_AGENT_BINARY;
    const c = agentCheck({ version: PIN, elfExists: true });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain(`[agent ${PIN} staged and pinned; ${LANE}]`);
    const clause = c.detail.slice(c.detail.indexOf("[agent "));
    expect(clause).not.toMatch(/\/|~/);
  });
  it("appends it to a failing detail too; the status stays fail", () => {
    delete process.env.COWORK_AGENT_BINARY;
    const c = agentCheck({ version: null, elfExists: false }, false);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain(`[no staged VM agent found; ${LANE}]`);
  });
  it("no clause when the probe cannot read Desktop's staging, or under a COWORK_AGENT_BINARY override", () => {
    delete process.env.COWORK_AGENT_BINARY;
    expect(agentCheck(null).detail).not.toContain(LANE);
    process.env.COWORK_AGENT_BINARY = "/some/other/claude";
    expect(agentCheck({ version: PIN, elfExists: true }).detail).not.toContain(LANE);
  });
});
