/**
 * The two parts of the Cowork sub-agent append that Desktop composes in CODE, outside the
 * server-overridable `## Cowork environment` section (Desktop >= 1.46388.3).
 *
 * Binary-verified against app.asar 1.46388.3, module `index.chunk-BInHX3er.js`, generator `zd(...)`:
 *
 *   return `\n\n${substitute(resolveSection(...))}${hostLoopMode ? Bd(vmCwd, hostCwd ?? vmCwd,
 *            hostOutputsDir, userSelectedFolders, hostOnlyFolders) : ""}${Rd}`
 *
 * Two facts follow from that shape and drive this module:
 *
 *  1. `Bd` (the folder manifest) and `Rd` (the trailing skills sentence) are appended AFTER
 *     `resolveSection`, so a server-delivered `spSectionPrompts` override replaces only the section —
 *     never these. They are not part of the overridable unit and do not belong in its asset.
 *  2. `Bd` is built from live session mount state, so no static file can be faithful to it. Same
 *     reasoning, and same treatment, as the main-loop "## Shell access" section in
 *     `src/runtime/hostloop-prompt.ts`, which stopped being a static asset for exactly this reason.
 *
 * Wording is PARAPHRASED, not verbatim: this is prompt text from a shipping product in a public repo,
 * and the sub-agent-append assets under `baselines/prompts/` are paraphrased for the same reason.
 * (Note the repo is not internally consistent here — `hostloop-prompt.ts` reproduces its section
 * verbatim. That predates this module; this file follows the assets it is composed with, not that
 * one.) Semantic drift in the real text is caught by
 * the `manifest` and `suffix` fingerprint axes in
 * `baselines/prompts/cowork-system-prompt-fingerprints.json` (sentinel: `checkSubagentPromptFacts`),
 * which hash production's own text — so a paraphrase that stops matching is a sync failure, not a
 * silent divergence.
 */

/** One folder as the manifest sees it. */
export interface SubagentManifestFolder {
  /** CANONICAL host path (realpath), matching production's `gg(folder)` — NOT the path as declared.
   *  Production renders `resolvedFolders[i].canonical`; rendering an uncanonicalized path would name a
   *  location production never names, in the sentence that tells the model where it may write. */
  hostPath: string;
  /** Mount directory name under `<vmCwd>/mnt/`, i.e. the plan's already-resolved collision-free name. */
  mountPath: string;
  /** False for a folder the shell cannot reach. Production derives this from `hostOnlyFolders` — a
   *  folder is reachable unless it is host-only, and a `cloud-sync` host-only folder is reachable again
   *  when `mountable` is true. The harness's analogue is a folder dropped from the mount set (the
   *  `mount-failed` kind); it has no cloud-sync or network-drive concept. */
  reachable: boolean;
}

export interface SubagentManifestInputs {
  /** The VM session root, `/sessions/<id>` — from `resolveMounts`, never a local literal. */
  vmCwd: string;
  /** Where relative paths in the file tools resolve: production's `hostCwd ?? vmCwd`. */
  hostCwd: string;
  /** This session's outputs folder on the host. Production passes it only in host-loop mode; when it
   *  is absent AND there are no folders, the manifest takes its no-list variant. */
  hostOutputsDir?: string;
  /** Attached folders, in the order production would list them. */
  folders: readonly SubagentManifestFolder[];
}

/** The path-gated builtin file tools the manifest names, verified by content through the export table
 *  of `index.chunk-Dnn1K3tQ.js` (`exports."kw" -> jNt = ["Read","Write","Edit","Glob","Grep"]`). The
 *  sentinel asserts this exact list in the asar, so a tool joining or leaving it fails the sync rather
 *  than silently changing what a sub-agent is told its file tools are. */
export const SUBAGENT_MANIFEST_FILE_TOOLS: readonly string[] = ["Read", "Write", "Edit", "Glob", "Grep"];

/** Appended UNCONDITIONALLY to both the host-loop and VM branches (`Rd`). Paraphrased. */
export const SUBAGENT_SKILL_SENTENCE =
  "\n\nTo use a skill — including one that comes from a plugin — call the `Skill` tool with the skill's name. " +
  "A plugin skill's name has the form `plugin-name:skill-name`.";

/**
 * Render the host-loop folder manifest. Mirrors `Bd`, including its two prose variants: the list
 * variant when there is anything to list, and the no-list variant when there is not.
 *
 * The empty case is reachable, not hypothetical: it is what a host-loop session with no outputs dir
 * and no attached folders produces.
 */
export function generateSubagentFolderManifest(inp: SubagentManifestInputs): string {
  const tools = SUBAGENT_MANIFEST_FILE_TOOLS.join(", ");
  const relative = `Relative paths in these tools start at \`${inp.hostCwd}\`.`;
  const lines: string[] = [];
  if (inp.hostOutputsDir) {
    lines.push(`- \`${inp.hostOutputsDir}\` (this session's outputs folder; shell: \`${inp.vmCwd}/mnt/outputs/\`)`);
  }
  for (const f of inp.folders) {
    lines.push(
      f.reachable
        ? `- \`${f.hostPath}\` (shell: \`${inp.vmCwd}/mnt/${f.mountPath}/\`)`
        : `- \`${f.hostPath}\` (the shell cannot reach this folder)`,
    );
  }
  if (lines.length === 0) {
    return `\n\n${tools} act on the user's computer, and reject \`/sessions/\` paths. ${relative}`;
  }
  return (
    `\n\n${tools} take the first path on each line below, and reject \`/sessions/\` paths. ${relative} ` +
    `The shell takes the shell path.\n\n` +
    `Folders on the user's computer (only read or write inside these; the user can attach more folders, ` +
    `so the list can be incomplete):\n` +
    lines.join("\n")
  );
}

/** Stable identity of the prompt text THIS module generates, for cassette staleness. The generator's
 *  output varies with live mounts, so the hashable thing is its constant templates: the two variants'
 *  prose, the three line shapes and the trailing sentence, with every interpolation blanked. Mixed
 *  into `hashBaselinePromptAssets` so that editing prompt text here stales recorded cassettes exactly
 *  as editing a `baselines/prompts/` asset does — text that reaches the model but is hashed by nothing
 *  is the fail-open this release found in the sentinel, and it must not be reintroduced one layer down. */
export function subagentGeneratedPromptText(): string {
  const P = "\u0000"; // one constant placeholder for every interpolated value
  const listVariant = generateSubagentFolderManifest({
    vmCwd: P,
    hostCwd: P,
    hostOutputsDir: P,
    folders: [
      { hostPath: P, mountPath: P, reachable: true },
      { hostPath: P, mountPath: P, reachable: false },
    ],
  });
  const emptyVariant = generateSubagentFolderManifest({ vmCwd: P, hostCwd: P, folders: [] });
  // Between them these two cover every constant this module can emit: both prose variants and all
  // three line shapes (outputs, reachable, unreachable), plus the trailing sentence.
  return [listVariant, emptyVariant, SUBAGENT_SKILL_SENTENCE].join("\u0001");
}
