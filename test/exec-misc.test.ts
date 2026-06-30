import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { readSessionManifest, hostPathLeaked, scanEvents } from "../src/run/execute.js";
import { isHostFsSealed, boundaryAllowList } from "../src/boundary.js";
import { loadBaseline } from "../src/baseline.js";
import { clampTimeout } from "../src/hostloop/workspace-handler.js";

// Token-free, spawn-free coverage for the misc bug-hunt fixes.

// readSessionManifest: valid / corrupt-JSON / missing-key.
describe("execute — readSessionManifest", () => {
  const write = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-manifest-"));
    const f = join(dir, "session.json");
    writeFileSync(f, content);
    return f;
  };

  it("returns agentSessionId for a valid manifest", () => {
    const f = write(JSON.stringify({ sessionId: "s1", agentSessionId: "uuid-123" }));
    expect(readSessionManifest(f, "s1")).toBe("uuid-123");
  });

  it("throws a friendly corrupt-manifest error on invalid JSON (resume path)", () => {
    const f = write("{ this is not json");
    expect(() => readSessionManifest(f, "s1")).toThrow(/corrupt manifest/);
  });

  it("throws a clear error when agentSessionId is missing (resume path)", () => {
    const f = write(JSON.stringify({ sessionId: "s1" }));
    expect(() => readSessionManifest(f, "s1")).toThrow(/missing agentSessionId/);
  });

  it("throws when agentSessionId is present but not a string", () => {
    const f = write(JSON.stringify({ sessionId: "s1", agentSessionId: 42 }));
    expect(() => readSessionManifest(f, "s1")).toThrow(/missing agentSessionId/);
  });
});

// hostPathLeaked: broadened to /home/ and /root/ for Linux CI, must NOT flag in-VM paths.
describe("execute — hostPathLeaked", () => {
  it("flags a Linux host path under /home/", () => {
    expect(hostPathLeaked("/home/runner/work/x")).toBe(true);
  });

  it("flags a macOS host path under /Users/", () => {
    expect(hostPathLeaked("/Users/foo")).toBe(true);
  });

  it("flags a /root/ host path", () => {
    expect(hostPathLeaked("ls: /root/secret")).toBe(true);
  });

  it("does NOT flag the legitimate in-VM /sessions/<id>/mnt/ path", () => {
    expect(hostPathLeaked("/sessions/abc/mnt/outputs/y")).toBe(false);
  });

  // file-URI forms: the path-leading `/` defeats the bare boundary class, so file:// is anchored explicitly.
  it("flags a file:// URI host path (macOS form)", () => {
    expect(hostPathLeaked("see file:///Users/alice/project/x.md")).toBe(true);
  });

  it("flags a file:// URI host path (Linux form)", () => {
    expect(hostPathLeaked("file:///home/runner/work/repo")).toBe(true);
  });

  it("flags a file://localhost/ authority-form URI host path", () => {
    expect(hostPathLeaked("file://localhost/Users/alice/secret")).toBe(true);
  });

  it("does NOT flag a legitimate in-VM file:// URI", () => {
    expect(hostPathLeaked("file:///sessions/abc/mnt/outputs/y.md")).toBe(false);
  });

  // URL-encoded and backslash forms are now decoded/normalized before matching.
  it("flags a URL-encoded host path (%2FUsers%2F…)", () => {
    expect(hostPathLeaked("link=%2FUsers%2Falice%2Fsecret")).toBe(true);
  });
  it("flags a backslash file URI (file:\\\\host\\Users\\…)", () => {
    expect(hostPathLeaked("file:\\\\host\\Users\\alice")).toBe(true);
  });
  it("tolerates a malformed %-escape without throwing (and still matches the raw form)", () => {
    expect(hostPathLeaked("100% done, see /Users/alice")).toBe(true);
    expect(hostPathLeaked("just 50% off")).toBe(false);
  });
});

