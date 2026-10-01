// A run as the report's Turn[] (SCHEMA.md M l.201-213; build-eval.md B l.119-131): one entry per user message,
// assistant text, tool call and tool result, in stream order, with no nesting.
//
// Two sources, never mixed. Main-loop turns come from `events.jsonl` events with no `parent_tool_use_id`. A
// sub-agent's turns come ONLY from its own transcript (`subagents/agent-<id>.jsonl`, joined to its dispatch by
// the `.meta.json` toolUseId): the parent stream carries only the sub-agent's tool_use/tool_result blocks —
// its text and thinking are suppressed there — and reading both would emit each of its tool turns twice.
// Sub-agent turns are inlined right after the dispatch's tool_call, each prefixed `[sub-agent <type>#<n>] `
// (the schema documents `name` for tool turns only, so the prefix is the carrier).
//
// Non-text payloads go to sidecar files with a markdown reference at the point they appeared (H l.217); a
// tool result over the cap is truncated in place with a pointer to a sidecar holding the full text. Nothing
// here is scrubbed: the flow writer scrubs every byte it writes.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Turn {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  name?: string;
  thinking?: string;
  attachments?: Array<{ kind?: string; ref: string; alt?: string }>;
}

export interface ChildTranscript {
  toolUseId: string;
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  lines: string[];
}

export interface TraceInput {
  events: readonly string[];
  prompt: string;
  /** The system turn's content; omitted ⇒ no system turn (never an invented one). */
  system?: string;
  children: readonly ChildTranscript[];
  /** Flow-root-relative prefix for sidecar references, e.g. `baseline/out/<id>_rep<k>/blobs/`. */
  sidecarPrefix: string;
  /** A tool result above this many UTF-8 bytes is truncated in place. Default 64 KiB. */
  resultCapBytes?: number;
}

export interface TraceOutput {
  turns: Turn[];
  sidecars: Array<{ name: string; data: Buffer | string }>;
  /** none = no dispatch; complete / partial / absent = how many dispatches had a transcript. */
  subagentTurns: "none" | "complete" | "partial" | "absent";
}

const DISPATCH_TOOLS = new Set(["Agent", "Task"]);
const DEFAULT_CAP = 64 * 1024;

