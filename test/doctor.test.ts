import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runDoctorChecks,
  tokenCheck,
  realProbe,
  agentBuildLine,
  freshnessFor,
  ghcrRefFor,
  registryDigestFrom,
  nativeAgentRemedy,
  nativeDriftNote,
  agentRemedy,
  type DoctorProbe,
  type DoctorCheck,
  type ImageFreshness,
} from "../src/run/doctor.js";
import { classifyNativeStagingDrift, loadBaseline, pinnedNativeAgentVersion, resolveHostAgentBinary } from "../src/baseline.js";

const OK_PROBE: DoctorProbe = {
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
  agentBinary: () => ({ ok: true, path: "/x/claude-code-vm/2.1.177/claude" }),
  hostAgentBinary: () => ({ ok: true, path: "/x/claude-code/2.1.177/claude.app/Contents/MacOS/claude" }),
  hasToken: () => true,
  hasKeychainToken: () => false,
  worktreeEnv: () => null,
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

  it("microvm vm-instance check is ok and non-blocking when the Lima instance is Running or Stopped", () => {
    for (const status of ["Running", "Stopped"]) {
      const cs = runDoctorChecks("microvm", probe({ vmInstanceStatus: () => status }));
      const vm = get(cs, "vm-instance");
      expect(vm.status).toBe("ok");
      expect(blocking(cs)).not.toContain("vm-instance");
    }
  });

  // Running only means the guest booted. A first boot cut off mid-provisioning is Running too, and doctor
  // used to call it "provisioned".
  it("microvm vm-instance check warns (not fails) when a Running instance is not provisioned", () => {
    for (const state of ["pending", "sealed", "failed"]) {
      const cs = runDoctorChecks("microvm", probe({ vmInstanceStatus: () => "Running", vmProvisioning: () => state }));
      const vm = get(cs, "vm-instance");
      expect(vm.status).toBe("warn");
      expect(vm.detail).toContain(state === "pending" ? "still provisioning" : state === "sealed" ? "firewalled" : "without the agent");
      expect(blocking(cs)).not.toContain("vm-instance");
    }
    const failed = get(runDoctorChecks("microvm", probe({ vmProvisioning: () => "failed" })), "vm-instance");
    expect(failed.remedy).toMatch(/vm delete/);
  });

  it("a Running + provisioned instance says so", () => {
    const vm = get(runDoctorChecks("microvm", OK_PROBE), "vm-instance");
    expect(vm.status).toBe("ok");
    expect(vm.detail).toMatch(/running — provisioned/);
  });

  it("microvm vm-instance check warns (not fails) when the Lima instance is Absent — self-provisions on first run", () => {
    const cs = runDoctorChecks("microvm", probe({ vmInstanceStatus: () => "Absent" }));
    const vm = get(cs, "vm-instance");
    expect(vm.status).toBe("warn");
    expect(vm.required).toBe(false);
    expect(blocking(cs)).not.toContain("vm-instance");
    expect(vm.remedy).toMatch(/vm init/);
  });

  it("microvm vm-instance check is skipped when limactl itself is missing, regardless of vmInstanceStatus", () => {
    const cs = runDoctorChecks("microvm", probe({ limaAvailable: () => false, vmInstanceStatus: () => "Running" }));
    expect(get(cs, "vm-instance").status).toBe("skip");
    expect(blocking(cs)).not.toContain("vm-instance");
  });

  it("non-microvm tiers never include a vm-instance check", () => {
    expect(runDoctorChecks("container", OK_PROBE).find((c) => c.id === "vm-instance")).toBeUndefined();
  });

  it("the node gate sits at the supported floor: 20 fails, 22 passes", () => {
    // 20 is EOL (2026-04-30) -- reporting it healthy told users an unsupported runtime was fine.
    expect(get(runDoctorChecks("protocol", probe({ nodeMajor: () => 18 })), "node").status).toBe("fail");
    expect(get(runDoctorChecks("protocol", probe({ nodeMajor: () => 20 })), "node").status).toBe("fail");
    expect(get(runDoctorChecks("protocol", probe({ nodeMajor: () => 22 })), "node").status).toBe("ok");
    expect(get(runDoctorChecks("protocol", probe({ nodeMajor: () => 24 })), "node").status).toBe("ok");
  });

  it("engines.node and the doctor gate state the same floor", () => {
    // Two hand-maintained copies of one number; drift makes doctor green on a runtime the package
    // refuses to install on, or vice versa.
    const engines = JSON.parse(readFileSync(resolve("package.json"), "utf8")).engines.node as string;
    const floor = Number(engines.match(/(\d+)/)![1]);
    expect(get(runDoctorChecks("protocol", probe({})), "node").title).toBe(`Node ≥ ${floor}`);
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
    // The Keychain branch must ALSO name --dotenv: a user keeping the token in an alternate file
    // otherwise wrongly concludes doctor can't be pointed at it.
    expect(tok.remedy).toMatch(/--dotenv <path>/);
  });

  // The message used to name "the in-Docker agent" as the actor — at EVERY tier, because the branch
  // never consults `tier`. That is false at hostloop (native host process) and at protocol (no Docker
  // at all). It also must not claim doctor "does not read your Keychain": doctor DOES read it (that is
  // what hasKeychainToken is), and the detail line one row above says so. The claim is scoped to what
  // the harness passes to the AGENT, which is true at every tier.
  // protocol keeps the user's REAL CLAUDE_CONFIG_DIR when no API key is present (protocol.ts:88-97),
  // because a fresh one breaks OAuth — so a Keychain-only macOS user genuinely CAN run this tier and
  // must not be told "not ready". Measured live 2026-07-25: scrubbed env + default config dir
  // authenticates; scrubbed env + fresh managed config dir prints "Not logged in". Every other tier
  // passes a managed config dir, so the token really is required there.
  it("protocol + Keychain-only is a non-blocking WARN, not a fail", () => {
    const tok = get(runDoctorChecks("protocol", probe({ hasToken: () => false, hasKeychainToken: () => true })), "token");
    expect(tok.status).toBe("warn");
    expect(tok.required).toBe(true); // still reported; readiness gates on status === "fail"
    expect(tok.detail).toMatch(/real CLAUDE_CONFIG_DIR/i);
    expect(tok.remedy).toMatch(/likely fine as-is/i);
  });

  it.each(["container", "hostloop", "microvm"] as const)(
    "%s + Keychain-only still FAILS — those tiers use a managed config dir, which severs self-sourcing",
    (tier) => {
      const tok = get(runDoctorChecks(tier, probe({ hasToken: () => false, hasKeychainToken: () => true })), "token");
      expect(tok.status).toBe("fail");
    },
  );

  it("protocol with NO token and NO Keychain still fails (the relaxation is Keychain-gated)", () => {
    const tok = get(runDoctorChecks("protocol", probe({ hasToken: () => false, hasKeychainToken: () => false })), "token");
    expect(tok.status).toBe("fail");
  });

  it.each(["container", "hostloop", "microvm"] as const)("the Keychain remedy names no tier-specific actor and is true at %s", (tier) => {
    const tok = get(runDoctorChecks(tier, probe({ hasToken: () => false, hasKeychainToken: () => true })), "token");
    expect(tok.detail).toMatch(/does not pass a Keychain credential to the agent/i);
    expect(tok.remedy).toMatch(/injects only env \/ \.env into the agent, at every tier/i);
  });

  // The original defect — "the in-Docker agent" emitted at EVERY tier because the branch never consulted
  // `tier` — must stay dead on all four, including protocol's own separate message.
  it.each(["container", "hostloop", "protocol", "microvm"] as const)("no tier names the in-Docker agent (%s)", (tier) => {
    const tok = get(runDoctorChecks(tier, probe({ hasToken: () => false, hasKeychainToken: () => true })), "token");
    expect(`${tok.detail} ${tok.remedy}`).not.toMatch(/in-Docker/i);
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

  // running from a git worktree where ./.env is gitignored → no token; point at the main .env.
  it("no token but the main checkout has a .env (git worktree) → remedy points at --dotenv <main .env>", () => {
    const tok = get(
      runDoctorChecks("container", probe({ hasToken: () => false, hasKeychainToken: () => false, worktreeEnv: () => "/main/repo/.env" })),
      "token",
    );
    expect(tok.status).toBe("fail");
    expect(tok.detail).toMatch(/worktree/i);
    expect(tok.remedy).toMatch(/--dotenv \/main\/repo\/\.env/);
  });

  it("worktree token remedy puts --dotenv BEFORE the subcommand", () => {
    const cs = runDoctorChecks("protocol", probe({ hasToken: () => false, worktreeEnv: () => "/main/.env" }));
    const remedy = get(cs, "token").remedy!;
    expect(remedy).toMatch(/--dotenv \/main\/\.env <cmd>/); // leading form present
    expect(remedy).not.toMatch(/<cmd> --dotenv/); // broken trailing form gone
  });

  it("generic no-token remedy advertises the --dotenv leading form", () => {
    const cs = runDoctorChecks("protocol", probe({ hasToken: () => false }));
    expect(get(cs, "token").remedy!).toMatch(/--dotenv <path> <cmd>/);
  });

  it("Keychain remedy takes precedence over the worktree remedy when both apply", () => {
    const tok = get(
      runDoctorChecks("container", probe({ hasToken: () => false, hasKeychainToken: () => true, worktreeEnv: () => "/main/.env" })),
      "token",
    );
    expect(tok.remedy).toMatch(/Keychain token into \.\/\.env/);
    // Precedence = the Keychain branch wins, so the worktree-specific path must NOT leak. (The Keychain
    // remedy now carries a GENERIC `--dotenv <path>` hint of its own, so assert the absence of the worktree
    // path specifically, not of `--dotenv` wholesale.)
    expect(tok.remedy).not.toMatch(/\/main\/\.env/);
  });
});

describe("doctor — agent image freshness (advisory, network best-effort)", () => {
  const withFreshness = (f: ImageFreshness, over: Partial<DoctorProbe> = {}) => probe({ imageFreshness: () => f, ...over });

  it("is absent unless the probe implements imageFreshness (test doubles stay hermetic)", () => {
    // OK_PROBE has no imageFreshness → no network, no check emitted.
    expect(runDoctorChecks("container", OK_PROBE).find((c) => c.id === "image-freshness")).toBeUndefined();
  });

  it("current → ok, non-blocking, no remedy", () => {
    const cs = runDoctorChecks("container", withFreshness({ state: "current", detail: "matches the published ghcr.io/…:2" }));
    const f = get(cs, "image-freshness");
    expect(f.status).toBe("ok");
    expect(f.required).toBe(false);
    expect(f.remedy).toBeUndefined();
    expect(blocking(cs)).not.toContain("image-freshness");
  });

  it("stale → warn (never a blocking fail) with a re-pull + retag remedy", () => {
    const cs = runDoctorChecks(
      "container",
      withFreshness({
        state: "stale",
        detail: "local cowork-agent-base:2 differs …",
        ghcrRef: "ghcr.io/yaniv-golan/cowork-agent-base:2",
        pinnedRef: "ghcr.io/yaniv-golan/cowork-agent-base@sha256:" + "a".repeat(64),
      }),
    );
    const f = get(cs, "image-freshness");
    expect(f.status).toBe("warn");
    expect(f.required).toBe(false);
    // Digest-addressed: pulling the floating `:2` cannot satisfy a pin to an older revision.
    expect(f.remedy).toMatch(/pull ghcr\.io\/yaniv-golan\/cowork-agent-base@sha256:a{64}/);
    expect(f.remedy).toMatch(/tag ghcr\.io\/yaniv-golan\/cowork-agent-base@sha256:a{64} cowork-agent-base:2/);
    expect(blocking(cs)).toEqual([]); // advisory only
  });

  it("local build and unknown (offline/custom) → quiet skip, no remedy", () => {
    for (const state of [
      { state: "local", detail: "built locally" } as ImageFreshness,
      { state: "unknown", detail: "offline" } as ImageFreshness,
    ]) {
      const f = get(runDoctorChecks("container", withFreshness(state)), "image-freshness");
      expect(f.status).toBe("skip");
      expect(f.remedy).toBeUndefined();
    }
  });

  it("is not emitted when the image is absent (nothing to compare)", () => {
    const cs = runDoctorChecks("container", withFreshness({ state: "current", detail: "x" }, { imagePresent: () => false }));
    expect(cs.find((c) => c.id === "image-freshness")).toBeUndefined();
  });

  it("is not emitted for microvm (no Docker agent image) even if the probe implements it", () => {
    const cs = runDoctorChecks(
      "microvm",
      withFreshness({ state: "stale", detail: "x", ghcrRef: "ghcr.io/y/z:2", pinnedRef: "ghcr.io/y/z@sha256:" + "b".repeat(64) }),
    );
    expect(cs.find((c) => c.id === "image-freshness")).toBeUndefined();
  });

  it("ghcrRefFor maps published tags and returns null for custom images", () => {
    expect(ghcrRefFor("cowork-agent-base:2")).toBe("ghcr.io/yaniv-golan/cowork-agent-base:2");
    expect(ghcrRefFor("cowork-agent-full:2")).toBe("ghcr.io/yaniv-golan/cowork-agent-full:2");
    expect(ghcrRefFor("my-custom-image:latest")).toBeNull();
  });
});

describe("doctor --tier hostloop — native agent binary", () => {
  it("fails when the native macOS binary is missing, even if the VM ELF resolves", () => {
    const cs = runDoctorChecks("hostloop", probe({ hostAgentBinary: () => ({ ok: false, error: "COWORK_HOST_AGENT_BINARY not found" }) }));
    expect(get(cs, "hostAgent").status).toBe("fail");
    expect(get(cs, "hostAgent").required).toBe(true);
    expect(blocking(cs)).toContain("hostAgent");
  });

  it("passes when the native binary resolves", () => {
    const cs = runDoctorChecks("hostloop", OK_PROBE);
    expect(get(cs, "hostAgent").status).toBe("ok");
  });

  it("also checks the native binary for the cowork tier", () => {
    const cs = runDoctorChecks("cowork", probe({ hostAgentBinary: () => ({ ok: false, error: "not found" }) }));
    expect(get(cs, "hostAgent").status).toBe("fail");
  });

  it("is absent (not just skipped) for container tier — the check doesn't apply there", () => {
    const cs = runDoctorChecks("container", OK_PROBE);
    expect(cs.find((c) => c.id === "hostAgent")).toBeUndefined();
  });

  // A patch-tolerated native staging-drift substitution stays `ok` (safe — no sha256 pin on the
  // native binary) but must surface a note naming the pinned-vs-found versions, so the substitution is
  // visible rather than silent. Exact matches stay ok with no note; a major/minor miss stays a fail.
  it("patch-tolerated substitution → status ok, with a note naming the pinned/found versions", () => {
    const cs = runDoctorChecks(
      "hostloop",
      probe({
        hostAgentBinary: () => ({
          ok: true,
          path: "/x/claude-code/2.1.208/claude.app/Contents/MacOS/claude",
          note: "patch-tolerated: pinned 2.1.205, using 2.1.208",
        }),
      }),
    );
    const hostAgent = get(cs, "hostAgent");
    expect(hostAgent.status).toBe("ok");
    expect(hostAgent.detail).toMatch(/2\.1\.205/);
    expect(hostAgent.detail).toMatch(/2\.1\.208/);
    expect(blocking(cs)).not.toContain("hostAgent");
  });

  it("exact match → status ok, no version-substitution note", () => {
    const cs = runDoctorChecks("hostloop", OK_PROBE); // OK_PROBE's hostAgentBinary carries no `note`
    const hostAgent = get(cs, "hostAgent");
    expect(hostAgent.status).toBe("ok");
    expect(hostAgent.detail).not.toMatch(/patch-tolerated/);
  });

  it("major/minor miss (no env fallback) → status fail, same as before", () => {
    const cs = runDoctorChecks(
      "hostloop",
      probe({
        hostAgentBinary: () => ({
          ok: false,
          error: "cowork-harness: baseline NATIVE agent binary not found: /x/claude-code/2.1.205/claude.app/Contents/MacOS/claude.",
        }),
      }),
    );
    const hostAgent = get(cs, "hostAgent");
    expect(hostAgent.status).toBe("fail");
    expect(blocking(cs)).toContain("hostAgent");
  });
});

// The `agent` check (staged VM ELF) is strict on container/microvm (the ELF IS the executed agent there),
// but on hostloop/cowork it's a non-executed parity mount into the bash sidecar, so doctor must ask the
// probe for `parityMount` tolerance — mirroring resolveAgentBinary's `{ parityMount: true }` opt-in.
describe("doctor — agent check parity-mount tolerance by tier", () => {
  it("--tier cowork asks for the VM ELF in parity-mount mode (tolerant)", () => {
    let sawParity: boolean | undefined;
    const cs = runDoctorChecks(
      "cowork",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude" };
        },
      }),
    );
    expect(sawParity).toBe(true);
    expect(get(cs, "agent").status).toBe("ok");
  });

  it("--tier hostloop also asks for parity-mount tolerance", () => {
    let sawParity: boolean | undefined;
    runDoctorChecks(
      "hostloop",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude" };
        },
      }),
    );
    expect(sawParity).toBe(true);
  });

  it("--tier container keeps the VM ELF check STRICT (no parity mount)", () => {
    let sawParity: boolean | undefined;
    runDoctorChecks(
      "container",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude" };
        },
      }),
    );
    expect(sawParity).toBeFalsy();
  });

  it("--tier microvm keeps the VM ELF check STRICT (no parity mount)", () => {
    let sawParity: boolean | undefined;
    runDoctorChecks(
      "microvm",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude" };
        },
      }),
    );
    expect(sawParity).toBeFalsy();
  });

  it("a parity-patch substitution note is surfaced in the agent check's detail", () => {
    const cs = runDoctorChecks(
      "cowork",
      probe({
        agentBinary: () => ({
          ok: true,
          path: "/x/claude-code-vm/2.1.178/claude",
          note: "parity mount: patch-tolerated (pinned 2.1.177, using 2.1.178)",
        }),
      }),
    );
    const agent = get(cs, "agent");
    expect(agent.status).toBe("ok");
    expect(agent.detail).toMatch(/2\.1\.177/);
    expect(agent.detail).toMatch(/2\.1\.178/);
    expect(blocking(cs)).not.toContain("agent");
  });
});

