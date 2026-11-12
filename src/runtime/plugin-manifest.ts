import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { warn } from "../io.js";
import { manifestlessPluginName, manifestNameAccepted, type Mount } from "../session.js";

/**
 * Write `.claude-plugin/plugin.json` (`{name}`) into the STAGED copy of a `remote_plugins` plugin whose source has
 * none, after the stager has copied it. Never touches the source, never overwrites a manifest, and never writes
 * through a staged `.claude-plugin` (or `plugin.json`) that is not a plain directory (or absent): staging keeps
 * symlinks as written, so either could point into the author's tree.
 *
 * Why: Claude Desktop does this for a plugin it syncs without a manifest (it writes `{name}` and never overwrites,
 * app.asar 4.23118.0, the remote plugin manager's install step), and it stages a server-synced plugin at
 * `.remote-plugins/<server id>`. Without it the agent would name the plugin after that id, while every harness reader
 * names it after the source (`manifestlessPluginName`), so `availableSkills[].whenToUse` was dropped and
 * `list_plugins` advertised an id the agent could not invoke.
 *
 * Not written:
 *  - a name the agent refuses in a manifest it loads by path (`manifestNameAccepted`): a WARN says so, and the plugin
 *    keeps its staged folder's name, which `manifestlessPluginName` then reports too;
 *  - a local-marketplace plugin: its staged folder is named after its marketplace entry, which the agent already
 *    loads it as, so a manifest would change no name, and Desktop writing one for a LOCAL marketplace plugin is not
 *    established;
 *  - a `local_plugins` mount: its staged folder is named after its source already, and a `plugins.from_host` mount
 *    (also `local-plugin`) is a hashed copy that must stay byte-identical.
 *
 * Edge cases left as they are, on purpose:
 *  - a manifest that exists but has no usable `name` is never replaced (Desktop never overwrites either), so the
 *    agent names that plugin after its staged folder while the readers fall back to the source folder's name;
 *  - the write happens after the copy, so the stage filter (a git tracked set) never sees the added file, and no
 *    staged-tree hash covers a `remote-plugin` mount (only `plugins.from_host` copies are re-hashed).
 *
 * Returns whether a manifest was written; the notice is printed only then, so a stager that re-copies onto an
 * existing staged tree each turn says it once.
 */
export function writeMissingPluginManifest(m: Mount, stagedDir: string): boolean {
  if (m.kind !== "remote-plugin") return false;
  const root = lstatSync(stagedDir, { throwIfNoEntry: false });
  if (!root?.isDirectory()) return false;
  const dir = join(stagedDir, ".claude-plugin");
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (dirStat !== undefined && !dirStat.isDirectory()) return false;
  const file = join(dir, "plugin.json");
  if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) return false;
  const folder = basename(m.hostPath);
  if (!manifestNameAccepted(folder)) {
    warn(
      `::warning:: [stage] the remote plugin at ${m.mountPath} has no .claude-plugin/plugin.json, and its folder name '${folder}' ` +
        `cannot be a plugin name (no whitespace, @, :, / or \\), so none is written: the agent loads it as '${manifestlessPluginName(m)}'. ` +
        `Add .claude-plugin/plugin.json with a plain name, or rename the folder\n`,
    );
    return false;
  }
  if (dirStat === undefined) mkdirSync(dir);
  writeFileSync(file, JSON.stringify({ name: folder }, null, 2) + "\n", { flag: "wx" });
  warn(
    `::notice:: [stage] the remote plugin at ${m.mountPath} has no .claude-plugin/plugin.json, ` +
      `so its staged copy gets one naming it '${folder}', as Claude Desktop writes for a plugin it syncs without one; the agent loads it as '${folder}'. ` +
      `Your folder is unchanged\n`,
  );
  return true;
}
