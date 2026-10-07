import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertContradiction } from "../src/run/execute.js";
import type { Scenario } from "../src/types.js";

// Cross-language drift tripwire (the scenario-lint-gate-id.test.ts pattern). The SAME defect is reported
// twice, in two languages that cannot share a string: `lint` reports `assert-contradiction` from offline
// Python, and `run`/`skill`/`record` refuse it from TypeScript. The plan for this feature asked for "the
// same text" in both; that is not literally achievable, so this pins what must not diverge — the trigger
// set, the satisfiable neighbours, and the claim each message makes.
//
// Compares EMITTED messages, not source text. A source scan cannot see a phrase the Python side wraps
// across two string literals, so it reports drift that isn't there (it did, on the first draft) — and,
// worse, would keep passing if the emitted message changed while the source fragments didn't.

const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;
if (!havePython) {
  // eslint-disable-next-line no-console
  console.warn("python3 not found — assert-contradiction message-sync tests skipped");
}

type Finding = { severity: string; rule: string; message: string; fix: string };

/** Lint a scenario body and return the `assert-contradiction` finding, if any. */
function lintContradiction(assertBlock: string): Finding | undefined {
  const dir = mkdtempSync(join(tmpdir(), "cwh-acms-"));
  const file = join(dir, "sc.yaml");
  // `hostloop` because the denial keys are hostloop-only; the tier gates the ASSERTION, not this rule,
  // but keeping the scenario coherent avoids an unrelated tier finding muddying the comparison.
  writeFileSync(file, `name: t\nbaseline: latest\nsession: (inline)\nfidelity: hostloop\nprompt: hi\n${assertBlock}`, "utf8");
  const r = spawnSync(py, [SCRIPT, "lint", "--json", file], { encoding: "utf8" });
  const findings: Finding[] = JSON.parse(r.stdout || "[]");
  return findings.find((f) => f.rule === "assert-contradiction");
}

const scenario = (assert: unknown[]) => ({ name: "t", prompt: "hi", assert }) as unknown as Scenario;

