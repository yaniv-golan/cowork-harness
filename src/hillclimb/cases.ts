// The cases of a hillclimb flow: one per scenario file, keyed by pathSafeId(<file stem>) — the name the user
// typed and the one trace filenames carry (addendum Q1). The scenario's own `name:` rides along for --case
// and for meta. Everything here runs before any spend: a bad id space would silently overwrite traces or
// shrink the scored denominator (S l.411-438).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../errors.js";
import { resolveInputs } from "../run/inputs.js";
import { parseScenarioFile } from "../run/execute.js";
import type { Scenario } from "../types.js";
import { scenarioRows } from "../eval/classify.js";
import { findDuplicateCaseIds, pathSafeId, unusableCaseIds } from "./ids.js";

export interface HillclimbCase {
  /** pathSafeId(stem): the row's prompt_id and the trace file's id. */
  id: string;
  stem: string;
  /** The stem, when pathSafeId changed it (S's meta.original_id). */
  originalId?: string;
  name: string;
  file: string;
  scenario: Scenario;
}

const stemOf = (file: string): string => basename(file).replace(/\.ya?ml$/i, "");

/** Load every scenario under `target` (a file, or a directory's .yaml/.yml files, sorted). In a directory a
 *  YAML document with no `prompt:` is not a scenario (eval's rule) and is reported in `skipped`; a single
 *  named file is always loaded so a wrong file fails loud. Throws UsageError on an empty set, a duplicate
 *  id (case-insensitive: macOS/Windows fold case) or an id the report cannot use. */
export function loadCases(target: string): { cases: HillclimbCase[]; skipped: string[] } {
  const inputs = resolveInputs(target, [".yaml", ".yml"]);
  if ("error" in inputs) throw new UsageError(`hillclimb: ${inputs.error}`);
  const skipped: string[] = [];
  const files = inputs.isDir
    ? inputs.files.filter((f) => {
        let doc: unknown;
        try {
          doc = parseYaml(readFileSync(f, "utf8"));
        } catch {
          return true; // unparseable: the scenario loader reports it
        }
        const isScenario = typeof doc === "object" && doc !== null && !Array.isArray(doc) && "prompt" in doc;
        if (!isScenario) skipped.push(basename(f));
        return isScenario;
      })
    : inputs.files;
  if (files.length === 0) throw new UsageError(`hillclimb: no scenario files under ${target}`);
  const cases = files.map((file): HillclimbCase => {
    const stem = stemOf(file);
    const id = pathSafeId(stem);
    // The lite report refuses an all-dot id (L l.342) and an empty one names no file — the shared rule.
    if (unusableCaseIds([stem]).length)
      throw new UsageError(`hillclimb: ${basename(file)}: "${stem}" is not a usable case id (rename the file)`);
    const scenario = parseScenarioFile(file);
    // The row keys are built from the scenario; a scenario they cannot be built from (two claims that
    // normalize alike) would fail every attempt AFTER its spend — refuse it now, as eval does.
    try {
      scenarioRows(stem, scenario.assert);
    } catch (e) {
      throw new UsageError(`hillclimb: ${basename(file)}: ${(e as Error).message}`);
    }
    return { id, stem, ...(id !== stem ? { originalId: stem } : {}), name: scenario.name, file, scenario };
  });
  const dups = findDuplicateCaseIds(cases.map((c) => c.stem));
  if (dups.length)
    throw new UsageError(
      `hillclimb: duplicate case id after sanitization: ${dups.map((d) => `'${d.id}' collides with '${d.collidesWith}'`).join("; ")} — rename one file`,
    );
  return { cases, skipped };
}

/** Apply `--case` selectors. Each selector matches a case's file stem, its id, or its scenario name; a
 *  selector that matches nothing, or matches two different cases, is refused with the full id list. */
export function selectCases(cases: readonly HillclimbCase[], selectors: readonly string[]): HillclimbCase[] {
  if (selectors.length === 0) return [...cases];
  const listing = cases.map((c) => `${c.id} (${c.name})`).join(", ");
  const chosen = new Set<HillclimbCase>();
  for (const sel of selectors) {
    const hits = cases.filter((c) => c.stem === sel || c.id === sel || c.name === sel);
    if (hits.length === 0) throw new UsageError(`--case: no case matches "${sel}". Cases: ${listing}`);
    if (hits.length > 1)
      throw new UsageError(
        `--case "${sel}" is ambiguous: it matches ${hits.map((c) => `${c.id} (${c.name})`).join(" and ")} — use the file stem`,
      );
    chosen.add(hits[0]);
  }
  return cases.filter((c) => chosen.has(c));
}

/** Validate `_state.json`'s split ids against every loaded case (not just the --case selection, as S
 *  validates against loadCases()). Returns notes for well-formed ids that match no case; throws UsageError
 *  for an id that can never match a row (not path-safe) or a split that is not a list. */
export function splitIdNotes(state: Record<string, unknown>, caseIds: readonly string[]): string[] {
  const known = new Set(caseIds);
  const notes: string[] = [];
  for (const k of ["train_ids", "val_ids", "test_ids"]) {
    const v = state[k];
    if (v == null) continue;
    if (!Array.isArray(v)) throw new UsageError(`_state.json ${k} must be a list of ids`);
    for (const sid of v) {
      const s = String(sid); // the report joins with String() on both sides — numeric ids are fine
      if (known.has(s)) continue;
      if (s !== pathSafeId(s))
        throw new UsageError(
          `_state.json split id '${s}' is not a path-safe id - record split ids exactly as they appear in results.jsonl's prompt_id`,
        );
      notes.push(`note: split id '${s}' matches no loaded case (expected for a trimmed subset run)`);
    }
  }
  return notes;
}
