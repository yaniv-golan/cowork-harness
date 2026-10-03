// The grade keys of a hillclimb row, and the metrics a flow declares. ONE producer:
// the row writer emits a case's keys in `caseKeyDecls` order, and `state-template` declares `flowMetricDecls`.
//
// A flow's cases usually have different assertion lists, so a per-index key means different things on
// different rows. Declared are therefore only keys that mean the same on every row:
//   pass              the run verdict, 0|1 — first, so it is the report's headline (build-report-lite.mjs l.304; eval-hillclimb.md l.148).
//                     OMITTED when the verdict failed only because semantic grading was refused
//   pass_present      0 exactly then; 1 otherwise
//   claims_present    1 when at least one semantic_matches claim was graded on this row
//   <metric>_present  1 when the scenario-declared float <metric> was measured (the float is OMITTED
//                     when unavailable, never 0); a case that does not declare <metric> carries 0
//   claims            the pooled share of graded semantic_matches claims that passed (refused asserts
//                     excluded); judge kind, scale 1
//   <metric>          a scenario-declared float — the UNION over the flow's cases
// With semantic_pairwise in the flow (any case), every row also carries — the union rule, so a case without one
// carries the companions as 0:
//   win_present       1 when every pairwise assert of the case was compared with the baseline reference
//   win_<vN>_present  the same against a later variant's reference (a metric only, never the verdict)
//   win               the mean pairwise value vs the baseline (1 win, 0.5 tie or both_bad, 0 loss); judge kind
//   win_<vN>          the same vs <vN>'s reference
//   both_bad          1 when the judge found both outputs bad on any pairwise assert; its companion is win_present
// The per-index keys stay on every row as drill-down data, and are declared only when every case has the
// identical assertion list:
//   a<i>_present      1 when semantic assertion i was graded (its evidence was not refused)
//   a<i>              0|1 for a non-semantic assertion i
//   a<i>_c<j>         0|1 for claim j of semantic assertion i
//   a<i>_win(_<vN>)   the pairwise value of assertion i, with its a<i>_win(_<vN>)_present
// Every `_present` companion precedes the graded keys, so none can become the headline by accident.

import { createHash } from "node:crypto";
import type { Assertion, ScenarioMetric } from "../types.js";
import { UsageError } from "../errors.js";
import { scenarioRows } from "../eval/classify.js";
import { firstAssertionKey } from "../run/repeat.js";

/** A scenario-declared numeric metric (the scenario's `metrics:` entry, whole). */
export type MetricDecl = ScenarioMetric;

export interface GradeKeyDecl {
  id: string;
  kind: "binary" | "float" | "judge";
  /** <= 14 characters (the full viewer's legend width, SCHEMA.md l.73-75). */
  label: string;
  better?: "higher" | "lower";
  scale?: number;
  /** A float's floor, when the scenario declares one: `check` reads it as the good end of a lower-is-better metric. */
  min?: number;
}

const LABEL_MAX = 14;
const label = (s: string): string => (s.length <= LABEL_MAX ? s : s.slice(0, LABEL_MAX));

const PASS: GradeKeyDecl = { id: "pass", kind: "binary", label: "Pass" };
const PASS_PRESENT: GradeKeyDecl = { id: "pass_present", kind: "binary", label: "pass measured" };
const CLAIMS_PRESENT: GradeKeyDecl = { id: "claims_present", kind: "binary", label: "claims graded" };
const CLAIMS: GradeKeyDecl = { id: "claims", kind: "judge", label: "Claims passed", scale: 1, better: "higher" };
// Lower is better: a variant that raises both-bad is a regression, not a gain (a binary defaults to "higher").
const BOTH_BAD: GradeKeyDecl = { id: "both_bad", kind: "binary", label: "Both bad", better: "lower" };
const winId = (ref?: string) => (ref === undefined ? "win" : `win_${ref}`);
const winDecl = (ref?: string): GradeKeyDecl => ({
  id: winId(ref),
  kind: "judge",
  label: label(ref === undefined ? "Win vs base" : `Win vs ${ref}`),
  scale: 1,
  better: "higher",
});
const winPresentDecl = (ref?: string): GradeKeyDecl => ({
  id: `${winId(ref)}_present`,
  kind: "binary",
  label: label(ref === undefined ? "win measured" : `win ${ref} meas`),
});

/** A flow's `semantic_pairwise` columns: present when any of its cases has the key. `metricRefs` are the later
 *  variants' references (`v3`, …) — each a `win_<vN>` column. */
export interface PairwiseDecls {
  metricRefs: readonly string[];
}

