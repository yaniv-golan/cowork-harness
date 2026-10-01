// `hillclimb` command family: `run`, `check`, `state-template`. The scenario runner comes from src/cli.ts (its
// per-scenario runner and decider channel live there); everything else is composed here.

import { join, relative, resolve } from "node:path";
import { parseArgs } from "../cli-args.js";
import { UsageError } from "../errors.js";
import { writeAllSync } from "../io.js";
import { applyCommandGlobal, applyParsedCommandGlobals, withCommandGlobals } from "../run/command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "../run/envelope.js";
import { collectSecrets, scrub } from "../secrets.js";
import { isolationRefusal } from "../decide/llm-transport.js";
import type { ScenarioRunner } from "../eval/job-runner.js";
import { HILLCLIMB_RUN_DEFAULTS, parseHillclimbRunArgs } from "./args.js";
import { loadCases } from "./cases.js";
import { headroom, metricRangeWarnings, pairwiseHints, pairwiseRefFindings, stateMetricFindings } from "./check.js";
import { prepareCases } from "./command.js";
import { FsRefusal, NoFollowRoot, lexists, normalizeRootArg } from "./fs.js";
import { redactDeep } from "./flow.js";
import { runHillclimbCommand } from "./run-command.js";
import { termSafe } from "./runner.js";
import { checkFlowDir, loadFlowSnapshot, type SchemaCheckReport } from "./schema-check.js";
import { stateTemplate, type StateTemplate } from "./state-template.js";
import {
  HILLCLIMB_CHECK_USAGE,
  HILLCLIMB_FREEZE_REF_USAGE,
  HILLCLIMB_REGRADE_BOOLEAN_FLAGS,
  HILLCLIMB_REGRADE_VALUE_FLAGS,
  HILLCLIMB_REGRADE_USAGE,
  HILLCLIMB_STATE_TEMPLATE_USAGE,
  HILLCLIMB_USAGE,
} from "./usage.js";
import { regradeFlow } from "./regrade.js";
import { freezeRefCommand } from "./freeze-ref.js";
import { flowHasPairwise } from "./grade-keys.js";
import { discoverFlowRefs, metricRefNames } from "./pairwise.js";
import { flowMetricUnion } from "./metric-keys.js";

const CMD = "hillclimb";

type JobFlags = { label?: string; ablateSkill?: boolean };

export interface HillclimbCliDeps<F extends JobFlags> {
  /** The scenario runner for one `run`, with its decider channel; `close` releases the channel. */
  runnerFor: (opts: { deciderCmd?: string; deciderDir?: string; json: boolean }) => {
    flags: F;
    runScenario: ScenarioRunner<F>;
    close: () => void;
  };
}

/** `hillclimb check`: our schema reading (harness profile) plus `_state.json`'s metric rule; headroom and a float
 *  outside its declared range only warn. */
export function checkReport(flowArg: string, cwd: string): { report: SchemaCheckReport; warnings: string[]; exitCode: 0 | 1 } {
  const flowAbs = resolve(cwd, normalizeRootArg(flowArg));
  if (!lexists(flowAbs)) throw new UsageError(`no flow dir at ${flowArg}`);
  const base = checkFlowDir(flowAbs, { profile: "harness" });
  const snap = loadFlowSnapshot(flowAbs);
  const extra = [...stateMetricFindings(snap), ...pairwiseRefFindings(snap)];
  const report = { ...base, findings: [...base.findings, ...extra], errors: base.errors + extra.length };
  return {
    report,
    warnings: [...headroom(snap).warnings, ...metricRangeWarnings(snap), ...pairwiseHints(snap, normalizeRootArg(flowArg))],
    exitCode: report.errors ? 1 : 0,
  };
}

