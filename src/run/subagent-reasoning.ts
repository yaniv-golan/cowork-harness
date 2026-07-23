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
 * KNOWN CAPTURE LIMIT — sub-agent thinking TEXT is empty by default. The child transcript records
 * sub-agent thinking blocks as an EMPTY `thinking` string plus a non-empty `signature` (the
 * cryptographic continuation token). This is NOT the binary stripping text at persist time — it's a
 * REQUEST-side display mode: the API's `thinking.display` for a sub-agent turn is forced to `"omitted"`
 * whenever the session is non-interactive (which the harness's `-p` spawn always is) and no explicit
 * display was set, so the model returns empty thinking blocks (signature-only) that the transcript then
 * faithfully records. (Binary-verified against the staged 2.1.205 agent: the non-interactive spawn path
 * forces `display:"omitted"` unless `--thinking-display` was set explicitly or `forwardSubagentText` is
 * on. Corpus-corroborated: 230/230 sub-agent thinking blocks were text-empty-but-signature-present,
 * while the same binary's MAIN-LOOP transcripts — which resolve display to the API default,
 * `"summarized"` on Sonnet-4.6 — keep 1810/1827 blocks with full text.) The signature is opaque (not a
 * reversible encoding of the text), and the same-run parent event stream drops sub-agent thinking too,
 * so with the default config the text is unrecoverable here.
 *
 * A lever exists but is OPT-IN and fidelity-diverging: the fenced `debug.thinking_display: "summarized"`
 * session field emits the agent binary's `--thinking-display summarized`, which surfaces SUMMARIZED
 * thinking text for BOTH loops (the API returns no raw chain-of-thought at all — `display` is only
 * `summarized`|`omitted`, so "summarized" is the ceiling). Live-verified: a matched hostloop A/B on
 * opus-4-8 showed the default run's sub-agent+main thinking blocks empty-but-signed, while the
 * `summarized` run's carried real text (sub-agent ~189 chars, main ~242). Real Cowork passes no such
 * flag, so the default `"omitted"` is the fidelity-faithful behavior; summarized is debug-only. Turns are
 * surfaced as `{ kind: "thinking", text: "", redacted: true }` so a consumer can tell "the sub-agent
 * reasoned, text omitted by request" from "no thought." Sub-agent TEXT turns (the visible receipt/output)
 * persist verbatim and are captured fully regardless.
 *
 * Same 50-entry / 10KB-per-entry cap convention as the main-thread `thinking[]` field
 * (`Run.THINKING_CAP` / `Run.THINKING_TEXT_CAP_BYTES` in src/run/run.ts) — kept as separate constants
 * here (not imported) because `Run` is a `run.ts`-private class with no exported cap; the VALUES are
 * intentionally identical, not the symbols.
 */
export const REASONING_CAP = 50;
export const REASONING_TEXT_CAP_BYTES = 10 * 1024;
/** Per-dispatch WebSearch capture caps: enough for real research fan-out without letting a
 *  search-looping sub-agent balloon result.json. Oldest entries elide first (sliding window, matching
 *  the reasoning cap's convention). */
export const SUBAGENT_WEBSEARCH_CAP = 10;
export const SUBAGENT_WEBSEARCH_RESULT_CAP_BYTES = 4 * 1024;

type SubagentEntry = NonNullable<RunResult["subagents"]>[number];
type ReasoningTurn = NonNullable<SubagentEntry["reasoning"]>[number];
type SubagentWebSearch = NonNullable<SubagentEntry["webSearches"]>[number];

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
 *  (non-WebSearch tool_use/tool_result excluded — those are already covered by
 *  `toolsUsed`/`referencesRead`) PLUS the sub-agent's own WebSearch calls (query from the assistant
 *  `tool_use` block, result text from the paired user `tool_result` block, both bounded) — the only
 *  place a sub-agent's research is recorded at all (the parent stream's `webSearches[]` is
 *  main-agent-scoped by design).
 *  Capped with the same sliding-window convention `Run.noteThinking` uses: push, and once the array
 *  exceeds the cap, shift the oldest entry out and count it in `elided` — so the surfaced turns are
 *  always the MOST RECENT `REASONING_CAP`. A malformed line (bad JSON, unexpected shape) is skipped,
 *  not fatal — the rest of the file still parses. */