describe("freshnessFor (pure pin comparison — the injectable probe cannot reach realProbe)", () => {
  const A = "sha256:" + "a".repeat(64);
  const B = "sha256:" + "b".repeat(64);
  const REF = "ghcr.io/yaniv-golan/cowork-agent-base:2";

  it("is unknown for a custom image with no published counterpart", () => {
    expect(freshnessFor("my/custom:latest", null, A, A).state).toBe("unknown");
  });

  it("is local when the image has no registry digest, even if a pin exists", () => {
    // README documents `docker build` as supported; a local build has empty RepoDigests and can never
    // match a registry pin. Failing it would break the documented workflow.
    expect(freshnessFor("cowork-agent-base:2", REF, null, A).state).toBe("local");
  });

  it("is unpinned — not current — when this build carries no pin", () => {
    // Must never read as `current`: "no pin" is not "matches".
    expect(freshnessFor("cowork-agent-base:2", REF, A, null).state).toBe("unpinned");
  });

  it("is current when the local digest equals the pin", () => {
    expect(freshnessFor("cowork-agent-base:2", REF, A, A).state).toBe("current");
  });

  it("is stale when they differ, and offers a DIGEST-addressed remedy", () => {
    const f = freshnessFor("cowork-agent-base:2", REF, B, A);
    expect(f.state).toBe("stale");
    // Pulling the floating `:2` cannot satisfy a pin to an older revision — a floating remedy leaves the
    // user in a permanent warn loop, and inverts the signal once a newer revision is published.
    expect((f as { pinnedRef: string }).pinnedRef).toBe(`ghcr.io/yaniv-golan/cowork-agent-base@${A}`);
  });
});

