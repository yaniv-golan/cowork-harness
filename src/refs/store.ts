// A frozen pairwise-reference store: what `semantic_pairwise` judges a run against.
//
// The guide's rule (build-eval.md l.83): freeze the baseline's outputs once and judge every later variant
// against those — never regenerate, or "win rate" silently changes meaning between rounds. So the store is
// APPEND-ONLY. An entry is created once, atomically; a later compose key for the same case is added beside the
// existing documents and never replaces one.
//
// Layout of one entry, `<store>/<case-id>/`:
//   ref.json              immutable: which run the entry was frozen from, and by what
//   doc-<key>.txt         one frozen judged document per compose key
//   doc-<key>.json        its sidecar: sha256, length, composer, `unchecked`
// The store is model-influenced (it sits in a flow dir the agent under test can reach in principle), so every
// read and write goes through the no-follow layer, and every read re-verifies the document's sha256 against its
// sidecar. Integrity covers accidental and partial edits; a CONSISTENT rewrite of a doc and its sidecar is caught
// one level up, by checking each row's recorded reference sha across variants.
//
// The store holds text it is given. Composing, scrubbing and host-path redaction happen in the caller.

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FsRefusal, NoFollowRoot, lexists, lstatOrNull, preflightRoot } from "../hillclimb/fs.js";
import { pathSafeId } from "../hillclimb/ids.js";

/** The spellings the scaffold probes for a frozen ref (runner-scaffold.mjs l.132-134). Any of them already
 *  present for a case blocks a freeze, so a hand-placed `<id>.html` is never shadowed. */
export const REF_EXTS = ["", ".html", ".txt", ".json"] as const;

export interface RefSource {
  /** What froze it: `hillclimb run`, `hillclimb freeze-ref`, `ref freeze`. */
  command: string;
  variant?: string;
  rep?: number;
  /** `~`-relative path of the kept run dir the documents were composed from. */
  runDir: string;
  /** sha256 of that run's `result.json`: the identity every later added document must share. */
  resultSha256: string;
  sessionId?: string;
}

interface EntryManifest {
  format: 1;
  caseId: string;
  source: RefSource;
  harnessVersion: string;
  composerId: string;
  frozenAt: string;
}

interface DocSidecar {
  format: 1;
  composeKey: string;
  composerId: string;
  sha256: string;
  chars: number;
  /** Frozen without a live fingerprint to check the recomposed document against. */
  unchecked?: true;
  addedAt: string;
}

export type ReadRefResult =
  | { status: "ok"; text: string; sha256: string; composerId: string; source: RefSource; unchecked?: true }
  | { status: "missing"; why: string }
  | { status: "integrity"; why: string };

const DOC_RE = /^doc-([0-9a-f]{16})\.(txt|json)$/;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Which compose options produced a document: composer identity, `include_subagent_text`, and the
 *  `evidence_files` scope (order-insensitive; absent ≠ any list). 16 hex. A composer change therefore surfaces
 *  as a missing document for the new key, never as a silent comparison across composers. */
export function composeKey(composerId: string, includeSubagentText: boolean, evidenceFiles: readonly string[] | undefined): string {
  const scope = evidenceFiles === undefined ? null : [...evidenceFiles].sort();
  return sha256(JSON.stringify([composerId, includeSubagentText, scope])).slice(0, 16);
}

function assertCaseId(caseId: string): void {
  if (caseId === "" || pathSafeId(caseId) !== caseId || /^\.+$/.test(caseId))
    throw new FsRefusal(`refusing: case id ${JSON.stringify(caseId)} is not a path-safe id`);
}

const now = (): string => new Date().toISOString();
const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

function writeDoc(root: NoFollowRoot, dir: string, key: string, text: string, composerId: string, unchecked: boolean): void {
  const sidecar: DocSidecar = {
    format: 1,
    composeKey: key,
    composerId,
    sha256: sha256(text),
    chars: text.length,
    ...(unchecked ? { unchecked: true as const } : {}),
    addedAt: now(),
  };
  // Document first, sidecar second: a crash between them leaves a document with no sidecar, which every
  // reader reports as an integrity problem rather than serving.
  root.createFile(join(dir, `doc-${key}.txt`), text);
  root.createFile(join(dir, `doc-${key}.json`), json(sidecar));
}

/** Freeze an entry for `caseId` once. `exists` — and nothing written — when any `REF_EXTS` spelling for the case
 *  is already present, a planted symlink included, or when a concurrent freeze of the same case won the rename. */
