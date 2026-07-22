import { warn } from "../io.js";
import type { RunResult } from "../types.js";
import { VERDICT_MODIFIER_KEYS } from "../types.js";

export interface VerdictSignal {
  code:
    | "assertion"
    | "result_error"
    | "transport_error"
    | "usage_limit"
    | "permissive_auto_allow"
    | "outputs_delete"
    | "host_path_leak"
    | "non_deterministic"
    | "l0_plugin_divergence"
    | "missing_capability"
    | "infra_error"
    | "exec_infra_error"
    | "stalled"
    | "prompt_asset_missing"
    | "scan_unavailable"
    | "ended_with_question";
  severity: "fail" | "warn";
  message: string;
}
/** a guard's visibility status this run. `ok` = ran and found nothing; `fired` = caught its failure
 *  mode; `na` = not applicable on this lane/tier; `unverified` = ran but couldn't conclude. NEVER `ok` for a
 *  guard that didn't run — a false ✓ would be its own silent-false-green. */
export type GuardStatus = "ok" | "fired" | "na" | "unverified";
export interface GuardReport {
  name: string;
  status: GuardStatus;
}
export interface Verdict {
  pass: boolean;
  exitCode: 0 | 1;
  signals: VerdictSignal[];
  guards: GuardReport[];
  /** The SAME `failures[]` projection formerly built by the now-removed `persistedVerdict` wrapper,
   *  computed inline here so there is exactly ONE verdict shape everywhere (result.json AND the
   *  `--output-format json` stdout envelope both carry this `Verdict`, never a second flatter shape):
   *  - a failure that traces to a specific failing assert carries its key — `Object.keys(a.assertion)`,
   *    the same convention `verify-run`'s text output (cli.ts) and the cassette replay-drift summary use
   *    — alongside its message. Reads `result.assertions` directly (not `signals`) because a
   *    `VerdictSignal` of code `"assertion"` doesn't itself carry which assertion failed.
   *  - a hard-verdict GUARD reason that failed the run independent of an explicit assert (infra error,
   *    scan-based host-path leak/outputs-delete, a stalled/transport/usage-limit/capability signal, …)
   *    carries just its message, no `assertion` key.
   *  - an unanswered-gate salvage (`result.unansweredGate` set) is special-cased: the generic
   *    `result_error`/`transport_error` signal for it would read as "run result was error" with no
   *    reason. Substitute the gate's own message (the decider's failure text, question embedded) so a
   *    salvaged run's `failures` actually names the gate reason instead of the generic placeholder.
   *  Empty on a pass. */
  failures: Array<{ assertion?: string; message: string }>;
}

/** build the "guards active this run" roster from the guards' INPUT PRECONDITIONS (lane + probe
 *  outcome), not from the signal list — a guard that ran clean pushes no signal, so absence is ambiguous. */
function guardRoster(result: RunResult, lane: "live" | "replay", signals: VerdictSignal[]): GuardReport[] {
  const fired = (code: VerdictSignal["code"]) => signals.some((s) => s.code === code);
  const live = lane === "live";
  const roster: GuardReport[] = [];

  // capability-use: live built-image tiers, only when the probe ran definitively.
  let cap: GuardStatus;
  if (!live || result.capabilityProbe === undefined || result.capabilityProbe === "skipped") cap = "na";
  else if (result.capabilityProbe === "unverified") cap = "unverified";
  else cap = fired("missing_capability") ? "fired" : "ok";
  roster.push({ name: "capability-use", status: cap });

  // fail-when-silent scan guards run on the live lane only; a cassette can't reproduce them.
  // scan-backed guards: absent scan evidence means the guard did NOT run — never ✓ for a guard
  // that didn't run. `unverified` is the roster's existing vocabulary for exactly this.
  const scanStatus = (code: VerdictSignal["code"]): GuardStatus =>
    !live ? "na" : result.scan === undefined ? "unverified" : fired(code) ? "fired" : "ok";
  roster.push({ name: "permissive-auto-allow", status: !live ? "na" : fired("permissive_auto_allow") ? "fired" : "ok" });
  roster.push({ name: "host-path", status: scanStatus("host_path_leak") });
  roster.push({ name: "outputs-delete", status: scanStatus("outputs_delete") });
  return roster;
}

