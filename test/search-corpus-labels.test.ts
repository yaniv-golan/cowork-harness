import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSubagentResearchView, formatSubagentResearchView } from "../src/run/trace-view.js";
import { findLatestRunForScenario } from "../src/run/latest-run.js";
import { buildRepeatRollup } from "../src/run/repeat.js";
import { formatRepeatRollup } from "../src/cli.js";
import type { RunResult } from "../src/types.js";

// A run served from a frozen search corpus says so on every surface a reader takes a verdict from.
const LABEL = "frozen search corpus p@aaaaaaaa — recorded results, harness ranking, searches not billed; not live search";
const sc = {
  poolId: "p",
  sha256: "a".repeat(64),
  label: LABEL,
  miss: "empty",
  interposition: "proxy-env+ca",
  credentialSource: "env",
  metrics: {
    requests: 0,
    served: 0,
    miss: 0,
    refused: 0,
    retriesFolded: 0,
    unfinished: 0,
    passedThroughWithSearchTool: 0,
    toolUses: 0,
    noRequest: 0,
  },
  calls: [],
};
function runDir(over: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-sclabel-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const t1 = join(root, "turns", "1");
  mkdirSync(t1, { recursive: true });
  const result = {
    scenario: "s",
    fidelity: "hostloop",
    baseline: "x",
    result: "success",
    decisions: [],
    toolCounts: {},
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [{ dispatchAgentType: "research", declaredTools: [], webSearches: [{ query: "q", resultText: "r" }] }],
    outDir: root,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
    ...over,
  };
  writeFileSync(join(t1, "result.json"), JSON.stringify(result));
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "s" }));
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [] }));
  return root;
}

describe("the frozen-corpus label on the reading surfaces", () => {
  it("trace's sub-agent research view: the searches shown were served from the pool", () => {
    const frozen = formatSubagentResearchView(buildSubagentResearchView(join(runDir({ searchCorpus: sc }), "trace.json")));
    expect(frozen.split("\n")[0]).toBe(`[${LABEL}] — these results were served from the pool, not searched live`);
    expect(formatSubagentResearchView(buildSubagentResearchView(join(runDir(), "trace.json")))).not.toContain("frozen search corpus");
  });

  it("status --latest-for: the newest run's label rides with its verdict", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-sclatest-"));
    const dir = join(root, "s", "r1");
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "result.json"), JSON.stringify({ scenario: "s", verdict: { pass: true }, searchCorpus: sc }));
    expect(findLatestRunForScenario(root, "s")).toMatchObject({ searchCorpusLabel: LABEL });
  });

  it("a --repeat rollup names the corpus its runs were served from", () => {
    const rr = (over: Partial<RunResult>): RunResult =>
      ({
        scenario: "t",
        fidelity: "hostloop",
        baseline: "x",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: "/tmp/x",
        ...over,
      }) as RunResult;
    const r = buildRepeatRollup("t", 2, [
      rr({ searchCorpus: sc as unknown as RunResult["searchCorpus"] }),
      rr({ searchCorpus: sc as unknown as RunResult["searchCorpus"] }),
    ]);
    expect(r.provenance.searchCorpus).toEqual([LABEL]);
    expect(formatRepeatRollup(r, 1, false)).toContain(`  search: [${LABEL}]`);
    const live = buildRepeatRollup("t", 1, [rr({})]);
    expect(live.provenance.searchCorpus).toBeUndefined();
    expect(formatRepeatRollup(live, 1, false)).not.toContain("search:");
  });

  it("a --repeat rollup leaves a run with a refused search out of passes and the rate, and names the count", () => {
    const rr = (over: Partial<RunResult>): RunResult =>
      ({
        scenario: "t",
        fidelity: "hostloop",
        baseline: "x",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: "/tmp/x",
        ...over,
      }) as RunResult;
    const refused = { ...sc, metrics: { ...sc.metrics, refused: 1 } };
    const r = buildRepeatRollup("t", 3, [
      rr({ searchCorpus: sc as unknown as RunResult["searchCorpus"] }),
      rr({ searchCorpus: sc as unknown as RunResult["searchCorpus"] }),
      rr({ searchCorpus: refused as unknown as RunResult["searchCorpus"] }),
    ]);
    expect(r.passes).toBe(2);
    expect(r.passRate).toBe(1);
    expect(r.provenance.searchRefusedRuns).toBe(1);
    expect(formatRepeatRollup(r, 1, false)).toMatch(/1 run\(s\) with refused searches excluded from the pass rate/);
  });

  const CLI = resolve("dist/cli.js");
  it.skipIf(!existsSync(CLI))("verify-run's text output prints the label", () => {
    const dir = runDir({ searchCorpus: sc });
    const scen = join(dir, "s.yaml");
    writeFileSync(scen, "name: s\nprompt: p\nfidelity: hostloop\nassert:\n  - result: success\n");
    const r = spawnSync("node", [CLI, "verify-run", dir, scen], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cwh-sccwd-")) });
    expect((r.stderr ?? "") + (r.stdout ?? "")).toContain(`· [${LABEL}]`);
  });
});
