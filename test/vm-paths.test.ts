import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  mapVMPathToHostPath,
  isScratchpadVMPath,
  deepTranslateVMPaths,
  encodeComputerUrlsForHostLoop,
  type VmPathContext,
} from "../src/vm-paths.js";

function baseCtx(overrides: Partial<VmPathContext> = {}): VmPathContext {
  return {
    sessionId: "sess1",
    outputsHostDir: "/host/outputs",
    uploadsHostDir: "/host/uploads",
    folders: new Map([["project", "/host/project"]]),
    autoMemoryHostDir: "/host/memory",
    hostHomeResolver: (sub: string) => (sub ? `/${sub}` : "/"),
    ...overrides,
  };
}

describe("mapVMPathToHostPath — mount routing", () => {
  it("maps mnt/outputs/... to outputsHostDir", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/outputs/report.pdf", ctx)).toBe(join("/host/outputs", "report.pdf"));
  });

  it("maps mnt/uploads/... to uploadsHostDir", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/uploads/input.csv", ctx)).toBe(join("/host/uploads", "input.csv"));
  });

  it("maps a named folder mount via ctx.folders", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/project/sub/file.txt", ctx)).toBe(join("/host/project", "sub/file.txt"));
  });

  it("maps mnt/.auto-memory/... to autoMemoryHostDir", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/.auto-memory/notes.md", ctx)).toBe(join("/host/memory", "notes.md"));
  });

  it("routes mnt/.host-home/<sub> through hostHomeResolver", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/.host-home/Users/me", ctx)).toBe("/Users/me");
  });

  it("routes bare mnt/.host-home (empty sub) through hostHomeResolver as the host root", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/.host-home", ctx)).toBe("/");
  });

  it("returns null for outputs/uploads/.auto-memory when the corresponding host dir is not configured", () => {
    const ctx = baseCtx({ outputsHostDir: undefined, uploadsHostDir: undefined, autoMemoryHostDir: undefined });
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/outputs/x", ctx)).toBeNull();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/uploads/x", ctx)).toBeNull();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/.auto-memory/x", ctx)).toBeNull();
  });

  it("returns null for .host-home when no resolver is configured", () => {
    const ctx = baseCtx({ hostHomeResolver: undefined });
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/.host-home/Users/me", ctx)).toBeNull();
  });

  it("returns null for an unmapped (unregistered) mount name", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/unregistered/x.txt", ctx)).toBeNull();
  });

  it("returns null for a non-mnt session path (the scratchpad/cwd has no host identity)", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/scratchpad/notes.txt", ctx)).toBeNull();
  });

  it("returns null for a path belonging to a different session", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/other/mnt/outputs/x", ctx)).toBeNull();
  });

  it("returns null for a path with no /sessions/ prefix at all", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/etc/passwd", ctx)).toBeNull();
  });
});

describe("mapVMPathToHostPath — traversal rejection", () => {
  it("rejects a literal .. segment before the mnt/ split", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/project/../../../etc", ctx)).toBeNull();
  });

  it("rejects a percent-encoded .. segment revealed only after decoding", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/project/%2e%2e/etc", ctx)).toBeNull();
  });

  it("rejects a doubled slash (an empty path segment)", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/project//x", ctx)).toBeNull();
  });

  it("rejects a lone . segment", () => {
    const ctx = baseCtx();
    expect(mapVMPathToHostPath("/sessions/sess1/mnt/project/./x", ctx)).toBeNull();
  });
});

describe("mapVMPathToHostPath — decode/encode round trip", () => {
  it("decodes a percent-encoded segment with spaces and parens by default", () => {
    const ctx = baseCtx();
    const vmPath = "/sessions/sess1/mnt/project/My%20Report%20%28v2%29.pdf";
    expect(mapVMPathToHostPath(vmPath, ctx)).toBe(join("/host/project", "My Report (v2).pdf"));
  });

  it("leaves segments literal when decodeSegments: false is passed", () => {
    const ctx = baseCtx();
    const vmPath = "/sessions/sess1/mnt/project/My%20Report.pdf";
    expect(mapVMPathToHostPath(vmPath, ctx, { decodeSegments: false })).toBe(join("/host/project", "My%20Report.pdf"));
  });
});

