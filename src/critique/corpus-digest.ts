// Content hashes over what a critique graded, so a consumer can tell whether a skill changed between two
// critiques without diffing files. Three hashes, three questions:
//
//   corpusHash          the STATIC evaluator corpus — SKILL.md, the skill's references/, the resolved agents and
//                       the plugin-root references those files LINK to. The same in `--corpus-only` and a graded
//                       run unless a file changed. A FLOOR for "did the skill change": scripts/ is not in it.
//   packagedCorpusHash  what the packager put in the evaluator's corpus (before the overall package cap, which only
//                       trims run sections in practice): the static corpus PLUS the plugin-root
//                       files the graded agent merely READ, and how much of each file the ceiling kept. Moves when
//                       the agent's reading varies, so it is evidence of what was graded, not a "changed" key.
//   skillTreeHash       every file staging DELIVERED for the skill (its whole folder, scripts/ included) plus the
//                       resolved agents and linked root references — the honest "anything changed" key.
//
// Every entry is keyed by its path relative to the MOUNT, never by a display key: the display key embeds the
// plugin's directory name, which differs between two clones of the same commit. Each file is hashed from the
// same bytes the packager decoded, so the hash and the graded text cannot come from two reads.
import { createHash } from "node:crypto";

/** Bump when what an entry hashes, or which entries count, changes — `critique --compare` refuses a mix. */
export const CORPUS_HASH_SCHEME = 1;

export type CorpusOrigin = "skill_md" | "reference" | "agent" | "root_ref_linked" | "root_ref_read";

/** How the delivered set was decided. `git-tracked`: a target inside a git work tree, whose tracked files staging
 *  delivers, hashed from their WORKING-TREE bytes (a local edit to a tracked file changes the hash).
 *  `worktree-all`: no work tree, or git mode off — staging copies every file. `git-commit`: a `git:<ref>:<path>`
 *  target, whose snapshot holds exactly the commit's files. */
export type HashBasis = "git-tracked" | "worktree-all" | "git-commit";

export interface CorpusManifestEntry {
  origin: CorpusOrigin;
  /** Mount-relative, forward-slash path. */
  key: string;
  /** `unreadable`: the file is in the delivered set but could not be read; `missing`: a resolved agent whose file
   *  does not exist. Both still count, so a file turning unreadable or disappearing changes the hash. */
  status: "ok" | "unreadable" | "missing";
  sha256?: string;
  bytes?: number;
  /** Set only when the ceiling cut this file: the bytes the evaluator was shown (0 = omitted). */
  keptBytes?: number;
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Code-point order, never `localeCompare`: the hash must not depend on the machine's collation.
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Row = { [k: string]: string | number | undefined };
function digest(rows: Row[]): string {
  // Each row is built with a fixed key order and only string/number values, so JSON.stringify is canonical.
  return `sha256:${sha256Hex(JSON.stringify(rows))}`;
}

const sortRows = <T extends { origin?: string; key: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => byCodePoint(a.origin ?? "", b.origin ?? "") || byCodePoint(a.key, b.key));

/** The static corpus: every origin except `root_ref_read`, by content. Cuts do not count — they depend on what
 *  else the run added. */
export function corpusHashOf(manifest: CorpusManifestEntry[]): string {
  return digest(
    sortRows(manifest.filter((e) => e.origin !== "root_ref_read")).map((e) =>
      e.status === "ok" ? { origin: e.origin, key: e.key, sha256: e.sha256! } : { origin: e.origin, key: e.key, status: e.status },
    ),
  );
}

/** What the evaluator was handed: every origin, by content, plus how much of each file it kept. */
export function packagedCorpusHashOf(manifest: CorpusManifestEntry[]): string {
  return digest(
    sortRows(manifest).map((e) => {
      if (e.status !== "ok") return { origin: e.origin, key: e.key, status: e.status };
      return e.keptBytes !== undefined
        ? { origin: e.origin, key: e.key, sha256: e.sha256!, keptBytes: e.keptBytes }
        : { origin: e.origin, key: e.key, sha256: e.sha256! };
    }),
  );
}

/** Every delivered file of the skill, plus the static corpus files outside the skill folder (agents, linked root
 *  references). `files` are the skill folder's delivered files, already mount-relative. */
export function skillTreeHashOf(
  files: Array<{ key: string; sha256?: string; status: CorpusManifestEntry["status"] }>,
  manifest: CorpusManifestEntry[],
): string {
  const outside = manifest.filter((e) => e.origin === "agent" || e.origin === "root_ref_linked");
  const rows = new Map<string, { key: string; sha256?: string; status: CorpusManifestEntry["status"] }>();
  for (const f of [...files, ...outside]) rows.set(f.key, { key: f.key, sha256: f.sha256, status: f.status });
  return digest(
    [...rows.values()]
      .sort((a, b) => byCodePoint(a.key, b.key))
      .map((r) => (r.status === "ok" ? { key: r.key, sha256: r.sha256! } : { key: r.key, status: r.status })),
  );
}

export interface CorpusDigest {
  corpusHashScheme: number;
  hashBasis: HashBasis;
  corpusHash: string;
  packagedCorpusHash: string;
  skillTreeHash: string;
  corpusManifest: CorpusManifestEntry[];
  /** Files under the skill folder that staging does NOT deliver (untracked or ignored, in git mode), skill-relative,
   *  capped at the first 50 names. They are neither mounted nor hashed. Empty outside git mode. */
  skillTreeUntracked: string[];
  /** How many such files there are in total. */
  skillTreeUntrackedCount: number;
  /** The skill folder's delivered files and their hashes — internal: compared between the two packagings to name
   *  the files behind `corpusDrift`; not emitted. */
  skillTreeFiles: Array<{ key: string; sha256?: string; status: "ok" | "unreadable" }>;
}
