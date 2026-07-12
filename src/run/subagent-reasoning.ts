import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../types.js";

/**
 * Capture per-sub-agent REASONING (thinking + intermediate text turns) from the child session
 * transcript the agent binary writes for each `Task` dispatch — the ONLY channel for a sub-agent's
 * reasoning, since the SDK suppresses sub-agent thinking on the parent event stream (live-verified
 * against a real dispatch). LIVE/record lane only: the child transcript exists only while the real
 * agent binary ran, so this is called at execute.ts's finalize (after `assembleRunResult`, before
 * `result.json` is written) and never on replay (no child transcript to read).
 *
 * Same 50-entry / 10KB-per-entry cap convention as the main-thread `thinking[]` field
 * (`Run.THINKING_CAP` / `Run.THINKING_TEXT_CAP_BYTES` in src/run/run.ts) — kept as separate constants
 * here (not imported) because `Run` is a `run.ts`-private class with no exported cap; the VALUES are
 * intentionally identical, not the symbols.
 */
export const REASONING_CAP = 50;
export const REASONING_TEXT_CAP_BYTES = 10 * 1024;

type SubagentEntry = NonNullable<RunResult["subagents"]>[number];
type ReasoningTurn = NonNullable<SubagentEntry["reasoning"]>[number];

/** Recursively find every `agent-*.meta.json` under `<configDirRoot>/projects/**\/subagents/` (any
 *  nesting depth — the projSlug/parentSessionUUID path segments are NOT reconstructed; the join happens
 *  purely on `meta.toolUseId`, see `captureSubagentReasoning` below). Never throws: an unreadable
 *  directory anywhere in the walk is silently skipped (not "no meta files found" for the WHOLE tree —
 *  only that subtree). */
function findMetaFiles(configDirRoot: string): string[] {
  const projectsRoot = join(configDirRoot, "projects");
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, TOCTOU removal, not-a-dir) — skip this subtree only
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".meta.json")) out.push(full);
    }
  };
  try {
    if (existsSync(projectsRoot)) walk(projectsRoot);
  } catch {
    /* existsSync itself should never throw, but stay defensive — see the module doc's "never throw" contract */
  }
  return out;
}

/** Parse ONE child session transcript (`agent-<id>.jsonl`, same per-line `{type, message:{role,
 *  content:[...]}}` shape as the main transcript) into its ordered thinking+text turns
 *  (tool_use/tool_result excluded — those are already covered by `toolsUsed`/`referencesRead`).
 *  Capped with the same sliding-window convention `Run.noteThinking` uses: push, and once the array
 *  exceeds the cap, shift the oldest entry out and count it in `elided` — so the surfaced turns are
 *  always the MOST RECENT `REASONING_CAP`. A malformed line (bad JSON, unexpected shape) is skipped,
 *  not fatal — the rest of the file still parses. */
function parseChildTranscript(jsonlPath: string): { reasoning: ReasoningTurn[]; elided: number } {
  const reasoning: ReasoningTurn[] = [];
  let elided = 0;
  const raw = readFileSync(jsonlPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // one malformed line does not abort the file
    }
    const rec = parsed as { type?: string; message?: { role?: string; content?: unknown } };
    if (rec.type !== "assistant" || rec.message?.role !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; text?: string; thinking?: string };
      let kind: "thinking" | "text" | undefined;
      let text: string | undefined;
      if (b?.type === "thinking" && typeof b.thinking === "string") {
        kind = "thinking";
        text = b.thinking;
      } else if (b?.type === "text" && typeof b.text === "string") {
        kind = "text";
        text = b.text;
      }
      if (kind === undefined || text === undefined) continue;
      const capped = text.length > REASONING_TEXT_CAP_BYTES ? text.slice(0, REASONING_TEXT_CAP_BYTES) : text;
      reasoning.push({ kind, text: capped });
      if (reasoning.length > REASONING_CAP) {
        reasoning.shift();
        elided++;
      }
    }
  }
  return { reasoning, elided };
}

/**
 * Join each `subagents[]` dispatch to its child session transcript (LIVE/record only) and populate
 * `.reasoning` (+ `.reasoningElided` past the cap) IN PLACE. Join key: `meta.toolUseId ===
 * subagents[].toolUseId` — an exact match, never a reconstructed path.
 *
 * NEVER THROWS: every fs/JSON operation is wrapped so a missing/malformed child transcript (or an
 * unreadable `configDirRoot` entirely — e.g. a tier this wasn't called for) just leaves the affected
 * dispatch's `reasoning` undefined, never aborts the caller's finalize path. A dispatch with no
 * matching child file is left untouched (`reasoning` stays undefined, distinct from `[]` — the latter
 * means a child file WAS found but produced no thinking/text turns, a valid "no reasoning captured").
 */
export function captureSubagentReasoning(configDirRoot: string, subagents: SubagentEntry[] | undefined): void {
  if (!subagents?.length) return;
  try {
    const metaFiles = findMetaFiles(configDirRoot);
    if (!metaFiles.length) return;
    const byToolUseId = new Map<string, SubagentEntry>();
    for (const s of subagents) if (s.toolUseId) byToolUseId.set(s.toolUseId, s);
    for (const metaPath of metaFiles) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { toolUseId?: string };
        const toolUseId = meta?.toolUseId;
        if (!toolUseId) continue;
        const entry = byToolUseId.get(toolUseId);
        if (!entry) continue; // meta file for a dispatch not (or no longer) in this result — skip
        const jsonlPath = metaPath.replace(/\.meta\.json$/, ".jsonl"); // agent-<id>.meta.json's sibling
        if (!existsSync(jsonlPath)) continue;
        const { reasoning, elided } = parseChildTranscript(jsonlPath);
        entry.reasoning = reasoning;
        if (elided > 0) entry.reasoningElided = elided;
      } catch {
        // this ONE dispatch's meta/child file is malformed — skip it, other dispatches still join
        continue;
      }
    }
  } catch {
    // belt-and-braces: capture must never break the caller's finalize path
  }
}
