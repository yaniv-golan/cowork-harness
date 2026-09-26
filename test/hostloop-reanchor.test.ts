import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHostLoopPathGate, type HostLoopPathGateConfig } from "../src/hostloop/pretooluse-path-hook.js";
import { hookEventFrom } from "../src/agent/session.js";

// From Desktop 2.7032.0 the agent runs at /var/empty, so a relative path means nothing useful. Desktop's
// PreToolUse hook then: re-anchors a pathless or relative Grep/Glob to the outputs dir (returning
// `updatedInput`), and BLOCKS a relative Read/Write/Edit/MultiEdit with "<Tool> needs an absolute path
// here". The agent's own deny rules refuse relative Read/Write/Edit first in production, so these blocks
// are the harness's second line: if the deny rules ever fail to load, a relative write is still refused
// instead of quietly landing in outputs.

const SPELLINGS = ["/var/empty", "/System/Volumes/Data/var/empty", "/private/var/empty", "/System/Volumes/Data/private/var/empty"];

describe("hostloop path gate — cwd off the outputs dir (baselines from 2.7032.0)", () => {
  let outputs: string;
  beforeEach(() => {
    outputs = join(realpathSync(mkdtempSync(join(tmpdir(), "reanchor-"))), "outputs");
    mkdirSync(join(outputs, "sub"), { recursive: true });
  });
  const cfg = (post: boolean): HostLoopPathGateConfig =>
    ({
      hostCwd: outputs,
      allowedRoots: [outputs],
      readOnlyRoots: [],
      scratchRoots: [outputs],
      scratchMode: false,
      uploadsRoots: [],
      spooledProjectsRoots: [],
      readOnlyPluginRoots: [],
      ...(post ? { processCwdSpellings: SPELLINGS } : {}),
    }) as HostLoopPathGateConfig;
  const updated = (r: unknown) =>
    (r as { hookSpecificOutput?: { hookEventName?: string; updatedInput?: Record<string, unknown> } }).hookSpecificOutput;

  it("a pathless Glob is re-anchored to outputs", async () => {
    const r = await checkHostLoopPathGate("Glob", { pattern: "*.md" }, cfg(true));
    expect(updated(r)?.hookEventName).toBe("PreToolUse");
    expect(updated(r)?.updatedInput).toEqual({ pattern: "*.md", path: outputs });
  });

  it("a pathless Grep is re-anchored to outputs", async () => {
    const r = await checkHostLoopPathGate("Grep", { pattern: "x" }, cfg(true));
    expect(updated(r)?.updatedInput).toEqual({ pattern: "x", path: outputs });
  });

  it("a relative Grep path resolves under outputs", async () => {
    const r = await checkHostLoopPathGate("Grep", { pattern: "x", path: "sub" }, cfg(true));
    expect(updated(r)?.updatedInput?.path).toBe(join(outputs, "sub"));
  });

  it.each(SPELLINGS)("an absolute Grep path under the process cwd (%s) is re-anchored to outputs", async (sp) => {
    const r = await checkHostLoopPathGate("Grep", { pattern: "x", path: `${sp}/sub` }, cfg(true));
    expect(updated(r)?.updatedInput?.path).toBe(join(outputs, "sub"));
  });

  it("a Glob whose pattern is absolute is left alone", async () => {
    const r = await checkHostLoopPathGate("Glob", { pattern: `${outputs}/*.md` }, cfg(true));
    expect(r).toEqual({});
  });

  it.each(["Read", "Write", "Edit", "MultiEdit"])("a relative %s is blocked with Desktop's wording, never re-anchored", async (tool) => {
    const r = (await checkHostLoopPathGate(tool, { file_path: "report.md" }, cfg(true))) as { decision?: string; reason?: string };
    expect(r.decision).toBe("block");
    expect(r.reason).toBe(`${tool} needs an absolute path here — use \`${join(outputs, "report.md")}\` for \`report.md\`.`);
  });

  it("a relative path that escapes outputs gets the generic wording", async () => {
    const r = (await checkHostLoopPathGate("Write", { file_path: "../../x.md" }, cfg(true))) as { reason?: string };
    expect(r.reason).toBe(`Write needs an absolute path here — use an absolute path under ${outputs}.`);
  });

  it("an absolute Write inside outputs is still allowed", async () => {
    expect(await checkHostLoopPathGate("Write", { file_path: join(outputs, "r.md") }, cfg(true))).toEqual({});
  });

  it("before 2.7032.0 nothing changes: a pathless Glob passes untouched and a relative Write resolves against outputs", async () => {
    expect(await checkHostLoopPathGate("Glob", { pattern: "*.md" }, cfg(false))).toEqual({});
    expect(await checkHostLoopPathGate("Write", { file_path: "report.md" }, cfg(false))).toEqual({});
  });
});

describe("hook_event records a re-anchor", () => {
  it("an updatedInput reply is recorded as allowed, with the rewritten path", () => {
    const ev = hookEventFrom(
      "cb",
      { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { pattern: "*.md", path: "/S/mnt/outputs" } } },
      { tool_name: "Glob", tool_input: { pattern: "*.md" } },
      "t1",
    ) as Record<string, unknown>;
    expect(ev.decision).toBe("allow");
    expect(ev.rewritten).toEqual({ path: "/S/mnt/outputs" });
  });
});
