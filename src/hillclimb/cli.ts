// `hillclimb` command family: `run`, `check`, `state-template`. The scenario runner comes from src/cli.ts (its
// per-scenario runner and decider channel live there); everything else is composed here.

import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "../cli-args.js";
import { UsageError } from "../errors.js";
import { writeAllSync } from "../io.js";
import { applyCommandGlobal, applyParsedCommandGlobals, withCommandGlobals } from "../run/command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "../run/envelope.js";
import { collectSecrets, scrub } from "../secrets.js";
import { isolationRefusal } from "../decide/llm-transport.js";
import { tokenCheck } from "../run/doctor.js";
import type { ScenarioRunner } from "../eval/job-runner.js";
import { HILLCLIMB_RUN_DEFAULTS, parseHillclimbRunArgs } from "./args.js";
import { isScenarioFile, loadCases } from "./cases.js";
import {
  assertSigWarnings,
  headroom,
  metricRangeWarnings,
  pairwiseHints,
  pairwiseRefFindings,
  staleAssertSigWarnings,
  stateMetricFindings,
} from "./check.js";
import { prepareCases } from "./command.js";
import { hashedPaths } from "./gate.js";
import { FsRefusal, NoFollowRoot, lexists, normalizeRootArg } from "./fs.js";
import { redactDeep } from "./flow.js";
import { runHillclimbCommand } from "./run-command.js";
import { termSafe } from "./runner.js";
import { checkFlowDir, loadFlowSnapshot, type SchemaCheckReport } from "./schema-check.js";
import { otherModelShareNotes } from "./cost.js";
import { trackedSkill } from "./skill.js";
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
import { flowMetricUnion, rowAssertSigs } from "./metric-keys.js";
import { pathSafeId } from "./ids.js";
import { parseScenarioFile } from "../run/execute.js";
import type { Scenario } from "../types.js";
import type { FlowSnapshot } from "./schema-check.js";

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

/** The scenarios `check` compares the rows' `meta.assert_sig` with, and the positional each case's remedy names.
 *
 *  With a target, its cases; a flow case it holds no scenario for is named in a note. Without one, the scenario files
 *  the flow's `_state.json` records: `harness_files` (each approval's record of what it hashed), else `harness_paths`
 *  (as state-template writes them). Both are cwd-relative and mix scenarios with session files, uploads and fixtures:
 *  a recorded file is a case's scenario when it is a scenario as a directory load decides it (`isScenarioFile`) and
 *  its stem's id is the case's. The rows themselves record only the scenario's name, never its file. A recorded file
 *  not found from this directory, or one that does not parse, is named in a note and its case left uncompared; with
 *  nothing recorded, one note says to pass the target. Only rows that record an assert_sig are compared.
 *
 *  A remedy's `regrade` positional must hash the scenario set the flow was approved over, or the gate refuses it: the
 *  recorded scenarios' one directory when it loads exactly them, else the case's own file, else its directory, each
 *  only when it reproduces that set (scenarios `harness_paths` lists are hashed whatever the positional); none ⇒ the
 *  placeholder. */
