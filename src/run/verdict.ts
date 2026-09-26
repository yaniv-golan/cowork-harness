import { warn } from "../io.js";
import { rootfsManifestDesktopVersion } from "../baseline.js";
import type { RunResult } from "../types.js";
import { VERDICT_MODIFIER_KEYS } from "../types.js";
import { outputsDeleteTier, outputsDeleteEntries, outputsDiffUnverified } from "./outputs-delete-tier.js";

export interface VerdictSignal {
  code:
    | "assertion"
    | "result_error"
    | "transport_error"
    | "usage_limit"
    | "permissive_auto_allow"
    | "outputs_delete"
    | "outputs_delete_unconfirmed"
    | "outputs_diff_unavailable"
    | "mount_delete"
    | "host_path_leak"
    | "non_deterministic"
    | "model_fallback"
    | "l0_host_config_contamination"
    | "missing_capability"
    | "infra_error"
    | "exec_infra_error"
    | "stalled"
    | "prompt_asset_missing"
    | "scan_unavailable"
    | "ended_with_question"
    | "undelivered_deliverables"
    | "delivery_unobservable";
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
   *  - EVERY entry carries `kind`, which is the actual discriminator. Keying off `assertion`'s presence
   *    was never sufficient and is now demonstrably wrong: guard, staleness and cassette-format failures
   *    all arrived key-less and indistinguishable from each other, while verify-run's answer-coverage
   *    misses inject a non-Assertion `answer_coverage` key and therefore READ as an authored assert.
   *    Filter on `kind`, not on whether `assertion` is set.
   *  - a hard-verdict GUARD reason that failed the run independent of an explicit assert (infra error,
   *    scan-based host-path leak/outputs-delete, a stalled/transport/usage-limit/capability signal, …)
   *    carries just its message, no `assertion` key.
   *  - an unanswered-gate salvage (`result.unansweredGate` set) is special-cased: the generic
   *    `result_error`/`transport_error` signal for it would read as "run result was error" with no
   *    reason. Substitute the gate's own message (the decider's failure text, question embedded) so a
   *    salvaged run's `failures` actually names the gate reason instead of the generic placeholder.
   *  Empty on a pass. */
  failures: Array<{ assertion?: string; message: string; kind: FailureKind }>;
}

/** What produced a `failures[]` entry. `assertion` = one of the author's own `assert:` items;
 *  `guard` = a hard-verdict signal they did not write (infra error, stall, host-path leak, unanswered
 *  gate, …); `staleness` = skill/baseline drift escalated to a failure by `--strict` /
 *  `--fail-on-skill-drift`; `cassette-format` = a cassette too new to interpret; `coverage` = a
 *  verify-run answer-coverage miss. */
export type FailureKind = "assertion" | "guard" | "staleness" | "cassette-format" | "coverage";

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
  // Derived from EVIDENCE, not from whether the signal fired. The signal is suppressed whenever the
  // scenario authored `no_delete_in_outputs` (it fails there instead) or waived via
  // `allow_outputs_delete` — in both cases `fired(code)` is false while a delete WAS detected, and
  // reporting `ok` would be a false ✓ for a guard that did catch its failure mode.
  // `fired` for ANY outputs-delete evidence, warn-tier included — the roster reports what the guard saw,
  // the signals say what it weighs. A filesystem-proven delete is `fired` even when the text scan is
  // missing; a diff that could not verify is `unverified`, never `ok`.
  const odTier = outputsDeleteTier(result.scan, result.fsDiff);
  roster.push({
    name: "outputs-delete",
    status: !live
      ? "na"
      : odTier !== "none"
        ? "fired"
        : result.scan === undefined || outputsDiffUnverified(result.fsDiff)
          ? "unverified"
          : "ok",
  });
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
/** Is this produced file one the user actually got?
 *
 *  LANE-PARAMETERISED ON PURPOSE. On the desktop-local lane a file under a user-visible root is delivered
 *  by LOCATION — no tool call needed (Cowork's own prompt tells the agent to save deliverables there).
 *  On the remote lane location delivers nothing: only membership in the delivered set counts (verified by
 *  live probe — writing to /mnt/user-data/outputs/ produced no card and an empty Outputs panel).
 *
 *  Today every harness run is local-shaped, so the location arm always applies; the delivered-set arm is
 *  what a `lane: remote` scenario will narrow to. Keeping both here means that change is a parameter,
 *  not a rewrite of the signal. */
