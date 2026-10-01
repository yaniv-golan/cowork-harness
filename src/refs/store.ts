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
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { FsRefusal, NoFollowRoot, lexists, lstatOrNull, normalizeRootArg } from "../hillclimb/fs.js";
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
  const root = NoFollowRoot.open(storeDir); // runs the preflight; every path below is built from root.root
  const store = root.root;
  const entryDir = join(store, caseId);
  const present = (): boolean => REF_EXTS.some((ext) => lexists(join(store, caseId + ext)));
  if (present()) return { status: "exists", entryDir };
  const tmp = join(store, `.tmp-${randomBytes(6).toString("hex")}`);
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
    // Re-probe every spelling right before the rename (the rename itself checks only `<case-id>`). What remains is the
    // directory-rename window renameNoFollow documents.
    if (present() || root.renameNoFollow(tmp, entryDir, { replace: false }) === "exists") {
      rmSync(tmp, { recursive: true, force: true });
      return { status: "exists", entryDir };
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

/** The store's absolute path (a user-typed relative path, `./` allowed, resolved once), or the refusal. */
function absStore(storeDir: string): { store: string } | { why: string } {
  try {
    return { store: resolve(normalizeRootArg(storeDir)) };
  } catch (e) {
    return { why: (e as Error).message };
  }
}

/** Structural check of one entry: the layout, the manifest, and doc/sidecar pairing. Does not hash documents. */
function inspectEntry(storeDir: string, caseId: string): { root?: NoFollowRoot; entryDir: string; result: Inspected } {
  const a = absStore(storeDir);
  if ("why" in a) return { entryDir: "", result: { status: "integrity", why: a.why } };
  const entryDir = join(a.store, caseId);
  if (lstatOrNull(a.store) === null) return { entryDir, result: { status: "missing", why: `reference store ${storeDir} does not exist` } };
  let root: NoFollowRoot;
  try {
    root = NoFollowRoot.existing(a.store);
  } catch (e) {
    return { entryDir, result: { status: "integrity", why: (e as Error).message } };
  }
  const fail = (why: string): { root: NoFollowRoot; entryDir: string; result: Inspected } => ({
    root,
    entryDir,
    result: { status: "integrity", why },
  });
  const st = lstatOrNull(entryDir);
  if (st === null) return { root, entryDir, result: { status: "missing", why: `no reference entry for case ${caseId} in ${storeDir}` } };
  if (st.isSymbolicLink() || !st.isDirectory()) return fail(`${entryDir} is not a plain directory`);
  const txt = new Set<string>();
  const side = new Set<string>();
  let hasManifest = false;
  for (const d of root.readdirNoFollow(entryDir)) {
    if (!d.isFile()) return fail(`${join(entryDir, d.name)} is not a regular file`);
    if (d.name === "ref.json") {
      hasManifest = true;
      continue;
    }
    const m = DOC_RE.exec(d.name);
    if (!m) return fail(`unexpected file ${join(entryDir, d.name)}`);
    (m[2] === "txt" ? txt : side).add(m[1]!);
  }
  if (!hasManifest) return fail(`${entryDir} has no ref.json`);
  for (const k of txt) if (!side.has(k)) return fail(`doc-${k}.txt has no sidecar (an interrupted add?)`);
  for (const k of side) if (!txt.has(k)) return fail(`doc-${k}.json has no document`);
  let manifest: EntryManifest;
  try {
    manifest = JSON.parse(root.readFile(join(entryDir, "ref.json"))) as EntryManifest;
  } catch (e) {
    return fail(`${join(entryDir, "ref.json")}: ${(e as Error).message}`);
  }
  if (manifest?.format !== 1 || manifest.caseId !== caseId || typeof manifest.source?.resultSha256 !== "string")
    return fail(`${join(entryDir, "ref.json")} does not describe case ${caseId}`);
  return { root, entryDir, result: { status: "ok", manifest, keys: txt } };
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
  const { root, entryDir, result } = inspectEntry(storeDir, caseId);
  if (result.status !== "ok") return result;
  if (!result.keys.has(key))
    return {
      status: "missing",
      why: `the reference for case ${caseId} has no document for compose key ${key} (a scope or composer change)`,
    };
  const d = readDoc(root!, entryDir, key);
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
  const { root, entryDir, result } = inspectEntry(storeDir, caseId);
  if (result.status !== "ok") throw new FsRefusal(`refusing to add to the reference for case ${caseId}: ${result.why}`);
  if (result.manifest.source.resultSha256 !== from.resultSha256)
    throw new FsRefusal(
      `refusing to add to the reference for case ${caseId}: it was frozen from a different source run (result.json sha256 ` +
        `${result.manifest.source.resultSha256.slice(0, 12)}…); every document in one entry must come from one run`,
    );
  if (result.keys.has(key)) return { status: "exists" };
  writeDoc(root!, entryDir, key, text, from.composerId, from.unchecked === true);
  return { status: "added" };
}

/** Check a whole store: every entry's layout, manifest and document hashes. Problems make the store unusable for
 *  the cases they name; notes (a leftover temp dir from an interrupted freeze) do not. */
export function verifyStore(storeDir: string): {
  entries: string[];
  problems: Array<{ caseId: string; why: string }>;
  notes: string[];
} {
  const a = absStore(storeDir);
  if ("why" in a) return { entries: [], problems: [{ caseId: "", why: a.why }], notes: [] };
  const st = lstatOrNull(a.store);
  if (st === null) return { entries: [], problems: [{ caseId: "", why: `reference store ${storeDir} does not exist` }], notes: [] };
  if (st.isSymbolicLink() || !st.isDirectory())
    return { entries: [], problems: [{ caseId: "", why: `reference store ${storeDir} is not a plain directory` }], notes: [] };
  const root = NoFollowRoot.existing(a.store);
  const entries: string[] = [];
  const problems: Array<{ caseId: string; why: string }> = [];
  const notes: string[] = [];
  for (const d of root.readdirNoFollow(a.store).sort((x, y) => x.name.localeCompare(y.name))) {
    const at = join(a.store, d.name);
    if (d.name.startsWith(".")) {
      notes.push(`${at}: left by an interrupted freeze; safe to delete`);
      continue;
    }
    if (!d.isDirectory() || pathSafeId(d.name) !== d.name) {
      problems.push({ caseId: d.name, why: `${at} is not a reference entry (a foreign file, link or name)` });
      continue;
    }
    entries.push(d.name);
    const { root: r, entryDir, result } = inspectEntry(a.store, d.name);
    if (result.status !== "ok") {
      problems.push({ caseId: d.name, why: result.why });
      continue;
    }
    for (const key of [...result.keys].sort()) {
      const doc = readDoc(r!, entryDir, key);
      if ("why" in doc) problems.push({ caseId: d.name, why: doc.why });
    }
  }
  return { entries, problems, notes };
}
