import { resolve, isAbsolute, relative, dirname, basename, join } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { homedir } from "node:os";

/**
 * The hostloop PreToolUse path-containment gate. A byte-faithful port of production's inline hook body,
 * re-derived against Desktop 1.20186.1 (`.vite/build/index.chunk-CS-g0Skn.js` — a per-file byte offset,
 * NOT stable across releases or even across a sync that reshuffles chunk contents; re-derive on every
 * sync). Current map: the `PreToolUse` install site (`e.hooks={...e.hooks,PreToolUse:[...]}`) @40289,
 * whose anonymous hook closure (`async g=>{...}`) starts @40450; the mutating-tool set (`["Write","Edit",
 * "MultiEdit"]`, two local copies — `Jt` @36196, `Yt` @31700); the read-only guard `qt` @31717 (uploads/
 * hardlink branch @32164, spooled-projects branch @32589, plugin branch @32816); the shared `/sessions`
 * VM-path detector `xe` (used by both this hook and canUseTool, hence its `[canUseTool:HostLoop]` log
 * prefix) @34321. `expandTildePath`/`resolveFilePath`/`isPathContainedInFolders`/
 * `HOST_LOOP_PATH_GATED_BUILTIN_TOOLS` are referenced here only as `t.`-prefixed imports from a shared
 * runtime chunk — call sites @40703/@40785/@31820/@34321 respectively, bodies not traced in this pass.
 * This is hostloop's ENTIRE security boundary once the agent process is a native host spawn: with no OS
 * sandbox around the native file tools, this gate (plus the runtime tripwire in hostloop.ts/chat.ts that
 * detects it failing to fire) is what stands between a compromised/misbehaving skill and the real host
 * filesystem.
 */

/** Production's own gated-tool set (`HOST_LOOP_PATH_GATED_BUILTIN_TOOLS`), exactly 5 tools. Exported as
 *  the single source for the hostloop hook matcher string (hostloop.ts) and the chat-lane tripwire's
 *  gated-tool set (chat.ts) — MultiEdit is gated too but is NOT in this set: production's own `/sessions`
 *  guard below is gated on this exact 5-tool set, not the wider matcher string (production's own install
 *  site appends `"MultiEdit"` onto this same 5-list for the matcher — the identical pattern this port
 *  already used); callers that need the full matcher add "MultiEdit" themselves. */
export const PATH_GATE_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
const PATH_GATE_TOOLS = new Set<string>(PATH_GATE_TOOL_NAMES);
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit"]); // production's `Jt`/`Yt`, 1.20186.1
const PATH_ARG_KEYS = ["file_path", "path"] as const;

/** Port of production's `expandTildePath` (imported via `t.`, call site @40703): tilde expansion. Applied
 *  BEFORE the absolute-check — a `~/...` value is not absolute but must never be resolved against hostCwd. */
export function expandTilde(a: string): string {
  return a === "~" ? homedir() : a.startsWith("~/") || a.startsWith("~\\") ? join(homedir(), a.slice(2)) : a;
}

/**
 * Faithful port of production's `resolveFilePath` (imported via `t.`, call site @40785, Desktop
 * 1.20186.1). Do NOT "improve" the branching — the hook caller's ENOENT-vs-other error discrimination
 * depends on exactly which errors carry a `.code`.
 */
export async function resolvePathForGate(p: string, allowNonExistent: boolean): Promise<string> {
  try {
    return await realpath(p); // bare catch below — ANY realpath failure falls through, as in production
  } catch {
    if (allowNonExistent) {
      // realpath failed but the path lexically exists per lstat → dangling symlink, symlink loop, or
      // unreadable component. Throw an Error with NO `code`: the caller's `code !== "ENOENT"` check
      // turns this into a hard block.
      if (await lstat(p).catch(() => null)) {
        throw new Error(`Refusing to resolve non-regular file: ${p}`);
      }
      // Truly nonexistent (the new-file case): canonicalize the PARENT — this is the branch that stops
      // a symlinked parent dir from letting a new-file Write escape — then rejoin the basename.
      // Deliberately NOT recursive and NOT wrapped: if the parent itself doesn't exist, realpath's raw
      // fs error (code === "ENOENT") propagates, and the caller falls back to the lexical path, exactly
      // as production's hook does; any other code (EACCES/ELOOP) propagates and the caller blocks.
      const realParent = await realpath(dirname(p));
      return join(realParent, basename(p));
    }
    throw new Error(`Failed to resolve path: ${p}`);
  }
}