/**
 * THE single source of a scenario's pass/fail + process exit code. Every verdict site
 * (the `run`/`skill` exit, the footer ✓/✗, the `replay` exit, and the JSON envelope `ok`) routes
 * through this so they can never diverge.
 *
 * Beyond failed assertions and a hard `result:"error"`, the harness must never green a run whose
 * declared isolation guarantees were not actually met:
 *   - a cowork-parity permissive auto-allow real Cowork would BLOCK (fail unless the scenario opts in
 *     via `allow_permissive_auto_allow`),
 *   - a recorded unauthorized delete in mnt/outputs, or a host-path leak — UNLESS the scenario already
 *     authored the matching assertion (`no_delete_in_outputs` / `transcript_no_host_path`), in which
 *     case that assertion owns the verdict and we don't double-count.
 *
 * These "fail-when-silent" signals are LIVE-only: a cassette structurally cannot reproduce them
 * (replay zeroes the scan signals and never re-runs the filesystem), so the `replay` lane evaluates
 * assertions + `result` only. Non-determinism is always a WARN, never a fail — live-lane / LLM /
 * external runs are legitimately non-reproducible and hard-failing them would break a supported mode.
 * There is intentionally NO interactive-human carve-out: `permissiveAutoAllow` is recorded only on the
 * automated `by:"cowork"` path, which a human/llm/external answer never triggers.
 *
 * The opt-in / authored-key checks read the ORIGINAL assertions off `result.assertions[].assertion`,
 * so no separate scenario object is threaded in.
 */
