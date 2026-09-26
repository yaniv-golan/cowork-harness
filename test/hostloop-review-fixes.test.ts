import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateHostLoopShellSection } from "../src/runtime/hostloop-prompt.js";
import { hostLoopProcessContract } from "../src/runtime/hostloop.js";
import { loadBaseline } from "../src/baseline.js";
import { checkHostLoopPathGate, type HostLoopPathGateConfig } from "../src/hostloop/pretooluse-path-hook.js";
import { hookEventFrom } from "../src/agent/session.js";

const OUT = "/run/work/session/mnt/outputs";
/** A real outputs dir: the gate re-gates a re-anchored path by containment, which needs a dir on disk. */
function realOutputs(): string {
  const d = join(realpathSync(mkdtempSync(join(tmpdir(), "cwh-rev-"))), "outputs");
  mkdirSync(join(d, "sub"), { recursive: true });
  return d;
}
const gateCfg = (out: string, spellings: string[]) =>
  ({
    hostCwd: out,
    allowedRoots: [out],
    readOnlyRoots: [],
    scratchRoots: [out],
    scratchMode: false,
    uploadsRoots: [],
    spooledProjectsRoots: [],
    readOnlyPluginRoots: [],
    processCwdSpellings: spellings,
  }) as HostLoopPathGateConfig;
const base = {
  sessionRoot: "/sessions/abc",
  mntRoot: "/sessions/abc/mnt",
  folders: [],
  uploads: [],
  hostOutputsDir: OUT,
  hostUploadsDir: "/u",
};

describe("the Shell access outputs bullet", () => {
  it("from Desktop 2.7032.0 does not call outputs the cwd — the agent runs at /var/empty and a relative path is refused", () => {
    const out = generateHostLoopShellSection({ ...base, processCwdOffOutputs: true } as never);
    expect(out).toContain(`- ${OUT} → /sessions/abc/mnt/outputs/  (your outputs directory)\n`);
    expect(out).not.toContain("— cwd");
  });
  it("before 2.7032.0 keeps its current wording", () => {
    expect(generateHostLoopShellSection(base as never)).toContain("(your outputs directory — cwd)");
  });
});

describe("a baseline whose appVersion does not parse", () => {
  afterEach(() => vi.restoreAllMocks());
  it("says so instead of silently taking the older, more permissive contract", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      writes.push(String(s));
      return true;
    }) as never);
    const out = mkdtempSync(join(tmpdir(), "cwh-badver-"));
    try {
      const c = hostLoopProcessContract({ ...loadBaseline("latest"), appVersion: "2.x-typo" } as never, out, "/S", OUT);
      expect(c.processCwd).toBeUndefined();
      expect(writes.join("")).toMatch(/::warning::.*appVersion "2\.x-typo"/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("hookEventFrom over the gate's own reply", () => {
  it("records the path the gate actually re-anchored a pathless Glob to", async () => {
    const out = realOutputs();
    const input = { tool_name: "Glob", tool_input: { pattern: "*.md" } };
    const reply = await checkHostLoopPathGate("Glob", input.tool_input, gateCfg(out, ["/var/empty", "/private/var/empty"]));
    const ev = hookEventFrom("cb", reply as Record<string, unknown>, input, "t1");
    expect(ev.decision).toBe("allow");
    expect(ev.rewritten).toEqual({ path: out });
  });
});

describe("Glob: an absolute pattern is never re-anchored, whatever its path", () => {
  it("leaves {pattern:'/abs/**', path:'sub'} to ordinary gating, as Desktop's guard keys on the pattern alone", async () => {
    const out = realOutputs();
    const cfg = gateCfg(out, ["/var/empty"]);
    // Control: the same relative path with a relative pattern IS re-anchored — so the case below is not
    // passing because re-anchoring is broken.
    const ctl = (await checkHostLoopPathGate("Glob", { pattern: "*.md", path: "sub" }, cfg)) as Record<string, any>;
    expect(ctl.hookSpecificOutput?.updatedInput?.path).toBe(join(out, "sub"));
    const r = (await checkHostLoopPathGate("Glob", { pattern: "/abs/**", path: "sub" }, cfg)) as Record<string, unknown>;
    expect(r.hookSpecificOutput).toBeUndefined();
  });
});
