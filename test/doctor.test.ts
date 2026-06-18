import { describe, it, expect } from "vitest";
import { runDoctorChecks, agentBuildLine, type DoctorProbe, type DoctorCheck } from "../src/run/doctor.js";

const OK_PROBE: DoctorProbe = {
  nodeMajor: () => 20,
  platform: () => "darwin",
  arch: () => "arm64",
  runtimeName: () => "docker",
  runtimeAvailable: () => true,
  runtimeDaemonUp: () => true,
  imageName: () => "cowork-agent-base:1",
  imagePresent: () => true,
  agentBinary: () => ({ ok: true, path: "/x/claude-code-vm/2.1.177/claude" }),
  hasToken: () => true,
  baseline: () => ({ ok: true, version: "1.13576.1" }),
};
const probe = (over: Partial<DoctorProbe>): DoctorProbe => ({ ...OK_PROBE, ...over });
const get = (cs: DoctorCheck[], id: string) => cs.find((c) => c.id === id)!;
const blocking = (cs: DoctorCheck[]) => cs.filter((c) => c.required && c.status === "fail").map((c) => c.id);

describe("doctor — runDoctorChecks", () => {
  it("container tier with everything present has no blocking failures", () => {
    expect(blocking(runDoctorChecks("container", OK_PROBE))).toEqual([]);
  });

  it("protocol tier marks runtime/image/agent as skipped + not required", () => {
    const cs = runDoctorChecks("protocol", probe({ runtimeAvailable: () => false, imagePresent: () => false }));
    for (const id of ["runtime", "image", "agent"]) {
      expect(get(cs, id).status).toBe("skip");
      expect(get(cs, id).required).toBe(false);
    }
    // protocol still requires a model token + node + baseline
    expect(blocking(runDoctorChecks("protocol", probe({ hasToken: () => false })))).toContain("token");
  });

  it("missing agent image → fail with a `docker build` remedy (package-root resolved)", () => {
    const cs = runDoctorChecks("container", probe({ imagePresent: () => false }));
    const img = get(cs, "image");
    expect(img.status).toBe("fail");
    expect(img.required).toBe(true);
    expect(img.remedy).toMatch(/docker build .*Dockerfile\.agent/);
  });

  it("unreachable daemon → runtime fails and image degrades to skip (not a second hard fail)", () => {
    const cs = runDoctorChecks("container", probe({ runtimeDaemonUp: () => false }));
    expect(get(cs, "runtime").status).toBe("fail");
    expect(get(cs, "image").status).toBe("skip");
    expect(get(cs, "image").required).toBe(false);
    expect(blocking(cs)).toEqual(["runtime"]);
  });

  it("unstaged agent → fail with a stage-it remedy", () => {
    const cs = runDoctorChecks("container", probe({ agentBinary: () => ({ ok: false, error: "Staged agent binary not found" }) }));
    expect(get(cs, "agent").status).toBe("fail");
    expect(get(cs, "agent").remedy).toMatch(/COWORK_AGENT_BINARY|Cowork/);
  });

  it("missing token blocks every tier", () => {
    expect(blocking(runDoctorChecks("container", probe({ hasToken: () => false })))).toContain("token");
  });

  it("microvm hard-requires macOS arm64; other tiers only warn", () => {
    const linux = probe({ platform: () => "linux", arch: () => "x64" });
    expect(get(runDoctorChecks("microvm", linux), "os").status).toBe("fail");
    expect(get(runDoctorChecks("microvm", linux), "os").required).toBe(true);
    expect(get(runDoctorChecks("container", linux), "os").status).toBe("warn");
    expect(get(runDoctorChecks("container", linux), "os").required).toBe(false);
  });

  it("Node < 20 fails", () => {
    expect(get(runDoctorChecks("protocol", probe({ nodeMajor: () => 18 })), "node").status).toBe("fail");
  });

  it("agentBuildLine names the image and the agent Dockerfile", () => {
    const line = agentBuildLine("docker", "myimage:1");
    expect(line).toContain("myimage:1");
    expect(line).toContain("docker/Dockerfile.agent");
    expect(line).toContain("--platform linux/arm64");
  });
});
