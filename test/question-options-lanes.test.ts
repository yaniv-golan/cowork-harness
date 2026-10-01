import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// The two lanes where `question_options` is easy to get wrong, each pinned by the failure it would
// otherwise ship silently.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function gateFrame(question: string, optionLabels: string[], descriptions?: Record<string, string>) {
  return {
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      input: {
        questions: [
          {
            question,
            options: optionLabels.map((label) =>
              descriptions?.[label] === undefined ? { label } : { label, description: descriptions[label] },
            ),
          },
        ],
      },
    },
  };
}

function keptRun(
  gate?: { question: string; options: string[]; descriptions?: Record<string, string> },
  opts: { corruptEvents?: boolean; noEvents?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-qo-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const t1 = join(root, "turns", "1");
  mkdirSync(t1, { recursive: true });
  writeFileSync(
    join(t1, "result.json"),
    JSON.stringify({
      scenario: "smoke",
      fidelity: "container",
      baseline: "desktop-1.14271.0",
      result: "success",
      // Deliberately EMPTY: the answer-time channel carries nothing here, proving this lane does not
      // read `decisions[].questions` (the design the reviews rejected).
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
    }),
  );
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  // trace.json carries question TEXT only — the distilled sidecar drops options, which is why this lane
  // must read events.jsonl instead.
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: gate ? [gate.question] : [], steps: [] }));
  if (gate && !opts.noEvents) {
    const lines = opts.corruptEvents
      ? ["{ this is not json", JSON.stringify(gateFrame(gate.question, gate.options, gate.descriptions))]
      : [JSON.stringify(gateFrame(gate.question, gate.options, gate.descriptions))];
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
  const r = spawnSync("node", [CLI, "verify-run", runDir, scenario], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cwh-qo-cwd-")) });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

const Q = "The rubric doesn't fit this stage";
const OPTS = ["Stop review", "Proceed anyway"];

describe.skipIf(!can)("verify-run grades question_options from events.jsonl", () => {
  // THE regression this test exists for. `parseGatesFromEvents` is otherwise called only inside
  // `if (scenario.answers.length > 0)` — so a scenario that asserts option order with NO scripted
  // answers (on_unanswered: first, an LLM-decided gate, a post-hoc check on a kept run) would have
  // reached the evaluator with no evidence at all. That is the reporter's own gate-stop scenario style.
  it("grades with an EMPTY answers: block — the answer-coverage gate must not decide this", () => {
    const run = keptRun({ question: Q, options: OPTS });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n  - result: success\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).toBe(0);
  });

  it("catches the reversed list on this lane too", () => {
    const run = keptRun({ question: Q, options: ["Proceed anyway", "Stop review"] });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/question_options/);
  });

  // Absent or partly-corrupt evidence must fail closed. A present-but-corrupt events.jsonl is otherwise
  // indistinguishable from "those were all the gates", which would grade a partial set as complete.
  it("fails evidence-unavailable when events.jsonl is absent", () => {
    const run = keptRun({ question: Q, options: OPTS }, { noEvents: true });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });

  it("fails evidence-unavailable when events.jsonl has an unparseable line", () => {
    const run = keptRun({ question: Q, options: OPTS }, { corruptEvents: true });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });
});

// `question_context` reads the SAME events.jsonl evidence on this lane, through the same `wantsGateOptions`
// switch in cli.ts. Reverting that switch to `question_options`-only was measured as a ZERO-failure
// mutation: the key would silently fail evidence-unavailable on every verify-run — a false RED nothing
// caught. These are the four cases `question_options` already pins, for the key that most needs them: the
// text it matches lives in an option `description`, which no other assert key can reach.
describe.skipIf(!can)("verify-run grades question_context from events.jsonl", () => {
  const DESC = { "Stop review": "The deck states: Seed. This review reads it as Pre-seed." };
  const withDesc = () => keptRun({ question: Q, options: OPTS, descriptions: DESC });

  it("matches text that lives ONLY in an option description, with an EMPTY answers: block", () => {
    const run = withDesc();
    const sc = scenarioFile(run, `assert:\n  - question_context:\n      matches: 'reads it as Pre-seed'\n  - result: success\n`);
    expect(verifyRun(run, sc).code).toBe(0);
  });

  // The pair. A one-sided green would also be produced by a key matching the question text.
  it("...where question_asked on the same regex FAILS", () => {
    const run = withDesc();
    const sc = scenarioFile(run, `assert:\n  - question_asked: 'reads it as Pre-seed'\n`);
    expect(verifyRun(run, sc).code).not.toBe(0);
  });

  it("FAILS when the text was never shown", () => {
    const run = withDesc();
    const sc = scenarioFile(run, `assert:\n  - question_context:\n      matches: 'never shown to anyone'\n`);
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/question_context/);
  });

  it("fails evidence-unavailable when events.jsonl is absent", () => {
    const run = keptRun({ question: Q, options: OPTS, descriptions: DESC }, { noEvents: true });
    const sc = scenarioFile(run, `assert:\n  - question_context:\n      matches: 'reads it as Pre-seed'\n`);
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });

  it("fails evidence-unavailable when events.jsonl has an unparseable line", () => {
    const run = keptRun({ question: Q, options: OPTS, descriptions: DESC }, { corruptEvents: true });
    const sc = scenarioFile(run, `assert:\n  - question_context:\n      matches: 'reads it as Pre-seed'\n`);
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });
});

