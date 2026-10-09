// One hillclimb job → one scenario run through the CLI's per-scenario runner (the eval job pattern), turned into
// the JobReport the runner core consumes. The scenario runner is a fake here: it records what it was asked to
// run and returns a result whose run dir holds real frames (the public csv-metrics example's init/result pair,
// test/fixtures/hillclimb-runs/README.md). The real runner through the stub agent is the CLI wiring test.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InterruptedError } from "../src/termination.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHillclimbJobRunner, type JobDeps } from "../src/hillclimb/job.js";
import type { HillclimbCase } from "../src/hillclimb/cases.js";
import type { RunResult, Scenario } from "../src/types.js";
import { UnansweredError } from "../src/errors.js";

const frames = readFileSync(join(import.meta.dirname, "fixtures", "hillclimb-runs", "result-event-pair.jsonl"), "utf8");

let root: string;
let calls: Array<{ scenario: Scenario; label: string; flags: { label?: string; ablateSkill?: boolean }; extra: Record<string, unknown> }>;
let clock: number;

const kase = (timeout_ms?: number): HillclimbCase =>
  ({
    id: "alpha",
    stem: "alpha",
    name: "Alpha",
    file: "/x/alpha.yaml",
    scenario: {
      name: "Alpha",
      prompt: "p",
      fidelity: "container",
      assert: [],
      ...(timeout_ms !== undefined ? { timeout_ms } : {}),
    } as unknown as Scenario,
  }) as HillclimbCase;

function deps(over: Partial<JobDeps<{ label?: string; ablateSkill?: boolean }>> = {}): JobDeps<{ label?: string; ablateSkill?: boolean }> {
  return {
    flags: { label: "shared" },
    now: () => clock,
    runDirFor: (scenario, runId) => join(root, scenario.name, runId),
    runScenario: async (a) => {
      calls.push(a as never);
      const outDir = join(root, a.scenario.name, String(a.extra.runId));
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "events.jsonl"), frames);
      clock += 5_000;
      return {
        result: "success",
        outDir,
        effectiveFidelity: "container",
        workDir: join(outDir, "work", "session", "mnt"),
      } as unknown as RunResult;
    },
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hc-job-"));
  calls = [];
  clock = 1_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("makeHillclimbJobRunner", () => {
  it("runs with a per-job COPY of the flags carrying the job's label and ablation, a fresh run id, rethrowUnanswered", async () => {
    const d = deps();
    const run = makeHillclimbJobRunner(d);
    await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "hillclimb:f:baseline", timeoutS: 0, ablate: true });
    expect(calls[0].flags).toEqual({ label: "hillclimb:f:baseline", ablateSkill: true });
    expect(d.flags).toEqual({ label: "shared" }); // never mutated: jobs run concurrently
    expect(calls[0].extra.runId).toMatch(/^local_[0-9a-z]{13}$/);
    expect(calls[0]).toMatchObject({ rethrowUnanswered: true });
  });

  it("two attempts of the same (case, rep) get different run ids, so a re-run never overwrites the first's dir", async () => {
    const run = makeHillclimbJobRunner(deps());
    const spec = { c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false };
    await run(spec);
    await run(spec);
    expect(calls[0].extra.runId).not.toBe(calls[1].extra.runId);
  });

  it("the runner's ceiling lowers the scenario's timeout_ms; a shorter scenario timeout is kept", async () => {
    const run = makeHillclimbJobRunner(deps());
    await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 60, ablate: false });
    await run({ c: kase(30_000), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 60, ablate: false });
    await run({ c: kase(30_000), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false });
    expect(calls.map((c) => c.scenario.timeout_ms)).toEqual([60_000, 30_000, 30_000]);
  });

  it("a timeout at the RUNNER's value is a runner timeout; at the scenario's own (shorter) value it is the skill's", async () => {
    const timedOut = (d: JobDeps<{ label?: string; ablateSkill?: boolean }>) => ({
      ...d,
      runScenario: async (a: Parameters<JobDeps<object>["runScenario"]>[0]) => {
        const r = await d.runScenario(a as never);
        return { ...r, result: "error", errorSource: "timeout" } as RunResult;
      },
    });
    const run = makeHillclimbJobRunner(timedOut(deps()));
    expect((await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 60, ablate: false })).runnerTimeout).toBe(true);
    expect((await run({ c: kase(30_000), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 60, ablate: false })).runnerTimeout).toBe(
      false,
    );
    // a tie goes to the runner (the conservative reading)
    expect((await run({ c: kase(60_000), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 60, ablate: false })).runnerTimeout).toBe(
      true,
    );
  });

  it("the report carries the run's events, its dir and the attempt's wall clock", async () => {
    const run = makeHillclimbJobRunner(deps());
    const rep = await run({ c: kase(), rep: 2, variant: "v1", runLabel: "l", timeoutS: 0, ablate: false });
    expect(rep.events).toEqual(frames.trim().split("\n"));
    expect(rep.runDir).toMatch(/Alpha\/local_/);
    expect(rep.attemptS).toBe(5);
    expect(rep.children).toEqual([]);
    expect(rep.result?.result).toBe("success");
    // the fake's run dir records no append: the run cannot say what was sent
    expect(rep.system).toBe("[system — harness append not recorded for this run; Anthropic's built-in system prompt withheld]");
  });

  it("a thrown job (an unanswered gate) keeps the throw and salvages the result.json it left", async () => {
    const run = makeHillclimbJobRunner(
      deps({
        runScenario: async (a) => {
          const outDir = join(root, a.scenario.name, String(a.extra.runId));
          mkdirSync(join(outDir, "turns", "1"), { recursive: true });
          writeFileSync(join(outDir, "turns", "1", "result.json"), JSON.stringify({ result: "error", partial: true }));
          writeFileSync(join(outDir, "events.jsonl"), frames);
          throw new UnansweredError("unanswered", "answer it");
        },
      }),
    );
    const rep = await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false });
    expect(rep.thrown).toBeInstanceOf(UnansweredError);
    expect(rep.result).toMatchObject({ result: "error", partial: true });
    expect(rep.events.length).toBe(2);
  });

  it("a thrown job that left nothing reports the throw with no result and no events", async () => {
    const run = makeHillclimbJobRunner(
      deps({
        runScenario: async () => {
          throw new Error("spawn failed");
        },
      }),
    );
    const rep = await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false });
    expect(rep).toMatchObject({ result: undefined, events: [], children: [] });
    expect((rep.thrown as Error).message).toBe("spawn failed");
  });

  it("the report carries the sub-agent append the session sent (SYNTHETIC control-out line)", async () => {
    const run = makeHillclimbJobRunner(
      deps({
        runScenario: async (a) => {
          const outDir = join(root, a.scenario.name, String(a.extra.runId));
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, "events.jsonl"), frames);
          writeFileSync(
            join(outDir, "control-out.jsonl"),
            JSON.stringify({
              type: "control_request",
              request_id: "1",
              request: { subtype: "initialize", appendSubagentSystemPrompt: "SYNTHETIC append" },
            }),
          );
          return { result: "success", outDir, effectiveFidelity: "container" } as unknown as RunResult;
        },
      }),
    );
    const rep = await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false });
    expect(rep.subagentAppend).toBe("SYNTHETIC append");
  });

  it("the system turn is the append the run actually sent (SYNTHETIC text), or says none was sent", async () => {
    const withAppend = (systemPromptAppend: string) =>
      makeHillclimbJobRunner(
        deps({
          runScenario: async (a) => {
            const outDir = join(root, a.scenario.name, String(a.extra.runId));
            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, "events.jsonl"), frames);
            // the run dir's record of exactly what the spawn passed as --append-system-prompt
            writeFileSync(join(outDir, "system-prompt-append.txt"), systemPromptAppend);
            return { result: "success", outDir, effectiveFidelity: "container" } as unknown as RunResult;
          },
        }),
      );
    const spec = { c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false };
    expect((await withAppend("SYNTHETIC session append")(spec)).system).toBe(
      "[system — harness append as sent; Anthropic's built-in system prompt withheld]\n\nSYNTHETIC session append",
    );
    expect((await withAppend("")(spec)).system).toBe("[system — harness append: none sent; Anthropic's built-in system prompt withheld]");
  });

  it("each attempt carries the runner's whole-run deadline (start + --timeout-s), none with no ceiling", async () => {
    const run = makeHillclimbJobRunner(deps());
    await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 60, ablate: false });
    await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false });
    expect(calls[0].extra.deadline).toBe(1_000_000 + 60_000);
    expect(calls[1].extra).not.toHaveProperty("deadline");
  });

  it("a timeout reported once the runner's deadline passed is the runner's, even under a shorter scenario timeout", async () => {
    // the scenario's own 1 s timeout binds the agent; the runner's 2 s deadline passes while the attempt runs (5 s)
    const run = makeHillclimbJobRunner(
      deps({
        runScenario: async (a) => {
          const outDir = join(root, a.scenario.name, String(a.extra.runId));
          mkdirSync(outDir, { recursive: true });
          clock += 5_000;
          return { result: "error", errorSource: "timeout", outDir, effectiveFidelity: "container" } as unknown as RunResult;
        },
      }),
    );
    expect((await run({ c: kase(1_000), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 2, ablate: false })).runnerTimeout).toBe(
      true,
    );
  });
});