describe("isScratchpadVMPath", () => {
  it("is true for a /sessions/<id>/... path that is not under mnt/", () => {
    expect(isScratchpadVMPath("/sessions/sess1/scratchpad/notes.txt", "sess1")).toBe(true);
    expect(isScratchpadVMPath("/sessions/sess1/", "sess1")).toBe(true);
  });

  it("is false for a path under mnt/", () => {
    expect(isScratchpadVMPath("/sessions/sess1/mnt/outputs/x.txt", "sess1")).toBe(false);
  });

  it("is false for a path outside /sessions/<id>/ entirely", () => {
    expect(isScratchpadVMPath("/tmp/x.txt", "sess1")).toBe(false);
  });
});

describe("deepTranslateVMPaths — the four rewrite forms (VM mode)", () => {
  it("rewrites markdown-link position with per-segment percent-encoding", () => {
    const ctx = baseCtx();
    const text = "[View](computer:///sessions/sess1/mnt/project/My Report (v2).pdf)";
    const out = deepTranslateVMPaths(text, ctx, false);
    expect(out).toBe("[View](computer:///host/project/My%20Report%20%28v2%29.pdf)");
  });

  it("rewrites backtick-quoted position WITHOUT percent-encoding", () => {
    const ctx = baseCtx();
    const text = "run `computer:///sessions/sess1/mnt/project/My Report.pdf` please";
    const out = deepTranslateVMPaths(text, ctx, false);
    expect(out).toBe("run `computer:///host/project/My Report.pdf` please");
  });

  it("rewrites a bare computer:// token with percent-encoding, stopping at the delimiter set", () => {
    const ctx = baseCtx();
    const text = "see computer:///sessions/sess1/mnt/project/report(v2).pdf now";
    const out = deepTranslateVMPaths(text, ctx, false);
    expect(out).toBe("see computer:///host/project/report%28v2%29.pdf now");
  });

  it("rewrites a bare VM path mentioned in prose, unencoded", () => {
    const ctx = baseCtx();
    const text = "the file lives at /sessions/sess1/mnt/project/report.pdf on disk";
    const out = deepTranslateVMPaths(text, ctx, false);
    expect(out).toBe("the file lives at /host/project/report.pdf on disk");
  });

  it("does not rewrite a bare VM path immediately preceded by an alphanumeric (lookbehind)", () => {
    const ctx = baseCtx();
    const text = "id123/sessions/sess1/mnt/outputs/report.pdf";
    expect(deepTranslateVMPaths(text, ctx, false)).toBe(text);
  });

  it("rewrites the same path when preceded by a non-alnum boundary", () => {
    const ctx = baseCtx();
    const text = " /sessions/sess1/mnt/outputs/report.pdf";
    expect(deepTranslateVMPaths(text, ctx, false)).toBe(" /host/outputs/report.pdf");
  });
});

describe("deepTranslateVMPaths — scratchpad and unmappable paths stay verbatim", () => {
  it("leaves a scratchpad (non-mnt) path exactly as written", () => {
    const ctx = baseCtx();
    const text = "working file is at /sessions/sess1/scratchpad/notes.txt for now";
    expect(deepTranslateVMPaths(text, ctx, false)).toBe(text);
  });

  it("leaves an unmappable mnt path (unregistered mount name) exactly as written, at every position", () => {
    const ctx = baseCtx();
    const link = "[View](computer:///sessions/sess1/mnt/unregistered/x.txt)";
    const backtick = "`computer:///sessions/sess1/mnt/unregistered/x.txt`";
    const bareToken = "computer:///sessions/sess1/mnt/unregistered/x.txt done";
    const prose = "at /sessions/sess1/mnt/unregistered/x.txt on disk";
    expect(deepTranslateVMPaths(link, ctx, false)).toBe(link);
    expect(deepTranslateVMPaths(backtick, ctx, false)).toBe(backtick);
    expect(deepTranslateVMPaths(bareToken, ctx, false)).toBe(bareToken);
    expect(deepTranslateVMPaths(prose, ctx, false)).toBe(prose);
  });
});

