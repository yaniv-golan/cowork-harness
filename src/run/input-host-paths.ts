import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { LaunchPlan, Mount } from "../session.js";
import { warn } from "../io.js";
import { hostPathTokens } from "./host-path-tokens.js";

/**
 * Input provenance for the `host_path_leak` signal.
 *
 * At container/microvm fidelity a host-root path in model-visible text fails the run, because the sandbox
 * shows the agent only `/sessions/…` paths — a host path there is how a harness leak looks. But a file the
 * USER uploads or connects can carry host paths of its own (a kept run dir's result.json, a log, a config),
 * and the agent reading or quoting it is not a leak: real Cowork would show the same bytes. So before the
 * agent runs, the staged input files are tokenized and the tokens kept as a private sidecar in the run dir;
 * the post-run scan exempts a token found there verbatim.
 *
 * The plugins the scenario declares (local, remote and marketplace plugin mounts), and the `skills.local` skills
 * it stages into the managed config dir (`mnt/.claude/skills/<name>` — only those, never the rest of that dir),
 * are input in the same sense:
 * the plugin under test reaches the agent through its staged copy, and a reference file in it may list
 * host-shaped literals of its own (a catalog of the very roots this signal looks for). Their STAGED copy is
 * walked — exactly the bytes the agent can read, never the source tree — under the same rules as the inputs.
 * A plugin's or skill's host SOURCE location is recorded too and is never exempt (see `neverExemptRoots` in the sidecar):
 * at container/microvm the agent sees them only under `/sessions/…`, so a source path in model-visible text
 * is what a leak of one looks like, whatever its files say.
 *
 * Captured on a FRESH stage only, never on a resumed turn: a connected folder is writable, so an agent could
 * write a host path into it in one turn and read it back in the next. Every bound (file size, binary files,
 * file and byte totals) only SHRINKS the corpus — fewer exemptions, so the signal fails closed. The bounds are
 * one budget, spent on the user's inputs first and the plugins and skills last, so their files can never
 * crowd out an input's exemptions.
 *
 * The sidecar lists private host paths: it lives beside `pre-run-manifest.json`, above the staged tree, and
 * nothing copies it into result.json or a cassette.
 */
export const INPUT_HOST_PATHS_FILE = "input-host-paths.json";