describe("the agent's own session transcript", () => {
  it("is the file the events' session id names, not another session's beside it", async () => {
    const sid = JSON.parse(frames.split("\n")[0]).session_id as string;
    const mine = JSON.stringify({ type: "assistant", isSidechain: false, effort: "high", message: { model: "claude-sonnet-5" } });
    const other = JSON.stringify({ type: "assistant", isSidechain: false, effort: "low", message: { model: "claude-sonnet-5" } });
    const run = makeHillclimbJobRunner(
      deps({
        runScenario: async (a) => {
          const outDir = join(root, a.scenario.name, String(a.extra.runId));
          const projects = join(outDir, "work", "session", "mnt", ".claude", "projects", "-sessions-x");
          mkdirSync(projects, { recursive: true });
          writeFileSync(join(outDir, "events.jsonl"), frames);
          writeFileSync(join(projects, `${sid}.jsonl`), mine + "\n");
          writeFileSync(join(projects, "0000-another-session.jsonl"), other + "\n");
          return {
            result: "success",
            outDir,
            effectiveFidelity: "container",
            workDir: join(outDir, "work", "session", "mnt"),
          } as unknown as RunResult;
        },
      }),
    );
    const report = await run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false });
    expect(report.transcript).toEqual([mine]);
  });
});

describe("an interrupt learned from a probe inside the scenario run", () => {
  it("propagates out of the job instead of becoming this attempt's error row", async () => {
    // The production runner: executeScenario's own probes (the host claude's --permission-prompts check under
    // answer_channel: none, say) can raise it inside the job, after the command's pre-checks passed.
    const run = makeHillclimbJobRunner(
      deps({
        runScenario: async () => {
          throw new InterruptedError("SIGINT", "claude --help");
        },
      }),
    );
    await expect(run({ c: kase(), rep: 0, variant: "baseline", runLabel: "l", timeoutS: 0, ablate: false })).rejects.toThrow(
      InterruptedError,
    );
  });
});