/** `hillclimb state-template`: the skeleton for the flow's cases, with the gate's files relative to cwd. */
export function stateTemplateFor(target: string, cwd: string, env: NodeJS.ProcessEnv, flowArg?: string): StateTemplate {
  const { cases } = loadCases(resolve(cwd, target));
  const prep = prepareCases(cases, { env });
  const assertions = cases.map((c) => ({ assertions: c.scenario.assert ?? [] }));
  // With --flow: each later variant's frozen reference, and how many scored rows (every variant) lack its column.
  let pairwiseRefs: Array<{ ref: string; rowsMissing: number }> | undefined;
  if (flowArg !== undefined && flowHasPairwise(assertions)) {
    const flowAbs = resolve(cwd, normalizeRootArg(flowArg));
    pairwiseRefs = [];
    if (lexists(flowAbs)) {
      const snap = loadFlowSnapshot(flowAbs);
      const rows = Object.values(snap.variants).flatMap((vs) =>
        (vs.results ?? "").split("\n").flatMap((l) => {
          try {
            return l.trim() ? [JSON.parse(l) as { grade?: Record<string, unknown> }] : [];
          } catch {
            return [];
          }
        }),
      );
      for (const ref of metricRefNames(discoverFlowRefs(flowAbs)))
        pairwiseRefs.push({ ref, rowsMissing: rows.filter((r) => r.grade?.[`win_${ref}_present`] === undefined).length });
    }
  }
  return stateTemplate({
    cases: cases.map((c) => ({ name: c.id, assertions: c.scenario.assert ?? [], metrics: c.scenario.metrics })),
    harnessPaths: prep.derivedPaths(cases).map((p) => relative(cwd, p)),
    decider: false,
    ...(pairwiseRefs ? { pairwiseRefs } : {}),
  });
}

/** `state-template --flow`: the metrics legend into `<flow>/metrics.md`, through the no-follow root. The loop
 *  re-runs state-template after adding a metric, so an existing copy that differs (possibly edited) is never
 *  overwritten: the new legend goes to `metrics.md.new` beside it. */
export function writeMetricsMd(
  flowArg: string,
  cwd: string,
  md: string,
  secrets: readonly string[],
): { status: "written" | "unchanged" | "new"; path: string } {
  const r = NoFollowRoot.open(flowArg, { cwd });
  const text = redactDeep(md, secrets);
  const target = join(r.root, "metrics.md");
  const flow = normalizeRootArg(flowArg);
  const existing = r.readIfPresent(target);
  if (existing === null) {
    r.createFile(target, text);
    return { status: "written", path: join(flow, "metrics.md") };
  }
  if (existing === text) return { status: "unchanged", path: join(flow, "metrics.md") };
  r.writeFile(join(r.root, "metrics.md.new"), text);
  return { status: "new", path: join(flow, "metrics.md.new") };
}

const err = (line: string, secrets: readonly string[]) => writeAllSync(2, scrub(termSafe(line), [...secrets]) + "\n");

