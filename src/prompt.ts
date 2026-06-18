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
  /** #49: structured fidelity warnings collected during prompt rendering — surfaced in RunResult.fidelityWarnings. */
  fidelityWarnings?: string[];
}

export function renderPrompts(baseline: PlatformBaseline, session: SessionConfig, sessionId: string): RenderedPrompts {
  const spawn = baseline.spawn;
  if (!spawn) return {};
  const sessionRoot = `/sessions/${sessionId}`;
  const mntRoot = `${sessionRoot}/mnt`;
  const firstFolder = session.folders[0]?.to ?? (session.folders[0]?.from ? basenameish(session.folders[0].from) : undefined);
  const workspaceFolder = firstFolder ? `${mntRoot}/.projects/${firstFolder}` : `${mntRoot}/outputs`;
  const tokens: Record<string, string> = {
    "{{cwd}}": sessionRoot,
    "{{skillsDir}}": `${mntRoot}/.claude`,
    "{{workspaceFolder}}": workspaceFolder,
    "{{folderSelected}}": firstFolder ? "true" : "false",
    "{{modelName}}": session.model ?? "Claude",
  };
  const subst = (s: string) => Object.entries(tokens).reduce((acc, [k, v]) => acc.split(k).join(v), s);
  const fidelityWarnings: string[] = [];
  const read = (rel?: string) => {
    if (!rel) return undefined; // no asset configured — not a drift, just absent
    const p = join(BASELINES_DIR, rel);
    if (!existsSync(p)) {
      // #35/#24: a baseline that REFERENCES a prompt asset which is absent must not silently degrade — the
      // run would proceed without key Cowork framing. By default this is a fatal error.
      // Set COWORK_HARNESS_ALLOW_MISSING_PROMPT=1 to skip and continue (still emits a warning).
      if (process.env.COWORK_HARNESS_ALLOW_MISSING_PROMPT === "1") {
        const msg = `[prompt] referenced asset not found: ${p} — running WITHOUT this prompt section (fidelity gap)`;
        warn(`::warning:: ${msg}\n`);
        fidelityWarnings.push(msg); // #49: surface to JSON callers via RunResult.fidelityWarnings
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

function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}
function basenameish(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}