describe.skipIf(!havePython)("assert-contradiction: TS refusal ↔ Python lint rule", () => {
  // Every (absence, presence) pair both sides must agree is unsatisfiable. One table, both languages —
  // adding a group to one side without the other fails here.
  const PAIRS: [label: string, ts: unknown[], yaml: string][] = [
    [
      "questions_count_max: 0 + gate_answer_count_min",
      [{ questions_count_max: 0 }, { gate_answer_count_min: 1 }],
      "assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n",
    ],
    [
      "questions_count_max: 0 + question_asked",
      [{ questions_count_max: 0 }, { question_asked: "x" }],
      'assert:\n  - questions_count_max: 0\n  - question_asked: "x"\n',
    ],
    [
      "questions_count_max: 0 + question_context",
      [{ questions_count_max: 0 }, { question_context: { matches: "x" } }],
      'assert:\n  - questions_count_max: 0\n  - question_context:\n      matches: "x"\n',
    ],
    [
      // `exactly: 0` included: zero sub-questions asked fails the count, so any value requires a gate.
      "questions_count_max: 0 + question_option_count",
      [{ questions_count_max: 0 }, { question_option_count: { matches: "x", exactly: 0 } }],
      'assert:\n  - questions_count_max: 0\n  - question_option_count:\n      matches: "x"\n      exactly: 0\n',
    ],
    [
      "questions_count_max: 0 + gate_answers_delivered: false",
      [{ questions_count_max: 0 }, { gate_answers_delivered: false }],
      "assert:\n  - questions_count_max: 0\n  - gate_answers_delivered: false\n",
    ],
    [
      "no_hook_blocked + hook_blocked",
      [{ no_hook_blocked: true }, { hook_blocked: "Bash" }],
      'assert:\n  - no_hook_blocked: true\n  - hook_blocked: "Bash"\n',
    ],
    [
      "no_path_denied + path_denied",
      [{ no_path_denied: true }, { path_denied: {} }],
      "assert:\n  - no_path_denied: true\n  - path_denied: {}\n",
    ],
    [
      "no_path_denied + vm_path_denied",
      [{ no_path_denied: true }, { vm_path_denied: true }],
      "assert:\n  - no_path_denied: true\n  - vm_path_denied: true\n",
    ],
    [
      // value-level: same event and needle, the negative's stream (`any`) covering the positive's
      "hook_output_not_contains + hook_output_contains (same event and needle)",
      [
        { hook_output_not_contains: { event: "Stop", text: "x" } },
        { hook_output_contains: { event: "Stop", stream: "stderr", text: "x" } },
      ],
      'assert:\n  - hook_output_not_contains: { event: Stop, text: "x" }\n  - hook_output_contains: { event: Stop, stream: stderr, text: "x" }\n',
    ],
    [
      "no_hook_event_blocked: true + hook_event_blocked: Stop",
      [{ no_hook_event_blocked: true }, { hook_event_blocked: "Stop" }],
      "assert:\n  - no_hook_event_blocked: true\n  - hook_event_blocked: Stop\n",
    ],
    [
      "no_hook_event_blocked {event} + hook_decision deny on a tool of that event",
      [{ no_hook_event_blocked: { event: "PreToolUse" } }, { hook_decision: { event: "PreToolUse", decision: "deny", tool: "Bash" } }],
      "assert:\n  - no_hook_event_blocked: { event: PreToolUse }\n  - hook_decision: { event: PreToolUse, decision: deny, tool: Bash }\n",
    ],
    [
      "hook_event_blocked {max: 0} + the bare hook_event_blocked (exit 2 is counted by either default)",
      [{ hook_event_blocked: { event: "Stop", max: 0 } }, { hook_event_blocked: "Stop" }],
      "assert:\n  - hook_event_blocked: { event: Stop, max: 0 }\n  - hook_event_blocked: Stop\n",
    ],
    [
      "hook_decision deny {max: 0} + hook_event_blocked via: json",
      [{ hook_decision: { event: "PreToolUse", decision: "block", max: 0 } }, { hook_event_blocked: { event: "PreToolUse", via: "json" } }],
      "assert:\n  - hook_decision: { event: PreToolUse, decision: block, max: 0 }\n  - hook_event_blocked: { event: PreToolUse, via: json }\n",
    ],
  ];

  it.each(PAIRS)("both sides flag %s", (label, ts, yaml) => {
    expect(assertContradiction(scenario(ts)), `TS lost the ${label} pair`).toBeDefined();
    expect(lintContradiction(yaml), `lint lost the ${label} pair`).toBeDefined();
  });

  // Neighbours that LOOK like the pairs above but are jointly satisfiable. One side refusing what the
  // other allows is worse than either being wrong alone.
  const OK: [label: string, ts: unknown[], yaml: string][] = [
    [
      "gate_answers_delivered: true (vacuous at zero, merely inert)",
      [{ questions_count_max: 0 }, { gate_answers_delivered: true }],
      "assert:\n  - questions_count_max: 0\n  - gate_answers_delivered: true\n",
    ],
    [
      "gate_answer_count_min: 0 (>= 0 always holds)",
      [{ questions_count_max: 0 }, { gate_answer_count_min: 0 }],
      "assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 0\n",
    ],
    [
      // PyYAML (YAML 1.1) reads both as True; the harness keeps the strings "yes" and "on", which differ
      "hook_output_* needles `yes` vs `on` (distinct strings to the harness, both True to PyYAML)",
      [{ hook_output_not_contains: { event: "Stop", text: "yes" } }, { hook_output_contains: { event: "Stop", text: "on" } }],
      "assert:\n  - hook_output_not_contains: { event: Stop, text: yes }\n  - hook_output_contains: { event: Stop, text: on }\n",
    ],
    [
      "two positive denial assertions",
      [{ vm_path_denied: true }, { path_denied: {} }],
      "assert:\n  - vm_path_denied: true\n  - path_denied: {}\n",
    ],
    [
      "hook_output_* with the negative on a narrower stream (a stdout hit satisfies both)",
      [
        { hook_output_not_contains: { event: "Stop", stream: "stderr", text: "x" } },
        { hook_output_contains: { event: "Stop", text: "x" } },
      ],
      'assert:\n  - hook_output_not_contains: { event: Stop, stream: stderr, text: "x" }\n  - hook_output_contains: { event: Stop, text: "x" }\n',
    ],
    [
      "hook_output_* on different events",
      [{ hook_output_not_contains: { event: "Stop", text: "x" } }, { hook_output_contains: { event: "SessionStart", text: "x" } }],
      'assert:\n  - hook_output_not_contains: { event: Stop, text: "x" }\n  - hook_output_contains: { event: SessionStart, text: "x" }\n',
    ],
    [
      "no_hook_event_blocked on one tool + hook_event_blocked on the whole event (another tool may block)",
      [{ no_hook_event_blocked: { event: "PreToolUse", tool: "Bash" } }, { hook_event_blocked: { event: "PreToolUse", via: "any" } }],
      "assert:\n  - no_hook_event_blocked: { event: PreToolUse, tool: Bash }\n  - hook_event_blocked: { event: PreToolUse, via: any }\n",
    ],
    [
      "hook_event_blocked via: exit2 {max: 0} + via: json (disjoint channels)",
      [{ hook_event_blocked: { event: "Stop", via: "exit2", max: 0 } }, { hook_event_blocked: { event: "Stop", via: "json" } }],
      "assert:\n  - hook_event_blocked: { event: Stop, via: exit2, max: 0 }\n  - hook_event_blocked: { event: Stop, via: json }\n",
    ],
    [
      "hook_event_blocked via: json {max: 0} + the bare form (exit 2 only)",
      [{ hook_event_blocked: { event: "Stop", via: "json", max: 0 } }, { hook_event_blocked: "Stop" }],
      "assert:\n  - hook_event_blocked: { event: Stop, via: json, max: 0 }\n  - hook_event_blocked: Stop\n",
    ],
    [
      "no_hook_event_blocked on one event + hook_decision deny on another",
      [{ no_hook_event_blocked: { event: "Stop" } }, { hook_decision: { event: "PreToolUse", decision: "deny" } }],
      "assert:\n  - no_hook_event_blocked: { event: Stop }\n  - hook_decision: { event: PreToolUse, decision: deny }\n",
    ],
    [
      "no_hook_event_blocked + hook_decision allow (an allow is not a block)",
      [{ no_hook_event_blocked: true }, { hook_decision: { event: "PreToolUse", decision: "allow" } }],
      "assert:\n  - no_hook_event_blocked: true\n  - hook_decision: { event: PreToolUse, decision: allow }\n",
    ],
    [
      "hook_event_blocked {max: 0} + {min: 0, max: 3} (zero blocks satisfies both)",
      [{ hook_event_blocked: { event: "Stop", max: 0 } }, { hook_event_blocked: { event: "Stop", min: 0, max: 3 } }],
      "assert:\n  - hook_event_blocked: { event: Stop, max: 0 }\n  - hook_event_blocked: { event: Stop, min: 0, max: 3 }\n",
    ],
    [
      "two negatives on different channels",
      [{ no_hook_blocked: true }, { no_path_denied: true }],
      "assert:\n  - no_hook_blocked: true\n  - no_path_denied: true\n",
    ],
  ];

  it.each(OK)("neither side flags %s", (label, ts, yaml) => {
    expect(assertContradiction(scenario(ts)), `TS started flagging ${label}`).toBeUndefined();
    expect(lintContradiction(yaml), `lint started flagging ${label}`).toBeUndefined();
  });

  it("both messages make the same claim, in the same words", () => {
    const ts = assertContradiction(scenario([{ questions_count_max: 0 }, { gate_answer_count_min: 1 }]))!;
    const lint = lintContradiction("assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n")!;
    // The load-bearing sentence — WHY the pairing is refused. A user who hits one message and then the
    // other must read one explanation, not two.
    for (const phrase of ["no run can satisfy", "a delivered gate records at least one question"]) {
      expect(ts, `the TS refusal lost "${phrase}"`).toContain(phrase);
      expect(lint.message, `the lint finding lost "${phrase}"`).toContain(phrase);
    }
  });

  it("both name every contradictory group, not just the first", () => {
    const both = [{ questions_count_max: 0 }, { gate_answer_count_min: 1 }, { no_hook_blocked: true }, { hook_blocked: "Bash" }];
    const ts = assertContradiction(scenario(both))!;
    const lint = lintContradiction(
      'assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n  - no_hook_blocked: true\n  - hook_blocked: "Bash"\n',
    )!;
    for (const key of ["questions_count_max", "hook_blocked"]) {
      expect(ts, `the TS refusal dropped ${key}`).toContain(key);
      expect(lint.message, `the lint finding dropped ${key}`).toContain(key);
    }
    // Both must also drop the singular phrasing once two groups are named — "both" would be wrong, and
    // this is precisely the message a user reads carefully.
    expect(ts).toContain("no run can satisfy all of them");
    expect(lint.message).toContain("no run can satisfy all of them");
  });

  it("both offer the same remedy", () => {
    const ts = assertContradiction(scenario([{ questions_count_max: 0 }, { question_asked: "x" }]))!;
    const lint = lintContradiction('assert:\n  - questions_count_max: 0\n  - question_asked: "x"\n')!;
    const remedy = "Keep the negative assertion and drop the positive one";
    expect(ts).toContain(remedy);
    expect(lint.fix, "the lint fix line drifted from the TS refusal's remedy").toContain(remedy);
  });

  it("the lint side is ERROR, matching a refusal rather than an advisory", () => {
    expect(lintContradiction("assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n")!.severity).toBe("ERROR");
  });
});

describe("the object hook_event_blocked's default channel is the same in both languages", () => {
  it("OBJECT_HOOK_EVENT_BLOCKED_VIA (TS) equals _OBJECT_HOOK_EVENT_BLOCKED_VIA (scenario.py)", async () => {
    const { OBJECT_HOOK_EVENT_BLOCKED_VIA } = await import("../src/assert.js");
    const { readFileSync } = await import("node:fs");
    const m = /^_OBJECT_HOOK_EVENT_BLOCKED_VIA = "(\w+)"$/m.exec(readFileSync(SCRIPT, "utf8"));
    expect(m?.[1]).toBe(OBJECT_HOOK_EVENT_BLOCKED_VIA);
  });
});
