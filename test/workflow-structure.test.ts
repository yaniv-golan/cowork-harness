import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Structural guards on the workflows themselves. A workflow is the one part of CI that CI cannot check:
// a job that never blocks a merge, a `docker build --platform linux/arm64` on an x86 runner, or a key
// GitHub silently ignores all look exactly like a working config until the day they matter.
//
// These are OFFLINE guards over the YAML. They complement `scripts/release-preflight.ts`, which checks
// the other direction (live ruleset contexts -> job names) and needs `gh` + admin scope. Note the `yaml`
// package parses per YAML 1.2, so the `on:` key stays the string "on" and is NOT folded to boolean true
// (the YAML 1.1 trap) — verified, not assumed.

const WF_DIR = join(".github", "workflows");

interface Job {
  name?: string;
  if?: string;
  "runs-on"?: string;
  needs?: string | string[];
  steps?: unknown[];
  paths?: unknown;
  "continue-on-error"?: unknown;
}
interface Workflow {
  name?: string;
  on?: { push?: { branches?: string[]; tags?: string[]; paths?: string[] } };
  jobs?: Record<string, Job | null>;
}

function workflows(): { file: string; doc: Workflow }[] {
  return readdirSync(WF_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((file) => ({ file, doc: parse(readFileSync(join(WF_DIR, file), "utf8")) as Workflow }));
}

const ci = () => workflows().find((w) => w.file === "ci.yml")!.doc;
const needsOf = (j: Job | null): string[] => (j?.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);

/** Contexts the `main` branch ruleset requires. The ruleset lives in GitHub settings, not in this repo,
 *  so nothing here can see it drift — these strings were read from the live ruleset on 2026-08-06 and are
 *  duplicated deliberately, as the offline half of the same guarantee release-preflight checks online. */
const REQUIRED_CONTEXTS = ["typecheck · test · build", "pytest helper lane (-m 'not cowork')"];

/** Jobs that run in CI but do NOT block a merge. This list is not an endorsement — it exists so that
 *  ADDING a job forces a conscious choice between "gates a merge" and "does not", instead of defaulting
 *  to "does not" silently. A new job belongs in `ci-green.needs` or here, with a reason. */
const NON_GATING: Record<string, string> = {
  "action-self-test": "exercises the packaged Action end-to-end; informative, not merge-blocking",
  boundary: "arm64 container parity lane; long-running",
  scenarios: "live-inference suite — SKIPPED as a job without ANTHROPIC_API_KEY, and a skipped job passes a gate",
  "live-key": "decides whether `scenarios` runs; it checks for a key, not for correctness",
  "parity-drift": "watches upstream Desktop; drift is news about the world, not a defect in the PR",
};

describe("the hang budgets of the sharded test jobs", () => {
  interface TimedStep {
    name?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
    "timeout-minutes"?: number;
  }
  const budget = (id: string, preVitestS: number) => {
    const job = ci().jobs?.[id] as (Omit<Job, "steps"> & { "timeout-minutes"?: number; steps: TimedStep[] }) | undefined;
    const runs = job!.steps.map((s) => s.run ?? "");
    const arm = runs.join("\n").match(/HANG_DUMP_GDB_BUDGET=(\d+) nohup scripts\/ci\/hang-dump\.sh (\d+) /);
    const stepOf = job!.steps.find((s) => /--kill-after=\d+s \d+ npx vitest run/.test(s.run ?? ""));
    const kill = stepOf?.run?.match(/--kill-after=(\d+)s (\d+) npx vitest run/);
    const n = {
      gdbS: Number(arm?.[1]),
      dumpS: Number(arm?.[2]),
      killAfterS: Number(kill?.[1]),
      vitestS: Number(kill?.[2]),
      stepS: Number(stepOf?.["timeout-minutes"]) * 60,
      jobMin: Number(job?.["timeout-minutes"]),
    };
    for (const [k, v] of Object.entries(n)) expect(Number.isFinite(v), `${id}: ${k} could not be read`).toBe(true);
    return { ...n, preVitestS };
  };

  // Seconds of typecheck and build ahead of vitest in the same step, allowed for generously.
  it.each([
    ["test", 0],
    ["floor", 60],
  ])("%s: the dump ends before the kill, the kill before the step limit, and the step before the job limit", (id, pre) => {
    const b = budget(id, pre);
    // Armed before the step, so the dump's clock starts no later than vitest's.
    expect(b.dumpS + b.gdbS).toBeLessThan(b.vitestS);
    expect(b.preVitestS + b.vitestS + b.killAfterS).toBeLessThan(b.stepS);
    // setup incl. gdb install 3 + step + disarm 1 + upload 1
    expect(3 + b.stepS / 60 + 1 + 1).toBeLessThanOrEqual(b.jobMin);
  });

  it("floor runs every shard to its end, and names the shard count it splits by", () => {
    const job = ci().jobs?.floor as unknown as { strategy: { "fail-fast": boolean; matrix: { shard: number[] } }; steps: TimedStep[] };
    expect(job.strategy["fail-fast"]).toBe(false);
    const n = job.strategy.matrix.shard.length;
    expect(job.strategy.matrix.shard).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    const shardStep = job.steps.find((s) => (s.run ?? "").includes("--shard="));
    expect(shardStep?.run).toContain(`--shard=\${{ matrix.shard }}/${n} `);
    expect(shardStep?.name).toContain(`shard \${{ matrix.shard }}/${n}`);
  });

  // Hang dumps written anywhere else are outside the uploaded artifact, so a captured hang would be lost silently.
  it.each([
    ["ci.yml", "test"],
    ["ci.yml", "floor"],
    ["floor-unsharded.yml", "floor-unsharded"],
  ])("%s, %s: the suite watchdog, the job-level dump and the upload share one directory", (file, id) => {
    const HANG_DIR = "${{ runner.temp }}/hangs";
    const job = workflows().find((w) => w.file === file)!.doc.jobs?.[id] as unknown as { steps: TimedStep[] };
    const vitest = job.steps.find((s) => /npx vitest run/.test(s.run ?? ""));
    expect(vitest?.env?.COWORK_TEST_HANG_DIR).toBe(HANG_DIR);
    expect(job.steps.map((s) => s.run ?? "").join("\n")).toMatch(/scripts\/ci\/hang-dump\.sh \d+ "\$RUNNER_TEMP\/hangs"/);
    const upload = job.steps.find((s) => (s.with?.name ?? "").startsWith("hangs-"));
    expect(upload?.with?.path).toBe(HANG_DIR);
  });
});

describe("floor-unsharded.yml, the main-only capture run", () => {
  const doc = () =>
    workflows().find((w) => w.file === "floor-unsharded.yml")!.doc as Workflow & {
      on: { workflow_dispatch?: unknown; pull_request?: unknown };
      concurrency?: unknown;
    };
  const text = () => readFileSync(join(WF_DIR, "floor-unsharded.yml"), "utf8");

  it("runs on pushes to main and by hand, never on a PR, and is never cancelled by a later push", () => {
    expect(doc().on.push?.branches).toEqual(["main"]);
    expect(doc().on).toHaveProperty("workflow_dispatch");
    expect(doc().on).not.toHaveProperty("pull_request");
    expect(doc().concurrency).toBeUndefined();
  });

  it("is unsharded, on the engines floor, and keeps its hang and timing artifacts", () => {
    expect(text()).toContain('node-version: "22"');
    expect(text()).not.toContain("--shard");
    expect(text()).toContain("scripts/ci/hang-dump.sh");
    expect(text()).toMatch(/name: hangs-floor$/m);
    expect(text()).toMatch(/name: timing-floor$/m);
  });

  it("is outside what the publish gate reads", () => {
    expect(readFileSync(join(".github", "actions", "require-ci-success", "action.yml"), "utf8")).toContain("--workflow=ci.yml");
  });
});

describe("ci.yml merge gating", () => {
  it("has a job named for each required ruleset context", () => {
    const names = Object.values(ci().jobs ?? {}).map((j) => j?.name);
    for (const ctx of REQUIRED_CONTEXTS) expect(names).toContain(ctx);
  });

  it("routes every job to a merge gate or an explicit non-gating reason", () => {
    // A required context is satisfied by ONE job; everything that must block a merge has to be reachable
    // from it via `needs`. `ci-green` exists only to be that funnel (it runs no build or test of its own), so a new
    // job absent from its `needs` runs on every PR and blocks nothing — green CI, unguarded merge.
    const jobs = ci().jobs ?? {};
    const roots = Object.entries(jobs)
      .filter(([, j]) => j?.name !== undefined && REQUIRED_CONTEXTS.includes(j.name))
      .map(([id]) => id);
    expect(roots.length).toBe(REQUIRED_CONTEXTS.length);

    const gated = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift()!;
      if (gated.has(id)) continue;
      gated.add(id);
      queue.push(...needsOf(jobs[id] ?? null));
    }

    const ungoverned = Object.keys(jobs).filter((id) => !gated.has(id) && !(id in NON_GATING));
    expect(ungoverned).toEqual([]);
  });

  it("the ci-green aggregator runs on a red prerequisite and fails on it, instead of skipping", () => {
    // Without `if: always()` a failed `needs` job SKIPS ci-green, and GitHub reports a skipped job as
    // SUCCESS on a required status check: a PR with a red build or test was mergeable. `always()` alone
    // would turn that into a false green, so a step must also fail on any non-success result.
    const gate = ci().jobs?.["ci-green"];
    expect(gate?.name).toBe("typecheck · test · build");
    expect(gate?.if).toMatch(/^\$\{\{\s*always\(\)\s*\}\}$|^always\(\)$/);
    const steps = JSON.stringify(gate?.steps ?? []);
    expect(steps).toContain("toJSON(needs)");
    expect(steps).toContain('select(.value.result != \\"success\\")');
    expect(steps).toContain("exit 1");
    // `continue-on-error` anywhere on the funnel turns a red result into a pass: on the gate or its step the
    // check concludes success anyway, and on a needed job `needs.<id>.result` reads `success` for a red job.
    expect(gate?.["continue-on-error"], "ci-green sets continue-on-error").toBeUndefined();
    for (const [i, step] of (gate?.steps ?? []).entries())
      expect((step as Record<string, unknown> | null)?.["continue-on-error"], `ci-green step ${i} sets continue-on-error`).toBeUndefined();
    for (const id of needsOf(gate ?? null))
      expect(ci().jobs?.[id]?.["continue-on-error"], `ci-green needs "${id}", which sets continue-on-error`).toBeUndefined();
    // A job-level `if:` on a needed job would make a legitimate skip fail the gate; keep conditionals on steps.
    for (const id of needsOf(gate ?? null))
      expect(ci().jobs?.[id]?.if, `ci-green needs "${id}", which has a job-level if:`).toBeUndefined();
  });
});

