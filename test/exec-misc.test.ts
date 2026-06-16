import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { readSessionManifest, hostPathLeaked } from "../src/run/execute.js";
import { isHostFsSealed, boundaryAllowList } from "../src/boundary.js";
import { loadBaseline } from "../src/baseline.js";
import { clampTimeout } from "../src/hostloop/workspace-handler.js";

// Token-free, spawn-free coverage for the misc bug-hunt fixes (#23, #24, #35, #29).

// #23 — readSessionManifest: valid / corrupt-JSON / missing-key.
describe("execute — readSessionManifest (#23)", () => {
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

// #24 — hostPathLeaked: broadened to /home/ and /root/ for Linux CI, must NOT flag in-VM paths.
describe("execute — hostPathLeaked (#24)", () => {
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
});

// #35 — isHostFsSealed: environment-agnostic negative guard.
describe("boundary — isHostFsSealed (#35)", () => {
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

// #29 — clampTimeout bounds.
describe("workspace-handler — clampTimeout (#29)", () => {
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
