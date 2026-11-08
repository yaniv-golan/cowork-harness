import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A microVM whose first boot hit `limactl start`'s timeout is left Running with provisioning unfinished.
// Reusing it — and then sealing it with the guest firewall — stranded it permanently: apt could never
// finish, the agent never reached PATH, and every later run failed with an opaque protocol error. These
// tests drive `vmInit` against a scripted `limactl` (every spawn goes through the mocked spawnSync) and
// pin that a reused VM must be READY before it is handed back.

const FAKE_HOME = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/lima-readiness-home-${process.pid}`);
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => FAKE_HOME }));

const spawnSync = vi.fn();
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawnSync: (...a: any[]) => spawnSync(...a),
}));
// The strict agent-binary resolution (existence + sha) is covered elsewhere; here it only has to succeed.
vi.mock("../src/baseline.js", async (orig) => ({
  ...(await orig<typeof import("../src/baseline.js")>()),
  resolveAgentBinary: () => "/fake/claude-code-vm/2.1.0/claude",
}));

import * as lima from "../src/runtime/lima.js";

const { spawnSync: realSpawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
import type { PlatformBaseline } from "../src/types.js";

const INSTANCE = "cowork-vm-readiness";
const BASELINE = { agentBinary: { stagedPath: "/fake/claude-code-vm/2.1.0/claude" } } as unknown as PlatformBaseline;

type Reply = { status: number | null; stdout?: string; stderr?: string; error?: Error };
const ok = (stdout = ""): Reply => ({ status: 0, stdout, stderr: "" });

/** Script the fake limactl. `list` answers the status; a `shell` whose script names the boot marker is the
 *  readiness probe; start/stop/create succeed unless overridden. Every call is recorded in order. */
function script(opts: { status: () => string; readiness: () => Reply; start?: () => Reply }) {
  const calls: string[][] = [];
  spawnSync.mockImplementation((_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "list") return ok(opts.status() + "\n");
    if (args[0] === "shell" && args.join(" ").includes("lima-boot-done")) return opts.readiness();
    if (args[0] === "start") return opts.start ? opts.start() : ok();
    return ok();
  });
  return calls;
}
const state = (s: string): Reply => ok(`COWORK_PROVISIONING=${s}\n`);
const readinessCalls = (calls: string[][]) => calls.filter((a) => a[0] === "shell" && a.join(" ").includes("lima-boot-done"));

/** Make the poll loop instant. Guarded so the suite runs (and fails on behaviour, not on a missing export)
 *  against code that has no poll loop at all. */
function instantClock() {
  const clock = (lima as any).provisionClock as { sleep: (ms: number) => void; now: () => number } | undefined;
  if (!clock) return;
  let t = 0;
  vi.spyOn(clock, "now").mockImplementation(() => t);
  vi.spyOn(clock, "sleep").mockImplementation((ms: number) => {
    t += ms;
  });
}

beforeEach(() => {
  spawnSync.mockReset();
  process.env.COWORK_HARNESS_LIMA_INSTANCE = INSTANCE;
  delete process.env.COWORK_HARNESS_VM_PROVISION_TIMEOUT_S;
  instantClock();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.COWORK_HARNESS_LIMA_INSTANCE;
  delete process.env.COWORK_HARNESS_VM_PROVISION_TIMEOUT_S;
  vi.restoreAllMocks();
});

describe("vmInit — a reused (Running) VM must be provisioned before it is returned", () => {
  it("control: a Running VM that reports ready is returned as-is (no restart)", () => {
    const calls = script({ status: () => "Running", readiness: () => state("ready") });
    expect(lima.vmInit(BASELINE)).toEqual({ instance: INSTANCE, status: "Running" });
    expect(calls.some((a) => a[0] === "start" || a[0] === "stop")).toBe(false);
  });

  it("waits while provisioning is still running, then returns once it is ready", () => {
    let n = 0;
    const calls = script({ status: () => "Running", readiness: () => (++n < 4 ? state("pending") : state("ready")) });
    expect(lima.vmInit(BASELINE).status).toBe("Running");
    expect(readinessCalls(calls)).toHaveLength(4);
  });

  it("gives up with a named error when provisioning never finishes within COWORK_HARNESS_VM_PROVISION_TIMEOUT_S", () => {
    process.env.COWORK_HARNESS_VM_PROVISION_TIMEOUT_S = "12";
    const calls = script({ status: () => "Running", readiness: () => state("pending") });
    expect(() => lima.vmInit(BASELINE)).toThrow(/never finished provisioning.*cowork-harness vm delete/s);
    // 12s at a 5s poll interval: probes at t=0, 5, 10 and a final one at the deadline — bounded, not a spin.
    expect(readinessCalls(calls).length).toBeGreaterThanOrEqual(2);
    expect(readinessCalls(calls).length).toBeLessThanOrEqual(5);
  });

  it("an unreachable guest (limactl shell failing) counts as still provisioning, not as ready", () => {
    process.env.COWORK_HARNESS_VM_PROVISION_TIMEOUT_S = "1";
    script({ status: () => "Running", readiness: () => ({ status: 255, stdout: "", stderr: "ssh: connect refused" }) });
    expect(() => lima.vmInit(BASELINE)).toThrow(/never finished provisioning/);
  });

  it("a VM firewalled mid-provisioning is restarted ONCE (iptables do not survive a reboot) and re-probed", () => {
    let booted = false;
    const calls = script({
      status: () => "Running",
      readiness: () => (booted ? state("ready") : state("sealed")),
      start: () => {
        booted = true;
        return ok();
      },
    });
    expect(lima.vmInit(BASELINE).status).toBe("Running");
    const verbs = calls.map((a) => a[0]).filter((v) => v === "stop" || v === "start");
    expect(verbs).toEqual(["stop", "start"]);
    expect(calls.find((a) => a[0] === "stop")).toContain("-f");
  });

  it("a sealed VM that is still not ready after its one restart fails with the vm delete remedy", () => {
    const calls = script({ status: () => "Running", readiness: () => state("sealed") });
    expect(() => lima.vmInit(BASELINE)).toThrow(/never finished provisioning.*cowork-harness vm delete/s);
    expect(calls.filter((a) => a[0] === "start")).toHaveLength(1); // exactly one restart, no loop
  });

  it("provisioning that ENDED without the agent on PATH fails immediately with the vm delete remedy", () => {
    const calls = script({ status: () => "Running", readiness: () => state("failed") });
    expect(() => lima.vmInit(BASELINE)).toThrow(/never finished provisioning.*agent.*cowork-harness vm delete/s);
    expect(readinessCalls(calls)).toHaveLength(1);
    expect(calls.some((a) => a[0] === "start" || a[0] === "delete")).toBe(false); // never auto-deletes
  });
});

describe("vmInit — the restart and fresh-start error paths name the remedy", () => {
  it("a failed restart of a sealed VM is the named error with the vm delete remedy", () => {
    script({ status: () => "Running", readiness: () => state("sealed"), start: () => ({ status: 1, stdout: "", stderr: "boom" }) });
    expect(() => lima.vmInit(BASELINE)).toThrow(/never finished provisioning.*restart.*cowork-harness vm delete/s);
  });

  it("a fresh start that comes up sealed does not claim a restart was tried", () => {
    let started = false;
    script({
      status: () => (started ? "Running" : "Stopped"),
      readiness: () => state("sealed"),
      start: () => {
        started = true;
        return ok();
      },
    });
    let msg = "";
    try {
      lima.vmInit(BASELINE);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/never finished provisioning.*firewall/s);
    expect(msg).not.toMatch(/restart did not/);
  });
});

// A deleted or pruned VM's name can come back (COWORK_HARNESS_LIMA_INSTANCE, or the same config hash), and the
// capability probe's per-instance cache would then describe a VM that no longer exists.
describe("vmDelete / vmPrune forget the instance's cached capability probe", () => {
  let runs: string;
  beforeEach(() => {
    runs = mkdtempSync(join(tmpdir(), "lima-cache-"));
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    writeFileSync(
      join(runs, "capability-cache.json"),
      JSON.stringify({ "microvm:cowork-vm-a": ["ocr"], "microvm:cowork-vm-b": [], "microvm:cowork-vm-keep": [], "container:x": [] }),
    );
  });
  afterEach(() => {
    delete process.env.COWORK_HARNESS_RUNS_DIR;
    rmSync(runs, { recursive: true, force: true });
  });
  const cache = async () => {
    const { readFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    return Object.keys(JSON.parse(readFileSync(join(runs, "capability-cache.json"), "utf8"))).sort();
  };

  it("vmDelete drops only that instance's entry", async () => {
    spawnSync.mockReturnValue(ok());
    lima.vmDelete("cowork-vm-a");
    expect(await cache()).toEqual(["container:x", "microvm:cowork-vm-b", "microvm:cowork-vm-keep"]);
  });

  it("vmPrune drops every pruned instance's entry and keeps the current one", async () => {
    spawnSync.mockImplementation((_c: string, args: string[]) =>
      args[0] === "list" ? ok("cowork-vm-a\ncowork-vm-b\ncowork-vm-keep\n") : ok(),
    );
    expect(lima.vmPrune("cowork-vm-keep").sort()).toEqual(["cowork-vm-a", "cowork-vm-b"]);
    expect(await cache()).toEqual(["container:x", "microvm:cowork-vm-keep"]);
  });
});

describe("vmInit — a fresh start is probed once, not polled", () => {
  for (const initial of ["Absent", "Stopped"]) {
    it(`${initial}: start then one probe; not ready ⇒ throws at once`, () => {
      let started = false;
      const calls = script({
        status: () => (started ? "Running" : initial),
        readiness: () => state("pending"),
        start: () => {
          started = true;
          return ok();
        },
      });
      expect(() => lima.vmInit(BASELINE)).toThrow(/has not finished provisioning/);
      expect(readinessCalls(calls)).toHaveLength(1);
    });

    it(`${initial}: still provisioning after start ⇒ the error says to re-run, not to delete`, () => {
      let started = false;
      script({
        status: () => (started ? "Running" : initial),
        readiness: () => state("pending"),
        start: () => {
          started = true;
          return ok();
        },
      });
      let msg = "";
      try {
        lima.vmInit(BASELINE);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/re-run; the next run waits for provisioning to finish \(COWORK_HARNESS_VM_PROVISION_TIMEOUT_S\)/);
      expect(msg).not.toMatch(/Delete it/);
    });

    it(`${initial}: start then ready ⇒ returns Running`, () => {
      let started = false;
      script({
        status: () => (started ? "Running" : initial),
        readiness: () => state("ready"),
        start: () => {
          started = true;
          return ok();
        },
      });
      expect(lima.vmInit(BASELINE).status).toBe("Running");
    });
  }

  it("passes a --timeout to limactl start so a slow first provision is not cut off at Lima's default", () => {
    let started = false;
    const calls = script({
      status: () => (started ? "Running" : "Absent"),
      readiness: () => state("ready"),
      start: () => {
        started = true;
        return ok();
      },
    });
    lima.vmInit(BASELINE);
    const start = calls.find((a) => a[0] === "start")!;
    expect(start[start.indexOf("--timeout") + 1]).toBe("20m");
  });
});

describe("provisioning readiness probe — exit-code and output mapping", () => {
  const map = (r: Reply) => (lima as any).provisioningFromProbe(r);
  it("maps each state token printed on exit 0", () => {
    for (const s of ["ready", "pending", "sealed", "failed"]) expect(map(state(s))).toBe(s);
  });
  it("a non-zero exit (ssh not up yet), a spawn error, a timeout (status null) or unrecognised output ⇒ pending", () => {
    expect(map({ status: 255, stdout: "COWORK_PROVISIONING=ready\n" })).toBe("pending");
    expect(map({ status: null, stdout: "" })).toBe("pending");
    expect(map({ status: 0, stdout: "", error: new Error("ENOENT") })).toBe("pending");
    expect(map(ok("something else\n"))).toBe("pending");
    expect(map(ok("COWORK_PROVISIONING=bogus\n"))).toBe("pending");
  });
});

// Execute the real guest script under `sh` with a fake `sudo` on PATH that answers each privileged check
// from env vars — so every branch of the script (not just its text) is exercised without a VM.
describe("provisioning readiness probe — the guest script's branches", () => {
  const dir = mkdtempSync(join(tmpdir(), "lima-probe-sh-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "sudo"),
    [
      "#!/bin/sh",
      '[ "$1" = "-n" ] && shift',
      'case "$1 $2 $3" in',
      '  "test -s /run/lima-boot-done") [ "$BOOT_DONE" = run ] ;;',
      '  "test -s /var/run/lima-boot-done") [ "$BOOT_DONE" = varrun ] ;;',
      '  "test -x /usr/local/bin/claude") [ "$AGENT" = 1 ] ;;',
      '  "iptables -S OUTPUT") [ "$IPT" = missing ] && exit 127; printf "%s\\n" "-P OUTPUT $IPT" "-A OUTPUT -o lo -j ACCEPT" ;;',
      "  *) exit 99 ;;",
      "esac",
    ].join("\n"),
  );
  chmodSync(join(bin, "sudo"), 0o755);
  const runProbe = (env: Record<string, string>) => {
    const r = realSpawnSync("sh", ["-c", (lima as any).provisioningProbeScript()], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    });
    return { exit: r.status, state: (lima as any).provisioningFromProbe(r) };
  };
  const cases: [string, Record<string, string>, string][] = [
    ["boot done + agent on PATH", { BOOT_DONE: "run", AGENT: "1", IPT: "ACCEPT" }, "ready"],
    ["boot done at the /var/run spelling", { BOOT_DONE: "varrun", AGENT: "1", IPT: "ACCEPT" }, "ready"],
    ["boot done, agent missing", { BOOT_DONE: "run", AGENT: "0", IPT: "ACCEPT" }, "failed"],
    // A sealed VM that has sat long enough for apt to give up: boot-done is written, the agent never landed.
    // A restart still recovers it, so it reads as sealed, not failed.
    ["boot done, agent missing, firewalled", { BOOT_DONE: "run", AGENT: "0", IPT: "DROP" }, "sealed"],
    ["boot done + agent on PATH, firewalled (an ordinary sealed-after-run VM)", { BOOT_DONE: "run", AGENT: "1", IPT: "DROP" }, "ready"],
    ["not done, OUTPUT policy DROP", { BOOT_DONE: "no", AGENT: "0", IPT: "DROP" }, "sealed"],
    ["not done, OUTPUT policy ACCEPT", { BOOT_DONE: "no", AGENT: "0", IPT: "ACCEPT" }, "pending"],
    ["not done, iptables not installed yet (exit 127)", { BOOT_DONE: "no", AGENT: "0", IPT: "missing" }, "pending"],
  ];
  for (const [name, env, expected] of cases)
    it(`${name} ⇒ ${expected} (script exits 0)`, () => {
      expect(runProbe(env)).toEqual({ exit: 0, state: expected });
    });
});
