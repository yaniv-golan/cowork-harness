import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../src/agent/session.js";
import { makeRenderer, type RenderPlan } from "../src/run/renderer.js";
import { makeDisplayTranslator, vmPathContextFromPlan, linkifyForTerminal, shouldLinkify } from "../src/run/display-translate.js";
import type { VmPathContext } from "../src/vm-paths.js";

const ESC = "\x1b";
const OSC8_START = `${ESC}]8;;`;
const ST = `${ESC}\\`;
const OSC8_CLOSE = `${OSC8_START}${ST}`;
/** Build the exact wrapped substring `linkifyForTerminal` produces for one occurrence, so tests
 *  assert against the real escape shape instead of a loose `.toContain`. */
function osc8(uri: string, display: string): string {
  return `${OSC8_START}${uri}${ST}${display}${OSC8_CLOSE}`;
}

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
    { type: "subagent_dispatch", toolUseId: "tu2", dispatchAgentType: "researcher", typeOmitted: false, declaredTools: ["Read"] },
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

// Item 3 — OSC 8 hyperlinks. `linkifyForTerminal` is a pure decorator: it never rewrites path
// content (that's `makeDisplayTranslator`'s job, above), it just wraps an ALREADY host-shaped
// `computer://` occurrence in an OSC 8 escape. Positions mirror vm-paths.ts's own three (markdown,
// backtick, bare) — see that module's `translateString` / `encodeComputerUrlsForHostLoop`.
describe("linkifyForTerminal — pure decorator", () => {
  it("markdown-link position: wraps a host-shaped link in OSC 8, display text unchanged", () => {
    const text = "[View report](computer:///Users/me/My%20Project/report.docx)";
    const uri = "file:///Users/me/My%20Project/report.docx";
    const display = "computer:///Users/me/My%20Project/report.docx";
    expect(linkifyForTerminal(text)).toBe(`[View report](${osc8(uri, display)})`);
  });

  it("bare-token position: wraps a host-shaped link, scan stops at whitespace", () => {
    const text = "open computer:///Users/me/report.pdf now";
    const uri = "file:///Users/me/report.pdf";
    const display = "computer:///Users/me/report.pdf";
    expect(linkifyForTerminal(text)).toBe(`open ${osc8(uri, display)} now`);
  });

  it("encodes a space in the file:// target (bare position)", () => {
    const text = "open computer:///Users/me/My%20Project/report.docx now";
    expect(linkifyForTerminal(text)).toContain("file:///Users/me/My%20Project/report.docx");
  });

  it("encodes literal parens in the file:// target, paren-balanced (bare position, unencoded input)", () => {
    const text = "open computer:///Users/me/Project/report(draft).pdf now";
    const uri = "file:///Users/me/Project/report%28draft%29.pdf";
    // display text is the ORIGINAL, byte-unchanged — including the un-encoded parens.
    const display = "computer:///Users/me/Project/report(draft).pdf";
    expect(linkifyForTerminal(text)).toBe(`open ${osc8(uri, display)} now`);
  });

  it("encodes # and ? in the file:// target (both URI-significant)", () => {
    const text = "see computer:///Users/me/report#draft?.pdf here";
    expect(linkifyForTerminal(text)).toContain("file:///Users/me/report%23draft%3F.pdf");
  });

  it("VM-shaped links (/sessions/...) are left exactly as written — bare position", () => {
    const text = "see computer:///sessions/sess1/mnt/outputs/report.pdf here";
    expect(linkifyForTerminal(text)).toBe(text);
  });

  it("VM-shaped links (/sessions/...) are left exactly as written — markdown position", () => {
    const text = "[report](computer:///sessions/sess1/mnt/outputs/report.pdf)";
    expect(linkifyForTerminal(text)).toBe(text);
  });

  it("backtick-quoted spans are NEVER linkified, even when host-shaped (a code span is a quotation)", () => {
    const text = "run `computer:///Users/me/report.pdf` to see it";
    expect(linkifyForTerminal(text)).toBe(text);
  });

  it("is idempotent — wrapping already-wrapped text (markdown position) is a no-op on the second pass", () => {
    const text = "[View report](computer:///Users/me/My%20Project/report.docx)";
    const once = linkifyForTerminal(text);
    const twice = linkifyForTerminal(once);
    expect(twice).toBe(once);
  });

  it("is idempotent — wrapping already-wrapped text (bare position) is a no-op on the second pass", () => {
    const text = "open computer:///Users/me/report.pdf now";
    const once = linkifyForTerminal(text);
    const twice = linkifyForTerminal(once);
    expect(twice).toBe(once);
  });

  it("double-application never double-encodes the target URI (%20 must not become %2520)", () => {
    const text = "open computer:///Users/me/My%20Project/report.docx now";
    const once = linkifyForTerminal(text);
    const twice = linkifyForTerminal(once);
    expect(twice).toContain("%20");
    expect(twice).not.toContain("%2520");
  });

  it("no computer:// occurrence at all — returns the exact same string", () => {
    const text = "nothing to see here";
    expect(linkifyForTerminal(text)).toBe(text);
  });
});

