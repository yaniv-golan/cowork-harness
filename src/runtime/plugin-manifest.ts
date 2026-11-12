import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { warn } from "../io.js";
import { manifestlessPluginName, type Mount } from "../session.js";

/**
 * Write `.claude-plugin/plugin.json` (`{name}`) into the STAGED copy of a remote or local-marketplace plugin whose
 * source has none, after the stager has copied it. Never touches the source, never overwrites a manifest, and never
 * writes through a staged `.claude-plugin` (or `plugin.json`) that is not a plain directory (or absent): staging keeps
 * symlinks as written, so either could point into the author's tree.
 *
 * Why: Claude Desktop does this for a plugin it syncs without a manifest (it writes `{name}` and never overwrites,
 * app.asar 4.23118.0, the remote plugin manager's install step), and it stages a server-synced plugin at
 * `.remote-plugins/<server id>`. Without it the agent would name the plugin after that id, while every harness reader
 * names it after the source (`manifestlessPluginName`), so `availableSkills[].whenToUse` was dropped and
 * `list_plugins` advertised an id the agent could not invoke. A `local_plugins` mount is left alone: its staged folder
 * is named after its source already, and a `plugins.from_host` mount (also `local-plugin`) is a hashed copy that must
 * stay byte-identical.
 *
 * Returns whether a manifest was written; the notice is printed only then, so a stager that re-copies onto an
 * existing staged tree each turn says it once.
 */
export function writeMissingPluginManifest(m: Mount, stagedDir: string): boolean {
  if (m.kind !== "remote-plugin" && m.kind !== "marketplace-plugin") return false;
  const root = lstatSync(stagedDir, { throwIfNoEntry: false });
  if (!root?.isDirectory()) return false;
  const dir = join(stagedDir, ".claude-plugin");
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (dirStat !== undefined && !dirStat.isDirectory()) return false;
  const file = join(dir, "plugin.json");
  if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) return false;
  const name = manifestlessPluginName(m);
  if (dirStat === undefined) mkdirSync(dir);
  writeFileSync(file, JSON.stringify({ name }, null, 2) + "\n", { flag: "wx" });
  warn(
    `::notice:: [stage] the ${m.kind === "remote-plugin" ? "remote" : "marketplace"} plugin at ${m.mountPath} has no .claude-plugin/plugin.json, ` +
      `so its staged copy gets one naming it '${name}', as Claude Desktop writes for a plugin it syncs without one; the agent loads it as '${name}'. ` +
      `Your folder is unchanged\n`,
  );
  return true;
}