// `question_option_count` reads the same events.jsonl evidence through the same `wantsGateOptions` switch, and
// it is the only gate key that grades EVERY sub-question: so the producer here carries one AskUserQuestion with
// two bundled sub-questions plus a second gate, never a hand-built context.
describe.skipIf(!can)("verify-run grades question_option_count from events.jsonl", () => {
  const PREFIX = "No changes — ";
  function multiGateRun(gates: { question: string; options: string[] }[][]): string {
    const run = keptRun({ question: Q, options: OPTS });
    const frames = gates.map((sub, i) => {
      const f = gateFrame("unused", []);
      f.request_id = `req-${i + 1}`;
      f.request.tool_use_id = `toolu_${i + 1}`;
      f.request.input.questions = sub.map((g) => ({ question: g.question, options: g.options.map((label) => ({ label })) }));
      return JSON.stringify(f);
    });
    writeFileSync(join(run, "events.jsonl"), frames.join("\n") + "\n");
    writeFileSync(join(run, "turns", "1", "trace.json"), JSON.stringify({ questions: gates.flat().map((g) => g.question), steps: [] }));
    return run;
  }
  const conforming = () =>
    multiGateRun([
      [
        { question: "Keep the TAM figure?", options: [`${PREFIX}keep it`, "Replace with bottom-up"] },
        { question: "Keep the competitor list?", options: ["Add Acme", `${PREFIX}keep the list`] },
      ],
      [{ question: "Ship the report?", options: [`${PREFIX}ship as is`, "Re-score moat"] }],
    ]);
  const ONE = `assert:\n  - question_option_count:\n      matches: '^${PREFIX}'\n      exactly: 1\n  - result: success\n`;

  it("passes when every sub-question of every gate has exactly one prefixed option, with an EMPTY answers: block", () => {
    const run = conforming();
    expect(verifyRun(run, scenarioFile(run, ONE)).code).toBe(0);
  });

  it("fails on the ONE bundled sub-question with two prefixed options, naming it", () => {
    const run = multiGateRun([
      [
        { question: "Keep the TAM figure?", options: [`${PREFIX}keep it`, "Replace with bottom-up"] },
        { question: "Keep the competitor list?", options: [`${PREFIX}keep the list`, `${PREFIX}add Acme`] },
      ],
      [{ question: "Ship the report?", options: [`${PREFIX}ship as is`, "Re-score moat"] }],
    ]);
    const r = verifyRun(run, scenarioFile(run, ONE));
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/1 of 3 did not/);
    expect(r.text).toMatch(/Keep the competitor list\?/);
  });

  it("fails on a gate with no prefixed option", () => {
    const run = multiGateRun([[{ question: "Ship the report?", options: ["Ship", "Re-score moat"] }]]);
    expect(verifyRun(run, scenarioFile(run, ONE)).code).not.toBe(0);
  });

  it("exactly: 0 catches a prefixed option that proposes a change", () => {
    const NONE = `assert:\n  - question_option_count:\n      matches: '^${PREFIX}.*\\b(add|remove)\\b'\n      exactly: 0\n`;
    const bad = multiGateRun([[{ question: "Keep the competitor list?", options: [`${PREFIX}add Acme`, "Remove Beta"] }]]);
    expect(verifyRun(bad, scenarioFile(bad, NONE)).code).not.toBe(0);
    const good = conforming();
    expect(verifyRun(good, scenarioFile(good, NONE)).code).toBe(0);
  });

  it("when_question narrows to matching sub-questions only", () => {
    const run = multiGateRun([
      [
        { question: "Keep the TAM figure?", options: [`${PREFIX}keep it`] },
        { question: "Which file?", options: ["a.xlsx", "b.xlsx"] },
      ],
    ]);
    const sc = scenarioFile(
      run,
      `assert:\n  - question_option_count:\n      when_question: '^Keep'\n      matches: '^${PREFIX}'\n      exactly: 1\n`,
    );
    expect(verifyRun(run, sc).code).toBe(0);
  });

  it("fails evidence-unavailable when events.jsonl is absent", () => {
    const run = keptRun({ question: Q, options: OPTS }, { noEvents: true });
    const r = verifyRun(run, scenarioFile(run, ONE));
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });
});

