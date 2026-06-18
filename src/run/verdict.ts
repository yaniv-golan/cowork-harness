import type { RunResult } from "../types.js";

export interface VerdictSignal {
  code:
    | "assertion"
    | "result_error"
    | "permissive_auto_allow"
    | "outputs_delete"
    | "host_path_leak"
    | "non_deterministic"
    | "l0_plugin_divergence";
  severity: "fail" | "warn";
  message: string;
}
export interface Verdict {
  pass: boolean;
  exitCode: 0 | 1;
  signals: VerdictSignal[];
}

/**
 * SEAM B — THE single source of a scenario's pass/fail + process exit code. Every verdict site
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
  if (result.result === "error") signals.push({ code: "result_error", severity: "fail", message: "run result was error" });

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

    if (result.scan?.outputsDeletes.length && !authored.some((a) => a.no_delete_in_outputs !== undefined))
      signals.push({
        code: "outputs_delete",
        severity: "fail",
        message: `unauthorized delete touched mnt/outputs: ${result.scan.outputsDeletes.join("; ")} (assert no_delete_in_outputs to make this explicit)`,
      });

    if (result.scan?.hostPathLeaked && !authored.some((a) => a.transcript_no_host_path !== undefined))
      signals.push({
        code: "host_path_leak",
        severity: "fail",
        message: "a host path leaked into model-visible text (assert transcript_no_host_path to make this explicit)",
      });

    // #20: L0 (protocol) with plugins diverges from Cowork's --plugin-dir cache layout — fail unless the
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

  const pass = !signals.some((s) => s.severity === "fail");
  return { pass, exitCode: pass ? 0 : 1, signals };
}