export function computeVerdict(result: RunResult, lane: "live" | "replay"): Verdict {
  const signals: VerdictSignal[] = [];

  for (const a of result.assertions)
    if (!a.pass) signals.push({ code: "assertion", severity: "fail", message: a.message ?? "assertion failed" });
  if (result.result === "error") {
    // a tail-end TRANSPORT drop (connection closed after a clean result) is still a fail — a run whose
    // stream didn't cleanly complete is not a faithful green — but distinguish it from a skill failure so the
    // footer doesn't read as a skill defect. Message is assertion-count-aware (no false comfort on an
    // unasserted run) and lane-aware (replay/verify-run write no artifacts, so don't claim they were).
    if (result.resultErrorKind === "usage_limit") {
      // Quota exhausted (429 + terminal usage-limit text) — NOT a skill defect. Still a fail (the run didn't
      // complete), but flagged distinctly so a batch halts fast instead of retrying into a spent quota.
      signals.push({
        code: "usage_limit",
        severity: "fail",
        message: "usage/quota limit hit (not a skill failure) — retry after the limit resets",
      });
    } else if (result.resultErrorKind === "transport") {
      const allPass = result.assertions.every((a) => a.pass);
      const msg =
        result.assertions.length === 0
          ? "transport dropped; NO assertions were defined, so success could not be verified — likely a flaky connection, retry"
          : !allPass
            ? "transport dropped after a successful result, but an assertion also failed — treat as a real failure"
            : lane === "replay"
              ? "transport dropped after a successful result; assertions re-checked on replay — likely a flaky connection, retry"
              : "transport dropped after a successful result; assertions passed and artifacts were written — likely a flaky connection, retry";
      signals.push({ code: "transport_error", severity: "fail", message: msg });
    } else {
      signals.push({ code: "result_error", severity: "fail", message: "run result was error" });
    }
  }

  // a declared requires_capabilities the running tier couldn't satisfy is a hard fail on BOTH lanes —
  // the field is run-time truth persisted to result.json, so verify-run/replay honor it (a clean full-parity
  // run records nothing here, so this never false-fails a later verify-run). Opt out with allow_missing_capability.
  if (result.requiresCapabilityUnmet?.caps.length && !result.assertions.some((a) => a.assertion.allow_missing_capability === true)) {
    const { caps, reason } = result.requiresCapabilityUnmet;
    signals.push({
      code: "missing_capability",
      severity: "fail",
      message:
        reason === "unknown"
          ? `requires_capabilities lists unknown capability famil(ies): ${caps.join(", ")} — likely a typo (an unknown family can never be verified present, so it hard-fails rather than silently passing). Use a known family or fix the spelling.`
          : reason === "omitted"
            ? `the running image omits declared required capabilit(ies): ${caps.join(", ")} — rebuild full parity (--build-arg COWORK_FULL_PARITY=1), or assert allow_missing_capability: true if the fallback is equivalent.`
            : `skill declares requires_capabilities [${caps.join(", ")}] but this tier could not verify them — run on a live built-image tier, or assert allow_missing_capability: true.`,
    });
  }

  // an infrastructure crash (VM/egress sidecar) is a hard fail on BOTH lanes and is NOT author-suppressible
  // (like a transport error — the run's evidence is contaminated, so "pass anyway" is never a valid choice).
  // Re-derived on the replay drive from the frozen infra_error events, so a recorded crash fails replay too.
  // Split by ORIGIN: a dead supervisor contaminates the whole run, a single failed `docker exec` does not.
  // Collapsing both into one fatal class meant one slow or unlucky command red-ed an otherwise sound run.
  // NOTE a residual gap this split does not close: if EVERY exec failed, the agent ran nothing and the
  // evidence is worthless, yet the run still only warns. Escalating that needs a successful-exec count,
  // which is not observable on the replay lane without freezing it into the cassette — deliberately left
  // for a follow-up rather than shipped as a rule that silently disagrees between lanes.
  const fatalInfra = (result.infraErrors ?? []).filter((e) => e.source !== "hostloop-exec");
  const execInfra = (result.infraErrors ?? []).filter((e) => e.source === "hostloop-exec");
  if (fatalInfra.length > 0) {
    signals.push({
      code: "infra_error",
      severity: "fail",
      message: `infrastructure error(s) during the run (evidence contaminated): ${fatalInfra.map((e) => e.message).join("; ")}`,
    });
  }
  if (execInfra.length > 0) {
    signals.push({
      code: "exec_infra_error",
      severity: "warn",
      message: `tool-call infrastructure error(s) — the affected command(s) failed, the run's evidence is otherwise intact: ${execInfra.map((e) => e.message).join("; ")}`,
    });
  }

  // a run that ended on an unanswered plain-text question is a hard fail on BOTH lanes (the flag is
  // re-derived by run.ts's detector on the live run AND the replay re-drive, so a recorded stall fails replay
  // too). `result:"success"` alone is too generous — the SDK turn didn't error, but the agent asked for input
  // and stopped, so the task did not complete. Opt out with allow_stall when ending on a question is intended.
  if (result.stalledOnQuestion && !result.assertions.some((a) => a.assertion.allow_stall === true)) {
    signals.push({
      code: "stalled",
      severity: "fail",
      message:
        "run ended on an unanswered question — the agent asked for input and stopped; the task did not complete. " +
        "Script the answer (answer: / --answer / a decider), or assert allow_stall: true if ending on a question is intended.",
    });
  }

  if (lane === "live") {
    const authored = result.assertions.map((a) => a.assertion);
    const optInPermissive = authored.some((a) => a.allow_permissive_auto_allow === true);
    if (result.permissiveAutoAllow?.length && !optInPermissive)
      signals.push({
        code: "permissive_auto_allow",
        severity: "fail",
        message:
          `cowork parity auto-allowed off-registry tool(s) real Cowork would BLOCK: ${result.permissiveAutoAllow.join(", ")} — ` +
          "not a faithful pass. Pin with --answer / permission_parity: strict, or assert allow_permissive_auto_allow: true.",
      });

    // Capability fidelity: the (partial 'core') agent image omits a capability real Cowork ships, and the
    // skill was observed USING it on an otherwise-green run → a likely FALSE NEGATIVE. Fail unless the
    // scenario opts in via `allow_missing_capability: true` (the skill's fallback is genuinely equivalent).
    // Mirrors permissive_auto_allow / l0_plugin_divergence — a warn-only would let the silent-green slip.
    if (result.missingCapabilityUse?.length && !authored.some((a) => a.allow_missing_capability === true))
      signals.push({
        code: "missing_capability",
        severity: "fail",
        message:
          `the agent image omits capabilit(ies) the skill used: ${result.missingCapabilityUse.join(", ")} — ` +
          "likely a FALSE NEGATIVE (real Cowork ships them). Rebuild full parity (--build-arg COWORK_FULL_PARITY=1); " +
          "or assert allow_missing_capability: true if the fallback is equivalent.",
      });

    // (live, heuristic) the agent's final answer contains a question and the run produced no deliverable — a
    // likely conversational dead-end that still exited result:"success". WARN, never fail. Strictly weaker
    // sibling of `stalled` (run.ts's strict trailing-`?`/no-tools detector); mutually exclusive by construction.
    const openEnded = !result.assertions.some((a) =>
      Object.entries(a.assertion).some(
        ([k, v]) => v !== undefined && k !== "result" && !(VERDICT_MODIFIER_KEYS as readonly string[]).includes(k),
      ),
    );
    if (
      result.result === "success" &&
      !result.stalledOnQuestion &&
      !result.assertions.some((a) => a.assertion.allow_stall === true) &&
      openEnded &&
      result.workspaceFiles !== undefined && // evidence observed (not the #52 rootAbsent/undefined case)
      !result.workspaceFiles.some((f) => f.class === "output") && // no DELIVERABLE under mnt/outputs
      /\?(?![\w=&/#])/.test(result.finalMessage ?? "") // a '?' not followed by a URL-query/path char
    )
      signals.push({
        code: "ended_with_question",
        severity: "warn",
        message:
          "the final answer contains a question and the run wrote no deliverable to outputs/ — the agent may have ended on a request for input instead of a deliverable. " +
          "Script the answer (answer:/--answer/a decider) or steer --decider-llm --intent; assert allow_stall: true if ending on a question is intended.",
      });

    // absent scan evidence means host-path/outputs-delete did NOT run — a silent ✓ there would be its own
    // false-green. Warn, not fail: matches the capability-probe `unverified` precedent, and a hard-fail would
    // fail every verify-run over a pre-scan-era result.json. An authored scan assertion still hard-fails via
    // scanMissing regardless of this signal.
    if (result.scan === undefined)
      signals.push({
        code: "scan_unavailable",
        severity: "warn",
        message:
          "post-run scan evidence unavailable (events.jsonl missing or corrupt) — the host-path and " +
          "outputs-delete guards did not run; assert no_delete_in_outputs/transcript_no_host_path to hard-fail on this",
      });

    if (result.scan?.outputsDeletes.length && !authored.some((a) => a.no_delete_in_outputs !== undefined))
      signals.push({
        code: "outputs_delete",
        severity: "fail",
        message: `unauthorized delete touched mnt/outputs: ${result.scan.outputsDeletes.join("; ")} (assert no_delete_in_outputs to make this explicit)`,
      });

    // hostloop AND protocol (L0) run the agent's native file tools on the REAL host cwd — neither
    // seals the filesystem — so a run at either fidelity is EXPECTED to see /Users/... paths; the scan
    // is not evidence of a leak there the way it is for the sandboxed container/microvm tiers (which
    // seal the FS and show the model /sessions/... paths). Gate the default-fail on the tier; the raw
    // scan result stays recorded in result.json either way (forensics), and an explicit
    // `transcript_no_host_path` assertion still enforces cleanliness at ANY tier via assert.ts.
    if (result.scan?.hostPathLeaked && (result.effectiveFidelity === "hostloop" || result.effectiveFidelity === "protocol")) {
      warn(
        `::notice:: [verdict] host_path_leak signal skipped at ${result.effectiveFidelity} fidelity — the agent runs on real host paths there, so they are expected (see docs/boundary.md)\n`,
      );
    } else if (result.scan?.hostPathLeaked && !authored.some((a) => a.transcript_no_host_path === true))
      signals.push({
        code: "host_path_leak",
        severity: "fail",
        message: "a host path leaked into model-visible text (assert transcript_no_host_path to make this explicit)",
      });

    // L0 (protocol) with plugins diverges from Cowork's --plugin-dir cache layout — fail unless the
    // scenario explicitly opts in via `allow_l0_plugin_divergence: true`. A warn-only let runs appear green
    // even though plugin loading behavior may differ from production Cowork.
    if (result.l0PluginDivergence && !authored.some((a) => a.allow_l0_plugin_divergence === true))
      signals.push({
        code: "l0_plugin_divergence",
        severity: "fail",
        message:
          "L0 (protocol) ran with plugins that load via --settings/managed config, not --plugin-dir (Cowork cache layout) — " +
          "not a faithful pass for plugin fidelity. Use container/microvm, or assert allow_l0_plugin_divergence: true to opt in.",
      });
  }

  if (result.nonDeterministic)
    signals.push({
      code: "non_deterministic",
      severity: "warn",
      message: "non-deterministic (LLM/external/human-decided) — a green run is NOT reproducible",
    });

  if (result.fidelityWarnings?.some((w) => w.includes("referenced asset not found")))
    signals.push({
      code: "prompt_asset_missing",
      severity: "warn",
      message:
        "run proceeded with a missing prompt asset (COWORK_HARNESS_ALLOW_MISSING_PROMPT=1) — " +
        "Cowork framing may be incomplete (fidelity gap)",
    });

  const pass = !signals.some((s) => s.severity === "fail");

  // `failures[]` — the flat, jq-friendly projection (see the field's doc comment on `Verdict` above).
  // Plain JSON in shape (no functions, and `assertion: undefined` — set only when no key was found — is
  // dropped by `JSON.stringify` like every other optional field on this type).
  const failures: Array<{ assertion?: string; message: string }> = [];

  for (const a of result.assertions) {
    if (a.pass) continue;
    const key = Object.keys(a.assertion).filter((k) => (a.assertion as Record<string, unknown>)[k] !== undefined)[0];
    failures.push(key ? { assertion: key, message: a.message ?? "assertion failed" } : { message: a.message ?? "assertion failed" });
  }

  for (const s of signals) {
    if (s.severity !== "fail" || s.code === "assertion") continue;
    // the gate's own message (pushed below) already names the reason — skip the content-free generic
    // result_error/transport_error signal emitted above for the same result:"error" so a salvaged run's
    // failures[] doesn't carry two entries for one root cause.
    if (result.unansweredGate && (s.code === "result_error" || s.code === "transport_error")) continue;
    failures.push({ message: s.message });
  }

  if (result.unansweredGate) failures.push({ message: result.unansweredGate.message });

  return { pass, exitCode: pass ? 0 : 1, signals, guards: guardRoster(result, lane, signals), failures };
}