/** The pairwise keys of a case, split as `perIndex` splits: companions first, graded after. `flow` adds the
 *  flow-wide columns; `perAssert` the per-index drill-down of THIS assertion list. */
function pairwiseKeys(
  assertions: readonly Assertion[],
  pw: PairwiseDecls,
  perAssert: boolean,
): { companions: GradeKeyDecl[]; graded: GradeKeyDecl[]; perIndexCompanions: GradeKeyDecl[]; perIndexGraded: GradeKeyDecl[] } {
  const refs = [undefined, ...pw.metricRefs];
  const idx = perAssert ? assertions.map((a, i) => (a.semantic_pairwise !== undefined ? i : -1)).filter((i) => i >= 0) : [];
  return {
    companions: refs.map(winPresentDecl),
    graded: [...refs.map(winDecl), BOTH_BAD],
    perIndexCompanions: idx.flatMap((i) =>
      refs.map((r) => ({ id: `a${i}_${winId(r)}_present`, kind: "binary" as const, label: label(`a${i} ${winId(r)} meas`) })),
    ),
    perIndexGraded: idx.flatMap((i) =>
      refs.map((r) => ({
        id: `a${i}_${winId(r)}`,
        kind: "judge" as const,
        label: label(`a${i} ${winId(r)}`),
        scale: 1,
        better: "higher" as const,
      })),
    ),
  };
}

/** Ids a scenario metric may not take — defined once, beside the scenario schema that refuses them. */
export { reservedMetricId } from "../types.js";

const hasSemantic = (assertions: readonly Assertion[]) => assertions.some((a) => a.semantic_matches !== undefined);

/** A whole-assertion row the pairwise judge can refuse: a semantic_pairwise assert with no other key (a multi-key
 *  one keeps one pass for all its keys — classify.ts repRowValues). */
export const refusableAssertion = (a: Assertion): boolean => a.semantic_pairwise !== undefined && Object.keys(a).length === 1;

function perIndex(assertions: readonly Assertion[]): { companions: GradeKeyDecl[]; graded: GradeKeyDecl[] } {
  const companions: GradeKeyDecl[] = [];
  const graded: GradeKeyDecl[] = [];
  for (const r of scenarioRows("", assertions)) {
    const i = r.assertionIndex;
    if (r.kind === "semantic_rollup") companions.push({ id: `a${i}_present`, kind: "binary", label: label(`a${i} graded`) });
    else if (r.kind === "assertion") {
      // A single-key semantic_pairwise assert can be refused (its reference or evidence unavailable): not
      // measured, so it carries a companion like a semantic_matches roll-up.
      if (refusableAssertion(assertions[i])) companions.push({ id: `a${i}_present`, kind: "binary", label: label(`a${i} graded`) });
      graded.push({ id: `a${i}`, kind: "binary", label: label(`a${i} ${firstAssertionKey(assertions[i])}`) });
    } else graded.push({ id: `a${i}_c${r.claimIndex}`, kind: "binary", label: label(`a${i} claim ${r.claimIndex}`) });
  }
  return { companions, graded };
}

const floatDecl = (m: MetricDecl): GradeKeyDecl => ({
  id: m.id,
  kind: "float",
  label: label(m.id),
  better: m.better,
  ...(m.scale !== undefined ? { scale: m.scale } : {}),
  ...(m.min !== undefined ? { min: m.min } : {}),
});
/** `<id>` cut to fit before `suffix` in LABEL_MAX, a separator left dangling by the cut dropped. */
const fit = (id: string, suffix: string): string => id.slice(0, LABEL_MAX - suffix.length).replace(/[_.\-\s]+$/, "") + suffix;
/** A metric's `_present` companion: `<id> measured` when it fits, else the id cut short before ` meas` (the pairwise
 *  companions' abbreviation). Cutting the whole label instead would leave a bare `amount_total m`. */
const presentLabels = new WeakMap<GradeKeyDecl, string>();
const presentDecl = (id: string): GradeKeyDecl => {
  const full = `${id} measured`;
  const d: GradeKeyDecl = { id: `${id}_present`, kind: "binary", label: full.length <= LABEL_MAX ? full : fit(id, " meas") };
  presentLabels.set(d, id);
  return d;
};

/** Labels made unique across one declaration list, each still <= LABEL_MAX: a label already taken is cut short and
 *  given a `~<n>` suffix. A graded key keeps its plain label before a `_present` companion does, so the number a
 *  reader climbs on reads as its id. Order is unchanged. */
