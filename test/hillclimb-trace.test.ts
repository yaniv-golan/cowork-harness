// Turn[] export (SCHEMA.md M l.201-213; build-eval.md B l.119-131). The fixture is a kept run of the repo's
// public subagent-manifest-probe example (test/fixtures/hillclimb-runs/README.md): one Agent dispatch whose
// sub-agent made seven tool calls.
//
// Two sources, never mixed: main-loop turns come from events.jsonl events with no parent_tool_use_id; a
// sub-agent's turns come only from its own transcript. The parent stream ALSO carries every sub-agent tool
// call and result (parented events) — reading both would emit each sub-agent tool turn twice.
import { describe, it, expect } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnsFromEvents, readChildTranscripts, keptChildTranscripts, type ChildTranscript } from "../src/hillclimb/trace.js";

const DIR = join(import.meta.dirname, "fixtures", "hillclimb-runs", "fanout-probe");
const events = readFileSync(join(DIR, "events.jsonl"), "utf8").trim().split("\n");
const children = readChildTranscripts(join(DIR, "subagents"));
const childToolUses = children[0].lines.filter((l) => {
  const o = JSON.parse(l);
  return (
    o.type === "assistant" && Array.isArray(o.message?.content) && o.message.content.some((b: { type: string }) => b.type === "tool_use")
  );
}).length;
const parentedToolUses = events.filter((l) => {
  const o = JSON.parse(l);
  return o.type === "assistant" && o.parent_tool_use_id && o.message.content.some((b: { type: string }) => b.type === "tool_use");
}).length;

const trace = (over: Partial<Parameters<typeof turnsFromEvents>[0]> = {}) =>
  turnsFromEvents({ events, prompt: "the prompt", system: "SYSTEM", children, sidecarPrefix: "baseline/out/c_rep0/blobs/", ...over });

describe("readChildTranscripts", () => {
  it("joins each transcript to its dispatch by the meta file's toolUseId", () => {
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ toolUseId: "toolu_01XB9SXzRHWjKtHwT5nWZn3x", agentType: "general-purpose", spawnDepth: 1 });
  });
});

