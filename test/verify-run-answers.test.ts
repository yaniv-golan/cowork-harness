import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// verify-run now ALSO checks that a scenario's scripted `answers` actually match the gates the
// kept run fired (parsed from events.jsonl, the only sidecar that retains option labels). The check is gated
// on `scenario.answers.length` — answer-less scenarios are untouched (covered by verify-run.test.ts).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

/** One AskUserQuestion gate frame as it appears verbatim in a kept run's events.jsonl (child→driver). */
function gateFrame(question: string, optionLabels: string[]) {
  return {
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      input: { questions: [{ question, options: optionLabels.map((label) => ({ label })) }] },
    },
  };
}

/** Where a kept run's per-turn artifacts (result.json/run.jsonl/trace.json) live under the current
 *  layout — `turns/1/`, no root compat copy of any of them. See verify-run.test.ts's `turn1Dir` for the
 *  same rationale. */
function turn1Dir(root: string): string {
  const d = join(root, "turns", "1");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Kept-run dir (success) with turns/1/result.json + sidecars; `gateOpts` adds an events.jsonl with one gate. */
function keptRun(opts: { withGate?: { question: string; options: string[] } } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-vra-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const result = {
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.14271.0",
    result: "success",
    decisions: [],
    toolCounts: { Read: 1 },
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: root,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  };
  const t1 = turn1Dir(root);
  writeFileSync(join(t1, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: opts.withGate ? [opts.withGate.question] : [], steps: [] }));
  if (opts.withGate) {
    // a non-control line first, to prove the parser filters by type and survives noise
    const lines = [
      JSON.stringify({ type: "assistant", text: "thinking" }),
      JSON.stringify(gateFrame(opts.withGate.question, opts.withGate.options)),
    ];
    writeFileSync(join(root, "events.jsonl"), lines.join("\n") + "\n");
  }
  return root;
}

function scenarioFile(dir: string, body: string): string {
  const f = join(dir, "scenario.yaml");
  writeFileSync(f, `name: smoke\nprompt: do the thing\nfidelity: container\n${body}`);
  return f;
}

function verifyRun(runDir: string, scenario: string) {
  const r = spawnSync("node", [CLI, "verify-run", runDir, scenario], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cwh-vracwd-")) });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

const Q = "Which scenarios should I model?";

describe.skipIf(!can)("verify-run answer-coverage", () => {
  it("a scripted answer that matches the run's actual gate → pass (coverage 1/1)", () => {
    const run = keptRun({ withGate: { question: Q, options: ["Base case", "Downside"] } });
    const sc = scenarioFile(
      run,
      `answers:\n  - when_question: "scenarios should I model"\n    choose: "Base case"\nassert:\n  - result: success\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/1\/1 gate\(s\) matched/);
  });

  it("no rule matches the gate (default on_unanswered=fail) → exit 1 with an answer_coverage failure", () => {
    const run = keptRun({ withGate: { question: Q, options: ["Base case", "Downside"] } });
    const sc = scenarioFile(
      run,
      `answers:\n  - when_question: "a totally different question"\n    choose: "Base case"\nassert:\n  - result: success\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/answer_coverage/);
    expect(r.text).toMatch(/no answer rule matched/);
  });

  it("a choose label not offered by the gate → exit 1 (invalid against the offered options)", () => {
    const run = keptRun({ withGate: { question: Q, options: ["Base case", "Downside"] } });
    const sc = scenarioFile(
      run,
      `answers:\n  - when_question: "scenarios should I model"\n    choose: "Sideways case"\nassert:\n  - result: success\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/invalid against the offered options/);
  });

  it("on_unanswered: first → an unmatched gate is NOT a coverage failure (would auto-pick)", () => {
    const run = keptRun({ withGate: { question: Q, options: ["Base case", "Downside"] } });
    const sc = scenarioFile(
      run,
      `on_unanswered: first\nanswers:\n  - when_question: "a different question"\n    choose: "Base case"\nassert:\n  - result: success\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).toBe(0);
  });

  it("scenario declares answers but the run dir has NO events.jsonl → exit 2 (can't verify ⇒ not green)", () => {
    const run = keptRun(); // no gate → no events.jsonl
    const sc = scenarioFile(run, `answers:\n  - when_question: "anything"\n    choose: "X"\nassert:\n  - result: success\n`);
    const r = verifyRun(run, sc);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/no events\.jsonl/);
  });

  it("an ANSWER-LESS scenario with no events.jsonl is unaffected (assert-only, exit 0)", () => {
    const run = keptRun(); // no events.jsonl
    const sc = scenarioFile(run, `assert:\n  - result: success\n`);
    const r = verifyRun(run, sc);
    expect(r.code).toBe(0);
  });

  it("refuses when events.jsonl has corrupt lines", () => {
    const run = keptRun(); // no gate → no events.jsonl written by default
    // Two lines that each fail JSON.parse — truncation / hand edit / raw agent-stdout noise.
    writeFileSync(
      join(run, "events.jsonl"),
      ['{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool"', "not json at all"].join("\n") + "\n",
    );
    const sc = scenarioFile(run, `answers:\n  - when_question: "anything"\n    choose: "X"\nassert:\n  - result: success\n`);
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/unparseable line/);
    expect(r.text).toMatch(/truncation, a hand edit, or raw agent-stdout noise/);
  });

  it("refuses when trace.json records more questions than events.jsonl yields gates", () => {
    const run = keptRun(); // no gate → clean-but-gateless
    // A clean, well-formed non-control_request line — NOT corrupt, just not a gate.
    writeFileSync(join(run, "events.jsonl"), JSON.stringify({ type: "assistant", text: "thinking" }) + "\n");
    // trace.json records a question the (gateless) events.jsonl never yields — incomplete evidence.
    writeFileSync(join(run, "turns", "1", "trace.json"), JSON.stringify({ questions: ["Which scenario?"], steps: [] }));
    const sc = scenarioFile(run, `answers:\n  - when_question: "anything"\n    choose: "X"\nassert:\n  - result: success\n`);
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/gate evidence incomplete/);
  });
});