const INPUT_KINDS: ReadonlySet<Mount["kind"]> = new Set(["upload", "folder", "project"]);
const PLUGIN_KINDS: ReadonlySet<Mount["kind"]> = new Set(["local-plugin", "remote-plugin", "marketplace-plugin"]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

/** The exemption corpus the post-run scan consults, and the roots it must never exempt under. */
export interface InputHostPathCorpus {
  tokens: ReadonlySet<string>;
  /** Locations the harness created for THIS run (the run dir, the VM session dir, the staged agent dir).
   *  A token at or under one is exactly what a sandbox leak looks like; an input file naming it can only
   *  be a coincidence, so it is never exempt. */
  neverExemptRoots: readonly string[];
  /** Roots refused only as themselves (not what is under them): the vm-work root and the runs dir hold
   *  OTHER sessions, which an input may legitimately name. */
  neverExemptExact?: readonly string[];
}

/** Is `token` a string prefix of `root` that does not end at a path boundary — a spelling of the root cut
 *  short at a space, `,` or `;` (`/Users/a/Library/Application` for `…/Application Support/…`)? */
function truncates(token: string, root: string): boolean {
  return root.length > token.length && root.startsWith(token) && root[token.length] !== "/";
}

/** Is this host-path token one the user supplied — and not at or under a root the harness created, nor a
 *  truncated spelling of one? */
export function isInputBorneHostPath(token: string, corpus: InputHostPathCorpus | undefined): boolean {
  if (!corpus || !corpus.tokens.has(token)) return false;
  // The own-root checks compare LOCATIONS, so the token is canonicalized first (membership above stays
  // exact): invisible format characters (Unicode `Cf`: zero-width chars, soft hyphen, BOM) dropped, `.`/`..` segments resolved, trailing sentence punctuation
  // and slashes removed (`<run dir>.` names the run dir), and case folded — macOS's default filesystem is
  // case-insensitive, so `/USERS/…` reaches the same place.
  const canon = (p: string): string => {
    const visible = p.replace(/\p{Cf}/gu, "");
    const normalized = posix.normalize(visible).replace(/[.:,;?!/]+$/, "") || visible;
    return normalized.toLowerCase();
  };
  const bare = canon(token);
  const roots = corpus.neverExemptRoots.filter((r) => r !== "").map(canon);
  const exact = (corpus.neverExemptExact ?? []).filter((r) => r !== "").map(canon);
  const underOrTruncates = roots.some((r) => bare === r || bare.startsWith(`${r}/`) || truncates(bare, r));
  const exactOrTruncates = exact.some((r) => bare === r || truncates(bare, r));
  return !underOrTruncates && !exactOrTruncates;
}

function isBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const n = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Tokenize the staged input mounts (uploads, connected folders, projects), the staged `workspace_fixture`
 * files and the staged plugin mounts under `mntHost` and write the corpus to `<outDir>/input-host-paths.json`,
 * with the plugins' host source locations as roots never to exempt. A no-op on a resumed turn, whose corpus is the one the first
 * turn captured. Deterministic: entries are walked in sorted order and tokens are stored sorted.
 */
export function captureInputHostPathCorpus(
  plan: Pick<LaunchPlan, "mounts" | "resume" | "workspaceFixture" | "stagedSkills">,
  mntHost: string,
  outDir: string,
): void {
  if (plan.resume) return;
  const tokens = new Set<string>();
  let files = 0;
  let bytes = 0;
  let capped = false;

  const visit = (path: string): void => {
    if (capped) return;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return; // unreadable: contributes nothing (fewer exemptions)
    }
    if (st.isSymbolicLink()) return; // never follow a link out of the staged tree
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(path).sort();
      } catch {
        return;
      }
      for (const n of names) if (!SKIP_DIRS.has(n)) visit(join(path, n));
      return;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
    if (files >= MAX_FILES || bytes + st.size > MAX_TOTAL_BYTES) {
      capped = true;
      return;
    }
    files++;
    bytes += st.size;
    try {
      if (isBinary(path)) return;
      for (const t of hostPathTokens(readFileSync(path, "utf8"))) tokens.add(t);
    } catch {
      /* unreadable: contributes nothing */
    }
  };

  for (const m of plan.mounts) if (INPUT_KINDS.has(m.kind)) visit(join(mntHost, m.mountPath));
  // workspace_fixture files are user-supplied input too: staged into outputs/ just before this runs, so the
  // files there now are exactly the fixture's (visited by name — never the whole outputs dir).
  for (const f of plan.workspaceFixture?.files ?? []) visit(join(mntHost, "outputs", ...f.path.split("/")));
  // The declared plugins and local skills LAST, so they spend only what the inputs left of the shared budget.
  const pluginSources = new Set<string>();
  const neverExemptSource = (src: string): void => {
    if (!src) return;
    pluginSources.add(src);
    try {
      pluginSources.add(realpathSync(src));
    } catch {
      /* source gone after staging: the raw spelling is enough */
    }
  };
  for (const m of plan.mounts) {
    if (!PLUGIN_KINDS.has(m.kind)) continue;
    visit(join(mntHost, m.mountPath));
    neverExemptSource(m.hostPath);
  }
  // A local skill's staged copy: the managed config dir lands at mnt/.claude (stageWorkspace), each skill at
  // skills/<dest> — visited by name, never the whole config dir (settings files the harness writes are not input).
  for (const sk of plan.stagedSkills ?? []) {
    visit(join(mntHost, ".claude", "skills", sk.dest));
    neverExemptSource(sk.src);
  }
  if (capped)
    warn(
      `::notice:: [scan] input, plugin and skill files exceed ${MAX_FILES} files / ${MAX_TOTAL_BYTES / 1024 / 1024} MiB — host paths in the rest ` +
        `are not recognised as user-supplied, so quoting them counts as a host_path_leak\n`,
    );
  writeFileSync(
    join(outDir, INPUT_HOST_PATHS_FILE),
    JSON.stringify({ version: 1, capped, tokens: [...tokens].sort(), neverExemptRoots: [...pluginSources].sort() }, null, 2),
  );
}

/** The roots a fresh stage recorded as never exempt (the declared plugins' and local skills' host source locations). Missing or
 *  unreadable ⇒ none — the corpus reader below then yields no tokens either, so nothing is exempted. */
export function readInputHostPathNeverExemptRoots(outDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, INPUT_HOST_PATHS_FILE), "utf8")) as { neverExemptRoots?: unknown };
    return Array.isArray(parsed.neverExemptRoots)
      ? parsed.neverExemptRoots.filter((t): t is string => typeof t === "string" && t !== "")
      : [];
  } catch {
    return [];
  }
}

/** The corpus a fresh stage persisted. Missing or unreadable ⇒ empty (no exemptions — fails closed). */
export function readInputHostPathCorpus(outDir: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(outDir, INPUT_HOST_PATHS_FILE), "utf8")) as { tokens?: unknown };
    return Array.isArray(parsed.tokens) ? new Set(parsed.tokens.filter((t): t is string => typeof t === "string")) : new Set();
  } catch {
    return new Set();
  }
}