function assertSigScenarios(
  snap: FlowSnapshot,
  cwd: string,
  flowShown: string,
  target: string | undefined,
): { target?: string; targetOf: (id: string) => string | undefined; cases: Array<{ id: string; scenario: Scenario }>; notes: string[] } {
  const ids = [...new Set(rowAssertSigs(snap).map((r) => r.promptId))];
  if (target !== undefined) {
    const cases = loadCases(resolve(cwd, target)).cases;
    const held = new Set(cases.map((c) => c.id));
    const notes = ids
      .filter((id) => !held.has(id))
      .map(
        (id) =>
          `note: the target ${target} has no scenario for case ${id}, so its rows were not compared with a current assertion set — pass the target that holds it: \`hillclimb check <scenario.yaml | dir/> --flow ${flowShown}\``,
      );
    return { target, targetOf: () => target, cases, notes };
  }
  if (!ids.length) return { targetOf: () => undefined, cases: [], notes: [] };
  const pass = `pass the target (\`hillclimb check <scenario.yaml | dir/> --flow ${flowShown}\`)`;
  let yaml: string[] = [];
  let listed: string[] = [];
  /** Every `harness_paths` entry as written, and the path keys of `harness_files` (`undefined` when it is absent). */
  let listedAll: string[] = [];
  let hashedKeys: Set<string> | undefined;
  let key = "harness_paths";
  try {
    const st = JSON.parse(snap.state ?? "{}") as Record<string, unknown>;
    const yamlOf = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && /\.ya?ml$/i.test(p)) : []);
    const files = st?.harness_files;
    listed = yamlOf(st?.harness_paths);
    listedAll = Array.isArray(st?.harness_paths) ? st.harness_paths.map(String) : [];
    if (files && typeof files === "object" && !Array.isArray(files))
      // Its `<…>` virtual entries and `skill:` tags are not paths.
      hashedKeys = new Set(Object.keys(files).filter((k) => !/^<.*>$/.test(k) && !k.startsWith("skill:")));
    yaml = yamlOf(files && typeof files === "object" && !Array.isArray(files) ? Object.keys(files) : undefined);
    if (yaml.length) key = "harness_files";
    else yaml = listed;
  } catch {
    // An unreadable _state.json is check's finding: nothing is recorded.
  }
  if (!yaml.length)
    return {
      targetOf: () => undefined,
      cases: [],
      notes: [
        `note: _state.json records no scenario files (harness_files, harness_paths), so the rows' assertion sets were not compared with the scenarios' current ones — pass the target: \`hillclimb check <scenario.yaml | dir/> --flow ${flowShown}\``,
      ],
    };
  const found = (p: string) => existsSync(resolve(cwd, p));
  const scenarios = yaml.filter((p) => found(p) && isScenarioFile(resolve(cwd, p)));
  const unfound = yaml.filter((p) => !found(p));
  const idOf = (p: string) => pathSafeId(basename(p).replace(/\.ya?ml$/i, ""));
  const cases: Array<{ id: string; scenario: Scenario }> = [];
  const fileOf = new Map<string, string>();
  const notes: string[] = [];
  const compare = (id: string) => `to compare case ${id}'s rows with its current assertion set`;
  for (const id of ids) {
    const mine = scenarios.filter((p) => idOf(p) === id);
    const gone = unfound.filter((p) => idOf(p) === id);
    let why: string | undefined;
    if (mine.length > 1) why = `_state.json ${key} records ${mine.length} scenario files for case ${id} (${mine.join(", ")}) — ${pass}`;
    else if (mine.length === 0 && gone.length)
      why = `the flow's recorded scenario ${gone.join(", ")} (_state.json ${key}) was not found relative to the current directory (${cwd}) — run check from the directory the flow was approved in, or ${pass}`;
    else if (mine.length === 0) why = `_state.json ${key} records no scenario file for case ${id} — ${pass}`;
    if (why !== undefined) {
      notes.push(`note: ${why} ${compare(id)}`);
      continue;
    }
    try {
      cases.push({ id, scenario: parseScenarioFile(resolve(cwd, mine[0]!)) });
      fileOf.set(id, mine[0]!);
    } catch (e) {
      notes.push(
        `note: the flow's recorded scenario ${mine[0]} (_state.json ${key}) cannot be read (${(e as Error).message}) — ${pass} ${compare(id)}`,
      );
    }
  }
  // Whether `regrade <t>` would hash what the flow was approved over, so the gate lets it through. With the
  // approval's record (`harness_files`): exactly its paths — every path regrade's digest would read for the cases
  // `<t>` loads (their scenarios, session files, uploads and fixtures), the lockfiles and the `harness_paths`
  // entries. Without it: the scenario set — every scenario `<t>` loads was recorded, and every recorded one it does
  // not load is hashed anyway (a `harness_paths` entry).
  const recorded = new Set(scenarios);
  const always = new Set(listed);
  const loads = new Map<string, { files: string[]; hashed?: Set<string> } | undefined>();
  const loaded = (t: string) => {
    if (!loads.has(t))
      try {
        const cs = loadCases(resolve(cwd, t)).cases;
        const files = cs.map((c) => relative(cwd, resolve(c.file)));
        const hashed =
          hashedKeys === undefined
            ? undefined
            : new Set(
                hashedPaths({ cwd, listed: listedAll, derived: prepareCases(cs, { env: process.env, noAgentRun: true }).derivedPaths(cs) }),
              );
        loads.set(t, { files, ...(hashed ? { hashed } : {}) });
      } catch {
        loads.set(t, undefined);
      }
    return loads.get(t);
  };
  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  const reproduces = (t: string, id: string) => {
    const got = loaded(t);
    if (got === undefined || !got.files.some((p) => idOf(p) === id)) return false;
    if (hashedKeys !== undefined) return got.hashed !== undefined && sameSet(got.hashed, hashedKeys);
    return got.files.every((p) => recorded.has(p)) && [...recorded].every((p) => got.files.includes(p) || always.has(p));
  };
  const dirs = [...new Set(scenarios.map((p) => dirname(p)))];
  const targetOf = (id: string): string | undefined => {
    const file = fileOf.get(id);
    const candidates = [...(dirs.length === 1 ? dirs : []), ...(file !== undefined ? [file, dirname(file)] : [])];
    return candidates.find((t) => reproduces(t, id));
  };
  const all = [...new Set(cases.map((c) => targetOf(c.id)))];
  return { ...(all.length === 1 && all[0] !== undefined ? { target: all[0] } : {}), targetOf, cases, notes };
}