describe("turnsFromEvents over a real fan-out run", () => {
  const { turns, subagentTurns } = trace();

  it("starts with the system turn, then the user prompt", () => {
    expect(turns[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(turns[1]).toEqual({ role: "user", content: "the prompt" });
  });

  it("every turn has a valid role and only the schema's keys; no empty thinking", () => {
    for (const t of turns) {
      expect(["system", "user", "assistant", "tool_call", "tool_result"]).toContain(t.role);
      for (const k of Object.keys(t)) expect(["role", "content", "name", "thinking", "attachments"]).toContain(k);
      expect(typeof t.content).toBe("string");
      if ("thinking" in t) expect(t.thinking!.trim()).not.toBe("");
    }
  });

  it("the run's thinking blocks are empty (current models redact them), so no turn carries thinking", () => {
    expect(events.some((l) => l.includes('"type":"thinking"'))).toBe(true);
    expect(turns.filter((t) => "thinking" in t)).toEqual([]);
  });

  it("sub-agent tool turns come from the transcript ONCE — never again from the parented stream events", () => {
    const subCalls = turns.filter((t) => t.role === "tool_call" && t.content.startsWith("[sub-agent "));
    expect(parentedToolUses).toBe(7);
    expect(subCalls).toHaveLength(childToolUses);
    expect(turns.filter((t) => t.role === "tool_call")).toHaveLength(1 + childToolUses);
  });

  it("sub-agent turns sit inline between the Agent call and its result, each prefixed", () => {
    const callIdx = turns.findIndex((t) => t.role === "tool_call" && t.name === "Agent" && !t.content.startsWith("[sub-agent"));
    const resultIdx = turns.findIndex((t, i) => i > callIdx && t.role === "tool_result" && t.name === "Agent");
    expect(callIdx).toBeGreaterThan(0);
    expect(resultIdx).toBeGreaterThan(callIdx + 1);
    for (const t of turns.slice(callIdx + 1, resultIdx)) expect(t.content).toMatch(/^\[sub-agent general-purpose#1\] /);
    expect(subagentTurns).toBe("complete");
  });

  it("every tool_result is named after its call", () => {
    const names = new Set(turns.filter((t) => t.role === "tool_call").map((t) => t.name));
    for (const t of turns.filter((t) => t.role === "tool_result")) expect(names).toContain(t.name);
  });
});

describe("turnsFromEvents — absence, caps, payloads", () => {
  it("no transcript for a dispatch ⇒ a note in its place and subagent turns 'absent'", () => {
    const { turns, subagentTurns } = trace({ children: [] });
    expect(subagentTurns).toBe("absent");
    expect(turns.some((t) => /\[sub-agent general-purpose\] transcript not captured/.test(t.content))).toBe(true);
    // its tool traffic is still on the parent stream: kept, prefixed, once
    expect(turns.filter((t) => t.role === "tool_call" && t.content.startsWith("[sub-agent general-purpose] "))).toHaveLength(
      parentedToolUses,
    );
  });

  it("one of two dispatches without a transcript ⇒ 'partial'", () => {
    // SYNTHETIC: the real Agent tool_use line repeated under a second id that has no transcript.
    const agentLine = events.find((l) => !JSON.parse(l).parent_tool_use_id && l.includes('"name":"Agent"'))!;
    const second = agentLine.replaceAll("toolu_01XB9SXzRHWjKtHwT5nWZn3x", "toolu_second");
    expect(trace({ events: [...events, second] }).subagentTurns).toBe("partial");
  });

  it("a run with no dispatch reports subagent turns 'none'", () => {
    const main = events.filter((l) => !JSON.parse(l).parent_tool_use_id && !l.includes('"name":"Agent"'));
    expect(trace({ events: main, children: [] }).subagentTurns).toBe("none");
  });

  it("a tool result over the cap is truncated with a pointer, and the full text goes to a sidecar", () => {
    const { turns, sidecars } = trace({ resultCapBytes: 200 });
    const cut = turns.find((t) => t.role === "tool_result" && t.content.includes("[truncated:"));
    expect(cut).toBeDefined();
    expect(cut!.content).toMatch(/\[truncated: \d+ bytes; full text in baseline\/out\/c_rep0\/blobs\/[\w.-]+\.txt\]/);
    expect(sidecars.length).toBeGreaterThan(0);
    expect(sidecars[0].name).toMatch(/\.txt$/);
  });

  it("text is redacted BEFORE the cap slices it: a secret straddling the cut leaves no prefix behind", () => {
    const secret = "sk-ant-straddle-0123456789abcdefghij";
    // SYNTHETIC: one tool result whose text puts the secret across the 200-byte cut.
    const text = "x".repeat(190) + secret + "y".repeat(50);
    const ev = [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
      }),
    ];
    const redact = (s: string) => s.split(secret).join("[REDACTED]");
    const { turns, sidecars } = trace({ events: ev, children: [], resultCapBytes: 200, redact });
    const all = JSON.stringify(turns) + sidecars.map((x) => String(x.data)).join("");
    expect(all).not.toContain(secret.slice(0, 12));
  });

  it("an image block in a tool result becomes a sidecar with a markdown image reference (H l.217)", () => {
    // SYNTHETIC: one tool_use/tool_result pair carrying a base64 PNG (no kept public run has one).
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const ev = [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "t1", name: "Screenshot", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }],
            },
          ],
        },
      }),
    ];
    const { turns, sidecars } = trace({ events: ev, children: [] });
    const res = turns.find((t) => t.role === "tool_result")!;
    expect(res.content).toMatch(/^!\[\]\(baseline\/out\/c_rep0\/blobs\/[\w.-]+\.png\)$/);
    expect(sidecars[0]).toMatchObject({ name: expect.stringMatching(/\.png$/) });
    expect(Buffer.from(sidecars[0].data).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("without a system string, no system turn is invented", () => {
    expect(trace({ system: undefined }).turns[0].role).toBe("user");
  });
});

describe("type check of the input shape", () => {
  it("ChildTranscript carries its lines", () => {
    const c: ChildTranscript = children[0];
    expect(c.lines.length).toBeGreaterThan(0);
  });
});

