// `hillclimb` command family: `run`, `check`, `state-template`. The scenario runner comes from src/cli.ts (its
// per-scenario runner and decider channel live there); everything else is composed here.

import { relative, resolve } from "node:path";
import { parseArgs } from "../cli-args.js";
import { UsageError } from "../errors.js";
import { writeAllSync } from "../io.js";
import { applyCommandGlobal, applyParsedCommandGlobals, withCommandGlobals } from "../run/command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "../run/envelope.js";
import { collectSecrets, scrub } from "../secrets.js";
import type { ScenarioRunner } from "../eval/job-runner.js";
import { HILLCLIMB_RUN_DEFAULTS, parseHillclimbRunArgs } from "./args.js";
import { loadCases } from "./cases.js";
import { headroom, stateMetricFindings } from "./check.js";
import { prepareCases } from "./command.js";
import { lexists, normalizeRootArg } from "./fs.js";
import { defaultSnapshotRoot, runHillclimbCommand } from "./run-command.js";
import { termSafe } from "./runner.js";
import { checkFlowDir, loadFlowSnapshot, type SchemaCheckReport } from "./schema-check.js";
import { stateTemplate, type StateTemplate } from "./state-template.js";
import { HILLCLIMB_CHECK_USAGE, HILLCLIMB_STATE_TEMPLATE_USAGE, HILLCLIMB_USAGE } from "./usage.js";

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

/** `hillclimb check`: our schema reading (harness profile) plus `_state.json`'s metric rule; headroom only warns. */
export function checkReport(flowArg: string, cwd: string): { report: SchemaCheckReport; warnings: string[]; exitCode: 0 | 1 } {
  const flowAbs = resolve(cwd, normalizeRootArg(flowArg));
  if (!lexists(flowAbs)) throw new UsageError(`no flow dir at ${flowArg}`);
  const base = checkFlowDir(flowAbs, { profile: "harness" });
  const snap = loadFlowSnapshot(flowAbs);
  const extra = stateMetricFindings(snap);
  const report = { ...base, findings: [...base.findings, ...extra], errors: base.errors + extra.length };
  return { report, warnings: headroom(snap).warnings, exitCode: report.errors ? 1 : 0 };
}

/** `hillclimb state-template`: the skeleton for the flow's cases, with the gate's files relative to cwd. */
export function stateTemplateFor(target: string, cwd: string, env: NodeJS.ProcessEnv): StateTemplate {
  const { cases } = loadCases(resolve(cwd, target));
  const prep = prepareCases(cases, { env });
  return stateTemplate({
    cases: cases.map((c) => ({ assertions: c.scenario.assert ?? [] })),
    harnessPaths: prep.derivedPaths(cases).map((p) => relative(cwd, p)),
    decider: false,
  });
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
      return usage((e as Error).message);
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
        snapshotRoot: defaultSnapshotRoot(),
        secrets,
        // Through process.stderr.write, so the terminal scrub applies to model-influenced text.
        stderr: (line) => err(line, secrets),
        flags: r.flags,
        runScenario: r.runScenario,
      });
    } finally {
      r.close();
    }
    if (json)
      writeAllSync(
        1,
        scrub(
          jsonPayloadEnvelope(`${CMD} run`, outcome.exitCode === 0, {
            flow: a.flow,
            variant: a.variant,
            scheduled: outcome.scheduled,
            ok: outcome.ok,
            failed: outcome.failed,
            exitCode: outcome.exitCode,
          }),
          secrets,
        ) + "\n",
      );
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
    const flow = p.options["--flow"] ?? HILLCLIMB_RUN_DEFAULTS.flow;
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
      const t = stateTemplateFor(p.positionals[0], process.cwd(), process.env);
      if (json)
        writeAllSync(
          1,
          scrub(jsonPayloadEnvelope(`${CMD} state-template`, true, { state: t.state, metrics_md: t.metricsMd }), secrets) + "\n",
        );
      else {
        writeAllSync(1, JSON.stringify(t.state, null, 2) + "\n");
        err(
          `save this as ${flow}/_state.json; on a re-run, merge by adding NEW metrics entries only (the loop owns the rest). The metrics legend is in --output-format json (metrics_md).`,
          secrets,
        );
      }
      return process.exit(0);
    } catch (e) {
      if (e instanceof UsageError) return usage(e.message, e.hint);
      throw e;
    }
  }

  return usage(`unknown hillclimb subcommand: ${sub}`, HILLCLIMB_USAGE);
}