function isDelivered(path: string, result: RunResult, isScratchpadClass: boolean): boolean {
  // A `presentedFiles` entry records `from` (the path the skill presented, VM-absolute) and `to` (where it
  // landed). The workspace path here is the synthetic `scratchpad/<rel>` form, so compare on the tail.
  //
  // `leaked` entries do NOT count as delivered: present_files' own copy-failure branch leaves the file in
  // the scratchpad, and its tool_result says so. Treating a leaked presentation as delivery would green
  // exactly the case `no_scratchpad_leak` exists to catch.
  const rel = path.startsWith("scratchpad/") ? path.slice("scratchpad/".length) : path;
  const presented = (result.presentedFiles ?? []).some(
    (p) => !p.leaked && (p.from === path || p.from === rel || p.from.endsWith(`/${rel}`)),
  );
  if (presented) return true;
  // Location arm — LOCAL ONLY. A non-scratchpad file sits under a user-visible root by construction, and
  // on the local lane that IS delivery: `outputs/` is durable and Cowork's own prompt tells the agent to
  // save deliverables there. On the remote lane the arm disappears — a remote container has no
  // auto-delivering outputs dir and is reclaimed at session end, so nothing is delivered by location.
  return !isScratchpadClass && locationDelivers(result.lane);
}

/** Does a file under a user-visible root count as delivered on this run's lane?
 *
 *  LOCAL: yes. Cowork's own prompt tells the agent to save deliverables into the workspace folder, and
 *  they persist there — `mnt/outputs` is a durable host directory.
 *  REMOTE: no. Verified by live probe — a remote container has no auto-delivering outputs directory
 *  (writing to `/mnt/user-data/outputs/` produced no card and an empty Outputs panel; the directory did
 *  not even exist until the agent created it). Only an explicit delivery reaches the user, and the
 *  workspace is reclaimed at session end.
 *
 *  Absent lane ⇒ local, so every result written before this axis existed keeps its meaning. */
export function locationDelivers(lane: RunResult["lane"]): boolean {
  return lane !== "remote";
}

/** Can the harness OBSERVE an explicit delivery on this lane at all?
 *
 *  Deliberately distinct from `locationDelivers`, which asks whether a file's LOCATION counts as
 *  delivery. This asks the prior question: does the harness serve any delivery tool here whose calls it
 *  could record?
 *
 *  LOCAL: yes — `present_files` is served (container + hostloop) and its calls land in `presentedFiles`.
 *  REMOTE: no — production delivers via the agent-native `SendUserFile`, which this harness does not
 *  model, so `presentedFiles` is structurally incapable of being non-empty there. Without this
 *  distinction `undelivered_deliverables` fires on EVERY live first-turn remote run that writes a file:
 *  `isDelivered`'s location arm is off (correctly), its `presentedFiles` arm can never match, and the
 *  warning then reports "never reached the user" about files whose delivery was simply unobservable.
 *  That is a claim the evidence cannot support — hence the separate `delivery_unobservable` signal.
 *
 *  Flip the remote arm when a remote delivery tool is modeled and this whole path self-heals into an
 *  informative signal; nothing else needs to change. */
export function deliveryObservable(lane: RunResult["lane"]): boolean {
  return lane !== "remote";
}

/** Can this run answer "was anything left undelivered?" at all?
 *
 *  Three distinct ways the answer is UNKNOWN rather than "nothing": the workspace walk produced no
 *  evidence (`workspaceFiles` undefined — replay, or a vanished root); no scratchpad walk ran on this
 *  tier (protocol has no session-root layout), so the absence of scratchpad entries proves nothing; or
 *  the run predates the telemetry. Staying silent in those cases would let "cannot tell" read as "clean",
 *  which is the failure mode this signal exists to remove. */
