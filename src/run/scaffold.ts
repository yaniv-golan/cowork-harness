import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { stringify } from "yaml";
import type { RunResult } from "../types.js";
import { buildGateTrace } from "./trace-view.js";
import { pkgVersion } from "./envelope.js";

/** Regex-escape a question so the scaffolded `when_question` matches it literally (the author can shorten
 *  it to a stable fragment afterwards). */
function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * SCAFFOLD-FROM-RUN: turn a `--keep` run into a starter scenario YAML, auto-filled from what the run
 * OBSERVED — the gates that fired (as scripted `answers`), the artifacts written (as `file_exists`), the
 * sub-agent count (as `dispatch_count_max`), and the prompt — so authoring is explore→lock instead of
 * guess-and-re-run. The output is a STARTER: review and tighten the `when_question` regexes before committing.
 */
export function buildScaffold(eventsFile: string): string {
  const runDir = dirname(eventsFile);
  const resultPath = join(runDir, "result.json");
  let result: Partial<RunResult>;
  if (!existsSync(resultPath)) {
    result = {};
  } else {
    try {
      result = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (e) {
      throw new Error("failed to parse result.json at " + resultPath + ": " + (e as Error).message);
    }
  }

  // Observed gates → scripted answers (one rule per answered sub-question).
  const answers: { when_question: string; choose: string }[] = [];
  // A delivered answer containing ", " is LIKELY a multiSelect set (the wire joins members with ", ").
  // Emitting it as a scalar `choose: "A, B"` is born un-replayable — ScriptedDecider wraps it to
  // `["A, B"]` and no single option is named "A, B", so replay throws. We can't reconstruct the member
  // list here (the gate trace carries neither the gate's options nor its multiSelect flag), so emit a
  // loud marker telling the author to split it into a `choose: [list]` before replay. This is a HEURISTIC
  // on the joined string: it can false-positive on a single-select free-text "Other" answer that happens
  // to contain ", ", and false-negative on a multiSelect with one (comma-free) selection. Precise
  // detection needs the gate trace to carry options+multiSelect — the deferred full-round-trip follow-up.
  const multiSelectSuspects: string[] = [];
  for (const g of buildGateTrace(eventsFile)) {
    if (!g.injectedAnswer) continue;
    let map: Record<string, unknown>;
    try {
      map = JSON.parse(g.injectedAnswer);
    } catch {
      continue;
    }
    for (const [q, a] of Object.entries(map)) {
      const val = String(a);
      if (val.includes(", ")) multiSelectSuspects.push(q);
      answers.push({ when_question: escapeRx(q), choose: val });
    }
  }

  // A partial run did NOT complete (it exited on an unanswered gate). Its artifacts are pre-failure and its
  // result is "error", so neither should become an assertion the author trusts — that would scaffold a
  // scenario asserting the half-finished output. Keep the gate answers (still worth locking) but drop the
  // artifact/result asserts and warn loudly.
  const partial = result.partial === true || result.result === undefined;

  // Observed artifacts → file_exists; sub-agent count → dispatch_count_max; final result.
  const assert: Record<string, unknown>[] = [];
  if (!partial) {
    for (const art of result.artifacts ?? []) assert.push({ file_exists: art.path });
    if ((result.subagents ?? []).length) assert.push({ dispatch_count_max: (result.subagents ?? []).length });
    assert.push({ result: result.result ?? "success" });
  }

  const scenario: Record<string, unknown> = {
    // `result.baseline` is the recorded appVersion; a scenario pins `latest` (or a `desktop-<ver>`) — default
    // to latest and let the author pin if they need a specific release.
    baseline: "latest",
    fidelity: result.fidelity ?? "container",
    prompt: result.prompt ?? "TODO: the prompt you ran (not recoverable from this run)",
    ...(answers.length ? { answers } : {}),
    assert,
  };

  const multiSelectMarker = multiSelectSuspects.length
    ? `# scaffold: answer(s) for ${[...new Set(multiSelectSuspects)]
        .map((q) => JSON.stringify(q))
        .join(
          ", ",
        )} look like a multiSelect set (contain ", "), emitted as a scalar 'choose: "A, B"'. If multiSelect, split each into 'choose: [A, B]' before replay or the gate won't match. (If it was a single free-text answer, leave it.)\n`
    : "";
  // Provenance signature — mirrors the cassette's `generator`/`cassetteVersion` fields. The scenario
  // schema is `additionalProperties:false`, so it rides as a YAML comment (survives parse + re-serialize)
  // rather than a structured field. Tool + version let a reader trace a committed scenario to its origin.
  const partialMarker = partial
    ? `# PARTIAL run — this run did NOT complete (it exited on an unanswered gate). The artifact and result\n` +
      `# assertions were omitted (the outputs are pre-failure). Re-run to completion and re-scaffold before trusting.\n`
    : "";
  return (
    `# generated by cowork-harness v${pkgVersion()} (scaffold) from ${runDir}\n` +
    `# REVIEW before committing: tighten the when_question regexes to stable fragments, prune asserts you don't need.\n` +
    partialMarker +
    multiSelectMarker +
    stringify(scenario)
  );
}