// scanEvents output-delete detector, broadened beyond rm/mv to python/find/etc.
describe("execute — scanEvents output-delete detection", () => {
  const bash = (command: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
  const scanOf = (cmds: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    const f = join(dir, "events.jsonl");
    writeFileSync(f, cmds.map(bash).join("\n"));
    return scanEvents(f).outputsDeletes;
  };
  it("catches python os.remove, find -delete, shred, and plain rm touching outputs/", () => {
    expect(scanOf([`python -c "import os; os.remove('outputs/x.json')"`]).length).toBe(1);
    expect(scanOf(["find outputs -name '*.tmp' -delete"]).length).toBe(1);
    expect(scanOf(["shred -u outputs/secret"]).length).toBe(1);
    expect(scanOf(["rm -rf mnt/outputs/dir"]).length).toBe(1);
  });
  it("does NOT flag a non-destructive command on outputs/", () => {
    expect(scanOf(["cat outputs/report.json"]).length).toBe(0);
    expect(scanOf(["rm /tmp/scratch"]).length).toBe(0); // delete, but not under outputs/
  });
  it("the stored finding surfaces the rm itself (resolved), not a leading VAR= assignment block", () => {
    // A long assignment prefix before the rm used to push the operative command past the 120-char slice,
    // so the finding showed only `ARTIFACTS_ROOT=… ANALYSIS_DIR=…`. The snippet now isolates the delete and
    // resolves $ANALYSIS_DIR.
    const cmd =
      'ARTIFACTS_ROOT="mnt/outputs/artifacts" && ANALYSIS_DIR="$ARTIFACTS_ROOT/market-sizing" && rm -f "$ANALYSIS_DIR"/inputs.json';
    const snip = scanOf([cmd]);
    expect(snip.length).toBe(1);
    expect(snip[0]).toMatch(/^rm /); // starts at the delete, not the assignment
    expect(snip[0]).toContain("mnt/outputs/artifacts/market-sizing"); // $ANALYSIS_DIR resolved + visible
    expect(snip[0]).not.toContain("ARTIFACTS_ROOT="); // assignment prefix dropped
  });
});

// isHostFsSealed: environment-agnostic negative guard.
describe("boundary — isHostFsSealed", () => {
  it("passes when the probe is a denial with NONE of the host markers", () => {
    expect(isHostFsSealed("ls: /Users: No such file or directory")).toBe(true);
  });

  it("fails when the output contains the test machine's own username (a real leak)", () => {
    const me = userInfo().username;
    expect(isHostFsSealed(`No such file\ndrwxr-xr-x ${me} staff`)).toBe(false);
  });

  it("fails when the output looks like a successful host listing (no denial)", () => {
    expect(isHostFsSealed("total 8\ndrwxr-xr-x someone")).toBe(false);
  });
});

describe("boundary — isHostFsSealed split-probe AND-semantics", () => {
  // The fix in runBoundaryChecks uses TWO independent probes (outUsers, outHost) and requires
  // BOTH to be sealed (isHostFsSealed(outUsers) && isHostFsSealed(outHost)).
  // This unit test guards that pure AND-combine so a leak on EITHER path fails the check.
  // Integration behavior (Docker two-probe split) is live-lane verified.

  it("both sealed => combined AND is true", () => {
    const outUsers = "ls: /Users: No such file or directory";
    const outHost = "ls: /host: No such file or directory";
    expect(isHostFsSealed(outUsers) && isHostFsSealed(outHost)).toBe(true);
  });

  it("Users leaks (real listing) => AND is false even if /host is sealed", () => {
    const outUsers = "total 8\ndrwxr-xr-x someone staff";
    const outHost = "ls: /host: No such file or directory";
    expect(isHostFsSealed(outUsers) && isHostFsSealed(outHost)).toBe(false);
  });

  it("/host leaks (real listing) => AND is false even if /Users is sealed", () => {
    const outUsers = "ls: /Users: No such file or directory";
    const outHost = "total 8\ndrwxr-xr-x someone staff";
    expect(isHostFsSealed(outUsers) && isHostFsSealed(outHost)).toBe(false);
  });
});

describe("boundary — boundaryAllowList folds in session egress", () => {
  const baseline = loadBaseline("desktop-1.12603.1");
  it("baseline-only when no session is given", () => {
    expect(boundaryAllowList(baseline)).toEqual(baseline.network.allowDomains);
  });
  it("appends a session's extra_allow domains", () => {
    expect(boundaryAllowList(baseline, { extraAllow: ["example.com"] })).toContain("example.com");
    expect(boundaryAllowList(baseline, { extraAllow: ["example.com"] })).toEqual(expect.arrayContaining(baseline.network.allowDomains));
  });
  it("unrestricted widens to ['*']", () => {
    expect(boundaryAllowList(baseline, { unrestricted: true })).toEqual(["*"]);
  });
});

// clampTimeout bounds.
describe("workspace-handler — clampTimeout", () => {
  it("defaults a missing/NaN value to 120000", () => {
    expect(clampTimeout(undefined)).toBe(120000);
    expect(clampTimeout("abc")).toBe(120000);
  });

  it("floors at 1000", () => {
    expect(clampTimeout(50)).toBe(1000);
    expect(clampTimeout(-5)).toBe(1000); // negative is truthy → Number()=-5, then Math.max floors to 1000
    expect(clampTimeout(0)).toBe(120000); // 0 is falsy → default 120000
  });

  it("caps at 600000", () => {
    expect(clampTimeout(9999999)).toBe(600000);
  });

  it("passes through an in-range value", () => {
    expect(clampTimeout(30000)).toBe(30000);
  });
});
