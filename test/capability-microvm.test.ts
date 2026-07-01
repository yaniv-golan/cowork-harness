import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:child_process so vmStatus's `limactl list` and probeMicrovmOmitted's `limactl shell`
// spawnSync calls are scriptable. Module-level mock intercepts both call sites.
const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...a: any[]) => spawnSync(...a) }));

import { probeMicrovmOmitted } from "../src/runtime/image-capabilities.js";

const INSTANCE = "cowork-vm-test";

/** Build a spawnSync return for `limactl list <instance> --format {{.Status}}`. */
function listResult(status: string) {
  return { status: 0, stdout: status + "\n", stderr: "" };
}
/** Build a spawnSync return for the `limactl shell` capability probe. */
function shellProbeResult(presentFamilies: string[]) {
  return { status: 0, stdout: `COWORK_PRESENT: ${presentFamilies.join(" ")}\n`, stderr: "" };
}

/** Route a spawnSync call: argv[0]==='list' → vmStatus; argv[0]==='shell' → probe. */
function router(listCb: () => any, shellCb: () => any) {
  return (_cmd: string, args: string[]) => {
    if (args[0] === "list") return listCb();
    if (args[0] === "shell") return shellCb();
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
}

let runsDir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "cap-microvm-"));
  process.env.COWORK_HARNESS_RUNS_DIR = runsDir;
  spawnSync.mockReset();
  warnSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  delete process.env.COWORK_HARNESS_RUNS_DIR;
  warnSpy.mockRestore();
});

describe("probeMicrovmOmitted — silent vmStatus gate", () => {
  it("returns null WITHOUT spawning limactl shell when vmStatus is 'Absent' (cold run)", () => {
    spawnSync.mockImplementation(
      router(
        () => listResult("Absent"),
        () => shellProbeResult(["ocr"]),
      ),
    );
    const result = probeMicrovmOmitted(INSTANCE);
    expect(result).toBeNull();
    // The shell probe must NOT have been issued.
    const shellCalls = spawnSync.mock.calls.filter((c: any) => c[1][0] === "shell");
    expect(shellCalls).toHaveLength(0);
    // No ::warning:: must be emitted for the not-Running case.
    const written = warnSpy.mock.calls.map((c: any) => String(c[0])).join("");
    expect(written).not.toMatch(/::warning::/);
  });

  it("returns null WITHOUT spawning limactl shell when vmStatus is 'Stopped'", () => {
    spawnSync.mockImplementation(
      router(
        () => listResult("Stopped"),
        () => shellProbeResult(["ocr"]),
      ),
    );
    const result = probeMicrovmOmitted(INSTANCE);
    expect(result).toBeNull();
    const shellCalls = spawnSync.mock.calls.filter((c: any) => c[1][0] === "shell");
    expect(shellCalls).toHaveLength(0);
    const written = warnSpy.mock.calls.map((c: any) => String(c[0])).join("");
    expect(written).not.toMatch(/::warning::/);
  });

  it("proceeds to probe via limactl shell when vmStatus is 'Running' and returns the omitted set", () => {
    spawnSync.mockImplementation(
      router(
        () => listResult("Running"),
        () => shellProbeResult(["ocr", "cv"]),
      ),
    );
    const result = probeMicrovmOmitted(INSTANCE);
    // ocr and cv are present → they are NOT in the omitted set; other families are omitted.
    expect(result).not.toBeNull();
    expect(result).not.toContain("ocr");
    expect(result).not.toContain("cv");
    // The shell probe was issued.
    const shellCalls = spawnSync.mock.calls.filter((c: any) => c[1][0] === "shell");
    expect(shellCalls).toHaveLength(1);
  });
});
