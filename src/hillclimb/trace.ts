// A run as the report's Turn[] (SCHEMA.md SCHEMA.md l.201-213; build-eval.md build-eval.md l.119-131): one entry per user message,
// assistant text, tool call and tool result, in stream order, with no nesting.
//
// Two sources, never mixed. Main-loop turns come from `events.jsonl` events with no `parent_tool_use_id`. A
// sub-agent's turns come ONLY from its own transcript (`subagents/agent-<id>.jsonl`, joined to its dispatch by
// the `.meta.json` toolUseId): the parent stream carries only the sub-agent's tool_use/tool_result blocks —
// its text and thinking are suppressed there — and reading both would emit each of its tool turns twice.
// Sub-agent turns are inlined right after the dispatch's tool_call, each prefixed `[sub-agent <type>#<n>] `
// (the schema documents `name` for tool turns only, so the prefix is the carrier).
//
// Non-text payloads go to sidecar files with a markdown reference at the point they appeared (eval-hillclimb.md l.217); a
// tool result over the cap is truncated in place with a pointer to a sidecar holding the full text. Nothing
// here is scrubbed: the flow writer scrubs every byte it writes.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { FsRefusal, NoFollowRoot } from "./fs.js";
import { join } from "node:path";

export interface Turn {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  name?: string;
  thinking?: string;
  attachments?: Array<{ kind?: string; ref: string; alt?: string }>;
}

export interface ChildTranscript {
  /** The dispatch this transcript answers, from its `.meta.json`. A forked skill's meta has none: it is then
   *  joined by the tool ids its transcript shares with the parent stream's parented events. */
  toolUseId?: string;
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  /** The child's prompt snapshot, reduced to its LAST part (where the harness append lands) and how many parts
   *  came before it. The earlier parts are Anthropic's built-in sub-agent prompt: the reader drops them and the
   *  snapshot line itself, so they never reach a trace. Absent ⇒ the transcript recorded no snapshot. */
  promptSnapshot?: { last: string; builtinParts: number };
  lines: string[];
}

export interface TraceInput {
  events: readonly string[];
  prompt: string;
  /** The system turn's content; omitted ⇒ no system turn (never an invented one). */
  system?: string;
  /** The sub-agent append the session sent (initialize.appendSubagentSystemPrompt); absent ⇒ none was sent. */
  subagentAppend?: string;
  children: readonly ChildTranscript[];
  /** Flow-root-relative prefix for sidecar references, e.g. `baseline/out/<id>_rep<k>/blobs/`. */
  sidecarPrefix: string;
  /** A tool result above this many UTF-8 bytes is truncated in place. Default 64 KiB. */
  resultCapBytes?: number;
  /** Applied to every text BEFORE any cap slices it — a secret straddling the cut would otherwise leave a
   *  prefix no later scrub can match (src/io.ts makes the same rule for display slices). */
  redact: (text: string) => string;
}

export interface TraceOutput {
  turns: Turn[];
  sidecars: Array<{ name: string; data: Buffer | string }>;
  /** none = no dispatch; complete / partial / absent = how many dispatches had a transcript. */
  subagentTurns: "none" | "complete" | "partial" | "absent";
}

const DISPATCH_TOOLS = new Set(["Agent", "Task"]);
const DEFAULT_CAP = 64 * 1024;

/** Every `agent-<id>.meta.json` + `.jsonl` pair under a sub-agents directory. A missing dir is no transcripts.
 *  The dir is agent-writable on the container and microvm tiers (it sits in the session mnt), so every read
 *  goes through the shared no-follow root: a planted symlink or FIFO is skipped, never followed or opened. */
