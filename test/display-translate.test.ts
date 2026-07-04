import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/agent/session.js";
import { makeRenderer, type RenderPlan } from "../src/run/renderer.js";
import { makeDisplayTranslator, vmPathContextFromPlan } from "../src/run/display-translate.js";
import type { VmPathContext } from "../src/vm-paths.js";

function baseCtx(overrides: Partial<VmPathContext> = {}): VmPathContext {
  return {
    sessionId: "sess1",
    outputsHostDir: "/host/outputs",
    uploadsHostDir: "/host/uploads",
    folders: new Map([["project", "/host/project"]]),
    ...overrides,
  };
}

describe("makeDisplayTranslator — policy gate", () => {
  const vmText = "see /sessions/sess1/mnt/outputs/report.pdf";

  it("translates iff hostloop + ctx + not shareable", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: false });
    expect(t(vmText)).toBe("see /host/outputs/report.pdf");
  });

  it("identity when fidelity is NOT hostloop (container)", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "container", shareable: false });
    expect(t(vmText)).toBe(vmText);
  });

  it("identity when fidelity is NOT hostloop (microvm)", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "microvm", shareable: false });
    expect(t(vmText)).toBe(vmText);
  });

  it("identity when fidelity is NOT hostloop (protocol)", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "protocol", shareable: false });
    expect(t(vmText)).toBe(vmText);
  });

  it("identity when ctx is absent (e.g. replay), even at hostloop", () => {
    const t = makeDisplayTranslator({ effectiveFidelity: "hostloop", shareable: false });
    expect(t(vmText)).toBe(vmText);
  });

  it("identity when shareable, EVEN at hostloop with a ctx (compact/demo must never leak /Users/…)", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: true });
    expect(t(vmText)).toBe(vmText);
  });

  it("identity when effectiveFidelity is undefined", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), shareable: false });
    expect(t(vmText)).toBe(vmText);
  });

  it("identity when opts is empty", () => {
    const t = makeDisplayTranslator({});
    expect(t(vmText)).toBe(vmText);
  });
});

// CONTRACT test: this is the table a future frontend (TUI, web view) copies wholesale instead of
// re-deriving the gate. It enumerates the full space named in the module header's three invariants —
// fidelity as a STRING axis (not collapsed to a hostloop/non-hostloop boolean) × ctx-present/absent ×
// shareable true/false — and asserts translate-vs-identity for every combination. The per-fidelity
// `describe` block above stays: it pins the exact translated OUTPUT for two individual tiers, which this
// table (deliberately) does not re-check per row.
describe("makeDisplayTranslator — CONTRACT: gate space (fidelity × ctx × shareable)", () => {
  const vmText = "see /sessions/sess1/mnt/outputs/report.pdf";
  const hostText = "see /host/outputs/report.pdf";

  const fidelities: Array<string | undefined> = ["hostloop", "container", "protocol", "microvm", undefined];

  const rows: Array<{ fidelity: string | undefined; ctxPresent: boolean; shareable: boolean }> = [];
  for (const fidelity of fidelities) {
    for (const ctxPresent of [true, false]) {
      for (const shareable of [true, false]) {
        rows.push({ fidelity, ctxPresent, shareable });
      }
    }
  }

  it.each(rows)(
    "fidelity=$fidelity ctx=$ctxPresent shareable=$shareable -> translate iff hostloop && ctx && !shareable",
    ({ fidelity, ctxPresent, shareable }) => {
      const t = makeDisplayTranslator({
        ctx: ctxPresent ? baseCtx() : undefined,
        effectiveFidelity: fidelity,
        shareable,
      });
      const expectTranslate = fidelity === "hostloop" && ctxPresent && !shareable;
      expect(t(vmText)).toBe(expectTranslate ? hostText : vmText);
    },
  );
});

describe("makeDisplayTranslator — hostloop mode: computer:// link percent-encoding", () => {
  it("percent-encodes a host path with a space in markdown-link position", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: false });
    const text = "[View report](computer:///Users/me/My Project/report.docx)";
    expect(t(text)).toBe("[View report](computer:///Users/me/My%20Project/report.docx)");
  });

  it("percent-encodes a bare computer:// token too (no markdown wrapper) — parens, since a bare token's scan stops at whitespace", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: false });
    const text = "open computer:///Users/me/Project/report(draft).pdf now";
    expect(t(text)).toBe("open computer:///Users/me/Project/report%28draft%29.pdf now");
  });

  it("leaves a backtick-quoted computer:// link unencoded", () => {
    const t = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: false });
    const text = "run `computer:///Users/me/My Project/report.docx`";
    expect(t(text)).toBe(text);
  });
});