/** `hillclimb check`: our schema reading (harness profile) plus `_state.json`'s metric rule; headroom, a float outside
 *  its declared range and rows graded under another assertion set than the scenario's now (`target`, else the
 *  scenario files `_state.json` records) only warn. */
export function checkReport(
  flowArg: string,
  cwd: string,
  target?: string,
): { report: SchemaCheckReport; warnings: string[]; exitCode: 0 | 1 } {
  const flowAbs = resolve(cwd, normalizeRootArg(flowArg));
  if (!lexists(flowAbs)) throw new UsageError(`no flow dir at ${flowArg}`);
  const base = checkFlowDir(flowAbs, { profile: "harness" });
  const snap = loadFlowSnapshot(flowAbs);
  const extra = [...stateMetricFindings(snap), ...pairwiseRefFindings(snap)];
  const report = { ...base, findings: [...base.findings, ...extra], errors: base.errors + extra.length };
  const flowShown = normalizeRootArg(flowArg);
  const sig = assertSigScenarios(snap, cwd, flowShown, target);
  return {
    report,
    warnings: [
      ...headroom(snap, sig.cases).warnings,
      ...metricRangeWarnings(snap),
      ...assertSigWarnings(snap, flowShown, sig.targetOf),
      ...staleAssertSigWarnings(snap, sig.cases, flowShown, sig.targetOf),
      ...sig.notes,
      ...pairwiseHints(snap, flowShown, sig.target),
      ...otherModelShareNotes(snap),
    ],
    exitCode: report.errors ? 1 : 0,
  };
}

/** `hillclimb state-template`: the skeleton for the flow's cases, with the gate's files relative to cwd. The tracked
 *  skill is resolved against the live plugin's git-tracked files with run's resolution — the files a pass would
 *  snapshot — and an unknown `skill` (`--skill`) is refused as run would refuse it. When run would omit the
 *  skill_invoked column (several skills and no --skill, or none), `perf_fields` leaves it out too, and a note says
 *  why; `harness_skill` is the runner's to write. With `flow` (`--flow`), each later variant's frozen pairwise
 *  reference is declared. */