describe("registryDigestFrom (which RepoDigest counts as 'this image, from the registry')", () => {
  const D1 = "sha256:" + "1".repeat(64);
  const D2 = "sha256:" + "2".repeat(64);
  const GHCR = "ghcr.io/yaniv-golan/cowork-agent-full";

  it("matches the BARE local name, not just the ghcr-qualified one", () => {
    // The regression this exists for: `cowork-agent-full:2` carries only `cowork-agent-full@sha256:…`
    // (no registry prefix), so a ghcr-only filter missed it, reported `local`, and silently skipped the
    // pin check for every full-parity user.
    expect(registryDigestFrom([`cowork-agent-full@${D1}`], GHCR, "cowork-agent-full:2")).toBe(D1);
  });

  it("matches the ghcr-qualified form", () => {
    expect(registryDigestFrom([`${GHCR}@${D1}`], GHCR, "cowork-agent-full:2")).toBe(D1);
  });

  it("prefers the ghcr-qualified digest when both forms are present and disagree", () => {
    // A machine can hold digests for the same name from two registries. The published one wins.
    expect(registryDigestFrom([`cowork-agent-full@${D2}`, `${GHCR}@${D1}`], GHCR, "cowork-agent-full:2")).toBe(D1);
  });

  it("is null for a genuinely local build (empty RepoDigests)", () => {
    expect(registryDigestFrom([], GHCR, "cowork-agent-full:2")).toBeNull();
  });

  it("ignores an unrelated image's digest", () => {
    expect(registryDigestFrom([`some-other/image@${D1}`], GHCR, "cowork-agent-full:2")).toBeNull();
  });

  it("does not treat a name PREFIX as a match", () => {
    // `cowork-agent-full-extra@…` must not satisfy `cowork-agent-full`.
    expect(registryDigestFrom([`cowork-agent-full-extra@${D1}`], GHCR, "cowork-agent-full:2")).toBeNull();
  });
});

