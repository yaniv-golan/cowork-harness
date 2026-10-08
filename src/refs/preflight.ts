// Checks that run before any spend for a scenario carrying `semantic_pairwise`. Pure over the filesystem:
// nothing here creates, writes or calls a model.

// The answer-key check (a reference store a mount exposes) is the shared `pathsInsideMounts`
// (src/hillclimb/answer-key.ts); callers pass every store a run will read.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathsInsideMounts } from "../hillclimb/answer-key.js";
import { pathSafeId, unusableCaseIds } from "../hillclimb/ids.js";
import { pairwiseComposeKey, type PairwiseRef } from "../run/pairwise-prepass.js";
import type { Assertion, Scenario } from "../types.js";
import { readRefDoc } from "./store.js";

export interface RefRequirement {
  caseId: string;
  assertIndex: number;
  refName: string;
  store: string;
  composeKey: string;
  /** sha256 of the task (the RAW scenario prompt) the run will answer; a reference frozen for another task is refused.
   *  Required on both sides: an entry with no task identity reads as damaged (integrity), never as "any task". */
  taskSha256: string;
}

/** Every (case, assert, reference) a run will judge against must already resolve, with integrity, to a document
 *  for its compose key. Returns the misses — empty means the run may spend. Never reads a document's text out. */
export function checkRefsBeforeSpend(
  reqs: readonly RefRequirement[],
): Array<RefRequirement & { status: "missing" | "integrity"; message: string }> {
  const out: Array<RefRequirement & { status: "missing" | "integrity"; message: string }> = [];
  for (const r of reqs) {
    const got = readRefDoc(r.store, r.caseId, r.composeKey);
    if (got.status === "ok") {
      if (got.taskSha256 === r.taskSha256) continue;
      out.push({
        ...r,
        status: "missing",
        message:
          `case ${r.caseId}, assert ${r.assertIndex}, reference "${r.refName}": it was frozen for a different task (the scenario's prompt changed) — ` +
          `freeze a new reference from a run of this prompt with \`ref freeze\``,
      });
      continue;
    }
    const remedy =
      got.status === "missing"
        ? "freeze one from a kept run with `ref freeze` (or, in a hillclimb flow, `hillclimb freeze-ref`)"
        : "a frozen reference is never repaired in place: freeze into a new store with `ref freeze` (or `hillclimb freeze-ref`)";
    out.push({
      ...r,
      status: got.status,
      message: `case ${r.caseId}, assert ${r.assertIndex}, reference "${r.refName}": ${got.why} — ${remedy}`,
    });
  }
  return out;
}

/** What a run judges against: the case's entry name, the references for each pairwise assert, and the ones frozen
 *  from this very variant (neutral — exempt from the existence check, a hillclimb baseline freezes them itself). */
export interface PairwiseSetup {
  caseId: string;
  refsFor: (a: Assertion) => PairwiseRef[];
  neutralRefs: ReadonlySet<string>;
  /** The references that decide the verdict; unset = every one. Only these must resolve before spend: a metric-only
   *  reference that cannot be read degrades its own comparison at run time instead. */
  gateRefs?: ReadonlySet<string>;
}

/** The default setup for a scenario run outside a hillclimb flow: the case id is the scenario's name (its file stem
 *  unless `name:` overrides it), made path-safe; each assert's references are its `refs:` stores (already resolved
 *  against the scenario file by the loader), named by their directory. */
export function scenarioPairwiseSetup(scenario: Scenario): PairwiseSetup {
  return {
    caseId: pathSafeId(scenario.name ?? ""),
    refsFor: (a) => (a.semantic_pairwise?.refs ?? []).map((store) => ({ name: basename(store.replace(/\/+$/, "")), store })),
    neutralRefs: new Set(),
  };
}

/** The pre-spend refusal for a scenario with `semantic_pairwise`, or undefined. ONE function, called by
 *  `executeScenario` before the run dir exists and by `record --dry-run`'s preview: every reference must resolve
 *  with integrity to a document for its assert's compose key, and no reference store may sit inside (or contain)
 *  a mounted source the agent can read — a frozen reference is the baseline's answer. */
export function pairwiseRefsRefusal(scenario: Scenario, setup: PairwiseSetup, mountRoots: readonly string[]): string | undefined {
  const pairwise = scenario.assert.map((a, i) => ({ a, i })).filter(({ a }) => a.semantic_pairwise !== undefined);
  if (!pairwise.length) return undefined;
  const problems: string[] = [];
  const unusable = unusableCaseIds([setup.caseId]);
  if (unusable.length) return `semantic_pairwise: case id ${JSON.stringify(setup.caseId)} is empty or all dots — set a scenario \`name:\``;
  const stores = new Set<string>();
  const reqs: RefRequirement[] = [];
  const taskSha256 = createHash("sha256")
    .update(scenario.prompt ?? "", "utf8")
    .digest("hex");
  for (const { a, i } of pairwise) {
    const refs = setup.refsFor(a);
    if (!refs.length) problems.push(`assert ${i}: semantic_pairwise has no reference — add \`refs:\` (a store written by \`ref freeze\`)`);
    for (const r of refs) {
      stores.add(r.store);
      if (!setup.neutralRefs.has(r.name) && (setup.gateRefs === undefined || setup.gateRefs.has(r.name)))
        reqs.push({
          caseId: setup.caseId,
          assertIndex: i,
          refName: r.name,
          store: r.store,
          composeKey: pairwiseComposeKey(a, scenario.lane),
          taskSha256,
        });
    }
  }
  problems.push(...checkRefsBeforeSpend(reqs).map((p) => p.message));
  for (const hit of pathsInsideMounts([...stores], mountRoots))
    problems.push(
      `reference store ${hit.path} overlaps the mounted source ${hit.mount} — the agent under test could read the reference it is judged against; move the store outside every mounted path`,
    );
  return problems.length ? `semantic_pairwise: refusing before the run spends anything —\n  ${problems.join("\n  ")}` : undefined;
}