export function readChildTranscripts(dir: string): ChildTranscript[] {
  if (!existsSync(dir)) return [];
  let root: NoFollowRoot;
  try {
    root = NoFollowRoot.existing(dir);
  } catch (e) {
    if (e instanceof FsRefusal) return [];
    throw e;
  }
  const read = (name: string): string | undefined => {
    try {
      return root.readFile(join(root.root, name));
    } catch (e) {
      if (e instanceof FsRefusal || (e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw e;
    }
  };
  const out: ChildTranscript[] = [];
  for (const ent of root.readdirNoFollow(root.root).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = ent.name;
    if (!f.endsWith(".meta.json") || !ent.isFile()) continue;
    let meta: { toolUseId?: unknown; agentType?: unknown; description?: unknown; spawnDepth?: unknown };
    try {
      meta = JSON.parse(read(f) ?? "");
    } catch {
      continue;
    }
    const text = read(f.replace(/\.meta\.json$/, ".jsonl"));
    if (text === undefined) continue;
    let promptSnapshot: ChildTranscript["promptSnapshot"];
    const lines: string[] = [];
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      const snap = snapshotOf(l);
      if (snap === undefined) lines.push(l);
      else if (snap !== null) promptSnapshot ??= snap;
    }
    out.push({
      ...(typeof meta.toolUseId === "string" ? { toolUseId: meta.toolUseId } : {}),
      ...(typeof meta.agentType === "string" ? { agentType: meta.agentType } : {}),
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
      ...(typeof meta.spawnDepth === "number" ? { spawnDepth: meta.spawnDepth } : {}),
      ...(promptSnapshot ? { promptSnapshot } : {}),
      lines,
    });
  }
  return out;
}

/** A `prompt_snapshot` attachment line, reduced to its last part; `null` for a snapshot line with no usable last
 *  part (dropped all the same); `undefined` for any other line. */
function snapshotOf(line: string): ChildTranscript["promptSnapshot"] | null | undefined {
  if (!line.includes('"prompt_snapshot"')) return undefined;
  let o: { type?: unknown; attachment?: { type?: unknown; systemPrompt?: unknown } };
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (o.type !== "attachment" || o.attachment?.type !== "prompt_snapshot") return undefined;
  const parts = o.attachment.systemPrompt;
  if (!Array.isArray(parts) || !parts.length || typeof parts[parts.length - 1] !== "string") return null;
  return { last: parts[parts.length - 1] as string, builtinParts: parts.length - 1 };
}

/** The sub-agent append a run's session sent: `initialize.appendSubagentSystemPrompt` in the harness-written
 *  `control-out.jsonl`. Undefined when the file or the field is absent (nothing was sent). */
export function sentSubagentAppend(outDir: string): string | undefined {
  let text: string | null;
  try {
    const r = NoFollowRoot.existing(outDir);
    text = r.readIfPresent(join(r.root, "control-out.jsonl"));
  } catch (e) {
    if (e instanceof FsRefusal || (e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw e;
  }
  for (const l of (text ?? "").split("\n")) {
    if (!l.includes("appendSubagentSystemPrompt")) continue;
    try {
      const o = JSON.parse(l) as { request?: { subtype?: unknown; appendSubagentSystemPrompt?: unknown } };
      if (o.request?.subtype === "initialize" && typeof o.request.appendSubagentSystemPrompt === "string")
        return o.request.appendSubagentSystemPrompt;
    } catch {
      /* a torn line */
    }
  }
  return undefined;
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
  const byId = new Map(input.children.filter((c) => c.toolUseId !== undefined).map((c) => [c.toolUseId!, c]));
  // The parent stream's parented events, by the dispatch they belong to. They identify a dispatch the tool
  // name does not (a forked Skill), join a transcript that names no toolUseId, and are the fallback source
  // when no transcript was kept.
  const parented = new Map<string, string[]>();
  for (const line of input.events) {
    let pid: unknown;
    try {
      pid = (JSON.parse(line) as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    } catch {
      continue;
    }
    if (typeof pid === "string" && pid) (parented.get(pid) ?? parented.set(pid, []).get(pid)!).push(line);
  }
  const toolIds = (lines: readonly string[]): Set<string> => {
    const ids = new Set<string>();
    for (const l of lines)
      try {
        const c = (JSON.parse(l) as { type?: string; message?: { content?: unknown } }).message?.content;
        if (Array.isArray(c)) for (const b of c as Block[]) if (b?.type === "tool_use" && b.id) ids.add(b.id);
      } catch {
        /* skip */
      }
    return ids;
  };
  const unnamed = input.children.filter((c) => c.toolUseId === undefined).map((c) => ({ c, ids: toolIds(c.lines), used: false }));
  // Each transcript is inlined at most once: one that dispatches itself (agent-writable on container/microvm)
  // would otherwise recurse without end.
  const inlined = new Set<ChildTranscript>();
  const childFor = (dispatchId: string): ChildTranscript | undefined => {
    const named = byId.get(dispatchId);
    if (named) {
      if (inlined.has(named)) return undefined;
      inlined.add(named);
      return named;
    }
    const mine = toolIds(parented.get(dispatchId) ?? []);
    const hit = unnamed.find((u) => !u.used && [...mine].some((id) => u.ids.has(id)));
    if (hit) hit.used = true;
    return hit?.c;
  };
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

  const clean = input.redact;
  // What the child received, said only from its own snapshot: the session's append is never stamped onto a
  // child whose snapshot does not end with exactly it (a fork, the protocol tier).
  const childSystem = (head: string, c: ChildTranscript): string => {
    const s = c.promptSnapshot;
    if (s === undefined) return `${head} — not recorded in its transcript]`;
    if (input.subagentAppend === undefined || s.last !== input.subagentAppend) return `${head} — harness append: none received]`;
    return `${head} — harness append as received; Anthropic's built-in sub-agent prompt (${s.builtinParts} parts) withheld]\n\n${clean(s.last)}`;
  };
  const capped = (raw: string): string => {
    const text = clean(raw);
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
          if (b.id && (DISPATCH_TOOLS.has(b.name) || parented.has(b.id))) {
            dispatches++;
            const child = childFor(b.id);
            const inp = b.input as { subagent_type?: unknown; skill?: unknown } | undefined;
            const kind =
              b.name === "Skill"
                ? `forked skill ${typeof inp?.skill === "string" ? inp.skill : "unknown"}`
                : `sub-agent ${child?.agentType ?? (typeof inp?.subagent_type === "string" ? inp.subagent_type : "unknown")}`;
            if (child) {
              found++;
              const n = (ordinals.get(kind) ?? 0) + 1;
              ordinals.set(kind, n);
              turns.push({ role: "system", content: childSystem(`${prefix}[${kind}#${n} system`, child) });
              walk(child.lines, `${prefix}[${kind}#${n}] `, false);
            } else if (parented.has(b.id)) {
              // No transcript: the parent stream still carries its tool traffic (not its text) — keep that.
              walk(parented.get(b.id)!, `${prefix}[${kind}] `, false);
              push({ role: "assistant", content: `${prefix}[${kind}] transcript not captured: its text and thinking are missing` });
            } else push({ role: "assistant", content: `${prefix}[${kind}] transcript not captured` });
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
  // The container/microvm root is in the agent-writable session mount: walk it without following anything.
  let r: NoFollowRoot;
  try {
    r = NoFollowRoot.existing(root);
  } catch (e) {
    if (e instanceof FsRefusal || (e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const dirs = (p: string): string[] => {
    try {
      return r
        .readdirNoFollow(p)
        .filter((d) => d.isDirectory())
        .map((d) => join(p, d.name));
    } catch (e) {
      if (e instanceof FsRefusal || (e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw e;
    }
  };
  const out: ChildTranscript[] = [];
  for (const cwd of dirs(join(r.root, "projects")))
    for (const session of dirs(cwd))
      if (dirs(session).includes(join(session, "subagents"))) out.push(...readChildTranscripts(join(session, "subagents")));
  return out;
}
