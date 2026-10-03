import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FailDecider } from "../src/decide/decider.js";
import type { DecisionRequest } from "../src/agent/session.js";
import type { RunContext } from "../src/decide/decider.js";
import { escapeRegExp } from "./helpers/regex.js";

// The unanswered-gate hint (FailDecider, src/decide/decider.ts) is the ONE surface an agent reads at the
// moment it is stuck, and nothing guarded it. It consequently rotted into naming only two of the four
// answer channels: measured against the shipped skill, agents asked how to answer a gate whose option set
// cannot be known in advance either hand-rolled the in-band req/resp files (what `gates`/`answer` exist to
// replace) or reached for `chat` (which produces no asserted run). These tests exist so that cannot recur.
//
// Two halves, and the SECOND is the load-bearing one:
//   1. content — every channel, and the two subcommands, are named at all.
//   2. per-command qualifiers ("[skill · run · record]") agree with what the CLI parser ACTUALLY accepts,
//      derived by executing each (command × flag) pair. The matrix is asymmetric in ways that are easy to
//      get wrong (`record` takes no --decider-cmd; `run` takes no --decider-llm), and this hint is the
//      worst possible place to be wrong: it tells a stuck user which flag to run. A hand-maintained copy
//      here would be the fourth in the repo (llms.txt, docs/decider-dir.md, the per-command --help), so it
//      is derived instead.

const ctx: RunContext = { task: "", transcript: () => "", toolLog: () => [], runId: "t" };
const gate: DecisionRequest = {
  id: "g1",
  kind: "question",
  questions: [{ question: "Which section should I extract?", options: [{ label: "Financials" }, { label: "Methodology" }] }],
};

async function hint(): Promise<string> {
  try {
    await new FailDecider().decide(gate, ctx);
  } catch (e) {
    return (e as { hint: string }).hint;
  }
  throw new Error("FailDecider did not throw — the on_unanswered:fail terminal is broken");
}

describe("unanswered-gate hint names every answer channel", () => {
  it("names the scripted path FIRST (it is the deterministic one; order is the recommendation)", async () => {
    const h = await hint();
    expect(h).toContain("when_question");
    expect(h.indexOf("when_question")).toBeLessThan(h.indexOf("--decider-dir"));
  });

  it("names all three live channels", async () => {
    const h = await hint();
    expect(h).toContain("--decider-dir");
    expect(h).toContain("--decider-cmd");
    expect(h).toContain("--decider-llm");
    expect(h).toContain("on_unanswered: llm"); // the YAML spelling — the ONLY one `run` accepts
  });

  it("names the `gates` and `answer` subcommands, not just the flag", async () => {
    // The measured failure: agents that DID find --decider-dir then told the user to hand-roll the
    // req-N.json/resp-N.json protocol. Naming the flag without its two subcommands is the defect.
    const h = await hint();
    expect(h).toContain("cowork-harness gates");
    expect(h).toContain("cowork-harness answer");
  });

  it("states that live channels are non-deterministic", async () => {
    expect(await hint()).toMatch(/non-deterministic/i);
  });

  it("does NOT offer `chat` — it answers gates at a TTY but yields no pass/fail verdict", async () => {
    expect(await hint()).not.toMatch(/\bchat\b/);
  });

  it("emits the channel block ONCE even for a multi-question gate (it must not repeat per question)", async () => {
    const multi: DecisionRequest = {
      id: "g2",
      kind: "question",
      questions: [
        { question: "First?", options: [{ label: "a" }] },
        { question: "Second?", options: [{ label: "b" }] },
        { question: "Third?", options: [{ label: "c" }] },
      ],
    };
    let h = "";
    try {
      await new FailDecider().decide(multi, ctx);
    } catch (e) {
      h = (e as { hint: string }).hint;
    }
    expect(h.match(/--decider-dir/g)?.length).toBe(1);
    expect(h.match(/when_question/g)?.length).toBe(3); // per-question lines still repeat, by design
  });
});