describe("every workflow", () => {
  it("declares no per-job `paths` filter", () => {
    // Path filters are workflow-level (`on.push.paths`). GitHub silently ignores an unknown `paths` key
    // on a job, so this reads as a working per-job filter while the job runs unconditionally.
    for (const { file, doc } of workflows()) {
      for (const [id, job] of Object.entries(doc.jobs ?? {})) {
        expect(job?.paths, `${file}: job "${id}" declares a job-level paths filter, which does not exist`).toBeUndefined();
      }
    }
  });

  it("runs arm64 image builds on an arm64 runner", () => {
    // `docker build --platform linux/arm64` on an x86 runner needs QEMU/binfmt that is not set up here;
    // without it the build fails, and with it the build is slow and subtly different from production.
    for (const { file, doc } of workflows()) {
      for (const [id, job] of Object.entries(doc.jobs ?? {})) {
        const steps = JSON.stringify(job?.steps ?? []);
        if (!/--platform[= ]linux\/arm64/.test(steps)) continue;
        expect(job?.["runs-on"], `${file}: job "${id}" builds arm64 but does not run on an arm64 runner`).toBe("ubuntu-24.04-arm");
      }
    }
  });

  it("does not list its own file in its push path filter", () => {
    // Self-triggering: the very commit that introduces the filter matches it, so the first thing the new
    // trigger publishes is the untested new trigger. Edit the workflow via workflow_dispatch instead.
    for (const { file, doc } of workflows()) {
      const paths = doc.on?.push?.paths ?? [];
      expect(paths, `${file}: lists itself in on.push.paths, so editing it triggers itself`).not.toContain(`.github/workflows/${file}`);
    }
  });
});

