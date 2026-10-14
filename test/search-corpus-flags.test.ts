// The `--search-corpus*` flags read one way on `run`, `eval` and `hillclimb run`, and `hillclimb check`'s findings over
// a flow's frozen rows. $0.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseEvalArgs } from "../src/eval/command.js";
import { parseHillclimbRunArgs } from "../src/hillclimb/args.js";
import { searchCorpusFindings, searchCorpusCostClause, flowRows } from "../src/hillclimb/search-corpus.js";
import type { FlowSnapshot } from "../src/hillclimb/schema-check.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const evalArgs =
  (...a: string[]) =>
  () =>
    parseEvalArgs(["s.yaml", "--arm", "x", "--arm", "y", ...a]);
const hcArgs =
  (...a: string[]) =>
  () =>
    parseHillclimbRunArgs(["evals", ...a]);
const runMessage = (...a: string[]) => {
  const r = spawnSync(process.execPath, [CLI, "run", "nope.yaml", ...a], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return r.stderr + r.stdout;
};

describe("one parser for the --search-corpus flags", () => {
  const cases: Array<[string[], RegExp]> = [
    [["--search-corpus", "p", "--search-corpus-miss", "maybe"], /--search-corpus-miss must be "empty" or "error" \(got "maybe"\)/],
    [
      ["--search-corpus", "p", "--search-corpus-min-score", "1.5"],
      /--search-corpus-min-score must be a number between 0 and 1, exclusive \(got "1.5"\)/,
    ],
    [["--search-corpus-miss", "error"], /--search-corpus-miss and --search-corpus-min-score need --search-corpus <pool>/],
  ];
  it.each(cases)("eval, hillclimb run and run refuse %j with the same message", (argv, msg) => {
    expect(evalArgs(...argv)).toThrow(msg);
    expect(hcArgs(...argv)).toThrow(msg);
    expect(runMessage(...argv)).toMatch(msg);
  });

  it("the allow flags need --search-corpus", () => {
    expect(evalArgs("--allow-confounded-pool")).toThrow(/--allow-confounded-pool needs --search-corpus <pool>/);
    expect(hcArgs("--allow-mixed-pool")).toThrow(/--allow-mixed-pool needs --search-corpus <pool>/);
  });

  it("parses the pool, the miss mode and the floor", () => {
    expect(
      parseEvalArgs(["s.yaml", "--arm", "x", "--arm", "y", "--search-corpus", "p", "--search-corpus-min-score", "0.5"]).searchCorpus,
    ).toEqual({
      pool: "p",
      miss: "empty",
      minScore: 0.5,
    });
  });
});

const row = (o: Record<string, unknown>) => JSON.stringify({ prompt_id: "alpha", rep: 0, ...o });
const sc = (sha: string, extra: Record<string, unknown> = {}) => ({
  search_corpus: { sha256: sha, label: `pool@${sha.slice(0, 8)}`, ...extra },
});
const snap = (variants: Record<string, { results?: string[]; errors?: string[] }>): FlowSnapshot => ({
  entries: [],
  variants: Object.fromEntries(
    Object.entries(variants).map(([k, v]) => [
      k,
      { results: (v.results ?? []).join("\n"), errors: (v.errors ?? []).join("\n"), traces: {} },
    ]),
  ),
});
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("hillclimb check: frozen-corpus findings", () => {
  it("rows from two pools, or frozen beside live, are an error", () => {
    const f = searchCorpusFindings(snap({ baseline: { results: [row({ meta: sc(A) })] }, v1: { results: [row({ meta: sc(B) })] } }));
    expect(f).toContainEqual(expect.objectContaining({ severity: "error", rule: "search_corpus.mixed" }));
    const live = searchCorpusFindings(snap({ baseline: { results: [row({ meta: {} })] }, v1: { results: [row({ meta: sc(A) })] } }));
    expect(live).toContainEqual(expect.objectContaining({ severity: "error", rule: "search_corpus.mixed" }));
  });

  it("only a warning when every frozen row was written under --allow-mixed-search", () => {
    const f = searchCorpusFindings(
      snap({
        baseline: { results: [row({ meta: sc(A, { allow_mixed_search: true }) })] },
        v1: { results: [row({ meta: sc(B, { allow_mixed_search: true }) })] },
      }),
    );
    expect(f).toContainEqual(expect.objectContaining({ severity: "warning", rule: "search_corpus.mixed" }));
  });

  it("a pool-mismatch error row is an error finding", () => {
    const f = searchCorpusFindings(snap({ baseline: { errors: [row({ failure_class: "search_pool_mismatch", meta: sc(A) })] } }));
    expect(f).toContainEqual(expect.objectContaining({ severity: "error", rule: "search_corpus.pool_mismatch" }));
  });

  it("warns on a confounded pool, a judge on recorded searches, and an asymmetric variant", () => {
    const counts = (served: number, miss: number) => sc(A, { served, miss, mean_top_score: 0.7 });
    const f = searchCorpusFindings(
      snap({
        baseline: { results: [row({ meta: counts(20, 0) })] },
        v1: {
          results: [
            row({
              meta: {
                ...counts(10, 10),
                search_corpus: { ...counts(10, 10).search_corpus, confounded: true, signals: ["search_corpus_semantic_judge"] },
              },
            }),
          ],
        },
      }),
    );
    const rules = f.filter((x) => x.severity === "warning").map((x) => x.rule);
    expect(rules).toEqual(expect.arrayContaining(["search_corpus.confounded", "search_corpus.semantic_judge", "search_corpus.asymmetric"]));
  });

  it("the cost clause counts scored and error rows, refusals and mismatches included", () => {
    const s = snap({
      baseline: {
        results: [row({ meta: sc(A, { served: 3, miss: 1, refused: 0 }) })],
        errors: [
          row({ failure_class: "search_refused", meta: sc(A, { served: 1, miss: 0, refused: 2 }) }),
          row({ failure_class: "search_pool_mismatch", meta: sc(A) }),
        ],
      },
    });
    expect(searchCorpusCostClause(flowRows(s))).toBe(
      `search frozen: 4 served, 1 miss, 2 refused over 3 row(s), 1 pool mismatch(es) [pool@aaaaaaaa]`,
    );
  });
});