function uniqueLabels(decls: GradeKeyDecl[]): GradeKeyDecl[] {
  const taken = new Set<string>();
  const out = new Map<GradeKeyDecl, string>();
  const claim = (d: GradeKeyDecl) => {
    let l = d.label;
    // A metric's `_present` label is told apart in its id part, so it keeps its ` meas` suffix.
    const base = presentLabels.get(d);
    for (let n = 2; taken.has(l); n++)
      l = base !== undefined ? fit(base, `~${n} meas`) : d.label.slice(0, LABEL_MAX - `~${n}`.length) + `~${n}`;
    taken.add(l);
    out.set(d, l);
  };
  for (const d of decls) if (!d.id.endsWith("_present")) claim(d);
  for (const d of decls) if (d.id.endsWith("_present")) claim(d);
  return decls.map((d) => (out.get(d) === d.label ? d : { ...d, label: out.get(d)! }));
}

/** Every key one case's scored rows carry, in row order. `metrics` is the FLOW's union, so a case that does
 *  not declare a metric still carries its `_present` (as 0). `claims_present` is on every row. */
export function caseKeyDecls(
  assertions: readonly Assertion[],
  metrics: readonly MetricDecl[] = [],
  pairwise?: PairwiseDecls,
): GradeKeyDecl[] {
  const idx = perIndex(assertions);
  const pw = pairwise ? pairwiseKeys(assertions, pairwise, true) : undefined;
  return [
    PASS,
    PASS_PRESENT,
    CLAIMS_PRESENT,
    ...(pw?.companions ?? []),
    ...metrics.map((m) => presentDecl(m.id)),
    ...idx.companions,
    ...(pw?.perIndexCompanions ?? []),
    CLAIMS,
    ...(pw?.graded ?? []),
    ...idx.graded,
    ...(pw?.perIndexGraded ?? []),
    ...metrics.map(floatDecl),
  ];
}

/** The metrics a flow declares, given each case's assertion list and its scenario-declared metrics. Throws
 *  UsageError when two cases declare one metric id differently. */
export function flowMetricDecls(
  cases: ReadonlyArray<{ name?: string; assertions: readonly Assertion[]; metrics?: readonly MetricDecl[] }>,
  pairwise: PairwiseDecls = { metricRefs: [] },
): GradeKeyDecl[] {
  const union = metricUnion(cases);
  const anySemantic = cases.some((c) => hasSemantic(c.assertions));
  const first = cases[0]?.assertions ?? [];
  const identical = cases.every((c) => JSON.stringify(c.assertions) === JSON.stringify(first));
  const idx = identical ? perIndex(first) : { companions: [], graded: [] };
  const pw = flowHasPairwise(cases) ? pairwiseKeys(first, pairwise, identical) : undefined;
  return uniqueLabels([
    PASS,
    PASS_PRESENT,
    ...(anySemantic ? [CLAIMS_PRESENT] : []),
    ...(pw?.companions ?? []),
    ...union.map((m) => presentDecl(m.id)),
    ...idx.companions,
    ...(pw?.perIndexCompanions ?? []),
    ...(anySemantic ? [CLAIMS] : []),
    ...(pw?.graded ?? []),
    ...idx.graded,
    ...(pw?.perIndexGraded ?? []),
    ...union.map(floatDecl),
  ]);
}

/** Whether any case of the flow has a `semantic_pairwise` assert (every row then carries the win columns). */
export const flowHasPairwise = (cases: ReadonlyArray<{ assertions: readonly Assertion[] }>): boolean =>
  cases.some((c) => c.assertions.some((a) => a.semantic_pairwise !== undefined));

/** The canonical declaration tuple: every field that changes what a metric's column means. The id is folded to
 *  lower case (ids compare case-insensitively), an absent `min` is its schema default 0 (writing `min: 0` changes
 *  nothing), and any other absent field is always `null`, so key order and an explicit `undefined` never change it. */
const declTuple = (m: MetricDecl): string =>
  JSON.stringify([m.id.toLowerCase(), m.artifact, m.path, m.better, m.scale ?? null, m.unbounded ?? null, m.min ?? 0]);

/** A metric declaration's signature, stamped on every scored row (`meta.metric_sigs`): the first 16 hex chars of
 *  the sha256 of its canonical tuple. A later pass compares it, so a column cannot change meaning mid-flow. */
export const metricSig = (m: MetricDecl): string => createHash("sha256").update(declTuple(m)).digest("hex").slice(0, 16);

/** A JSON value with every object's keys sorted, so key order never changes it; `undefined` members are dropped, as
 *  `JSON.stringify` drops them. Two assertions are the same assertion when their canonical JSON is equal. */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return JSON.stringify(sort(v)) ?? "null";
}