describe("ci.yml concurrency", () => {
  it("never cancels an in-progress run on main", () => {
    // A cancelled `main` run makes that commit unpublishable: `require-ci-success` requires
    // `conclusion == success` for the SHA it checks, and `cancelled` is not it. PR runs stay
    // cancellable — that is where the saving is, and no gate consults them.
    const doc = workflows().find((w) => w.file === "ci.yml")!.doc as { concurrency?: { "cancel-in-progress"?: unknown } };
    const flag = doc.concurrency?.["cancel-in-progress"];
    expect(String(flag)).not.toBe("true");
    expect(String(flag)).toContain("refs/heads/main");
  });
});

describe("ci.yml live suite", () => {
  // Without a key the live suite used to run with every real step skipped and report SUCCESS — a green
  // check that validated nothing. It must be skipped as a whole JOB instead, so it shows as skipped.
  // A step-level `if` over a key guard is exactly the shape that produced the false green.
  it("is skipped at JOB level on the key-check output, with no step-level key guard", () => {
    const jobs = ci().jobs ?? {};
    const scenarios = jobs.scenarios!;
    expect(needsOf(scenarios)).toContain("live-key");
    expect(scenarios.if).toMatch(/needs\.live-key\.outputs\.has_key\s*==\s*'true'/);
    const stepIfs = (scenarios.steps ?? []).map((st) => (st as { if?: string }).if).filter((c): c is string => c !== undefined);
    expect(stepIfs.filter((c) => c !== "always()")).toEqual([]);
  });

  it("is not reachable from a required context (a skipped job would PASS a required-status rule)", () => {
    const jobs = ci().jobs ?? {};
    const gateNeeds = Object.values(jobs)
      .filter((j) => j?.name !== undefined && REQUIRED_CONTEXTS.includes(j.name))
      .flatMap((j) => needsOf(j));
    expect(gateNeeds).not.toContain("scenarios");
    expect(gateNeeds).not.toContain("live-key");
    expect(REQUIRED_CONTEXTS).not.toContain(jobs.scenarios?.name);
  });
});