/** Every `agent-<id>.meta.json` + `.jsonl` pair under a sub-agents directory. A missing dir is no transcripts. */
export function readChildTranscripts(dir: string): ChildTranscript[] {
  if (!existsSync(dir)) return [];
  const out: ChildTranscript[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".meta.json")) continue;
    let meta: { toolUseId?: unknown; agentType?: unknown; description?: unknown; spawnDepth?: unknown };
    try {
      meta = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const jsonl = join(dir, f.replace(/\.meta\.json$/, ".jsonl"));
    if (typeof meta.toolUseId !== "string" || !existsSync(jsonl)) continue;
    out.push({
      toolUseId: meta.toolUseId,
      ...(typeof meta.agentType === "string" ? { agentType: meta.agentType } : {}),
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
      ...(typeof meta.spawnDepth === "number" ? { spawnDepth: meta.spawnDepth } : {}),
      lines: readFileSync(jsonl, "utf8")
        .split("\n")
        .filter((l) => l.trim()),
    });
  }
  return out;
}

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function turnsFromEvents(input: TraceInput): TraceOutput {
  const cap = input.resultCapBytes ?? DEFAULT_CAP;
  const turns: Turn[] = [];
  const sidecars: TraceOutput["sidecars"] = [];
  const byId = new Map(input.children.map((c) => [c.toolUseId, c]));
  const ordinals = new Map<string, number>();
  let dispatches = 0;
  let found = 0;

  const sidecar = (ext: string, data: Buffer | string): string => {
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
    const name = `${sidecars.length}-${hash}.${ext}`;
    sidecars.push({ name, data });
    return input.sidecarPrefix + name;
  };

  const resultText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content, null, 2);
    const parts: string[] = [];
    for (const b of content as Block[]) {
      if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string") {
        const ext = EXT[b.source.media_type ?? ""] ?? "bin";
        parts.push(`![](${sidecar(ext, Buffer.from(b.source.data, "base64"))})`);
      } else parts.push(`<[${b?.type ?? "unknown"} block]>`);
    }
    return parts.join("\n");
  };

  const capped = (text: string): string => {
    const bytes = Buffer.byteLength(text);
    if (bytes <= cap) return text;
    const ref = sidecar("txt", text);
    return `${Buffer.from(text).subarray(0, cap).toString("utf8").replace(/�$/, "")}\n[truncated: ${bytes} bytes; full text in ${ref}]`;
  };

  /** Walk one stream (the main loop, or one sub-agent's transcript). */
  const walk = (lines: readonly string[], prefix: string, mainLoop: boolean): void => {
    const toolNames = new Map<string, string>();
    let pendingThinking: string | undefined;
    let lastTextMsg: string | undefined;
    const push = (t: Turn) => {
      if (pendingThinking && (t.role === "assistant" || t.role === "tool_call")) {
        t.thinking = pendingThinking;
        pendingThinking = undefined;
      }
      turns.push(t);
    };
    for (const line of lines) {
      let o: { type?: string; parent_tool_use_id?: unknown; message?: { id?: string; content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (mainLoop && o.parent_tool_use_id) continue; // a sub-agent's traffic: its transcript is the source
      if (o.type !== "assistant" && o.type !== "user") continue;
      const content = o.message?.content;
      if (!Array.isArray(content)) continue; // a sub-agent's dispatch prompt (a string) is already in the tool_call
      for (const b of content as Block[]) {
        if (o.type === "assistant" && b.type === "thinking") {
          if (typeof b.thinking === "string" && b.thinking.trim()) pendingThinking = b.thinking;
        } else if (o.type === "assistant" && b.type === "text" && typeof b.text === "string") {
          const last = turns[turns.length - 1];
          const msg = o.message?.id;
          if (msg !== undefined && msg === lastTextMsg && last?.role === "assistant") last.content += `\n\n${b.text}`;
          else push({ role: "assistant", content: prefix + b.text });
          lastTextMsg = msg;
        } else if (o.type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
          lastTextMsg = undefined;
          if (b.id) toolNames.set(b.id, b.name);
          push({ role: "tool_call", name: b.name, content: prefix + JSON.stringify(b.input ?? {}, null, 2) });
          if (DISPATCH_TOOLS.has(b.name) && b.id) {
            dispatches++;
            const child = byId.get(b.id);
            const declared = (b.input as { subagent_type?: unknown } | undefined)?.subagent_type;
            const type = child?.agentType ?? (typeof declared === "string" ? declared : "unknown");
            if (child) {
              found++;
              const n = (ordinals.get(type) ?? 0) + 1;
              ordinals.set(type, n);
              walk(child.lines, `${prefix}[sub-agent ${type}#${n}] `, false);
            } else push({ role: "assistant", content: `${prefix}[sub-agent ${type}] transcript not captured` });
          }
        } else if (o.type === "user" && b.type === "tool_result") {
          lastTextMsg = undefined;
          const name = (b.tool_use_id && toolNames.get(b.tool_use_id)) || "unknown";
          push({ role: "tool_result", name, content: prefix + capped(resultText(b.content)) });
        }
      }
    }
  };

  if (input.system !== undefined) turns.push({ role: "system", content: input.system });
  turns.push({ role: "user", content: input.prompt });
  walk(input.events, "", true);
  const subagentTurns = dispatches === 0 ? "none" : found === dispatches ? "complete" : found === 0 ? "absent" : "partial";
  return { turns, sidecars, subagentTurns };
}

/** The sub-agent transcripts a KEPT run dir holds, found by the same per-tier rule the live capture uses
 *  (`resolveSubagentConfigRoot`, src/run/execute.ts:307-323), mapped onto the kept copy:
 *  - hostloop, and protocol with a managed config dir → `<outDir>/claude-config`;
 *  - container → `<workDir>/.claude` (the bind-mounted session mnt, kept in place);
 *  - microvm → `<workDir>/.claude` (the snapshot of the VM session root, `snapshotMicroVmWorkspace`).
 *  Unmanaged protocol keeps none. Transcripts sit at `<root>/projects/<cwd>/<session>/subagents/`. */
export function keptChildTranscripts(run: { outDir: string; fidelity: string; workDir?: string }): ChildTranscript[] {
  const root =
    run.fidelity === "hostloop" || run.fidelity === "protocol"
      ? join(run.outDir, "claude-config")
      : run.fidelity === "container" || run.fidelity === "microvm"
        ? join(run.workDir ?? join(run.outDir, "work", "session", "mnt"), ".claude")
        : undefined;
  if (root === undefined) return [];
  const projects = join(root, "projects");
  if (!existsSync(projects)) return [];
  const out: ChildTranscript[] = [];
  for (const cwd of readdirSync(projects, { withFileTypes: true })) {
    if (!cwd.isDirectory()) continue;
    for (const session of readdirSync(join(projects, cwd.name), { withFileTypes: true }))
      if (session.isDirectory()) out.push(...readChildTranscripts(join(projects, cwd.name, session.name, "subagents")));
  }
  return out;
}
