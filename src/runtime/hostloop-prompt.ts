import { dirname } from "node:path";

/**
 * Dynamic host-loop "## Shell access" prompt section for Desktop >= 1.14271.0.
 *
 * Binary-verified against app.asar (Desktop 1.14271.0, fingerprint bd96569a339874cb), function
 * `Lxr(...)`, block `x("host_loop_shell", …)`. That release refactored this section from static
 * prose into a TABLE built from live session mount state — one bullet per mounted folder plus
 * conditional outputs/skills/uploads lines and a "no folders connected" branch. A static file can
 * no longer be faithful, so we reproduce the generator and populate it from the run's REAL mounts.
 *
 * Re-verified against app.asar (Desktop 1.15962.0, fingerprint 0fe570e50d97404f), block
 * `host_loop_shell` at byte offset ~9,364,458: every UNCONDITIONAL fragment below is still
 * byte-for-byte identical. The only delta is one ADDITIVE conditional sentence — see
 * the `ie`/`QA` note near the end of generateHostLoopShellSection — which we still omit by design.
 *
 * Wording is reproduced verbatim (note `→` U+2192 and `—` U+2014). The output begins at
 * "## Shell access" (the asar's leading "\n\n" is supplied by the caller's join), mirroring how the
 * legacy static-file path is combined.
 */

interface HostLoopFolder {
  /** Real host path of the mounted folder/upload. */
  hostPath: string;
  /** Mount path RELATIVE to mntRoot (e.g. "project" for a work folder, "uploads/foo.txt"). */
  mountPath: string;
}

export interface HostLoopShellInputs {
  /** Session root, e.g. "/sessions/<id>". */
  sessionRoot: string;
  /** Mount root, e.g. "/sessions/<id>/mnt". */
  mntRoot: string;
  /** Mountable work folders — for Desktop >= 1.14271.0 these are the bare collision-resolved names
   *  (e.g. `project`); the bullet renders whatever `mountPath` the plan resolved. */
  folders: HostLoopFolder[];
  /** Attached-file uploads (the harness's `uploads/<base>` mounts), if any. */
  uploads: HostLoopFolder[];
  /**
   * Host path of the config dir whose `skills/` subdir is staged in-guest at `<mntRoot>/.claude/skills`.
   * Provide it ONLY when skills are actually staged; omit/undefined to suppress the skills bullet
   * (the asar's `Ae` line is conditional on a skills root — we don't fabricate one).
   */
  skillsConfigDir?: string;
  // Constants — defaulted to the binary-verified production names; overridable for tests.
  workspaceServer?: string;
  bashTool?: string;
  requestFolderTool?: string;
}

/**
 * Reproduce the 1.14271.0 host_loop_shell section. Pure — no fs/spawn — so it can be asserted
 * byte-for-byte against asar-verified fixtures.
 */
export function generateHostLoopShellSection(inp: HostLoopShellInputs): string {
  const ws = inp.workspaceServer ?? "workspace";
  const bash = inp.bashTool ?? "bash";
  const reqFolder = inp.requestFolderTool ?? "request_cowork_directory";
  const { sessionRoot, mntRoot, folders, uploads } = inp;

  // Outputs bullet (asar `CA`). The harness has no separate hostOutputsDir/hostCwd, so oe === cwd ===
  // sessionRoot → the " — cwd" suffix is always present. Outputs is NOT in plan.mounts; synthesize it.
  const outputsBullet = `- ${sessionRoot} → ${mntRoot}/outputs/  (your outputs directory — cwd)`;

  // Per-folder bullets (asar `te`): `- <hostPath> → <mntRoot>/<name>/`. We render the folder's REAL
  // resolved mount path. For Desktop >= 1.14271.0 that's the bare collision-resolved basename (matching
  // real Cowork, e.g. `mnt/project`); on legacy baselines it's `mnt/.projects/<name>`. Either way the
  // rendered path matches where files actually are, so the model's bash paths line up.
  const folderBullets = folders.map((f) => `- ${f.hostPath} → ${mntRoot}/${f.mountPath}/`);
  const te = folderBullets.length > 0 ? folderBullets.join("\n") + "\n" + outputsBullet : outputsBullet;

  // Skills bullet (asar `Ae`) — only when skills are staged. k = skillsConfigDir, so `<k>/skills` maps to
  // `<mntRoot>/.claude/skills/`, which is exactly where the staged config dir surfaces in-guest.
  const skillsPresent = !!inp.skillsConfigDir;
  const Ae = skillsPresent ? `\n- ${inp.skillsConfigDir}/skills → ${mntRoot}/.claude/skills/ (read-only)` : "";

  // Uploads bullet (asar `ne`) — single line per the asar shape. The harness mounts uploads per-file with
  // arbitrary parents; represent the host side with the first upload's parent dir (approximate but real).
  const ne = uploads.length > 0 ? `\n- ${dirname(uploads[0].hostPath)} → ${mntRoot}/uploads/ (read-only, attached files)` : "";

  // Example translate line (asar `zA`/`DA`): first folder if any, else the outputs dir.
  const first = folders[0];
  const zA = first ? first.hostPath : sessionRoot;
  const DA = first ? `${mntRoot}/${first.mountPath}` : `${mntRoot}/outputs`;

  // "No folders connected" branch (asar `PA`).
  const PA =
    folders.length > 0
      ? ""
      : `\n\nNo user folders are connected yet. To work with the user's files, request a folder with mcp__cowork__${reqFolder}.`;

  // asar `ie` branch (host-only/unmounted folders) is ALWAYS empty here: the harness runs a single
  // container where every mount is visible to both file tools and workspace-bash, so there is no
  // "file-tool-reachable but not bash-mounted" set. Omit the branch. In 1.15962.0 this branch is the
  // literal `QA.length>0` sentence ("Folders annotated 'bash ... cannot see this path' in the
  // workspace section above are not mounted here; use Read/Write/Edit/Grep/Glob for those.") — `QA` is
  // the set of non-empty folder copyHint annotations, which is empty in our single-container topology,
  // so the real generator would emit nothing here too. Still correct to omit.

  const skillSuffix = skillsPresent ? " Skill scripts can be run via bash using the VM path above." : "";

  return (
    `## Shell access\n\n` +
    `Shell commands use \`mcp__${ws}__${bash}\` and run in an isolated Linux environment. ` +
    `Each call is independent — no cwd or env carryover between calls. Use absolute paths.\n\n` +
    `Paths in bash differ from what file tools (Read/Write/Edit) see:\n${te}${Ae}${ne}\n\n` +
    `So a file you Read at ${zA}/foo.txt is reached in bash at ${DA}/foo.txt — use the mapping above to translate.` +
    skillSuffix +
    PA +
    `\n\nThe Linux environment boots in the background. If bash returns "Workspace still starting", wait a few seconds and retry.`
  );
}