/** Symlink-safe containment (production's `isPathContainedInFolders`, imported via `t.`, call site
 *  @31820, Desktop 1.20186.1, ported): realpath each ALLOWED ROOT (the candidate arrives already
 *  canonicalized by resolvePathForGate), then check the candidate is the root or a genuine,
 *  non-".."-relative descendant. A root that doesn't exist is skipped, not fatal — matches production. */
async function isContained(candidate: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    try {
      const realRoot = await realpath(root);
      if (candidate === realRoot) return true;
      const rel = relative(realRoot, candidate);
      if (!isAbsolute(rel) && !rel.startsWith("..")) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface HostLoopPathGateConfig {
  hostCwd: string; // production: hostCwd = getOutputsDir(e)
  allowedRoots: string[]; // containment universe (reads incl. uploads/spool/plugins; writes reach here only past the read-only guard)
  /** mode:"r" folder mounts — HARNESS EXTENSION (consented, not product drift): readable by
   *  non-mutating tools only; production has no ro folders. Preserved across the 1.20186.1 re-port. */
  readOnlyRoots: string[];
  scratchRoots: string[]; // production's `be`/`k` — [hostCwd, hostOutputsDir]; here both are the SAME dir
  scratchMode: boolean; // scratch ⟺ chat-type session (production: sessionType === "chat", the `ie` flag)
  /** Production 1.20186.1 read-only CATEGORIES (the `qt` guard): a mutating tool whose path lands in one
   *  of these blocks with the category's own message; all remain READABLE via allowedRoots membership.
   *  Replaces the removed claudePluginRoot blanket exemption. */
  uploadsRoots: string[];
  spooledProjectsRoots: string[];
  readOnlyPluginRoots: string[];
}

export async function checkHostLoopPathGate(
  toolName: string,
  input: Record<string, unknown>,
  cfg: HostLoopPathGateConfig,
): Promise<{ decision: "block"; reason: string } | Record<string, never>> {
  if (!PATH_GATE_TOOLS.has(toolName) && toolName !== "MultiEdit") return {};
  // Production's /sessions guard loops BOTH ["file_path","path"] keys — it is a SEPARATE mechanism from
  // the main path extraction below, which is first-match-only. Gated on PATH_GATE_TOOLS specifically (not
  // the wider toolName!=="MultiEdit"-inclusive check the surrounding function otherwise uses): a
  // /sessions-shaped MultiEdit is denied via the GENERIC containment message below, not this one — same
  // block/allow outcome either way, but the denial TEXT differs, and this matches production's own gating.
  for (const key of PATH_GATE_TOOLS.has(toolName) ? PATH_ARG_KEYS : []) {
    const v = input[key];
    if (typeof v === "string" && (v === "/sessions" || v.startsWith("/sessions/")))
      return {
        decision: "block",
        reason:
          `\`${v}\` is a VM path. In this session the ${toolName} tool runs on the host filesystem, where ` +
          `\`/sessions/...\` doesn't exist. Use the host path for this file (connected folders are available ` +
          `at their real locations), or use the \`bash\` tool — which runs inside the VM — to operate on ` +
          `\`/sessions/...\` paths.`,
      };
  }
  // Production takes the FIRST string among ["file_path","path"] for the MAIN extraction/containment
  // check that follows (`.map(...).find(...)`) — a genuinely different, first-match-only mechanism.
  const raw = PATH_ARG_KEYS.map((k) => input[k]).find((v): v is string => typeof v === "string");
  if (raw === undefined) return {};
  // Production's order, preserved: trim → tilde-expand → lexical resolve against hostCwd → resolve with
  // the hook caller's exact ENOENT-fallback / non-ENOENT-block error split. The fallback lives HERE, in
  // the caller, not the resolver — production splits it the same way.
  const expanded = expandTilde(raw.trim());
  const lexical = isAbsolute(expanded) ? expanded : resolve(cfg.hostCwd, expanded);
  let candidate: string;
  try {
    candidate = await resolvePathForGate(lexical, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      return {
        decision: "block",
        reason: `\`${raw}\` could not be safely resolved (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    candidate = lexical; // parent dir doesn't exist either — lexical fallback, matching production
  }
  const mutating = MUTATING_TOOLS.has(toolName);
  // Production's `qt` read-only guard (1.20186.1): for a mutating tool, runs BEFORE the scratch/
  // containment logic below and checks three categories in order, each with its own deny text. The
  // uploads AND spooled-projects categories share production's chat-session text verbatim (the same
  // "write a modified copy to the scratch directory" wording the scratch branch below also uses) — chat
  // sessions never reach the plugin category at all, since its own guard is `!isChat` (production's chat
  // roots exclude plugin content entirely; see docs/fidelity-gaps.md "Chat-lane session topology").
  // Replaces the removed claudePluginRoot blanket exemption. Re-derive the literal texts from the asar
  // offsets in the header comment on every sync.
  if (mutating) {
    const scratchCopyMessage = `\`${raw}\` is read-only in this session. Read it and write a modified copy to a bare filename in the scratch directory instead.`;
    if (await isContained(candidate, cfg.uploadsRoots))
      return {
        decision: "block",
        reason: cfg.scratchMode
          ? scratchCopyMessage
          : `\`${raw}\` is read-only in this session — it is a hardlink to the user's original file, so writing here would overwrite it on their disk. If this document has a working copy (a Documents working file the user can see and export), edit that instead. Otherwise write your changes to a new file under the outputs directory.`,
      };
    if (await isContained(candidate, cfg.spooledProjectsRoots))
      return {
        decision: "block",
        reason: cfg.scratchMode
          ? scratchCopyMessage
          : `\`${raw}\` is read-only in this session (spooled tool results). Write a modified copy under the outputs directory instead.`,
      };
    if (!cfg.scratchMode && (await isContained(candidate, cfg.readOnlyPluginRoots)))
      return {
        decision: "block",
        reason: `\`${raw}\` is read-only in this session (plugin, skill, or knowledge content). Write a modified copy under the outputs directory instead.`,
      };
  }
  // Production's scratch + mutating branch: allow in the scratch roots; block-with-read-only-message in
  // the read-only roots.
  if (cfg.scratchMode && mutating) {
    if (await isContained(candidate, cfg.scratchRoots)) return {};
    if (await isContained(candidate, cfg.readOnlyRoots))
      return {
        decision: "block",
        reason: `\`${raw}\` is read-only in this session. Read it and write a modified copy to a bare filename in the scratch directory instead.`,
      };
  }
  // Production's composition: base set + read-only tail ONLY for non-scratch, non-mutating calls.
  const roots = [...(cfg.scratchMode ? cfg.scratchRoots : cfg.allowedRoots), ...(cfg.scratchMode || mutating ? [] : cfg.readOnlyRoots)];
  if (!(await isContained(candidate, roots)))
    return {
      decision: "block",
      // Production's hook-denial message uses the BARE tool name (`Lh = "request_cowork_directory"`, asar
      // byte 8081028) — the `mcp__cowork__` prefix is production's separate SYSTEM-PROMPT naming
      // convention, not what the hook denial text actually interpolates.
      reason: cfg.scratchMode
        ? `\`${raw}\` is outside this session's scratch directory, so ${toolName} can't reach it. Use a bare filename to stay inside the scratch directory; for files on the user's computer, suggest starting a Cowork task instead.`
        : `\`${raw}\` is outside this session's connected folders, so ${toolName} can't reach it. If this is a user project or working folder, request it with the \`request_cowork_directory\` tool — the user will be asked to approve it. Don't request system or application-internal directories.`,
    };
  return {};
}