/** An assertion as hillclimb identifies it: `semantic_pairwise.refs` left out. `parseScenarioFile` rewrites refs to
 *  host-absolute paths, and hillclimb ignores them (a flow's references are its own), so a checkout's location must
 *  not change an assertion's identity. Any other assert is returned as it is, so its canonical JSON is unchanged. */
function withoutRefs(a: unknown): unknown {
  const sp = (a as { semantic_pairwise?: unknown } | null)?.semantic_pairwise;
  if (sp === null || typeof sp !== "object" || !("refs" in sp)) return a;
  const { refs: _refs, ...rest } = sp as Record<string, unknown>;
  void _refs;
  return { ...(a as object), semantic_pairwise: rest };
}

/** Two assertions are the same assertion when their identities are equal: the canonical JSON (key order never
 *  changes it) of the assertion as written, `semantic_pairwise.refs` left out. Every judge input an assert carries —
 *  its rubric, claims, judge model, evidence scope (`include_subagent_text`, `evidence_files`, `include_fork_results`)
 *  and so its pairwise compose key — is part of it. */
export const assertIdentity = (a: unknown): string => canonicalJson(withoutRefs(a));

/** The identity of each assertion of one list, with what it reads from its SIBLINGS folded in. `no_delete_in_mounts`
 *  grades against the mounts `allow_delete_in` waives across the whole list (`evaluate`), so adding or removing a
 *  sibling waiver changes what it grades: its identity carries the list's waived mounts (sorted, deduped). Every other
 *  assertion reads only its own object, so its identity is `assertIdentity`'s; so is this one's when nothing is waived. */
export function assertIdentities(list: readonly unknown[]): string[] {
  const waived = [
    ...new Set(
      list.flatMap((a) => {
        const w = (a as { allow_delete_in?: unknown } | null)?.allow_delete_in;
        return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : [];
      }),
    ),
  ].sort();
  return list.map((a) =>
    waived.length && (a as { no_delete_in_mounts?: unknown } | null)?.no_delete_in_mounts !== undefined
      ? canonicalJson({ assertion: withoutRefs(a), waivedBySiblings: { allow_delete_in: waived } })
      : assertIdentity(a),
  );
}

/** The assertion set a row was graded under, stamped on every scored row (`meta.assert_sig`): the first 16 hex chars
 *  of the sha256 of the canonical `{assert, expect_denied}` — key order never changes it, and neither does where the
 *  checkout lives (`semantic_pairwise.refs` is left out, as in `assertIdentity`). Rows of one case carrying two sigs
 *  were graded by two graders; `hillclimb regrade` brings them current. */
export const assertSig = (s: { assert: readonly unknown[]; expect_denied?: readonly string[] }): string =>
  createHash("sha256")
    .update(canonicalJson({ assert: s.assert.map(withoutRefs), expect_denied: s.expect_denied ?? [] }))
    .digest("hex")
    .slice(0, 16);

/** The union of the cases' scenario-declared metrics, in first-seen order. A metric id declared differently in
 *  another case (any field: the file, the path, the direction, the bound, the floor) is refused, naming both cases:
 *  one column cannot mean two things. Ids are compared case-insensitively, as the scenario compares its own: two
 *  spellings of one id would be two keys on a row but one file on a case-folding disk. */
export function metricUnion(cases: ReadonlyArray<{ name?: string; metrics?: readonly MetricDecl[] }>): MetricDecl[] {
  const seen = new Map<string, { m: MetricDecl; name: string }>();
  cases.forEach((c, i) => {
    const name = c.name ?? `case ${i + 1}`;
    for (const m of c.metrics ?? []) {
      const prev = seen.get(m.id.toLowerCase());
      if (prev === undefined) seen.set(m.id.toLowerCase(), { m, name });
      else if (prev.m.id !== m.id)
        throw new UsageError(
          `metric "${prev.m.id}" (${prev.name}) and metric "${m.id}" (${name}) differ only in case; ids are compared case-insensitively — spell them the same in every scenario`,
        );
      else if (declTuple(prev.m) !== declTuple(m))
        throw new UsageError(
          `metric "${m.id}" is declared differently in ${prev.name} and ${name} (${JSON.stringify(prev.m)} vs ${JSON.stringify(m)}); one column cannot mean two things — make the declarations identical or rename one`,
        );
    }
  });
  return [...seen.values()].map((e) => e.m);
}

export { presentCompanionOf } from "./present.js";