describe("image-freshness is offline", () => {
  it("the freshness path spawns no network-reaching command", () => {
    // The check's whole selling point over the old GHCR round-trip is that it works with no network and
    // no `docker buildx`. That property was previously argued from "I removed the call" — which is not a
    // thing that can fail later. This asserts it: the only spawn in imageFreshness is a LOCAL
    // `image inspect` (a daemon-socket call), and the pin is read from disk.
    const src = readFileSync(resolve("src/run/doctor.ts"), "utf8");
    const body = src.slice(src.indexOf("imageFreshness(): ImageFreshness {"));
    // Strip line comments: the body legitimately EXPLAINS the removed round-trip, and a guard that trips
    // on its own rationale would just get the rationale deleted.
    const fn = body
      .slice(0, body.indexOf("\n  },"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of ["buildx", "imagetools", "curl", "fetch(", "https://"]) {
      expect(fn, `imageFreshness must not reach the network (found ${forbidden})`).not.toContain(forbidden);
    }
    // Exactly one spawn, and it is the local inspect.
    expect(fn.match(/spawnSync\(/g)?.length ?? 0).toBe(1);
    expect(fn).toContain('"image", "inspect"');
  });
});

// `eval` refuses before spend on doctor's own token check, so the check must be ONE function that doctor
// itself uses — a second detector could decide a tier differently from what doctor prints.
describe("doctor — tokenCheck is the token row runDoctorChecks reports", () => {
  const tiers = ["protocol", "container", "microvm", "hostloop", "cowork"] as const;
  const probes: Array<Partial<DoctorProbe>> = [
    {},
    { hasToken: () => false },
    { hasToken: () => false, hasKeychainToken: () => true },
    { hasToken: () => false, hasKeychainToken: () => true, platform: () => "linux" },
    { hasToken: () => false, worktreeEnv: () => "/main/.env" },
  ];
  it.each(tiers)("at %s, for every token situation", (tier) => {
    for (const over of probes) expect(tokenCheck(tier, probe(over))).toEqual(get(runDoctorChecks(tier, probe(over)), "token"));
  });
  it("the consumer's case — Keychain only, no env token — fails at hostloop and cowork and only warns at protocol", () => {
    const kc = probe({ hasToken: () => false, hasKeychainToken: () => true });
    expect(tokenCheck("hostloop", kc).status).toBe("fail");
    expect(tokenCheck("cowork", kc).status).toBe("fail");
    expect(tokenCheck("protocol", kc).status).toBe("warn");
  });
});

// Claude Code on Linux (and wherever it has no Keychain) keeps its login in `<config dir>/.credentials.json`.
// protocol keeps the operator's real config dir, so the agent signs itself in from that file, exactly as it
// does from the macOS Keychain; every other tier gives it a managed dir, where the file is not seen.
describe("doctor — a signed-in config dir (.credentials.json) counts at protocol only", () => {
  const credsFile = (path: string | null) => ({ hasToken: () => false, configCredentialsFile: () => path });
  it.each(["linux", "darwin"])("on %s: warn at protocol, naming the file, never reading it", (plat) => {
    const tok = tokenCheck("protocol", probe({ ...credsFile("/home/u/.claude/.credentials.json"), platform: () => plat }));
    expect(tok.status).toBe("warn");
    expect(tok.detail).toMatch(/\/home\/u\/\.claude\/\.credentials\.json/);
    expect(tok.remedy).toMatch(/setup-token/);
  });
  it.each(["container", "microvm", "hostloop", "cowork"] as const)("still fails at %s", (tier) => {
    expect(tokenCheck(tier, probe({ ...credsFile("/home/u/.claude/.credentials.json"), platform: () => "linux" })).status).toBe("fail");
  });
  it("no file (and no Keychain, no token) still fails at protocol", () => {
    expect(tokenCheck("protocol", probe({ ...credsFile(null), platform: () => "linux" })).status).toBe("fail");
  });
  it("an env token still wins, and the file is not consulted", () => {
    let asked = false;
    const tok = tokenCheck("protocol", probe({ configCredentialsFile: () => ((asked = true), "/x/.credentials.json") }));
    expect(tok.status).toBe("ok");
    expect(asked).toBe(false);
  });
  it("the real probe looks in CLAUDE_CONFIG_DIR when set, else ~/.claude, by existence only", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-creds-"));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = dir;
      expect(realProbe.configCredentialsFile!()).toBeNull();
      writeFileSync(join(dir, ".credentials.json"), "not json — never parsed");
      expect(realProbe.configCredentialsFile!()).toBe(join(dir, ".credentials.json"));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The native agent's remedy is keyed on WHY it was not found. "Open Cowork once" is the wrong advice for a
// version mismatch, for a staging layout this harness cannot read, on Linux (no native macOS agent at all),
// and for an account whose Claude runs on its organization's infrastructure (Desktop stages nothing locally).
describe("doctor — native agent remedy per cause", () => {
  const kinds = ["major-minor", "build", "missing-root", "missing", "unfinished", "unusable-build", "unknown-layout", "override"] as const;

  it("every cause has its own remedy, and none says 'open Cowork once'", () => {
    const seen = new Set<string>();
    for (const k of kinds) {
      const r = nativeAgentRemedy(k, "darwin");
      expect(r, k).not.toMatch(/open (Claude )?Cowork once/i);
      seen.add(r);
    }
    expect(seen.size).toBe(kinds.length);
  });

  it("version/build mismatches name the fallback env var; missing causes name COWORK_HOST_AGENT_BINARY", () => {
    expect(nativeAgentRemedy("major-minor", "darwin")).toContain("COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1");
    expect(nativeAgentRemedy("build", "darwin")).toContain("COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1");
    for (const k of ["missing-root", "missing", "unfinished", "unknown-layout"] as const)
      expect(nativeAgentRemedy(k, "darwin"), k).toContain("COWORK_HOST_AGENT_BINARY");
    expect(nativeAgentRemedy("missing-root", "darwin")).toMatch(/organization/);
    expect(nativeAgentRemedy("unfinished", "darwin")).toMatch(/\.verified|finish/);
    expect(nativeAgentRemedy("major-minor", "darwin")).not.toMatch(/recovering-an-old-agent-version/);
  });

  // docs/cli.md's platform table: Linux live is `container` only (microvm is Apple-VZ); Windows is
  // replay/protocol only. A Mach-O override cannot run off macOS, so it is not offered there.
  it("off macOS the remedy is the exact platform text, for every cause but override", () => {
    const LINUX =
      "hostloop, and cowork when it resolves to host-loop, run the native macOS agent binary, which does not exist on linux — use --tier container (docs/cli.md#prerequisites-for-anything-above-protocol-fidelity)";
    const WIN =
      "hostloop, and cowork when it resolves to host-loop, run the native macOS agent binary, which does not exist on win32 — use --tier protocol or replay (docs/cli.md#prerequisites-for-anything-above-protocol-fidelity)";
    for (const k of ["major-minor", "build", "missing-root", "missing", "unfinished", "unusable-build", "unknown-layout"] as const) {
      expect(nativeAgentRemedy(k, "linux"), k).toBe(LINUX);
      expect(nativeAgentRemedy(k, "win32"), k).toBe(WIN);
    }
    expect(nativeAgentRemedy("override", "linux")).toMatch(/COWORK_HOST_AGENT_BINARY/);
  });

  it("runDoctorChecks renders the remedy for the probe's kind", () => {
    const cs = runDoctorChecks("hostloop", probe({ hostAgentBinary: () => ({ ok: false, error: "x", kind: "major-minor" }) }));
    expect(get(cs, "hostAgent").remedy).toBe(nativeAgentRemedy("major-minor", "darwin"));
    const linux = runDoctorChecks(
      "hostloop",
      probe({ platform: () => "linux", hostAgentBinary: () => ({ ok: false, error: "x", kind: "missing-root" }) }),
    );
    expect(get(linux, "hostAgent").remedy).toBe(nativeAgentRemedy("missing-root", "linux"));
  });
});

// The REAL probe, end to end: loadBaseline("latest") + the resolver + the classifier + the override check.
// HOME points at a temp dir (os.homedir() honours it on POSIX), so the staged tree is a fixture and never
// the operator's Application Support.
describe("doctor — real hostAgentBinary probe over a temp HOME", () => {
  const LEAF = ["claude.app", "Contents", "MacOS", "claude"];
  const BUILD = "f2326db61802";
  const pinned = () => pinnedNativeAgentVersion(loadBaseline("latest"))!;
  const withHome = (fn: (home: string) => void) => {
    const saved = { HOME: process.env.HOME, O: process.env.COWORK_HOST_AGENT_BINARY, F: process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK };
    const home = mkdtempSync(join(tmpdir(), "cowork-doctor-home-"));
    process.env.HOME = home;
    delete process.env.COWORK_HOST_AGENT_BINARY;
    delete process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK;
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      fn(home);
    } finally {
      process.stderr.write = write;
      for (const [k, v] of [
        ["HOME", saved.HOME],
        ["COWORK_HOST_AGENT_BINARY", saved.O],
        ["COWORK_HARNESS_ALLOW_AGENT_FALLBACK", saved.F],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      rmSync(home, { recursive: true, force: true });
    }
  };
  const stageBuild = (home: string, ver: string, build = BUILD, mtime = 100) => {
    const dir = join(home, "Library", "Application Support", "Claude", "claude-code", ver, build);
    mkdirSync(join(dir, ...LEAF.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...LEAF), "#!/bin/sh\n");
    writeFileSync(join(dir, ".verified"), build + "0".repeat(52));
    utimesSync(join(dir, ".verified"), mtime, mtime);
    return join(dir, ...LEAF);
  };
  const patchBump = (v: string) => {
    const [a, b, c] = v.split(".").map(Number);
    return `${a}.${b}.${c + 2}`;
  };

  it("latest baseline's flat pin, only a patch-newer nested build staged → ok, patch-tolerated note", () => {
    withHome((home) => {
      const found = patchBump(pinned());
      const bin = stageBuild(home, found);
      const r = realProbe.hostAgentBinary();
      expect(r).toMatchObject({ ok: true, path: bin });
      expect(r.ok && r.note).toContain(`patch-tolerated: pinned ${pinned()}, using ${found}`);
      const cs = runDoctorChecks("hostloop", probe({ hostAgentBinary: realProbe.hostAgentBinary }));
      expect(get(cs, "hostAgent").status).toBe("ok");
      expect(blocking(cs)).not.toContain("hostAgent");
    });
  });

  it("COWORK_HOST_AGENT_BINARY set → ok with NO drift note, even while a patch drift exists on disk", () => {
    withHome((home) => {
      const bin = stageBuild(home, patchBump(pinned()));
      process.env.COWORK_HOST_AGENT_BINARY = bin;
      const r = realProbe.hostAgentBinary();
      expect(r).toMatchObject({ ok: true, path: bin });
      expect(r.ok && r.note).toBeFalsy();
    });
  });

  // A FLAT pin is what every baseline before desktop-2.19675.0 carries, so this case pins one explicitly
  // rather than reading `latest` (which now names a build). It drives the same three calls the real probe
  // makes — resolver, classifier, note — so the end-to-end path is the one doctor runs.
  it("two builds of the pinned version (flat pin) → ok, with relocated AND ambiguous notes naming both builds", () => {
    withHome((home) => {
      const flat = loadBaseline("desktop-2.16120.0");
      const ver = pinnedNativeAgentVersion(flat)!;
      expect(flat.agentBinary?.nativeStagedPath).toMatch(new RegExp(`/${ver.replace(/\./g, "\\.")}/claude\\.app/`)); // precondition: flat
      stageBuild(home, ver, "aaaaaaaaaaaa", 100);
      const bin = stageBuild(home, ver, "bbbbbbbbbbbb", 200);
      expect(resolveHostAgentBinary(flat)).toBe(bin);
      const note = nativeDriftNote(classifyNativeStagingDrift(flat));
      expect(note).toMatch(/pinned path uses the flat layout/);
      expect(note).toMatch(/ambiguous: 2 builds of [\d.]+, using bbbbbbbbbbbb/);
    });
  });

  // `latest` (desktop-2.19675.0 onwards) pins the BUILD. The pinned build wins over a newer sibling build of
  // the same version — no drift and no ambiguity, so no note at all.
  it("latest's build pin with a newer sibling build of the same version staged → ok, the PINNED build", () => {
    withHome((home) => {
      const pinnedPath = loadBaseline("latest").agentBinary?.nativeStagedPath ?? "";
      const build = pinnedPath.match(/\/[\d.]+\/([0-9a-f]{12})\/claude\.app\//)?.[1];
      expect(build).toBeDefined(); // precondition: latest pins a build
      const bin = stageBuild(home, pinned(), build!, 100);
      stageBuild(home, pinned(), "bbbbbbbbbbbb", 200);
      const r = realProbe.hostAgentBinary();
      expect(r).toMatchObject({ ok: true, path: bin });
      expect(r.ok && r.note).toBeFalsy(); // exact build pin: no drift, no ambiguity
    });
  });

  // latest (desktop-2.19675.0 onwards) also pins the build PER ARCH. An x64 host is held to the x64 entry, not
  // to the arm64 build in nativeStagedPath — through the real probe, with the host arch faked.
  const asArch = (arch: string, fn: () => void) => {
    const saved = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "arch", saved);
    }
  };
  it("x64 host: latest's x64 build staged → ok, no note; another x64 build only → fail, kind build", () => {
    const x64 = loadBaseline("latest").agentBinary?.nativeBuilds?.x64;
    expect(x64, "precondition: latest pins an x64 build").toMatch(/^[0-9a-f]{12}$/);
    asArch("x64", () => {
      withHome((home) => {
        const bin = stageBuild(home, pinned(), x64!, 100);
        const r = realProbe.hostAgentBinary();
        expect(r).toMatchObject({ ok: true, path: bin });
        expect(r.ok && r.note).toBeFalsy();
      });
      withHome((home) => {
        stageBuild(home, pinned(), "cccccccccccc", 100);
        expect(realProbe.hostAgentBinary()).toMatchObject({ ok: false, kind: "build" });
      });
    });
  });

  it("a major/minor jump staged → fail, kind major-minor, and doctor gives that cause's remedy (not 'nothing staged')", () => {
    withHome((home) => {
      const [a, b] = pinned().split(".").map(Number);
      stageBuild(home, `${a}.${b + 1}.0`);
      const r = realProbe.hostAgentBinary();
      expect(r).toMatchObject({ ok: false, kind: "major-minor" });
      const cs = runDoctorChecks("hostloop", probe({ hostAgentBinary: realProbe.hostAgentBinary }));
      expect(get(cs, "hostAgent").remedy).toBe(nativeAgentRemedy("major-minor", "darwin"));
    });
  });

  it("an unfinished build of the pinned version only → fail, kind unfinished", () => {
    withHome((home) => {
      const bin = stageBuild(home, pinned());
      rmSync(join(bin, "..", "..", "..", "..", ".verified"));
      expect(realProbe.hostAgentBinary()).toMatchObject({ ok: false, kind: "unfinished" });
    });
  });

  it("an unrecognised entry in the pinned version dir only → fail, kind unknown-layout", () => {
    withHome((home) => {
      mkdirSync(join(home, "Library", "Application Support", "Claude", "claude-code", pinned(), "weird"), { recursive: true });
      expect(realProbe.hostAgentBinary()).toMatchObject({ ok: false, kind: "unknown-layout" });
    });
  });

  it("an empty HOME (no Desktop) → fail, kind missing-root, and doctor gives that cause's remedy", () => {
    withHome(() => {
      const r = realProbe.hostAgentBinary();
      expect(r).toMatchObject({ ok: false, kind: "missing-root" });
      const cs = runDoctorChecks("hostloop", probe({ hostAgentBinary: realProbe.hostAgentBinary }));
      expect(get(cs, "hostAgent").status).toBe("fail");
      expect(get(cs, "hostAgent").remedy).toBe(nativeAgentRemedy("missing-root", "darwin"));
    });
  });
});

// The pure note builder, one row per branch (the real-probe cases above cover patch, relocated and ambiguous
// end to end).
describe("doctor — nativeDriftNote", () => {
  const base = { stagedPath: "/x", pinned: "2.1.286", found: "2.1.286" };
  it("exact and unambiguous → no note", () => {
    expect(nativeDriftNote({ ...base, kind: "exact", layout: "nested", foundBuild: "aaaaaaaaaaaa" })).toBeUndefined();
  });
  it("relocated from a flat pin into a build dir", () => {
    expect(nativeDriftNote({ ...base, kind: "exact", relocated: true, layout: "nested", foundBuild: "aaaaaaaaaaaa" })).toBe(
      "pinned path uses the flat layout; the same version is staged at 2.1.286/aaaaaaaaaaaa/",
    );
  });
  it("relocated, with the pinned flat file still present", () => {
    expect(
      nativeDriftNote({ ...base, kind: "exact", relocated: true, pinnedFilePresent: true, layout: "nested", foundBuild: "aaaaaaaaaaaa" }),
    ).toBe(
      "pinned path uses the flat layout; the same version is staged at 2.1.286/aaaaaaaaaaaa/, which runs; the pinned flat file is also still present",
    );
  });
  it("relocated from a build pin to a flat install carrying that build's marker", () => {
    expect(nativeDriftNote({ ...base, kind: "exact", relocated: true, layout: "flat", pinnedBuild: "aaaaaaaaaaaa" })).toBe(
      "pinned build aaaaaaaaaaaa found as a flat install",
    );
  });
  it("ambiguous: names the count, the chosen build and the rule", () => {
    expect(
      nativeDriftNote({ ...base, kind: "exact", layout: "nested", foundBuild: "bbbbbbbbbbbb", others: ["aaaaaaaaaaaa", "cccccccccccc"] }),
    ).toBe("ambiguous: 3 builds of 2.1.286, using bbbbbbbbbbbb (newest .verified)");
  });
  it("a different build under the fallback env", () => {
    expect(nativeDriftNote({ ...base, kind: "build", pinnedBuild: "aaaaaaaaaaaa", foundBuild: "bbbbbbbbbbbb", layout: "nested" })).toBe(
      "fallback (COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1): pinned build aaaaaaaaaaaa, using bbbbbbbbbbbb of 2.1.286",
    );
  });
  it("a major/minor jump under the fallback env", () => {
    expect(
      nativeDriftNote({ ...base, kind: "major-minor", pinned: "2.1.284", found: "2.2.0", layout: "nested", foundBuild: "bbbbbbbbbbbb" }),
    ).toBe("fallback (COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1): pinned 2.1.284, using 2.2.0 (build bbbbbbbbbbbb)");
  });
  it("patch", () => {
    expect(nativeDriftNote({ ...base, kind: "patch", pinned: "2.1.284", layout: "flat" })).toBe(
      "patch-tolerated: pinned 2.1.284, using 2.1.286",
    );
  });
});

// The container ELF, through the REAL probe and resolver over a temp HOME — the kind doctor keys its
// remedy on comes from the producer, not from the test.
describe("doctor — real agentBinary probe over a temp HOME", () => {
  const withHome = (fn: (home: string) => void) => {
    const saved = { HOME: process.env.HOME, O: process.env.COWORK_AGENT_BINARY, F: process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK };
    const home = mkdtempSync(join(tmpdir(), "cowork-doctor-home-"));
    process.env.HOME = home;
    delete process.env.COWORK_AGENT_BINARY;
    delete process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK;
    try {
      fn(home);
    } finally {
      for (const [k, v] of [
        ["HOME", saved.HOME],
        ["COWORK_AGENT_BINARY", saved.O],
        ["COWORK_HARNESS_ALLOW_AGENT_FALLBACK", saved.F],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      rmSync(home, { recursive: true, force: true });
    }
  };
  it("the pinned ELF pruned, a sibling staged → kind pruned, and doctor's container remedy names the runbook", () => {
    withHome((home) => {
      const dir = join(home, "Library", "Application Support", "Claude", "claude-code-vm", "0.0.1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude"), "x");
      const r = realProbe.agentBinary();
      expect(r).toMatchObject({ ok: false, kind: "pruned" });
      const cs = runDoctorChecks("container", probe({ agentBinary: realProbe.agentBinary }));
      expect(get(cs, "agent").remedy).toBe(agentRemedy("pruned", false));
    });
  });
  it("nothing staged → kind missing", () => {
    withHome(() => {
      expect(realProbe.agentBinary()).toMatchObject({ ok: false, kind: "missing" });
    });
  });
});

describe("doctor — container agent remedy for a pruned pin", () => {
  it("names the recovery runbook and COWORK_AGENT_BINARY, not 'open Cowork once'", () => {
    const cs = runDoctorChecks("container", probe({ agentBinary: () => ({ ok: false, error: "x", kind: "pruned" }) }));
    const r = get(cs, "agent").remedy!;
    expect(r).toBe(agentRemedy("pruned", false));
    expect(r).toContain("docs/maintenance.md#recovering-an-old-agent-version");
    expect(r).toContain("COWORK_AGENT_BINARY");
    expect(r).not.toMatch(/open Claude Cowork once/);
  });
  it("a never-staged ELF: Desktop stages it on macOS; elsewhere point COWORK_AGENT_BINARY at a Linux ELF", () => {
    const r = agentRemedy("missing", false);
    expect(r).not.toMatch(/open Claude Cowork once/i);
    expect(r).toMatch(/macOS/);
    expect(r).toMatch(/COWORK_AGENT_BINARY=<path> to a Linux ELF/);
  });
  it("override → fix or unset COWORK_AGENT_BINARY", () => {
    expect(agentRemedy("override", false)).toBe("fix or unset COWORK_AGENT_BINARY — it names a path that does not exist");
  });
  it("parity mount appends the non-executed note to every cause", () => {
    for (const k of ["pruned", "missing", "override", undefined])
      expect(agentRemedy(k, true)).toBe(
        `${agentRemedy(k, false)} — note: on this tier the ELF is a non-executed parity mount, not the binary that actually runs (that's the native \`hostAgent\` check below)`,
      );
  });
});