describe("deepTranslateVMPaths — deep walk: copy-on-write and base64 skip", () => {
  it("returns the exact same reference when nothing in the tree changed", () => {
    const ctx = baseCtx();
    const value = { a: "no vm paths here", b: [1, 2, "still none"], c: { nested: true } };
    const out = deepTranslateVMPaths(value, ctx, false);
    expect(out).toBe(value);
  });

  it("returns a new top-level reference but preserves untouched siblings by reference", () => {
    const ctx = baseCtx();
    const untouchedNested = { nested: true };
    const untouchedArrayItem = { keep: "me" };
    const value = {
      changed: "at /sessions/sess1/mnt/outputs/report.pdf now",
      untouched: untouchedNested,
      list: [untouchedArrayItem, "no path here"],
    };
    const out = deepTranslateVMPaths(value, ctx, false);
    expect(out).not.toBe(value);
    expect(out.changed).toBe("at /host/outputs/report.pdf now");
    expect(out.untouched).toBe(untouchedNested);
    // Nothing inside `list` changed, so the array itself keeps its original reference too.
    expect(out.list).toBe(value.list);
    expect(out.list[0]).toBe(untouchedArrayItem);
    expect(out.list[1]).toBe("no path here");
  });

  it("copies an array only when one of its elements changed, preserving other elements by reference", () => {
    const ctx = baseCtx();
    const untouchedItem = { keep: "me" };
    const value = [untouchedItem, "at /sessions/sess1/mnt/outputs/report.pdf now"];
    const out = deepTranslateVMPaths(value, ctx, false);
    expect(out).not.toBe(value);
    expect(out[0]).toBe(untouchedItem);
    expect(out[1]).toBe("at /host/outputs/report.pdf now");
  });

  it("skips { type: 'base64', data } objects whole, even if data contains VM-path-shaped text", () => {
    const ctx = baseCtx();
    const blob = { type: "base64" as const, data: "/sessions/sess1/mnt/outputs/report.pdf" };
    const value = { blob };
    const out = deepTranslateVMPaths(value, ctx, false);
    expect(out.blob).toBe(blob);
    expect(out.blob.data).toBe("/sessions/sess1/mnt/outputs/report.pdf");
  });
});

describe("encodeComputerUrlsForHostLoop", () => {
  it("returns the input unchanged when it has no computer:// substring", () => {
    expect(encodeComputerUrlsForHostLoop("nothing to see here")).toBe("nothing to see here");
  });

  it("percent-encodes a markdown-link position payload", () => {
    const text = "[View](computer:///Users/me/Project/report (v2).docx) done";
    expect(encodeComputerUrlsForHostLoop(text)).toBe("[View](computer:///Users/me/Project/report%20%28v2%29.docx) done");
  });

  it("percent-encodes a bare token position payload", () => {
    const text = "open computer:///Users/me/report(v2).docx now";
    expect(encodeComputerUrlsForHostLoop(text)).toBe("open computer:///Users/me/report%28v2%29.docx now");
  });

  it("leaves a backtick-quoted payload unencoded (pass-through)", () => {
    const text = "see `computer:///Users/me/report (v2).docx` for details";
    expect(encodeComputerUrlsForHostLoop(text)).toBe(text);
  });
});

describe("deepTranslateVMPaths — hostLoopMode encode-only branch", () => {
  it("applies encodeComputerUrlsForHostLoop and does not touch host paths further (no VM prefix present)", () => {
    const ctx = baseCtx();
    const text = "[View](computer:///Users/me/Project/report (v2).docx) done";
    const out = deepTranslateVMPaths(text, ctx, true);
    expect(out).toBe("[View](computer:///Users/me/Project/report%20%28v2%29.docx) done");
  });

  it("leaves backtick-quoted host links unencoded under hostLoopMode too", () => {
    const ctx = baseCtx();
    const text = "see `computer:///Users/me/report (v2).docx` for details";
    expect(deepTranslateVMPaths(text, ctx, true)).toBe(text);
  });

  it("percent-encodes a bare host-path token under hostLoopMode", () => {
    const ctx = baseCtx();
    const text = "open computer:///Users/me/report(v2).docx now";
    expect(deepTranslateVMPaths(text, ctx, true)).toBe("open computer:///Users/me/report%28v2%29.docx now");
  });

  it("still resolves a VM-shaped path if one appears under hostLoopMode", () => {
    const ctx = baseCtx();
    const text = "at /sessions/sess1/mnt/outputs/report.pdf on disk";
    expect(deepTranslateVMPaths(text, ctx, true)).toBe("at /host/outputs/report.pdf on disk");
  });
});
