// `ref freeze` and `ref verify`: freeze a kept run's judged documents as a pairwise reference, and check a store.
//
// The composition itself (scenario → `semantic_pairwise` asserts → the run's judged document per compose key,
// compared with the live fingerprint) is injected as `FreezeDeps`, so this module holds only the freeze policy.

import { pathSafeId } from "../hillclimb/ids.js";
import { join } from "node:path";
import { FsRefusal, lexists } from "../hillclimb/fs.js";
import { REF_EXTS, addRefDoc, freezeRef, verifyStore, type RefSource } from "./store.js";

/** One kept run, composed for freezing. `live` compares the recomposed document with the fingerprint the live
 *  judge recorded: `match`, `differs`, or `unknown` (no fingerprint: a run recorded before the assert existed). */
export interface ComposedForFreeze {
  caseId: string;
  source: RefSource;
  harnessVersion: string;
  composerId: string;
  docs: Array<{ key: string; text: string; live: "match" | "differs" | "unknown" }>;
}

export interface FreezeDeps {
  compose(runDir: string, scenarioFile: string): ComposedForFreeze | { refused: string };
}

export interface FreezeOptions {
  runDir: string;
  scenarioFile: string;
  out: string;
  caseId?: string;
  allowUnchecked: boolean;
}

export interface FreezeOutcome {
  exitCode: 0 | 2;
  message: string;
  caseId?: string;
  frozen: string[];
  added: string[];
}

const refuse = (message: string, caseId?: string): FreezeOutcome => ({ exitCode: 2, message, caseId, frozen: [], added: [] });

export function freezeFromRun(opts: FreezeOptions, deps: FreezeDeps): FreezeOutcome {
  const c = deps.compose(opts.runDir, opts.scenarioFile);
  if ("refused" in c) return refuse(`ref freeze: ${c.refused}`);
  const caseId = opts.caseId ?? c.caseId;
  if (caseId === "" || pathSafeId(caseId) !== caseId)
    return refuse(`ref freeze: case id ${JSON.stringify(caseId)} is not path-safe (letters, digits, _ . - only)`);
  if (c.docs.length === 0) return refuse(`ref freeze: ${opts.scenarioFile} has no semantic_pairwise assert — nothing to freeze`, caseId);
  // A recomposed document that differs from what the live judge read is a different output than the run's: the
  // work dir or a connected folder changed after the run. Freezing it would make every later comparison against
  // bytes no judge ever saw for that run. No flag overrides this.
  const differs = c.docs.filter((d) => d.live === "differs").map((d) => d.key);
  if (differs.length)
    return refuse(
      `ref freeze: the recomposed judged document differs from the one the live judge read for compose key(s) ${differs.join(", ")} — ` +
        `a file in the kept run changed after the run; freeze from an untouched run`,
      caseId,
    );
  const unknown = c.docs.filter((d) => d.live === "unknown").map((d) => d.key);
  if (unknown.length && !opts.allowUnchecked)
    return refuse(
      `ref freeze: no live fingerprint to check compose key(s) ${unknown.join(", ")} against (the run predates the assert); ` +
        `pass --allow-unchecked to freeze it anyway, marked unchecked`,
      caseId,
    );
  const unchecked = new Set(unknown);
  try {
    if (!REF_EXTS.some((ext) => lexists(join(opts.out, caseId + ext)))) {
      // A fresh entry: everything checked goes in one atomic freeze; unchecked documents are added after, marked.
      const checked = c.docs.filter((d) => !unchecked.has(d.key));
      const first = checked.length ? checked : c.docs.slice(0, 1);
      const r = freezeRef(opts.out, caseId, c.source, Object.fromEntries(first.map((d) => [d.key, d.text])), {
        harnessVersion: c.harnessVersion,
        composerId: c.composerId,
        unchecked: checked.length === 0,
      });
      if (r.status === "exists")
        return refuse(`ref freeze: a reference for case ${caseId} appeared in ${opts.out} concurrently; nothing written`, caseId);
      const added: string[] = [];
      for (const d of c.docs.filter((d) => !first.includes(d)))
        if (
          addRefDoc(opts.out, caseId, d.key, d.text, {
            resultSha256: c.source.resultSha256,
            composerId: c.composerId,
            unchecked: unchecked.has(d.key),
          }).status === "added"
        )
          added.push(d.key);
      return { exitCode: 0, message: `ref freeze: froze case ${caseId} into ${opts.out}`, caseId, frozen: first.map((d) => d.key), added };
    }
    const added: string[] = [];
    for (const d of c.docs)
      if (
        addRefDoc(opts.out, caseId, d.key, d.text, {
          resultSha256: c.source.resultSha256,
          composerId: c.composerId,
          unchecked: unchecked.has(d.key),
        }).status === "added"
      )
        added.push(d.key);
    if (added.length === 0)
      return refuse(
        `ref freeze: case ${caseId} is already frozen in ${opts.out} with every compose key; a frozen reference is never rewritten`,
        caseId,
      );
    return {
      exitCode: 0,
      message: `ref freeze: added ${added.length} compose key(s) to case ${caseId} in ${opts.out}`,
      caseId,
      frozen: [],
      added,
    };
  } catch (e) {
    if (e instanceof FsRefusal) return refuse(`ref freeze: ${e.message}`, caseId);
    throw e;
  }
}

export function verifyStores(stores: readonly string[]): {
  exitCode: 0 | 1;
  stores: Array<{ store: string } & ReturnType<typeof verifyStore>>;
} {
  const out = stores.map((store) => ({ store, ...verifyStore(store) }));
  return { exitCode: out.some((s) => s.problems.length > 0) ? 1 : 0, stores: out };
}