function parseChildTranscript(jsonlPath: string): {
  reasoning: ReasoningTurn[];
  elided: number;
  webSearches: SubagentWebSearch[];
  webSearchesElided: number;
} {
  const reasoning: ReasoningTurn[] = [];
  let elided = 0;
  const webSearches: SubagentWebSearch[] = [];
  let webSearchesElided = 0;
  /** WebSearch tool_use id → its query, awaiting the paired tool_result on a later user record. */
  const pendingSearches = new Map<string, string>();
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
    // USER records carry the tool_result halves — resolve any pending WebSearch before the
    // assistant-only filter below skips the record.
    if (rec.type === "user" && Array.isArray(rec.message?.content)) {
      for (const block of rec.message.content) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown };
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const query = pendingSearches.get(b.tool_use_id);
        if (query === undefined) continue;
        pendingSearches.delete(b.tool_use_id);
        // tool_result content is a string OR an array of {type:"text",text} blocks — take the text parts.
        const text =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content
                  .map((c) =>
                    c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "",
                  )
                  .join("\n")
              : "";
        const truncatedResult = text.length > SUBAGENT_WEBSEARCH_RESULT_CAP_BYTES;
        const entry: SubagentWebSearch = { query, resultText: truncatedResult ? text.slice(0, SUBAGENT_WEBSEARCH_RESULT_CAP_BYTES) : text };
        if (truncatedResult) entry.resultTruncated = true;
        webSearches.push(entry);
        if (webSearches.length > SUBAGENT_WEBSEARCH_CAP) {
          webSearches.shift();
          webSearchesElided++;
        }
      }
      continue;
    }
    if (rec.type !== "assistant" || rec.message?.role !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      // A WebSearch tool_use stashes its query keyed by id, awaiting the paired user-record tool_result.
      const tu = block as { type?: string; id?: string; name?: string; input?: { query?: unknown } };
      if (tu?.type === "tool_use" && tu.name === "WebSearch" && typeof tu.id === "string" && typeof tu.input?.query === "string") {
        pendingSearches.set(tu.id, tu.input.query);
        continue;
      }
      const b = block as { type?: string; text?: string; thinking?: string; signature?: string };
      let kind: "thinking" | "text" | undefined;
      let text: string | undefined;
      let redacted = false;
      if (b?.type === "thinking" && typeof b.thinking === "string") {
        kind = "thinking";
        text = b.thinking;
        // Sub-agent thinking turns arrive with an empty `thinking` string but a non-empty `signature`
        // (the continuation token) — the model returned no thinking text because the non-interactive
        // spawn forces `thinking.display:"omitted"` for sub-agents (see the module doc; NOT a
        // persist-time strip). Flag that as `redacted: true` so a consumer reads it as "the sub-agent
        // reasoned here, text omitted by request" rather than "no thought." An empty thinking block with
        // NO signature carries no evidence any reasoning happened, so it is left unflagged.
        if (text === "" && typeof b.signature === "string" && b.signature.length > 0) redacted = true;
      } else if (b?.type === "text" && typeof b.text === "string") {
        kind = "text";
        text = b.text;
      }
      if (kind === undefined || text === undefined) continue;
      const capped = text.length > REASONING_TEXT_CAP_BYTES ? text.slice(0, REASONING_TEXT_CAP_BYTES) : text;
      const turn: ReasoningTurn = { kind, text: capped };
      if (redacted) turn.redacted = true;
      reasoning.push(turn);
      if (reasoning.length > REASONING_CAP) {
        reasoning.shift();
        elided++;
      }
    }
  }
  return { reasoning, elided, webSearches, webSearchesElided };
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
        const { reasoning, elided, webSearches, webSearchesElided } = parseChildTranscript(jsonlPath);
        entry.reasoning = reasoning;
        if (elided > 0) entry.reasoningElided = elided;
        // Same live-lane-only channel as reasoning: absent = never captured (replay), [] = captured, none made.
        if (webSearches.length > 0) entry.webSearches = webSearches;
        if (webSearchesElided > 0) entry.webSearchesElided = webSearchesElided;
      } catch {
        // this ONE dispatch's meta/child file is malformed — skip it, other dispatches still join
        continue;
      }
    }
  } catch {
    // belt-and-braces: capture must never break the caller's finalize path
  }
}
