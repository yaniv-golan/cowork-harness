// `ref freeze` and `ref verify`: freeze a kept run's judged documents as a pairwise reference, and check a store.
//
// The composition itself (scenario → `semantic_pairwise` asserts → the run's judged document per compose key,
// compared with the live fingerprint) is injected as `FreezeDeps`, so this module holds only the freeze policy.

import { parseArgs } from "../cli-args.js";
import { pathSafeId } from "../hillclimb/ids.js";
import { writeAllSync } from "../io.js";
import { applyParsedCommandGlobals, withCommandGlobals } from "../run/command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "../run/envelope.js";
import { collectSecrets, scrub } from "../secrets.js";
import { composeFromRunDir } from "./compose.js";
import { REF_FREEZE_BOOLEAN_FLAGS, REF_FREEZE_VALUE_FLAGS, REF_USAGE } from "./cli-usage.js";
import { join } from "node:path";
import { FsRefusal, lexists } from "../hillclimb/fs.js";
import { REF_EXTS, addRefDocs, freezeRef, verifyStore, type RefSource } from "./store.js";

/** One kept run, composed for freezing. `live` compares the recomposed document with the fingerprint the live
 *  judge recorded: `match`, `differs`, or `unknown` (no fingerprint: a run recorded before the assert existed). */
export interface ComposedForFreeze {
  caseId: string;
  source: RefSource;
  harnessVersion: string;
  composerId: string;
  /** The scenario the run answered, and sha256 of its prompt: recorded in the entry so a later run of a different task
   *  is refused instead of compared with an answer to another question. */
  scenario: string;
  taskSha256: string;
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
      // A fresh entry: every document — checked and unchecked — in ONE atomic freeze, so a refusal never follows a write.
      const r = freezeRef(
        opts.out,
        caseId,
        c.source,
        Object.fromEntries(c.docs.map((d) => [d.key, { text: d.text, unchecked: unchecked.has(d.key) }])),
        { harnessVersion: c.harnessVersion, composerId: c.composerId, scenario: c.scenario, taskSha256: c.taskSha256 },
      );
      if (r.status === "exists")
        return refuse(`ref freeze: a reference for case ${caseId} appeared in ${opts.out} concurrently; nothing written`, caseId);
      return {
        exitCode: 0,
        message: `ref freeze: froze case ${caseId} into ${opts.out}`,
        caseId,
        frozen: c.docs.map((d) => d.key),
        added: [],
      };
    }
    // An existing entry gains only compose keys it lacks, and only for the same run and task it was frozen for. Every
    // key is checked before any is written, so a refusal leaves the entry as it was.
    const { added } = addRefDocs(
      opts.out,
      caseId,
      c.docs.map((d) => ({ key: d.key, text: d.text, unchecked: unchecked.has(d.key) })),
      { resultSha256: c.source.resultSha256, composerId: c.composerId, taskSha256: c.taskSha256 },
    );
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

function freezeDeps(secrets: string[]): FreezeDeps {
  return { compose: (runDir, scenarioFile) => composeFromRunDir(runDir, scenarioFile, secrets) };
}

/** `ref freeze` / `ref verify`. */
export async function cmdRef(args: string[]): Promise<never> {
  const CMD = "ref";
  const json = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({
        booleans: [...REF_FREEZE_BOOLEAN_FLAGS],
        values: [...REF_FREEZE_VALUE_FLAGS],
        enums: { "--output-format": ["text", "json"] },
        noDashValue: ["--scenario", "--out", "--case-id"],
      }),
    );
  } catch (e) {
    return fail(CMD, "usage", scrub((e as Error).message, collectSecrets()), undefined, json);
  }
  applyParsedCommandGlobals(CMD, p, json);
  const secrets = collectSecrets();
  const [sub, ...rest] = p.positionals;
  if (sub === "verify") {
    if (!rest.length || p.options["--scenario"] || p.options["--out"] || p.options["--case-id"] || p.flags["--allow-unchecked"])
      return fail(CMD, "usage", REF_USAGE, undefined, json);
    const v = verifyStores(rest);
    if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(CMD, v.exitCode === 0, { stores: v.stores }), secrets) + "\n");
    else
      for (const s of v.stores) {
        writeAllSync(
          2,
          scrub(`${s.store}: ${s.entries.length} entr${s.entries.length === 1 ? "y" : "ies"}, ${s.problems.length} problem(s)`, secrets) +
            "\n",
        );
        for (const pr of s.problems) writeAllSync(2, scrub(`  ✗ ${pr.caseId || "(store)"}: ${pr.why}`, secrets) + "\n");
        for (const n of s.notes) writeAllSync(2, scrub(`  note: ${n}`, secrets) + "\n");
      }
    return process.exit(v.exitCode);
  }
  const scenarioFile = p.options["--scenario"];
  const out = p.options["--out"];
  if (sub !== "freeze" || rest.length !== 1 || !scenarioFile || !out) return fail(CMD, "usage", REF_USAGE, undefined, json);
  const o = freezeFromRun(
    { runDir: rest[0]!, scenarioFile, out, caseId: p.options["--case-id"], allowUnchecked: p.flags["--allow-unchecked"] === true },
    freezeDeps(secrets),
  );
  if (o.exitCode !== 0) return fail(CMD, "runtime", scrub(o.message, secrets), undefined, json, 2);
  if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(CMD, true, { ...o }), secrets) + "\n");
  else writeAllSync(2, scrub(o.message, secrets) + "\n");
  return process.exit(0);
}
