import { warn } from "./io.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformBaseline } from "./types.js";
import type { SessionConfig } from "./session.js";

const BASELINES_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "baselines");

/**
 * Render the Cowork system-prompt sections + subagent append from the baseline,
 * substituting the Desktop builder's tokens (mirror of `y8r`). `systemPromptAppend` is
 * delivered via the `--append-system-prompt` CLI flag (layered on the agent's built-in base
 * prompt — see argv.ts); only `subagentAppend` goes over the `initialize` control_request
 * (appendSubagentSystemPrompt).
 *
 * Reconstructed cowork-specific sections only (the full base prompt isn't cleanly
 * extractable); enough to give the model Cowork's file/skill/outputs framing.
 */
export interface RenderedPrompts {
  systemPromptAppend?: string;
  subagentAppend?: string;
  /** Structured fidelity warnings collected during prompt rendering — surfaced in RunResult.fidelityWarnings. */
  fidelityWarnings?: string[];
}

/**
 * Host-loop's prompt-token substitution recipe (production's exact recipe — plan §1.4/P2a). Only
 * consulted when `effectiveFidelity === "hostloop"`; every other tier keeps today's VM-path tokens
 * byte-identical. All fields are HOST paths (hostloop is the one tier where the model already speaks
 * host paths, matching what production substitutes there).
 */
export interface HostLoopPromptOpts {
  effectiveFidelity?: string;
  /** `{{cwd}}` -> this (production: `hostCwd ?? sessionRoot`). */
  hostCwd?: string;
  /** Pre-replacement target for the literal substring `{{cwd}}/mnt/uploads` — MUST be applied before
   *  the general `{{cwd}}` substitution (see below), or a naive `{{cwd}}`-then-append-`/mnt/uploads`
   *  join could diverge from where uploads are actually staged. */
  hostUploadsDir?: string;
  /** `{{skillsDir}}` -> this, falling back to the verbatim string "(no skills directory — skip skill
   *  reads)" when absent (binary-verified fallback — grep-anchor `"{{skillsDir}}"`). */
  hostSkillsDir?: string;
  /** `{{workspaceFolder}}` -> this, falling back to `hostCwd` (production: the connected folder's host
   *  path `?? hostCwd`). */
  hostWorkspaceFolder?: string;
}

export function renderPrompts(
  baseline: PlatformBaseline,
  session: SessionConfig,
  sessionId: string,
  /**
   * The mnt-relative mount path of the first connected work folder (from `plan.mounts`), e.g. `project`
   * (gated, >=1.14271.0) or `.projects/project` (legacy). Passed by the caller so `{{workspaceFolder}}`
   * uses the ACTUAL resolved+gated mount name and can never drift from where the folder is really mounted.
   * Undefined when no folder is connected.
   */
  firstFolderMountPath?: string,
  hostLoopOpts?: HostLoopPromptOpts,
): RenderedPrompts {
  const spawn = baseline.spawn;
  if (!spawn) return {};
  const sessionRoot = `/sessions/${sessionId}`;
  const mntRoot = `${sessionRoot}/mnt`;
  const workspaceFolder = firstFolderMountPath ? `${mntRoot}/${firstFolderMountPath}` : `${mntRoot}/outputs`;
  // {{currentDateTime}}/{{currentTimezone}} are deliberately render-time-impure (wall clock, host
  // TZ) — that's what the real Desktop builder substitutes, and the rendered append never enters a
  // cassette (fingerprint hashes baseline+skillHash only), so replay determinism is unaffected. Do
  // not freeze these for testability; snapshot tests of the full rendered prompt would flake by design.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const localDateTime =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const isHostLoop = hostLoopOpts?.effectiveFidelity === "hostloop";
  const tokens: Record<string, string> = {};
  // Host-loop's uploads pre-replacement MUST be inserted BEFORE the "{{cwd}}" entry below: `subst`
  // applies tokens in Object.entries insertion order (guaranteed for string keys), each a global
  // find-replace over the whole string, so this consumes every "{{cwd}}/mnt/uploads" occurrence first
  // — exactly production's order (1) — leaving the plain "{{cwd}}" substitution (order (2)) to handle
  // only what's left. Reversing the order would rewrite "{{cwd}}/mnt/uploads" via the generic {{cwd}}
  // token first, then naively append "/mnt/uploads" to whatever host path that yields — which is only
  // correct when the uploads dir happens to be a literal `<hostCwd>/mnt/uploads` child, not in general.
  if (isHostLoop && hostLoopOpts?.hostUploadsDir) tokens["{{cwd}}/mnt/uploads"] = hostLoopOpts.hostUploadsDir;
  tokens["{{cwd}}"] = isHostLoop ? (hostLoopOpts?.hostCwd ?? sessionRoot) : sessionRoot;
  tokens["{{skillsDir}}"] = isHostLoop ? (hostLoopOpts?.hostSkillsDir ?? "(no skills directory — skip skill reads)") : `${mntRoot}/.claude`;
  tokens["{{workspaceFolder}}"] = isHostLoop
    ? (hostLoopOpts?.hostWorkspaceFolder ?? hostLoopOpts?.hostCwd ?? sessionRoot)
    : workspaceFolder;
  tokens["{{folderSelected}}"] = firstFolderMountPath ? "true" : "false";
  tokens["{{modelName}}"] = session.model ?? "Claude";
  // <env> tokens (>=1.18286.0 append). The exact Desktop date format is unverified from the asar
  // (substitution happens host-side); a readable local timestamp keeps the semantic content.
  tokens["{{currentDateTime}}"] = localDateTime;
  tokens["{{currentTimezone}}"] = Intl.DateTimeFormat().resolvedOptions().timeZone;
  tokens["{{accountName}}"] = session.account_name ?? "User";
  const subst = (s: string) => Object.entries(tokens).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  const fidelityWarnings: string[] = [];
  const read = (rel?: string) => {
    if (!rel) return undefined; // no asset configured — not a drift, just absent
    const p = join(BASELINES_DIR, rel);
    if (!existsSync(p)) {
      // A baseline that REFERENCES a prompt asset which is absent must not silently degrade — the
      // run would proceed without key Cowork framing. By default this is a fatal error.
      // Set COWORK_HARNESS_ALLOW_MISSING_PROMPT=1 to skip and continue (still emits a warning).
      if (process.env.COWORK_HARNESS_ALLOW_MISSING_PROMPT === "1") {
        const msg = `[prompt] referenced asset not found: ${p} — running WITHOUT this prompt section (fidelity gap)`;
        warn(`::warning:: ${msg}\n`);
        fidelityWarnings.push(msg); // surface to JSON callers via RunResult.fidelityWarnings
        return undefined;
      }
      throw new Error(`cowork-harness: missing prompt asset: ${p}. Set COWORK_HARNESS_ALLOW_MISSING_PROMPT=1 to skip.`);
    }
    return subst(stripComments(readFileSync(p, "utf8"))).trim();
  };
  return {
    systemPromptAppend: read(spawn.promptTemplate),
    subagentAppend: read(spawn.subagentAppend),
    fidelityWarnings: fidelityWarnings.length ? fidelityWarnings : undefined,
  };
}

/**
 * Strip HTML comments from a prompt asset. Repeats until the string stabilizes so that
 * nested / overlapping markers (e.g. `<!--<!-- -->-->`) can't leave a residual `<!--`
 * behind after a single pass — a one-shot `.replace` is incomplete sanitization.
 */
export function stripComments(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<!--[\s\S]*?-->/g, "");
  } while (s !== prev);
  return s;
}