function isDeliveryEvidenceUsable(result: RunResult): boolean {
  if (result.workspaceFiles === undefined) return false; // no workspace walk at all
  // No delivery tool is served on this lane, so `presentedFiles` can never be non-empty — "not in the
  // delivered set" carries zero information here. Handled by `delivery_unobservable` instead, which says
  // the question was unanswerable rather than answering it wrongly.
  if (!deliveryObservable(result.lane)) return false;
  // The PERSISTED completeness flag, not an emptiness check on the results. Inferring "the walk ran" from
  // "a scratchpad entry exists" is self-fulfilling: it cannot distinguish a tier that runs no walk
  // (protocol has no session-root layout; chat passes no root; replay materializes a tree) from a run that
  // genuinely left nothing behind. Both then read as clean, which is the vacuous pass this signal exists
  // to remove. Absent on results written before the flag existed ⇒ cannot tell.
  if (result.scratchpadEvidenceComplete !== true) return false;
  // Missing delivery telemetry cannot be read as "nothing was delivered" — that would invent an
  // undelivered verdict from absence of evidence.
  if (result.presentedFiles === undefined) return false;
  // A RESUMED turn re-walks a scratchpad that still holds files DELIVERED ON AN EARLIER TURN — present_files
  // copies, leaving the source in place — while `presentedFiles` only covers this turn. Warning there would
  // state something false ("never reached the user") about a file the user already has.
  if ((result.turn ?? 1) > 1) return false;
  return true;
}

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

  // a declared requires_capabilities the running tier couldn't satisfy is a hard fail, computed from a
  // live run and persisted to result.json. verify-run reads that persisted outcome and honors it (a clean
  // full-parity run records nothing here, so this never false-fails a later verify-run); replay re-drives
  // and resets requiresCapabilityUnmet to undefined (see cassette.ts), so it does not re-surface on replay.
  // Opt out with allow_missing_capability.
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
    // Mirrors permissive_auto_allow / l0_host_config_contamination — a warn-only would let the silent-green slip.
    if (result.missingCapabilityUse?.length && !authored.some((a) => a.allow_missing_capability === true))
      signals.push({
        code: "missing_capability",
        severity: "fail",
        message:
          `the agent image omits capabilit(ies) the skill used: ${result.missingCapabilityUse.join(", ")} — ` +
          `likely a FALSE NEGATIVE (real Cowork ships them${rootfsManifestDesktopVersion() ? ` — per its rootfs manifest captured at Desktop ${rootfsManifestDesktopVersion()}` : ""}). ` +
          "Rebuild full parity (--build-arg COWORK_FULL_PARITY=1); " +
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
      // Shares the undelivered signal's location model, so it needs the same lane awareness: on the
      // remote lane an `output`-class file is NOT evidence of a deliverable reaching anyone, so treating
      // its presence as "the run produced something" would suppress this warning on the lane where the
      // question matters most.
      !result.workspaceFiles.some((f) => f.class === "output" && locationDelivers(result.lane)) &&
      /\?(?![\w=&/#])/.test(result.finalMessage ?? "") // a '?' not followed by a URL-query/path char
    )
      signals.push({
        code: "ended_with_question",
        severity: "warn",
        message:
          "the final answer contains a question and the run wrote no deliverable to outputs/ — the agent may have ended on a request for input instead of a deliverable. " +
          "Script the answer (answer:/--answer/a decider) or steer --decider-llm --intent; assert allow_stall: true if ending on a question is intended.",
      });

    // A skill can produce a deliverable, never deliver it, and still green: no assertion covers the
    // NEGATIVE case unless an author thought to write one. Observed live — a run created 23 files and
    // delivered 3, and reported success.
    //
    // What happens to an undelivered file differs BY LANE, and the message must not overclaim:
    //   remote — the container is reclaimed at session end; the file is DESTROYED.
    //   local  — the file persists but is INVISIBLE; the scratchpad is not a surface the user sees.
    // Both are delivery failures. Only one is data loss, so this says "never reached the user", which is
    // true on both, rather than naming a destruction that does not happen on local.
    //
    // WARN, never fail: a skill may legitimately leave working files behind. This exists to make the
    // question visible on every run without anyone opting in — which is the whole point, since the
    // scenarios that most need it are the ones whose author never considered delivery.
    // On LOCAL only scratchpad files can be undelivered (a file under a user-visible root is delivered by
    // location). On REMOTE nothing is delivered by location, so every produced file is a candidate — which
    // is what makes the motivating case (23 produced, 3 delivered) visible on the lane it was observed on.
    const candidates = locationDelivers(result.lane)
      ? (result.workspaceFiles ?? []).filter((f) => f.class === "scratchpad")
      : (result.workspaceFiles ?? []).filter((f) => f.class !== "input");
    const undelivered = isDeliveryEvidenceUsable(result)
      ? candidates.filter((f) => !isDelivered(f.path, result, f.class === "scratchpad"))
      : [];
    if (undelivered.length && !result.assertions.some((a) => a.assertion.allow_undelivered_deliverables === true))
      signals.push({
        code: "undelivered_deliverables",
        severity: "warn",
        message:
          `${undelivered.length} file(s) the skill produced never reached the user: ` +
          `${undelivered
            .slice(0, 5)
            .map((f) => f.path)
            .join(", ")}${undelivered.length > 5 ? `, +${undelivered.length - 5} more` : ""}. ` +
          // The explanation and the remedy BOTH depend on the lane, and must be branched on the same
          // predicate that selected the candidates above — otherwise the remote lane (whose candidate set
          // includes files under a user-visible root) inherits the local wording and reads as a
          // self-contradiction: "written outside every user-visible root" naming `outputs/report.md`,
          // with "write deliverables under outputs/" as the fix for a file already there. Observed live.
          //
          // The `else` arm is currently UNREACHABLE — `isDeliveryEvidenceUsable` now returns false when
          // delivery is unobservable, and `deliveryObservable` and `locationDelivers` happen to agree
          // (both "not remote") while no remote delivery tool is modeled. It is retained deliberately:
          // the two predicates are distinct questions and diverge the moment a remote delivery tool
          // ships (observable:true, locationDelivers:false), which makes this arm live again. Deleting
          // it would silently restore the wrong-wording bug at exactly that point.
          (locationDelivers(result.lane)
            ? "They were written outside every user-visible root and never delivered — on a remote Cowork session the " +
              "workspace is reclaimed at session end, and on a local one they stay invisible to the user. " +
              "Write deliverables under outputs/ (or a connected folder), or deliver them explicitly."
            : "On `lane: remote` NOTHING is delivered by location — the session's workspace is reclaimed at session " +
              "end, so a file reaches the user only if the skill delivers it explicitly. Moving it under outputs/ " +
              "does not help on this lane; deliver each one.") +
          " Set `allow_undelivered_deliverables: true` if these are intermediates the user is not meant to receive.",
      });

    // The honest counterpart to the signal above, for a lane where the delivery question cannot be
    // answered at all. Silence would read as "clean" (the exact failure `undelivered_deliverables` was
    // built to remove) and firing `undelivered_deliverables` would claim more than the evidence supports,
    // so state the gap itself.
    //
    // Gated on the SAME candidate set the other signal would have used: a run that produced nothing to
    // deliver has nothing unverifiable about it, and warning there would make this fire on every remote
    // run regardless of behaviour — reproducing in miniature the always-fires defect this replaces.
    // `allow_undelivered_deliverables` suppresses it too: a scenario that has already declared its
    // leftovers intentional should not be nagged about the lane instead.
    if (
      !deliveryObservable(result.lane) &&
      result.workspaceFiles !== undefined &&
      result.workspaceFiles.some((f) => f.class !== "input") &&
      !result.assertions.some((a) => a.assertion.allow_undelivered_deliverables === true)
    )
      signals.push({
        code: "delivery_unobservable",
        severity: "warn",
        message:
          "this run produced file(s), but whether any of them reached the user CANNOT BE VERIFIED on `lane: remote` — " +
          "nothing is delivered by location there, and the harness models no remote delivery tool (production uses the " +
          "agent-native SendUserFile). This is a harness coverage gap, not a finding about the skill: treat the run's " +
          "delivery behaviour as unmeasured rather than clean. Use `lane: local` to measure delivery via present_files, " +
          "or set `allow_undelivered_deliverables: true` to acknowledge the gap for this scenario.",
      });

    // absent scan evidence means the host-path guard and the outputs-delete TEXT scan did NOT run (the outputs
    // filesystem diff still did — see `fsDiff`) — a silent ✓ there would be its own
    // false-green. Warn, not fail: matches the capability-probe `unverified` precedent, and a hard-fail would
    // fail every verify-run over a pre-scan-era result.json. An authored scan assertion still hard-fails via
    // scanMissing regardless of this signal.
    if (result.scan === undefined)
      signals.push({
        code: "scan_unavailable",
        severity: "warn",
        message:
          "post-run scan evidence unavailable (events.jsonl missing or corrupt) — the host-path guard and the " +
          "outputs-delete text scan did not run (the outputs filesystem diff still did); assert " +
          "no_delete_in_outputs/transcript_no_host_path to hard-fail on this",
      });

    // `allow_outputs_delete` accepts the detection for this scenario. It is a WAIVER of the harness's
    // post-hoc scan, not a model of production's `allow_cowork_file_delete` approval handshake — the
    // agent never saw an EPERM here, so a skill that would have caught one and escalated still diverges.
    //
    // The evidence is tiered (see outputsDeleteTier): a delete the filesystem diff proved, a delete statement
    // whose own operand is an outputs path, or any text hit on a turn whose diff could not verify ⇒ `fail`; a
    // text hit resting only on the detector's inference, with a clean diff ⇒ the `outputs_delete_unconfirmed`
    // warn. The waiver suppresses both. An authored `no_delete_in_outputs` suppresses only the FAIL (the
    // assertion owns the verdict); the warn is still raised, because a passing assertion's advisory evidence
    // is visible only in the JSON envelope, and the warn is what keeps an unconfirmed hit on stderr.
    const optInOutputsDelete = authored.some((a) => a.allow_outputs_delete === true);
    const authoredOutputsDelete = authored.some((a) => a.no_delete_in_outputs !== undefined);
    const outputsTier = outputsDeleteTier(result.scan, result.fsDiff);
    const outputsEvidence = outputsDeleteEntries(result.scan, result.fsDiff).join("; ");
    if (outputsTier === "fail" && !authoredOutputsDelete && !optInOutputsDelete)
      signals.push({
        code: "outputs_delete",
        severity: "fail",
        message:
          `unauthorized delete touched mnt/outputs: ${outputsEvidence} ` +
          `(assert no_delete_in_outputs to make this explicit, or allow_outputs_delete if the deletion is intended)`,
      });
    if (outputsTier === "warn" && !optInOutputsDelete)
      signals.push({
        code: "outputs_delete_unconfirmed",
        severity: "warn",
        message:
          `delete-shaped command(s) near mnt/outputs, not confirmed: ${outputsEvidence} — no output that existed at ` +
          `turn start was deleted, and no flagged delete has an outputs path as its own operand. A file created AND ` +
          `deleted within this turn is invisible to the filesystem diff, so inspect the command; waive with ` +
          `allow_outputs_delete if the deletion is intended`,
      });
    // A diff that could not verify is never silent: with a text hit it already failed above; without one,
    // a delete by a script file or a non-bash tool would go unseen, so say so.
    if (outputsDiffUnverified(result.fsDiff) && outputsTier === "none" && !optInOutputsDelete)
      signals.push({
        code: "outputs_diff_unavailable",
        severity: "warn",
        message:
          `the outputs filesystem diff could not verify this turn (${result.fsDiff?.reason ?? (result.fsDiff?.status === "unavailable" ? "unavailable" : "malformed diff in result.json")}) — ` +
          `a delete made without a bash command (a script file, another tool) would not have been detected`,
      });
    // Deletes in a delete-denied mount OTHER than outputs. WARN, not fail, on purpose: production
    // ENFORCES this (EPERM) while we only DETECT it after the fact, so by the time we see it the run has
    // already diverged — and promoting it to a failure would silently re-verdict every existing scenario
    // whose skill deletes in a connected folder. Suppressed per-mount by `allow_delete_in`, and entirely
    // when the scenario authored `no_delete_in_mounts` (it fails there instead).
    const waivedMounts = new Set(authored.flatMap((a) => a.allow_delete_in ?? []));
    const authoredMountDeny = authored.some((a) => a.no_delete_in_mounts !== undefined);
    const unwaived = (result.scan?.mountDeletes ?? []).filter((d) => d.mount !== "outputs" && !waivedMounts.has(d.mount));
    if (unwaived.length && !authoredMountDeny)
      signals.push({
        code: "mount_delete",
        severity: "warn",
        message:
          `delete op(s) touched delete-denied mount(s) ${[...new Set(unwaived.map((d) => d.mount))].join(", ")} — ` +
          `production denies unlink/rmdir there until per-mount approval, so this run diverged ` +
          `(assert no_delete_in_mounts to hard-fail on it, or allow_delete_in if the deletion is intended)`,
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

    // L0 (protocol) reading the operator's REAL config dir — their installed plugins, skills, auto-memory
    // and MCP servers are live alongside the thing under test and can answer INSTEAD of it. Fail unless the
    // scenario opts in via `allow_l0_host_config_contamination: true`.
    //
    // This used to mean "plugins load via --settings, not --plugin-dir". That is obsolete: protocol now
    // passes --plugin-dir, so delivery works. What survives is CONTAMINATION, and it stays a FAIL rather
    // than the warn it might look like — nothing else catches it (scanHostInventory is reachable only from
    // the cassette RECORD path and never reaches a verdict; host_path_leak's default-fail is deliberately
    // skipped at this tier; and a host plugin's own `plugins[]` entry exempts its namespaced skills from
    // the record-time inventory scan).
    if (result.l0HostConfigContamination && !authored.some((a) => a.allow_l0_host_config_contamination === true))
      signals.push({
        code: "l0_host_config_contamination",
        severity: "fail",
        message:
          "L0 (protocol) ran against your REAL config dir — your installed plugins, skills, auto-memory and MCP servers " +
          "were visible to the agent and may have answered INSTEAD of the plugin/skill under test, so this run did not " +
          "necessarily measure it. Set COWORK_MANAGED_CONFIG=1 with a token in the environment, use container/microvm, " +
          "or assert allow_l0_host_config_contamination: true to opt in.",
      });
  }

  // The agent did not run the model the scenario asked for. Reported from the SDK's own
  // `system`/`model_fallback` event, so the TRIGGER is the binary's word, not our inference — that is what
  // separates a retired/blocked pin (the scenario is wrong, and every future run is wrong the same way)
  // from a transient overload (this run only). Both are warnings: the run still happened and its
  // assertions still mean something, but the model that produced it is not the one on record.
  for (const f of result.modelFallbacks ?? []) {
    const persistent = f.trigger === "model_not_found" || f.trigger === "model_blocked" || f.trigger === "permission_denied";
    // Whether a PIN existed changes what this event means, so the sentence has to know. On an unpinned run
    // — and on every replay, which resolves no model by design — there is no pinned id to change, and
    // telling the reader to change one names a thing that does not exist.
    const pinned = result.modelSource === "user_setting";
    signals.push({
      code: "model_fallback",
      severity: "warn",
      message:
        `the agent fell back off ${f.originalModel ?? "the requested model"} to ` +
        `${f.fallbackModel ?? "another model"} (trigger: ${f.trigger}) — ` +
        (pinned
          ? "this run did NOT use the pinned model. "
          : "this run used neither the model it started on nor any model the scenario names. ") +
        (persistent
          ? pinned
            ? "This trigger is a property of the pin, not of the moment: every run of this scenario falls back the same way until the pinned id is changed."
            : "This trigger is persistent rather than transient, so a re-run falls back the same way; pin `model:` to make the model a stated fact."
          : "This trigger is transient — a re-run may well hold."),
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
  const failures: Array<{ assertion?: string; message: string; kind: FailureKind }> = [];

  for (const a of result.assertions) {
    if (a.pass) continue;
    const key = Object.keys(a.assertion).filter((k) => (a.assertion as Record<string, unknown>)[k] !== undefined)[0];
    // `source` is stamped by whoever injected the pseudo-assertion; its absence means the author wrote it.
    const kind: FailureKind = a.source ?? "assertion";
    failures.push(
      key ? { assertion: key, message: a.message ?? "assertion failed", kind } : { message: a.message ?? "assertion failed", kind },
    );
  }

  for (const s of signals) {
    if (s.severity !== "fail" || s.code === "assertion") continue;
    // the gate's own message (pushed below) already names the reason — skip the content-free generic
    // result_error/transport_error signal emitted above for the same result:"error" so a salvaged run's
    // failures[] doesn't carry two entries for one root cause.
    if (result.unansweredGate && (s.code === "result_error" || s.code === "transport_error")) continue;
    failures.push({ message: s.message, kind: "guard" });
  }

  if (result.unansweredGate) failures.push({ message: result.unansweredGate.message, kind: "guard" });

  return { pass, exitCode: pass ? 0 : 1, signals, guards: guardRoster(result, lane, signals), failures };
}