export function freezeRef(
  storeDir: string,
  caseId: string,
  source: RefSource,
  docs: Record<string, string>,
  meta: { harnessVersion: string; composerId: string; unchecked?: boolean },
): { status: "frozen" | "exists"; entryDir: string } {
  assertCaseId(caseId);
  if (Object.keys(docs).length === 0) throw new Error("freezeRef: no documents to freeze");
  preflightRoot(storeDir, []);
  const root = NoFollowRoot.open(storeDir);
  const entryDir = join(storeDir, caseId);
  if (REF_EXTS.some((ext) => lexists(join(storeDir, caseId + ext)))) return { status: "exists", entryDir };
  const tmp = join(storeDir, `.tmp-${randomBytes(6).toString("hex")}`);
  root.mkdir(tmp);
  try {
    const manifest: EntryManifest = {
      format: 1,
      caseId,
      source,
      harnessVersion: meta.harnessVersion,
      composerId: meta.composerId,
      frozenAt: now(),
    };
    root.createFile(join(tmp, "ref.json"), json(manifest));
    for (const [key, text] of Object.entries(docs)) writeDoc(root, tmp, key, text, meta.composerId, meta.unchecked === true);
    // Re-probe right before the rename: an EMPTY directory planted at the name would otherwise be replaced.
    if (REF_EXTS.some((ext) => lexists(join(storeDir, caseId + ext)))) {
      rmSync(tmp, { recursive: true, force: true });
      return { status: "exists", entryDir };
    }
    try {
      renameSync(tmp, entryDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        rmSync(tmp, { recursive: true, force: true });
        return { status: "exists", entryDir };
      }
      throw e;
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  root.assertIn(entryDir, "freeze a reference");
  return { status: "frozen", entryDir };
}

type Inspected =
  { status: "ok"; manifest: EntryManifest; keys: Set<string> } | { status: "missing"; why: string } | { status: "integrity"; why: string };

/** Structural check of one entry: the layout, the manifest, and doc/sidecar pairing. Does not hash documents. */
function inspectEntry(storeDir: string, caseId: string): { root?: NoFollowRoot; result: Inspected } {
  const storeSt = lstatOrNull(storeDir);
  if (storeSt === null) return { result: { status: "missing", why: `reference store ${storeDir} does not exist` } };
  let root: NoFollowRoot;
  try {
    root = NoFollowRoot.existing(storeDir);
  } catch (e) {
    return { result: { status: "integrity", why: (e as Error).message } };
  }
  const entryDir = join(storeDir, caseId);
  const st = lstatOrNull(entryDir);
  if (st === null) return { root, result: { status: "missing", why: `no reference entry for case ${caseId} in ${storeDir}` } };
  if (st.isSymbolicLink() || !st.isDirectory())
    return { root, result: { status: "integrity", why: `${entryDir} is not a plain directory` } };
  const txt = new Set<string>();
  const side = new Set<string>();
  let hasManifest = false;
  for (const d of readdirSync(entryDir, { withFileTypes: true })) {
    if (!d.isFile()) return { root, result: { status: "integrity", why: `${join(entryDir, d.name)} is not a regular file` } };
    if (d.name === "ref.json") {
      hasManifest = true;
      continue;
    }
    const m = DOC_RE.exec(d.name);
    if (!m) return { root, result: { status: "integrity", why: `unexpected file ${join(entryDir, d.name)}` } };
    (m[2] === "txt" ? txt : side).add(m[1]!);
  }
  if (!hasManifest) return { root, result: { status: "integrity", why: `${entryDir} has no ref.json` } };
  for (const k of txt)
    if (!side.has(k)) return { root, result: { status: "integrity", why: `doc-${k}.txt has no sidecar (an interrupted add?)` } };
  for (const k of side) if (!txt.has(k)) return { root, result: { status: "integrity", why: `doc-${k}.json has no document` } };
  let manifest: EntryManifest;
  try {
    manifest = JSON.parse(root.readFile(join(entryDir, "ref.json"))) as EntryManifest;
  } catch (e) {
    return { root, result: { status: "integrity", why: `${join(entryDir, "ref.json")}: ${(e as Error).message}` } };
  }
  if (manifest?.format !== 1 || manifest.caseId !== caseId || typeof manifest.source?.resultSha256 !== "string")
    return { root, result: { status: "integrity", why: `${join(entryDir, "ref.json")} does not describe case ${caseId}` } };
  return { root, result: { status: "ok", manifest, keys: txt } };
}

function readDoc(root: NoFollowRoot, entryDir: string, key: string): { text: string; sidecar: DocSidecar } | { why: string } {
  let sidecar: DocSidecar;
  let text: string;
  try {
    sidecar = JSON.parse(root.readFile(join(entryDir, `doc-${key}.json`))) as DocSidecar;
    text = root.readFile(join(entryDir, `doc-${key}.txt`));
  } catch (e) {
    return { why: `doc-${key}: ${(e as Error).message}` };
  }
  if (sidecar?.format !== 1 || sidecar.composeKey !== key) return { why: `doc-${key}.json does not describe compose key ${key}` };
  if (sha256(text) !== sidecar.sha256 || text.length !== sidecar.chars)
    return { why: `doc-${key}.txt does not match its recorded sha256 — the frozen reference was edited` };
  return { text, sidecar };
}

/** Read one frozen document, verified. Never returns text on any failure. */
export function readRefDoc(storeDir: string, caseId: string, key: string): ReadRefResult {
  assertCaseId(caseId);
  const { root, result } = inspectEntry(storeDir, caseId);
  if (result.status !== "ok") return result;
  if (!result.keys.has(key))
    return {
      status: "missing",
      why: `the reference for case ${caseId} has no document for compose key ${key} (a scope or composer change)`,
    };
  const d = readDoc(root!, join(storeDir, caseId), key);
  if ("why" in d) return { status: "integrity", why: d.why };
  return {
    status: "ok",
    text: d.text,
    sha256: d.sidecar.sha256,
    composerId: d.sidecar.composerId,
    source: result.manifest.source,
    ...(d.sidecar.unchecked ? { unchecked: true as const } : {}),
  };
}

/** Add a document for a NEW compose key to an existing entry, composed from the SAME source run. Never rewrites:
 *  an existing key reports `exists`. A different source run, a missing entry, or a damaged entry throws. */
export function addRefDoc(
  storeDir: string,
  caseId: string,
  key: string,
  text: string,
  from: { resultSha256: string; composerId: string; unchecked?: boolean },
): { status: "added" | "exists" } {
  assertCaseId(caseId);
  const { root, result } = inspectEntry(storeDir, caseId);
  if (result.status !== "ok") throw new FsRefusal(`refusing to add to the reference for case ${caseId}: ${result.why}`);
  if (result.manifest.source.resultSha256 !== from.resultSha256)
    throw new FsRefusal(
      `refusing to add to the reference for case ${caseId}: it was frozen from a different source run (result.json sha256 ` +
        `${result.manifest.source.resultSha256.slice(0, 12)}…); every document in one entry must come from one run`,
    );
  if (result.keys.has(key)) return { status: "exists" };
  writeDoc(root!, join(storeDir, caseId), key, text, from.composerId, from.unchecked === true);
  return { status: "added" };
}

/** Check a whole store: every entry's layout, manifest and document hashes. Problems make the store unusable for
 *  the cases they name; notes (a leftover temp dir from an interrupted freeze) do not. */
export function verifyStore(storeDir: string): {
  entries: string[];
  problems: Array<{ caseId: string; why: string }>;
  notes: string[];
} {
  const st = lstatOrNull(storeDir);
  if (st === null) return { entries: [], problems: [{ caseId: "", why: `reference store ${storeDir} does not exist` }], notes: [] };
  if (st.isSymbolicLink() || !st.isDirectory())
    return { entries: [], problems: [{ caseId: "", why: `reference store ${storeDir} is not a plain directory` }], notes: [] };
  const entries: string[] = [];
  const problems: Array<{ caseId: string; why: string }> = [];
  const notes: string[] = [];
  for (const d of readdirSync(storeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.name.startsWith(".")) {
      notes.push(`${join(storeDir, d.name)}: left by an interrupted freeze; safe to delete`);
      continue;
    }
    if (!d.isDirectory() || pathSafeId(d.name) !== d.name) {
      problems.push({ caseId: d.name, why: `${join(storeDir, d.name)} is not a reference entry (a foreign file, link or name)` });
      continue;
    }
    entries.push(d.name);
    const { root, result } = inspectEntry(storeDir, d.name);
    if (result.status !== "ok") {
      problems.push({ caseId: d.name, why: result.why });
      continue;
    }
    for (const key of [...result.keys].sort()) {
      const doc = readDoc(root!, join(storeDir, d.name), key);
      if ("why" in doc) problems.push({ caseId: d.name, why: doc.why });
    }
  }
  return { entries, problems, notes };
}