export function stateTemplateFor(
  target: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: { skill?: string; flow?: string } = {},
): StateTemplate {
  const { cases } = loadCases(resolve(cwd, target));
  const prep = prepareCases(cases, { env });
  let tracked: ReturnType<typeof trackedSkill>;
  try {
    tracked = trackedSkill(prep.lever, opts.skill);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const assertions = cases.map((c) => ({ assertions: c.scenario.assert ?? [] }));
  // With --flow: each later variant's frozen reference, and how many scored rows (every variant) lack its column.
  // Each lacking row's variant and case are carried, so the note can say which rows they are and how to fill them.
  let pairwiseRefs: Array<{ ref: string; rowsMissing: number; missing: Array<{ variant: string; caseId: string }> }> | undefined;
  if (opts.flow !== undefined && flowHasPairwise(assertions)) {
    const flowAbs = resolve(cwd, normalizeRootArg(opts.flow));
    pairwiseRefs = [];
    if (lexists(flowAbs)) {
      const snap = loadFlowSnapshot(flowAbs);
      const rows = Object.entries(snap.variants).flatMap(([variant, vs]) =>
        (vs.results ?? "").split("\n").flatMap((l) => {
          try {
            const r = l.trim() ? (JSON.parse(l) as { prompt_id?: unknown; grade?: Record<string, unknown> }) : undefined;
            return r ? [{ variant, caseId: String(r.prompt_id), grade: r.grade }] : [];
          } catch {
            return [];
          }
        }),
      );
      for (const ref of metricRefNames(discoverFlowRefs(flowAbs))) {
        const missing = rows
          .filter((r) => r.grade?.[`win_${ref}_present`] === undefined)
          .map(({ variant, caseId }) => ({ variant, caseId }));
        pairwiseRefs.push({ ref, rowsMissing: missing.length, missing });
      }
    }
  }
  const t = stateTemplate({
    cases: cases.map((c) => ({ name: c.id, assertions: c.scenario.assert ?? [], metrics: c.scenario.metrics })),
    harnessPaths: prep.derivedPaths(cases).map((p) => relative(cwd, p)),
    decider: false,
    ...(pairwiseRefs ? { pairwiseRefs, target } : {}),
    skillInvoked: tracked.name !== undefined,
  });
  // With --flow: a float the flow's _state.json still declares that no scenario declares any more. Only here are both
  // the scenarios and the flow at hand (`check` reads no scenario's metrics), so this is where a removal's leftover is named.
  if (opts.flow !== undefined) {
    const flowAbs = resolve(cwd, normalizeRootArg(opts.flow));
    if (lexists(flowAbs)) {
      const now = new Set(t.state.metrics.map((m) => m.id));
      let declared: unknown[] = [];
      try {
        const st = JSON.parse(loadFlowSnapshot(flowAbs).state ?? "{}");
        if (Array.isArray(st?.metrics)) declared = st.metrics;
      } catch {
        // An unreadable _state.json is `check`'s finding, not this note's.
      }
      for (const m of declared) {
        if (!m || typeof m !== "object") continue;
        const { id, kind } = m as { id?: unknown; kind?: unknown };
        if (kind === "float" && typeof id === "string" && !now.has(id))
          t.notes.push(
            `no scenario declares metric ${id} any more; remove its entries (${id} and ${id}_present) from _state.json's metrics`,
          );
      }
    }
  }
  return tracked.name === undefined ? { ...t, notes: [...t.notes, tracked.note] } : t;
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
        tokenCheck: (tier) => tokenCheck(tier),
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
        withCommandGlobals({
          booleans: [],
          values: sub === "check" ? ["--flow", "--output-format"] : ["--flow", "--skill", "--output-format"],
          enums: { "--output-format": ["text", "json"] },
        }),
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
        if (p.positionals.length > 1) return usage(`hillclimb check takes at most one scenario file or directory`, HILLCLIMB_CHECK_USAGE);
        const c = checkReport(flow, process.cwd(), p.positionals[0]);
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
      const skillOpt = p.options["--skill"];
      const t = stateTemplateFor(p.positionals[0], process.cwd(), process.env, {
        ...(skillOpt !== undefined ? { skill: skillOpt } : {}),
        ...(flowGiven !== undefined ? { flow: flowGiven } : {}),
      });
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
          `save this as ${flow}/_state.json; on a re-run, merge by adding NEW metrics entries only (the loop owns the rest), and remove the entries (<id> and <id>_present) of a metric no scenario declares any more.` +
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
    if (p.flags["--rejudge"] === true && p.flags["--fill-refs"] === true)
      return usage(`hillclimb regrade: --rejudge and --fill-refs exclude each other (a fill re-judges nothing)`, HILLCLIMB_REGRADE_USAGE);
    const out = await regradeFlow(
      {
        target: p.positionals[0],
        flow: p.options["--flow"] ?? HILLCLIMB_RUN_DEFAULTS.flow,
        variant: p.options["--variant"] ?? "all",
        cases: (p.repeated?.["--case"] as string[] | undefined) ?? [],
        ...(p.options["--judge-model"] !== undefined ? { judgeModel: p.options["--judge-model"] } : {}),
        fillRefs: p.flags["--fill-refs"] === true,
        rejudge: p.flags["--rejudge"] === true,
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
    // A refusal's text already went to stderr through `stderr` above, so only JSON output prints it again.
    if (json && out.error)
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
