import { describe, it, expect, vi } from "vitest";
import { checkHostLoopWriteConsent, logHostWriteNotice } from "../src/hostloop/safety.js";

describe("checkHostLoopWriteConsent", () => {
  it("throws naming every writable folder when consent is not given", () => {
    const session = {
      folders: [
        { from: "/a", mode: "rw" as const },
        { from: "/b", mode: "rwd" as const },
      ],
    };
    expect(() => checkHostLoopWriteConsent(session, false)).toThrow(/\/a, \/b/);
  });

  it("never throws when consent is given", () => {
    const session = { folders: [{ from: "/a", mode: "rw" as const }] };
    expect(() => checkHostLoopWriteConsent(session, true)).not.toThrow();
  });

  it("never throws for read-only-only or folder-less sessions, regardless of consent", () => {
    expect(() => checkHostLoopWriteConsent({ folders: [{ from: "/a", mode: "r" as const }] }, false)).not.toThrow();
    expect(() => checkHostLoopWriteConsent({ folders: [] }, false)).not.toThrow();
  });
});

describe("logHostWriteNotice", () => {
  it("warns once per writable folder, skips read-only folders", () => {
    const warn = vi.fn();
    logHostWriteNotice(
      [
        { from: "/a", mode: "rw" },
        { from: "/b", mode: "r" },
        { from: "/c", mode: "rwd" },
      ],
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("/a");
    expect(warn.mock.calls[1][0]).toContain("/c");
  });
});
