import { describe, it, expect } from "vitest";
import { maskVolatileText, canonicalizeInput } from "../src/run/diff.js";

describe("maskVolatileText — the masks a run/cassette diff needs to compare two runs of the same scenario", () => {
  it("masks a toolu_ tool-use id", () => {
    expect(maskVolatileText("toolu_01AbCdEfGh23")).toBe("toolu_<ID>");
  });

  it("masks a UUID (session ids, request_ids)", () => {
    expect(maskVolatileText("session 35ccd28a-5843-4a74-aa96-ede9032c5f62 started")).toBe("session <UUID> started");
  });

  it("masks a local_<hrtime> run-dir marker", () => {
    expect(maskVolatileText("/sessions/local_9hldogcxp")).toBe("/sessions/<SESSION>");
  });

  it("masks a sess-<id> pinned session marker", () => {
    expect(maskVolatileText("runs/scenario/sess-abc123")).toBe("runs/scenario/<SESSION>");
  });

  it("masks an ISO-8601 timestamp", () => {
    expect(maskVolatileText("captured at 2026-07-03T12:34:56.789Z")).toBe("captured at <TIMESTAMP>");
  });

  it("masks a host path (reusing the scan.ts path-class regex, not a new pattern)", () => {
    expect(maskVolatileText("wrote to /Users/alice/project/file.md")).toBe("wrote to <HOST_PATH>");
    expect(maskVolatileText("under /home/bob/x")).toBe("under <HOST_PATH>");
  });

  it("leaves stable, non-volatile content untouched", () => {
    expect(maskVolatileText("action items for Q2 report")).toBe("action items for Q2 report");
  });

  it("masks multiple distinct volatile spans in one string", () => {
    const s = "toolu_ABC123 ran at 2026-07-03T00:00:00Z in /sessions/local_xyz";
    expect(maskVolatileText(s)).toBe("toolu_<ID> ran at <TIMESTAMP> in /sessions/<SESSION>");
  });
});

describe("canonicalizeInput — bounded, key-aware canonicalization for tool-sequence comparison", () => {
  it("masks volatile string values inside a nested tool input", () => {
    const canon = canonicalizeInput({ path: "outputs/x.md", note: "toolu_ABC123 done" });
    expect(canon).not.toContain("toolu_ABC123");
    expect(canon).toContain("outputs/x.md");
  });

  it("drops/zeroes a structurally-named volatile numeric key (duration_ms) regardless of its value", () => {
    const a = canonicalizeInput({ command: "ls", duration_ms: 123 });
    const b = canonicalizeInput({ command: "ls", duration_ms: 999 });
    expect(a).toBe(b);
  });

  it("drops a structurally-named volatile key spelled durationMs (camelCase variant)", () => {
    const a = canonicalizeInput({ command: "ls", durationMs: 1 });
    const b = canonicalizeInput({ command: "ls", durationMs: 2 });
    expect(a).toBe(b);
  });

  it("caps the canonicalized output at a bounded length (never an unbounded dump)", () => {
    const huge = canonicalizeInput({ blob: "x".repeat(10_000) });
    expect(huge.length).toBeLessThan(2100);
  });

  it("two structurally-identical inputs (module the volatile fields) canonicalize identically", () => {
    const a = canonicalizeInput({ path: "outputs/x.md", request_id: "aaaa1111-2222-3333-4444-555566667777" });
    const b = canonicalizeInput({ path: "outputs/x.md", request_id: "bbbb1111-2222-3333-4444-555566667777" });
    expect(a).toBe(b);
  });

  it("two structurally-different inputs canonicalize differently", () => {
    const a = canonicalizeInput({ path: "outputs/x.md" });
    const b = canonicalizeInput({ path: "outputs/y.md" });
    expect(a).not.toBe(b);
  });
});