// ---- the skill's decision router: the SECOND surface that must name every channel ----
//
// The hint (above) is read when you are already stuck. The router is read when you are choosing. Both
// rotted the same way, so both are guarded. Scoped to the anchored region deliberately: this is NOT the
// "a flag must appear somewhere in a doc" gate that test/skill-docs-sync.test.ts explicitly declines —
// `--decider-dir` WAS mentioned in SKILL.md the whole time, in a table row, and agents still could not
// choose it. What is asserted here is PLACEMENT: it must be inside the decision procedure, with its cost.

// The decision tree lives in references/authoring.md (it moved out of SKILL.md when the entrypoint was
// split); SKILL.md keeps the Orient bullet that routes "interactive but asserted" away from `chat`, and the
// routing-table row that sends a reader choosing a channel to the tree.
describe("the skill's answer-channel router", () => {
  const skillMd = readFileSync(resolve(".claude/skills/cowork-harness/SKILL.md"), "utf8");
  const authoringMd = readFileSync(resolve(".claude/skills/cowork-harness/references/authoring.md"), "utf8");
  const router = (): string => {
    const m = authoringMd.match(/<!-- answer-channels:begin -->([\s\S]*?)<!-- answer-channels:end -->/);
    if (!m) throw new Error("the answer-channels markers are gone from references/authoring.md — the router is unguarded");
    return m[1];
  };

  it("SKILL.md routes a reader choosing a channel to the decision tree's file", () => {
    expect(skillMd).toMatch(/\[`references\/authoring\.md`\]\(references\/authoring\.md\) \|[^\n]*answer-channel decision tree/);
  });

  it("has the anchored region at all, and it is substantial (not an emptied stub)", () => {
    expect(router().length).toBeGreaterThan(800);
  });

  /** The decision BRANCHES — the `──►` lines. Presence of a token anywhere in the region is not enough:
   *  `--decider-dir` sat in a SKILL.md table for releases while agents still could not choose it. What
   *  has to hold is that each channel is the outcome of a branch, i.e. reachable by answering questions
   *  about your own situation. (A first cut of this test asserted mere containment and stayed green when
   *  the in-band branch was deleted — the cost bullets still mentioned the flag.) */
  const branches = (): string => {
    const lines = router()
      .split("\n")
      .filter((l) => l.includes("──►"));
    if (lines.length < 4) throw new Error(`router has only ${lines.length} decision branches — the tree collapsed`);
    return lines.join("\n");
  };

  it.each(["--decider-dir", "--decider-cmd", "--decider-llm", "on_unanswered: fail"])(
    "reaches %s as the outcome of a decision BRANCH, not just as a mention",
    (channel) => {
      expect(branches()).toContain(channel);
    },
  );

  it("still names the YAML-only spelling somewhere in the router (`run` accepts no --decider-llm)", () => {
    expect(router()).toContain("on_unanswered: llm");
  });

  it("names the two subcommands that operate the in-band channel", () => {
    expect(router()).toContain("cowork-harness gates");
    expect(router()).toContain("cowork-harness answer");
  });

  it("keeps the scripted path as the stated default, ahead of every live channel", () => {
    const r = router();
    expect(r.indexOf("on_unanswered: fail")).toBeLessThan(r.indexOf("--decider-dir"));
  });

  it("carries the in-band channel's COST, so teaching it cannot read as promoting it", () => {
    const r = router();
    expect(r).toMatch(/unusable unattended|nonDeterministic/);
    expect(r).toMatch(/fresh,? empty dir/i);
  });

  it("routes 'interactive but asserted' away from `chat` (the measured mis-route)", () => {
    expect(skillMd).toMatch(/not\*{0,2}\s*`chat`|\*\*not\*\* `chat`/);
  });
});

// ---- the derived half: the hint's [command] qualifiers vs. what the parser accepts ----

const CLI = resolve("dist/cli.js");
const haveCli = existsSync(CLI);
if (!haveCli) {
  // Loud, not silent: a skipped acceptance matrix must never read as a passing one.
  // eslint-disable-next-line no-console
  console.warn("dist/cli.js missing — answer-channel acceptance-matrix tests SKIPPED (run `npm run build` first)");
}