export async function cmdHillclimb<F extends JobFlags>(args: string[], deps: HillclimbCliDeps<F>): Promise<never> {
  const json = isJsonOutput(args);
  const [sub, ...rest] = args;
  const secrets = collectSecrets();
  const usage = (m: string, hint?: string): never => fail(CMD, "usage", scrub(m, secrets), hint, json);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    writeAllSync(2, HILLCLIMB_USAGE + "\n");
    return process.exit(sub === undefined ? 2 : 0);
  }

  if (sub === "run") {
    let a: ReturnType<typeof parseHillclimbRunArgs>;
    try {
      a = parseHillclimbRunArgs(rest);
    } catch (e) {
      return fail(`${CMD} run`, "usage", scrub((e as Error).message, secrets), undefined, json);
    }
    if (a.help) {
      writeAllSync(2, HILLCLIMB_USAGE + "\n");
      return process.exit(0);
    }
    for (const g of a.globals) applyCommandGlobal(CMD, g.flag, g.value, json);
    const r = deps.runnerFor({
      ...(a.deciderCmd !== undefined ? { deciderCmd: a.deciderCmd } : {}),
      ...(a.deciderDir !== undefined ? { deciderDir: a.deciderDir } : {}),
      json,
    });
    let outcome: Awaited<ReturnType<typeof runHillclimbCommand>>;
    try {
      outcome = await runHillclimbCommand(a, {
        cwd: process.cwd(),
        env: process.env,
        secrets,
        // Through err(), so the terminal and secret scrubs apply to model-influenced text.
        stderr: (line) => err(line, secrets),
        flags: r.flags,
        runScenario: r.runScenario,
        isolationCheck: () => isolationRefusal(),
      });
    } finally {
      r.close();
    }
    const payload = {
      flow: a.flow,
      variant: a.variant,
      scheduled: outcome.scheduled,
      scored: outcome.scored ?? 0,
      failed: outcome.failed,
      exitCode: outcome.exitCode,
      // eval's dry-run shape: the estimate under plan.cost; a top-level cost would read as spend.
      ...(a.dryRun ? { dryRun: true, ...(outcome.cost ? { plan: { cost: outcome.cost } } : {}) } : {}),
    };
    // A refusal or a mid-run stop is the shared error envelope, the payload riding along as eval's plan does.
    // Its text already went to stderr, so only JSON output prints it again.
    if (json && outcome.error)
      return fail(
        `${CMD} run`,
        outcome.error.category,
        scrub(outcome.error.message, secrets),
        undefined,
        json,
        outcome.exitCode as 1 | 2,
        undefined,
        {
          payload,
        },
      );
    if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(`${CMD} run`, outcome.exitCode === 0, payload), secrets) + "\n");
    return process.exit(outcome.exitCode);
  }

  if (sub === "check" || sub === "state-template") {
    let p;
    try {
      p = parseArgs(
        rest,
        withCommandGlobals({ booleans: [], values: ["--flow", "--output-format"], enums: { "--output-format": ["text", "json"] } }),
      );
    } catch (e) {
      return usage((e as Error).message, sub === "check" ? HILLCLIMB_CHECK_USAGE : HILLCLIMB_STATE_TEMPLATE_USAGE);
    }
    if (p.flags["--help"] === true) {
      writeAllSync(2, (sub === "check" ? HILLCLIMB_CHECK_USAGE : HILLCLIMB_STATE_TEMPLATE_USAGE) + "\n");
      return process.exit(0);
    }
    applyParsedCommandGlobals(CMD, p, json);
    const flowGiven = p.options["--flow"];
    const flow = flowGiven ?? HILLCLIMB_RUN_DEFAULTS.flow;
    try {
      if (sub === "check") {
        if (p.positionals.length) return usage(`hillclimb check takes no positional argument`, HILLCLIMB_CHECK_USAGE);
        const c = checkReport(flow, process.cwd());
        if (json)
          writeAllSync(
            1,
            scrub(jsonPayloadEnvelope(`${CMD} check`, c.exitCode === 0, { ...c.report, warnings: c.warnings }), secrets) + "\n",
          );
        else {
          for (const f of c.report.findings)
            err(`${f.level}: ${f.file}${f.line !== undefined ? `:${f.line}` : ""} [${f.rule}] ${f.message}`, secrets);
          for (const w of c.warnings) err(w, secrets);
          err(`${c.report.errors} error(s), ${c.report.notes} note(s) — ${c.report.reading}. ${c.report.disclaimer}`, secrets);
        }
        return process.exit(c.exitCode);
      }
      if (p.positionals.length !== 1)
        return usage(`hillclimb state-template takes exactly one scenario file or directory`, HILLCLIMB_STATE_TEMPLATE_USAGE);
      const t = stateTemplateFor(p.positionals[0], process.cwd(), process.env, flowGiven);
      if (!json) for (const n of t.notes) err(`note: ${n}`, secrets);
      const md = flowGiven !== undefined ? writeMetricsMd(flowGiven, process.cwd(), t.metricsMd, secrets) : undefined;
      if (md && !json)
        err(
          md.status === "written"
            ? `wrote ${md.path}`
            : md.status === "unchanged"
              ? `${md.path} is up to date`
              : `${normalizeRootArg(flowGiven!)}/metrics.md differs from the current legend and was left as it is; the new legend is in ${md.path} — merge it`,
          secrets,
        );
      if (json)
        writeAllSync(
          1,
          scrub(
            jsonPayloadEnvelope(`${CMD} state-template`, true, {
              state: t.state,
              metrics_md: t.metricsMd,
              ...(t.notes.length ? { notes: t.notes } : {}),
              ...(md ? { metrics_md_file: md } : {}),
            }),
            secrets,
          ) + "\n",
        );
      else {
        writeAllSync(1, JSON.stringify(t.state, null, 2) + "\n");
        err(
          `save this as ${flow}/_state.json; on a re-run, merge by adding NEW metrics entries only (the loop owns the rest).` +
            (md
              ? ""
              : ` The metrics legend (metrics.md) was not written: pass --flow ${HILLCLIMB_RUN_DEFAULTS.flow} (or your flow dir) to write it, or read metrics_md under --output-format json.`),
          secrets,
        );
      }
      return process.exit(0);
    } catch (e) {
      if (e instanceof UsageError) return usage(e.message, e.hint);
      if (e instanceof FsRefusal) return usage(e.message);
      throw e;
    }
  }

  if (sub === "regrade") {
    let p;
    try {
      p = parseArgs(
        rest,
        withCommandGlobals({
          booleans: [...HILLCLIMB_REGRADE_BOOLEAN_FLAGS],
          values: [...HILLCLIMB_REGRADE_VALUE_FLAGS],
          repeated: ["--case"],
          enums: { "--output-format": ["text", "json"] },
          noDashValue: ["--flow", "--variant", "--case", "--judge-model"],
        }),
      );
    } catch (e) {
      return usage((e as Error).message, HILLCLIMB_REGRADE_USAGE);
    }
    if (p.flags["--help"] === true) {
      writeAllSync(2, HILLCLIMB_REGRADE_USAGE + "\n");
      return process.exit(0);
    }
    applyParsedCommandGlobals(CMD, p, json);
    if (p.positionals.length !== 1) return usage(`hillclimb regrade takes exactly one scenario file or directory`, HILLCLIMB_REGRADE_USAGE);
    const out = await regradeFlow(
      {
        target: p.positionals[0],
        flow: p.options["--flow"] ?? HILLCLIMB_RUN_DEFAULTS.flow,
        variant: p.options["--variant"] ?? "all",
        cases: (p.repeated?.["--case"] as string[] | undefined) ?? [],
        ...(p.options["--judge-model"] !== undefined ? { judgeModel: p.options["--judge-model"] } : {}),
        fillRefs: p.flags["--fill-refs"] === true,
        approveHarness: p.flags["--approve-harness"] === true,
        allowDocDrift: p.flags["--allow-doc-drift"] === true,
        allowUnchecked: p.flags["--allow-unchecked"] === true,
      },
      {
        cwd: process.cwd(),
        env: process.env,
        secrets: [...secrets],
        stderr: (l) => err(l, secrets),
        isolationCheck: () => isolationRefusal(),
        // The metric columns `run` grades rows with: a rebuilt row keeps only declared keys.
        metricDecls: flowMetricUnion,
      },
    );
    const payload = { flow: p.options["--flow"] ?? HILLCLIMB_RUN_DEFAULTS.flow, variants: out.variants, exitCode: out.exitCode };
    if (out.error)
      return fail(
        `${CMD} regrade`,
        out.error.category,
        scrub(out.error.message, secrets),
        undefined,
        json,
        out.exitCode as 1 | 2,
        undefined,
        {
          payload,
        },
      );
    if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(`${CMD} regrade`, out.exitCode === 0, payload), secrets) + "\n");
    return process.exit(out.exitCode);
  }

  if (sub === "freeze-ref") {
    let p;
    try {
      p = parseArgs(
        rest,
        withCommandGlobals({
          booleans: [],
          values: ["--flow", "--variant", "--output-format"],
          repeated: ["--case"],
          enums: { "--output-format": ["text", "json"] },
          noDashValue: ["--flow", "--variant", "--case"],
        }),
      );
    } catch (e) {
      return usage((e as Error).message, HILLCLIMB_FREEZE_REF_USAGE);
    }
    if (p.flags["--help"] === true) {
      writeAllSync(2, HILLCLIMB_FREEZE_REF_USAGE + "\n");
      return process.exit(0);
    }
    applyParsedCommandGlobals(CMD, p, json);
    const variant = p.options["--variant"];
    if (p.positionals.length !== 1 || variant === undefined)
      return usage(`hillclimb freeze-ref takes one scenario file or directory and --variant`, HILLCLIMB_FREEZE_REF_USAGE);
    try {
      const r = freezeRefCommand({
        target: p.positionals[0],
        flowArg: normalizeRootArg(p.options["--flow"] ?? HILLCLIMB_RUN_DEFAULTS.flow),
        variant,
        caseIds: (p.repeated?.["--case"] as string[] | undefined) ?? [],
        cwd: process.cwd(),
        secrets: [...secrets],
      });
      if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(`${CMD} freeze-ref`, r.exitCode === 0, { ...r }), secrets) + "\n");
      else {
        for (const f of r.frozen) err(`froze ${f.case} from ${variant} rep ${f.rep}`, secrets);
        for (const f of r.added) err(`added compose key(s) to ${f.case} (from its recorded rep ${f.rep})`, secrets);
        for (const c of r.exists) err(`${c}: already frozen`, secrets);
        for (const f of r.refused) err(`refused ${f.case}: ${f.why}`, secrets);
      }
      return process.exit(r.exitCode);
    } catch (e) {
      if (e instanceof UsageError) return usage(e.message, e.hint);
      if (e instanceof FsRefusal) return usage(e.message);
      throw e;
    }
  }

  return usage(`unknown hillclimb subcommand: ${sub}`, HILLCLIMB_USAGE);
}