describe("shouldLinkify — the TTY/CI/env/shareable gate", () => {
  const rows: Array<{ isTTY: boolean; ci: boolean; noHyperlinks: boolean; shareable: boolean }> = [];
  for (const isTTY of [true, false]) {
    for (const ci of [true, false]) {
      for (const noHyperlinks of [true, false]) {
        for (const shareable of [true, false]) {
          rows.push({ isTTY, ci, noHyperlinks, shareable });
        }
      }
    }
  }

  it.each(rows)(
    "isTTY=$isTTY CI=$ci NO_HYPERLINKS=$noHyperlinks shareable=$shareable -> linkify iff all four gate legs hold",
    ({ isTTY, ci, noHyperlinks, shareable }) => {
      const env: Record<string, string | undefined> = {};
      if (ci) env.CI = "true";
      if (noHyperlinks) env.COWORK_HARNESS_NO_HYPERLINKS = "1";
      const expected = isTTY && !ci && !noHyperlinks && !shareable;
      expect(shouldLinkify(env, isTTY, shareable)).toBe(expected);
    },
  );
});

describe("renderer — injected linkify decorates the live sink only, never dump()", () => {
  const translate = makeDisplayTranslator({ ctx: baseCtx(), effectiveFidelity: "hostloop", shareable: false });
  function sink() {
    const out: string[] = [];
    return { write: (s: string) => out.push(s), text: () => out.join("") };
  }
  const linkifyEvents: AgentEvent[] = [
    { type: "assistant_text", text: "see computer:///sessions/sess1/mnt/outputs/report.pdf for details" },
    {
      type: "tool_use",
      name: "Bash",
      input: { command: "cat computer:///sessions/sess1/mnt/outputs/report.pdf" },
      toolUseId: "tu1",
    },
    { type: "tool_result", toolUseId: "tu1", isError: false, text: "computer:///sessions/sess1/mnt/outputs/report.pdf: 3 lines" },
  ];

  it("live sink shows the OSC 8 escape around the translated (host-shaped) assistant-text link", () => {
    const s = sink();
    const p: RenderPlan = {
      live: true,
      progress: true,
      verbose: true,
      color: false,
      compact: false,
      translate,
      linkify: linkifyForTerminal,
    };
    const r = makeRenderer(p, s.write);
    for (const e of linkifyEvents) r.onEvent!(e);
    expect(s.text()).toContain(OSC8_START + "file:///host/outputs/report.pdf");
    expect(s.text()).toContain("computer:///host/outputs/report.pdf" + OSC8_CLOSE);
  });

  it("dump() (the failure-transcript buffer) is escape-free even when live output was linkified", () => {
    const s = sink();
    const p: RenderPlan = {
      live: true,
      progress: true,
      verbose: true,
      color: false,
      compact: false,
      translate,
      linkify: linkifyForTerminal,
    };
    const r = makeRenderer(p, s.write);
    for (const e of linkifyEvents) r.onEvent!(e);
    expect(r.dump()).toContain("computer:///host/outputs/report.pdf");
    expect(r.dump()).not.toContain(OSC8_START);
  });

  it("tool_use input summaries and tool_result heads are NOT linkified (hard-sliced lines; a truncated URL wrapped is a wrong-target link)", () => {
    const s = sink();
    const p: RenderPlan = {
      live: true,
      progress: true,
      verbose: true,
      color: false,
      compact: false,
      translate,
      linkify: linkifyForTerminal,
    };
    const r = makeRenderer(p, s.write);
    for (const e of linkifyEvents) r.onEvent!(e);
    // the tool lines are present (translated) but never contain the OSC 8 opener.
    const lines = s.text().split("\n");
    const toolLines = lines.filter((l) => l.includes("Bash") || l.includes("3 lines"));
    expect(toolLines.length).toBeGreaterThan(0);
    for (const l of toolLines) expect(l).not.toContain(OSC8_START);
  });

  it("without an injected linkify, the live sink stays plain (identity — today's behavior)", () => {
    const s = sink();
    const p: RenderPlan = { live: true, progress: true, verbose: true, color: false, compact: false, translate };
    const r = makeRenderer(p, s.write);
    for (const e of linkifyEvents) r.onEvent!(e);
    expect(s.text()).not.toContain(OSC8_START);
  });
});