describe("vmPathContextFromPlan", () => {
  it("derives outputs/uploads under <outDir>/work/session/mnt, and maps folder mounts by mountPath", () => {
    const plan = {
      mounts: [
        { kind: "folder", hostPath: "/Users/me/proj", mountPath: "project" },
        { kind: "upload", hostPath: "/Users/me/attach/x.csv", mountPath: "uploads/x.csv" },
      ],
    };
    const ctx = vmPathContextFromPlan("sess1", plan, "/tmp/runs/scenario/sess1");
    expect(ctx.sessionId).toBe("sess1");
    expect(ctx.outputsHostDir).toBe("/tmp/runs/scenario/sess1/work/session/mnt/outputs");
    expect(ctx.uploadsHostDir).toBe("/tmp/runs/scenario/sess1/work/session/mnt/uploads");
    expect(ctx.folders.get("project")).toBe("/Users/me/proj");
    expect(ctx.folders.has("uploads/x.csv")).toBe(false); // upload-kind mounts are NOT folders
  });

  it("returns an empty folders map when the plan has no folder mounts", () => {
    const ctx = vmPathContextFromPlan("sess1", { mounts: [] }, "/tmp/runs/x");
    expect(ctx.folders.size).toBe(0);
  });
});

describe("renderer surfaces agree on translated text (assistant text, sub-agent text, tool_use, tool_result)", () => {
  const plan = (translate: (s: string) => string): RenderPlan => ({
    live: true,
    progress: true,
    verbose: true,
    color: false,
    compact: false,
    translate,
  });
  function sink() {
    const out: string[] = [];
    return { write: (s: string) => out.push(s), text: () => out.join("") };
  }
  const translate = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: false });

  const events: AgentEvent[] = [
    { type: "assistant_text", text: "see /sessions/sess1/mnt/outputs/report.pdf" },
    { type: "tool_use", name: "Bash", input: { command: "cat /sessions/sess1/mnt/outputs/report.pdf" }, toolUseId: "tu1" },
    { type: "tool_result", toolUseId: "tu1", isError: false, text: "/sessions/sess1/mnt/outputs/report.pdf: 3 lines" },
    { type: "subagent_dispatch", toolUseId: "tu2", agentType: "researcher", declaredTools: ["Read"] },
    { type: "assistant_text", text: "sub-note: /sessions/sess1/mnt/outputs/notes.md", parentToolUseId: "tu2" },
  ];

  it("live display AND the dumped transcript both show the host path (not the VM path)", () => {
    const s = sink();
    const r = makeRenderer(plan(translate), s.write);
    for (const e of events) r.onEvent!(e);
    const displayed = s.text();
    expect(displayed).toContain("/host/outputs/report.pdf"); // tool_use input summary
    expect(displayed).toContain("/host/outputs/report.pdf: 3 lines"); // tool_result head
    expect(displayed).not.toContain("/sessions/sess1/mnt/");
    expect(r.dump()).toContain("/host/outputs/report.pdf"); // assistant text, buffered
    expect(r.dump()).not.toContain("/sessions/sess1/mnt/");
  });

  it("sub-agent (parentToolUseId) assistant text is translated too, under --verbose", () => {
    const s = sink();
    const r = makeRenderer(plan(translate), s.write);
    for (const e of events) r.onEvent!(e);
    expect(s.text()).toContain("/host/outputs/notes.md");
    expect(s.text()).not.toContain("/sessions/sess1/mnt/outputs/notes.md");
  });

  it("without a translate function, nothing changes (identity — replay/default behavior)", () => {
    const s = sink();
    const noTranslatePlan: RenderPlan = { live: true, progress: true, verbose: true, color: false, compact: false };
    const r = makeRenderer(noTranslatePlan, s.write);
    for (const e of events) r.onEvent!(e);
    expect(s.text()).toContain("/sessions/sess1/mnt/outputs/report.pdf");
    expect(r.dump()).toContain("/sessions/sess1/mnt/outputs/report.pdf");
  });
});
