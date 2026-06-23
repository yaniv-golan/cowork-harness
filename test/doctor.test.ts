import { describe, it, expect } from "vitest";
import { runDoctorChecks, agentBuildLine, type DoctorProbe, type DoctorCheck } from "../src/run/doctor.js";

const OK_PROBE: DoctorProbe = {
  nodeMajor: () => 20,
  platform: () => "darwin",
  arch: () => "arm64",
  runtimeName: () => "docker",
  runtimeAvailable: () => true,
  runtimeDaemonUp: () => true,
  limaAvailable: () => true,
  imageName: () => "cowork-agent-base:2",
  imagePresent: () => true,
  proxyImageName: () => "cowork-egress-proxy:1",
  proxyImagePresent: () => true,
  agentBinary: () => ({ ok: true, path: "/x/claude-code-vm/2.1.177/claude" }),
  hasToken: () => true,
  hasKeychainToken: () => false,
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

  it("microvm checks Lima (limactl), NOT the Docker runtime/image/proxy", () => {
    const cs = runDoctorChecks("microvm", OK_PROBE);
    const ids = cs.map((c) => c.id);
    expect(ids).toContain("lima"); // L2 prerequisite is Lima
    expect(ids).not.toContain("runtime"); // no Docker daemon check
    expect(ids).not.toContain("image"); // no agent IMAGE — the microVM uses its own rootfs
    expect(ids).not.toContain("proxy"); // host-side proxy, not the Docker egress-proxy image
    expect(ids).toContain("agent"); // the staged ELF is still bind-mounted into the guest
    expect(get(cs, "lima").status).toBe("ok");
    expect(blocking(cs)).toEqual([]);
  });

  it("microvm blocks when limactl is missing (and a Docker outage does NOT affect it)", () => {
    const noLima = runDoctorChecks("microvm", probe({ limaAvailable: () => false }));
    expect(get(noLima, "lima").status).toBe("fail");
    expect(get(noLima, "lima").remedy).toMatch(/Lima|limactl|COWORK_LIMACTL/);
    expect(blocking(noLima)).toContain("lima");
    // Docker being down is irrelevant to the microvm verdict (it never probes the runtime).
    expect(blocking(runDoctorChecks("microvm", probe({ runtimeAvailable: () => false, runtimeDaemonUp: () => false })))).toEqual([]);
  });

  it("microvm still blocks on a missing staged agent binary (bind-mounted into the guest)", () => {
    const cs = runDoctorChecks("microvm", probe({ agentBinary: () => ({ ok: false, error: "Staged agent binary not found" }) }));
    expect(get(cs, "agent").status).toBe("fail");
    expect(blocking(cs)).toContain("agent");
  });

  it("Node < 20 fails", () => {
    expect(get(runDoctorChecks("protocol", probe({ nodeMajor: () => 18 })), "node").status).toBe("fail");
  });

  it("egress proxy image is reported but never blocks (auto-built on first run)", () => {
    const present = get(runDoctorChecks("container", OK_PROBE), "proxy");
    expect(present.status).toBe("ok");
    expect(present.required).toBe(false);
    const absentCs = runDoctorChecks("container", probe({ proxyImagePresent: () => false }));
    expect(get(absentCs, "proxy").status).toBe("skip");
    expect(get(absentCs, "proxy").detail).toMatch(/built automatically/);
    expect(blocking(absentCs)).toEqual([]); // absence is never a blocking failure
  });

  it("Windows host gets an explicit unsupported note (warn on container, not a hard fail)", () => {
    const os = get(runDoctorChecks("container", probe({ platform: () => "win32", arch: () => "x64" })), "os");
    expect(os.status).toBe("warn");
    expect(os.remedy).toMatch(/Windows/);
  });

  it("agentBuildLine names the image and the agent Dockerfile", () => {
    const line = agentBuildLine("docker", "myimage:1");
    expect(line).toContain("myimage:1");
    expect(line).toContain("docker/Dockerfile.agent");
    expect(line).toContain("--platform linux/arm64");
  });

  // A Claude Code login writes the token to the macOS Keychain, but the in-Docker agent reads
  // only env/.env. doctor should detect the Keychain-only situation and point at .env instead of a dead-end
  // "set a token" remedy.
  it("no env token but a Keychain credential (macOS) → remedy points at copying into .env", () => {
    const tok = get(runDoctorChecks("container", probe({ hasToken: () => false, hasKeychainToken: () => true })), "token");
    expect(tok.status).toBe("fail");
    expect(tok.detail).toMatch(/Keychain/i);
    expect(tok.remedy).toMatch(/\.env/);
    expect(tok.remedy).toMatch(/keychain token/i);
  });

  it("no env token and NO Keychain credential → the generic 'set a token' remedy (no Keychain mention)", () => {
    const tok = get(runDoctorChecks("container", probe({ hasToken: () => false, hasKeychainToken: () => false })), "token");
    expect(tok.status).toBe("fail");
    expect(tok.detail).not.toMatch(/Keychain/i);
    expect(tok.remedy).toMatch(/setup-token/);
  });

  it("non-macOS host never shows the Keychain remedy (gated on darwin)", () => {
    // Even if a (hypothetical) probe reported a keychain entry, a linux host must get the generic remedy.
    const tok = get(
      runDoctorChecks("container", probe({ platform: () => "linux", hasToken: () => false, hasKeychainToken: () => true })),
      "token",
    );
    expect(tok.detail).not.toMatch(/Keychain/i);
    expect(tok.remedy).toMatch(/setup-token/);
  });
});