describe("keptChildTranscripts — where each tier leaves sub-agent transcripts in a kept run dir", () => {
  const layouts: Array<[string, (out: string) => string]> = [
    ["hostloop", (out) => join(out, "claude-config")],
    ["protocol", (out) => join(out, "claude-config")], // the managed config dir; unmanaged protocol has none
    ["container", (out) => join(out, "work", "session", "mnt", ".claude")],
    ["microvm", (out) => join(out, "work", "session", "mnt", ".claude")], // the snapshot of the VM session root
  ];
  for (const [tier, root] of layouts)
    it(`${tier}: finds the transcript under ${tier === "hostloop" || tier === "protocol" ? "claude-config" : "work/session/mnt/.claude"}`, () => {
      const out = mkdtempSync(join(tmpdir(), `hc-kept-${tier}-`));
      try {
        const dest = join(root(out), "projects", "-enc-cwd", "0000-session", "subagents");
        mkdirSync(dest, { recursive: true });
        cpSync(join(DIR, "subagents"), dest, { recursive: true });
        const found = keptChildTranscripts({ outDir: out, fidelity: tier, workDir: join(out, "work", "session", "mnt") });
        expect(found.map((c) => c.toolUseId)).toEqual(["toolu_01XB9SXzRHWjKtHwT5nWZn3x"]);
        // and a tier pointed at the WRONG root finds nothing, so the per-tier rule is what finds it
        const other = tier === "container" || tier === "microvm" ? "hostloop" : "container";
        expect(keptChildTranscripts({ outDir: out, fidelity: other, workDir: join(out, "work", "session", "mnt") })).toEqual([]);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
});

describe("a forked skill (context: fork) — its work is the skill's own and must be in the trace", () => {
  const FDIR = join(import.meta.dirname, "fixtures", "hillclimb-runs", "forked-skill");
  const fevents = readFileSync(join(FDIR, "events.jsonl"), "utf8").trim().split("\n");
  const fchildren = readChildTranscripts(join(FDIR, "subagents"));
  const run = (children: ChildTranscript[]) =>
    turnsFromEvents({ events: fevents, prompt: "p", children, sidecarPrefix: "baseline/out/c_rep0/blobs/" });

  it("the fork's transcript has no toolUseId, yet is joined to its Skill call by the tool ids it shares", () => {
    expect(fchildren).toHaveLength(1);
    expect(fchildren[0].toolUseId).toBeUndefined();
    const { turns, subagentTurns } = run(fchildren);
    const forked = turns.filter((t) => t.role === "tool_call" && t.content.startsWith("[forked skill example-fork-skill#1] "));
    expect(forked).toHaveLength(17); // the run recorded 18 tool calls: the Skill call itself + 17 inside the fork
    expect(subagentTurns).toBe("complete");
    const skillCall = turns.findIndex((t) => t.role === "tool_call" && t.name === "Skill");
    const skillResult = turns.findIndex((t) => t.role === "tool_result" && t.name === "Skill");
    expect(skillCall).toBeLessThan(turns.indexOf(forked[0]));
    expect(turns.indexOf(forked[16])).toBeLessThan(skillResult);
  });

  it("with no transcript, the fork's own tool calls still appear (from the parent stream) and the trace says it is not complete", () => {
    const { turns, subagentTurns } = run([]);
    expect(turns.filter((t) => t.role === "tool_call" && t.content.startsWith("[forked skill example-fork-skill] "))).toHaveLength(17);
    expect(subagentTurns).toBe("absent");
  });
});

describe("readChildTranscripts over an agent-writable dir", () => {
  it("a planted FIFO or symlink is skipped, never read — the runner must not hang or pull in a host file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-fifo-"));
    try {
      writeFileSync(join(dir, "agent-f.meta.json"), JSON.stringify({ toolUseId: "tf" }));
      execFileSync("mkfifo", [join(dir, "agent-f.jsonl")]);
      writeFileSync(join(dir, "agent-s.meta.json"), JSON.stringify({ toolUseId: "ts" }));
      writeFileSync(join(dir, "host.txt"), '{"type":"assistant","message":{"content":[{"type":"text","text":"HOST"}]}}\n');
      symlinkSync(join(dir, "host.txt"), join(dir, "agent-s.jsonl"));
      cpSync(join(DIR, "subagents"), dir, { recursive: true });
      expect(readChildTranscripts(dir).map((c) => c.toolUseId)).toEqual(["toolu_01XB9SXzRHWjKtHwT5nWZn3x"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