// Replay: the committed cassette's frozen AskUserQuestion is re-driven through `handleDecision`, which produces
// `gateOptions` — the same producer a live run uses. Copied to a scratch tree with its relative layout so
// `--assert-from` sees the recorded scenario unchanged except for its assert block.
describe.skipIf(!can)("replay grades question_option_count from the cassette's own gate", () => {
  function replayWith(assertYaml: string, edit?: (cassette: Record<string, unknown>) => void) {
    const root = mkdtempSync(join(tmpdir(), "cwh-qoc-replay-"));
    for (const d of ["examples/replays", "e2e/scenarios", "e2e/sessions"]) mkdirSync(join(root, d), { recursive: true });
    const cassette = JSON.parse(readFileSync("examples/replays/example-multiselect-gate.cassette.json", "utf8")) as Record<string, unknown>;
    edit?.(cassette);
    writeFileSync(join(root, "examples/replays/c.cassette.json"), JSON.stringify(cassette, null, 2));
    copyFileSync("e2e/sessions/minimal.yaml", join(root, "e2e/sessions/minimal.yaml"));
    const src = readFileSync("e2e/scenarios/smoke-multiselect.yaml", "utf8").replace(/\nassert:\n[\s\S]*$/, "\n");
    writeFileSync(join(root, "e2e/scenarios/smoke-multiselect.yaml"), `${src}assert:\n${assertYaml}`);
    const r = spawnSync(
      "node",
      [
        CLI,
        "replay",
        join(root, "examples/replays/c.cassette.json"),
        "--assert-from",
        join(root, "e2e/scenarios/smoke-multiselect.yaml"),
        "--output-format",
        "json",
      ],
      { encoding: "utf8", cwd: root },
    );
    // The JSON envelope says which assertions were GRADED: an exit code alone cannot tell a pass from a skipped key.
    const env = JSON.parse(r.stdout) as {
      results: Array<{ assertions: Array<{ assertion: Record<string, unknown>; pass: boolean; message?: string }> }>;
    };
    const grades = env.results[0]!.assertions.filter((a) => "question_option_count" in a.assertion);
    return { code: r.status, text: (r.stderr || "") + grades.map((g) => g.message ?? "").join("\n"), grades };
  }

  it("passes on the recorded labels (Auth, Billing, Audit)", () => {
    const r = replayWith(`  - question_option_count:\n      matches: '^(Auth|Audit)$'\n      exactly: 2\n`);
    expect(r.code, r.text).toBe(0);
    expect(r.grades).toMatchObject([{ pass: true }]);
  });

  it("a cassette without controlOut cannot grade it: excluded with a warning, never a pass", () => {
    const r = replayWith(`  - question_option_count:\n      matches: '^(Auth|Audit)$'\n      exactly: 2\n`, (c) => delete c.controlOut);
    // Not graded at all: excluded (the replay warns), never a pass.
    expect(r.grades).toEqual([]);
    expect(r.text).toMatch(/question_option_count/);
  });

  it("a gate label the cassette's redaction rewrote makes a count it could change evidence-unavailable", () => {
    const redact = (c: Record<string, unknown>) => {
      c.events = (c.events as string[]).map((e) => e.replaceAll('"label":"Billing"', '"label":"[REDACTED:path:0123456789ab]"'));
    };
    const r = replayWith(`  - question_option_count:\n      matches: '^B'\n      exactly: 1\n`, redact);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable: question_option_count: 1 sub-question\(s\) carry option labels rewritten/);
  });

  it("fails on a bound the recorded labels do not satisfy, naming the sub-question", () => {
    const r = replayWith(`  - question_option_count:\n      matches: '^A'\n      exactly: 1\n`);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/"Which features would you like to enable\?" has 2 of \[Auth, Billing, Audit\]/);
  });
});
