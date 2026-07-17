import { describe, it, expect, vi } from "vitest";

// `doctor` computes `decideLoopFromBaseline(loadBaseline("latest"))` DIRECTLY (not through the injectable
// DoctorProbe) to gate the cowork VM-ELF parity-mount tolerance on the resolved loop — see
// runDoctorChecks's `coworkLoop`/`coworkIsHostLoop` in src/run/doctor.ts. Isolated in its own file (like
// test/staleness-resolved-tier.test.ts) because it mocks `loadBaseline` with a synthetic gate-controlled
// baseline to steer that resolution.
//
// The defect this guards: `doctor --tier cowork` used to apply the tolerance UNCONDITIONALLY, even when
// the baseline resolves cowork to VM-loop — where a cowork run executes the ELF directly through the
// STRICT container.ts path. That would make doctor report `agent: ok` (false-green) on a pruned-pin +
// patch-newer baseline that the real run hard-fails on.

const state = vi.hoisted(() => ({ gateOn: true }));

vi.mock("../src/baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/baseline.js")>();
  return {
    ...actual,
    loadBaseline: (name: string) => {
      if (name !== "latest") return actual.loadBaseline(name);
      // `hostLoop:1143815894` gate on ⇒ decideLoopFromBaseline resolves "host"; off ⇒ "vm".
      return {
        appVersion: "9.9.9",
        provenance: { gates: { "hostLoop:1143815894": { on: state.gateOn } } },
      } as unknown as ReturnType<typeof actual.loadBaseline>;
    },
  };
});

const { runDoctorChecks } = await import("../src/run/doctor.js");
type DoctorProbe = import("../src/run/doctor.js").DoctorProbe;
type DoctorCheck = import("../src/run/doctor.js").DoctorCheck;

const OK_PROBE: DoctorProbe = {
  nodeMajor: () => 20,
  platform: () => "darwin",
  arch: () => "arm64",
  runtimeName: () => "docker",
  runtimeAvailable: () => true,
  runtimeDaemonUp: () => true,
  limaAvailable: () => true,
  vmInstanceStatus: () => "Running",
  imageName: () => "cowork-agent-base:2",
  imagePresent: () => true,
  proxyImageName: () => "cowork-egress-proxy:2",
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

describe("doctor — cowork VM-ELF tolerance gated on the resolved loop", () => {
  it("cowork resolving to VM-loop → STRICT agent check (no parityMount) — no false-green", () => {
    state.gateOn = false; // gate off ⇒ decideLoopFromBaseline resolves "vm"
    let sawParity: boolean | undefined;
    const cs = runDoctorChecks(
      "cowork",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude-code-vm/2.1.177/claude" };
        },
      }),
    );
    expect(sawParity).toBeFalsy();
    expect(get(cs, "agent").title).toBe("Staged agent binary (VM/container ELF)"); // strict title, not the parity-mount one
    const loopNote = get(cs, "cowork-loop");
    expect(loopNote.detail).toMatch(/VM-loop/);
    expect(loopNote.detail).toMatch(/STRICT/);
  });

  it("cowork resolving to host-loop → TOLERANT agent check (parityMount)", () => {
    state.gateOn = true; // gate on ⇒ decideLoopFromBaseline resolves "host"
    let sawParity: boolean | undefined;
    const cs = runDoctorChecks(
      "cowork",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude-code-vm/2.1.177/claude" };
        },
      }),
    );
    expect(sawParity).toBe(true);
    const loopNote = get(cs, "cowork-loop");
    expect(loopNote.detail).toMatch(/hostloop/);
  });

  it("hostloop tier stays unconditionally tolerant even when the cowork gate resolves to VM-loop", () => {
    state.gateOn = false; // irrelevant to `hostloop` — it never consults the cowork gate
    let sawParity: boolean | undefined;
    runDoctorChecks(
      "hostloop",
      probe({
        agentBinary: (opts) => {
          sawParity = opts?.parityMount;
          return { ok: true, path: "/x/claude-code-vm/2.1.177/claude" };
        },
      }),
    );
    expect(sawParity).toBe(true);
  });
});

describe("doctor — native `hostAgent` requirement gated on the resolved loop (mirror of the agent gate)", () => {
  it("cowork resolving to VM-loop → hostAgent is NOT required (the ELF is the agent there, not the native binary)", () => {
    state.gateOn = false; // cowork → vm
    // native binary ABSENT: a VM-loop cowork run doesn't use it, so it must NOT block "not ready"
    const cs = runDoctorChecks("cowork", probe({ hostAgentBinary: () => ({ ok: false, error: "not staged" }) }));
    expect(get(cs, "hostAgent").required).toBe(false);
    expect(get(cs, "hostAgent").detail).toMatch(/not the executed agent at this resolution/);
    // and the overall verdict is not blocked by this check alone (no required check failed)
    expect(cs.filter((c) => c.required && c.status === "fail")).toHaveLength(0);
  });

  it("cowork resolving to host-loop → hostAgent IS required (the native binary is the executed agent)", () => {
    state.gateOn = true; // cowork → host
    const cs = runDoctorChecks("cowork", probe({}));
    expect(get(cs, "hostAgent").required).toBe(true);
  });

  it("hostloop tier → hostAgent IS required regardless of the cowork gate", () => {
    state.gateOn = false;
    const cs = runDoctorChecks("hostloop", probe({}));
    expect(get(cs, "hostAgent").required).toBe(true);
  });
});