/** A scenario file that merely has to PARSE — every check below fails at argument parsing, before load. */
function fixtures(): { skillDir: string; scenario: string } {
  const d = mkdtempSync(join(tmpdir(), "ach-"));
  mkdirSync(join(d, ".claude", "skills", "s"), { recursive: true });
  writeFileSync(join(d, ".claude", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nbody\n");
  const scenario = join(d, "s.yaml");
  writeFileSync(scenario, "name: t\nbaseline: latest\nfidelity: container\nprompt: hi\nassert:\n- result: success\n");
  return { skillDir: d, scenario };
}

/** Does `command` accept `flag`? Determined by the PARSER, never by a hand-written table.
 *  Appends an always-invalid flag: whichever flag the parser names in its rejection is the rejected one,
 *  so this never reaches a run and costs nothing. */
function accepts(command: string, positionals: string[], flag: string, value?: string): boolean {
  const args = [command, ...positionals, flag, ...(value ? [value] : []), "--zzz-unknown-probe"];
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  // FAIL LOUD rather than open. This probe decides acceptance by the ABSENCE of a rejection message, so
  // anything that yields no output reads as "accepted" — a spawn error, a killed child, a missing CLI all
  // returned `true` for every flag, turning the matrix uniformly permissive instead of partly wrong. That
  // is the direction that manufactures a green, and it is silent. The probe always appends an invalid
  // flag, so a healthy run ALWAYS produces a rejection on one of the two streams; empty output means we
  // learned nothing and must say so.
  if (r.error) throw new Error(`accepts(): spawn failed for \`${command} ${flag}\`: ${r.error.message}`);
  if (r.status === null)
    throw new Error(`accepts(): probe for \`${command} ${flag}\` was killed by ${r.signal ?? "a signal"} — no verdict`);
  if (!out.trim())
    throw new Error(`accepts(): probe for \`${command} ${flag}\` produced NO output — cannot distinguish acceptance from a failed spawn`);
  const escaped = escapeRegExp(flag);
  return !new RegExp(`(?:unknown flag|unexpected argument\\(s\\)):[^\\n]*${escaped}`).test(out);
}

describe.runIf(haveCli)("hint's per-command qualifiers match the real parser", () => {
  const FLAG_VALUE: Record<string, string | undefined> = {
    "--decider-dir": "/tmp/ach-probe",
    "--decider-cmd": "cat",
    "--decider-llm": undefined,
  };

  it("parsed a non-empty qualifier set (guards against a hint reword silently emptying this test)", async () => {
    const claims = [...(await hint()).matchAll(/(--decider-[a-z]+)[^\n[]*\[([^\]]+)\]/g)];
    expect(claims.length).toBe(3);
  });

  it("every command the hint CLAIMS accepts a flag really does, and every one it omits really doesn't", async () => {
    const { skillDir, scenario } = fixtures();
    const positionals: Record<string, string[]> = {
      skill: [skillDir, "do the thing"],
      run: [scenario],
      record: [scenario],
    };
    const claims = [...(await hint()).matchAll(/(--decider-[a-z]+)[^\n[]*\[([^\]]+)\]/g)];

    const problems: string[] = [];
    for (const [, flag, list] of claims) {
      const claimed = new Set(list.split("·").map((s) => s.trim()));
      for (const cmd of Object.keys(positionals)) {
        const actual = accepts(cmd, positionals[cmd], flag, FLAG_VALUE[flag]);
        if (claimed.has(cmd) !== actual) {
          problems.push(
            `${flag}: hint ${claimed.has(cmd) ? "claims" : "omits"} \`${cmd}\`, but the parser ${actual ? "accepts" : "rejects"} it`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("sanity: the probe can detect a rejection (else the test above passes vacuously)", () => {
    const { scenario } = fixtures();
    // `record` genuinely does not take --decider-cmd. If this ever reports "accepts", the oracle is broken.
    expect(accepts("record", [scenario], "--decider-cmd", "cat")).toBe(false);
  });
});
