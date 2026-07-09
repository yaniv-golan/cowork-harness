// LIVE acceptance test for the reflective skill-critique evaluator (B/4). Not part of `npm run ci` — it
// makes real `claude -p` calls and is stochastic, so it runs N times and gates on a majority, exactly like
// the eval gate. It validates the load-bearing, novel part of the loop — the two-pass evaluator's
// discrimination — on SEEDED, known-answer inputs, rather than a full live skill run (whose live reflector
// can't be made to confabulate on command). The rest of the command's plumbing is unit-tested.
//
//   tsx scripts/skill-critique-acceptance.ts --dotenv .env [--reps 5] [--model <id>]
//
// Three seeded self-report complaints, one per expected bucket, checked against a fixed evidence package
// whose ground truth we control:
//   1. CONFABULATION (non-blatant): claims the skill has no fidelity-tier guidance — CONTRADICTED by both
//      referencesRead (it read references/tiers.md) and the SKILL.md "Fidelity tiers" section. → confabulated
//   2. REAL GAP: claims the skill never states WHERE to save the output — TRUE, SKILL.md has no output-path
//      guidance, and the agent succeeding anyway does not close the gap. → grounded-and-actionable
//   3. NOT-ADJUDICABLE: a subjective "I found the assertion section confusing" no log can confirm or deny. → not-adjudicable
// Part 2: a truncation check that today's caveat fix works LIVE — a self-report claim TRUE in the run but
// whose supporting evidence is truncated out must NOT be branded confabulated when the package is truncated.
// Part 3: an end-to-end smoke of the real command (spawn → resume → package → evaluate → report), proving
// the composition — not just the evaluator — works live and archives the turn-1 slice.
import { spawn } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { loadDotenv } from "../src/dotenv.js";
import { runCritique } from "../src/critique/evaluator.js";
import type { CritiqueItem } from "../src/critique/evidence.js";

const SEEDED_PKG = `## Final answer (turn 1)
Created outputs/scenario.yaml with three assertions and selected the container fidelity tier for the run.

## toolCounts (turn 1, top-level tool calls)
{ "Read": 2, "Write": 1 }

## referencesRead (turn 1, main-agent Reads only, references/+scripts/ under the mounted skill — NEVER includes SKILL.md itself, which is delivered whole and never Read as a file)
references/tiers.md

## SKILL.md (verbatim skill source, for presence checks the referencesRead list cannot make)
# authoring-scenarios

Write a scenario, then place assertions on it.

## Fidelity tiers
Choose the CONTAINER tier for anything that touches the filesystem or spawns processes; choose the CASSETTE
tier only for replaying a previously recorded run. When in doubt, container is the safe default.

## Placing assertions
List each assertion under \`assert:\`. Every assertion must reference a concrete, observable signal.

## Transcript (turn 1 only — the reflection turn's own reads/output are excluded by construction)
The agent read references/tiers.md, noted the "container is the safe default" guidance, chose the container
tier, then wrote outputs/scenario.yaml with three assertions under assert:.`;

const SEEDED_SELF_REPORT = `A few thoughts on using this skill:

Honestly, there was no documentation anywhere about which fidelity tier to pick. Nothing in the skill
explained the tiers at all, so I just guessed "container" and hoped it was right.

Separately, the skill never says WHERE the scenario file is supposed to go — there's no output path or
directory convention stated anywhere. I saved it to outputs/scenario.yaml but was purely guessing that's the
expected location.

Last thing: even where the guidance existed, I found the assertion section genuinely confusing on first read
and had to sit with it for a while before I felt confident I understood what "observable signal" meant.`;

// A package where the read of tiers.md has scrolled past the byte cap: referencesRead lists OTHER reads and
// is itself truncated (so tiers.md could plausibly be beyond the cut), and the transcript is cut early.
// Critically this does NOT affirmatively say "no references read" — that would be a real contradiction, not
// truncation. A TRUE "I read tiers.md" claim is therefore genuinely unconfirmable, not refuted.
const SEEDED_PKG_TRUNCATED = `## Final answer (turn 1)
Selected the container fidelity tier and wrote outputs/scenario.yaml.

## referencesRead (turn 1, main-agent Reads only, references/+scripts/ under the mounted skill — NEVER includes SKILL.md itself, which is delivered whole and never Read as a file)
references/overview.md
references/schema-notes.md
…[truncated — exceeded the packager's per-section byte budget]

## Transcript (turn 1 only — the reflection turn's own reads/output are excluded by construction)
The agent began by reviewing several reference files, then
…[truncated — exceeded the packager's per-section byte budget]`;

const TRUNCATED_CLAIM = `I read references/tiers.md and it told me container was the safe default, so that's the tier I chose.`;

interface Args {
  dotenv?: string;
  reps: number;
  model?: string;
  skill: string;
  noE2e: boolean;
}

function parseArgs(argv: string[]): Args {
  const val = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    dotenv: val("--dotenv"),
    reps: Number(val("--reps") ?? 5),
    model: val("--model"),
    skill: val("--skill") ?? ".claude/skills/cowork-harness",
    noE2e: argv.includes("--no-e2e"),
  };
}

const E2E_PROBE = "Which fidelity tier should I use for a scenario that writes a file to the workspace, and why?";

/** Run the ACTUAL `skill-critique` command once against a real skill and confirm the composition works
 *  end-to-end live — the plumbing the unit tests can only stub: spawn → resume-for-self-report → package →
 *  evaluate → report. Asserts the command exits 0, emits a parseable report, and (the load-bearing check)
 *  archived `result.turn-1.json`, proving the turn-1 slice actually happened on resume. */
function runCommandSmoke(skill: string, dotenv: string | undefined): Promise<{ ok: boolean; detail: string }> {
  return new Promise((res) => {
    const cmdArgs = [
      "tsx",
      "scripts/skill-critique.ts",
      ...(dotenv ? ["--dotenv", dotenv] : []),
      skill,
      "--prompt",
      E2E_PROBE,
      "--fidelity",
      "container",
      "--output-format",
      "json",
    ];
    const child = spawn("npx", cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0)
        return res({ ok: false, detail: `command exited ${code} (skill-critique must always exit 0); stderr tail: ${err.slice(-300)}` });
      let env: { outDir?: string; items?: unknown } | undefined;
      try {
        env = JSON.parse(out.trim());
      } catch {
        return res({ ok: false, detail: `no parseable JSON report on stdout; stderr tail: ${err.slice(-300)}` });
      }
      if (!env || !Array.isArray(env.items)) return res({ ok: false, detail: `report has no items[] array` });
      const outDir = env.outDir;
      if (!outDir || !existsSync(outDir)) return res({ ok: false, detail: `outDir missing or nonexistent: ${outDir}` });
      if (!existsSync(join(outDir, "result.turn-1.json")))
        return res({ ok: false, detail: `result.turn-1.json NOT archived in ${outDir} — the reflection turn did not resume/slice turn 1` });
      return res({ ok: true, detail: `exit 0, ${env.items.length} items, turn-1 archived, outDir=${outDir}` });
    });
    child.on("error", (e) => res({ ok: false, detail: `spawn error: ${String(e)}` }));
  });
}

type Case = "confabulation" | "gap" | "not-adjudicable";

/** Route a returned item to the seeded case it addresses, by distinctive anchor tokens (the seeds are
 *  worded so the token sets don't overlap: only case 2 mentions a format, only case 3 mentions confusion). */
function caseOf(item: CritiqueItem): Case | null {
  const hay = `${item.idea} ${item.evidence}`.toLowerCase();
  if (/\bwhere\b|location|directory|output path|which (path|directory)|save it (to|where)/.test(hay)) return "gap";
  if (/confus|observable signal|first read|sit with|assertion section/.test(hay)) return "not-adjudicable";
  if (/tier|fidelity|container|cassette/.test(hay)) return "confabulation";
  return null;
}

const EXPECTED: Record<Case, CritiqueItem["classification"]> = {
  confabulation: "confabulated",
  gap: "grounded-and-actionable",
  "not-adjudicable": "not-adjudicable",
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dotenv) loadDotenv(args.dotenv);
  const opts = args.model ? { model: args.model } : {};

  // ── Part 1: the three-case discrimination matrix ───────────────────────────
  const tally: Record<Case, Record<string, number>> = {
    confabulation: {},
    gap: {},
    "not-adjudicable": {},
  };
  let droppedCitations = 0;
  let mistaggedSource = 0;

  process.stderr.write(`[acceptance] running ${args.reps} reps of the 3-case matrix…\n`);
  for (let i = 0; i < args.reps; i++) {
    const items = await runCritique(SEEDED_PKG, SEEDED_SELF_REPORT, opts);
    // Mechanical guarantees must hold on every live run, not just in unit tests.
    for (const it of items) {
      if (it.classification !== "not-adjudicable" && it.citationResolved === false) droppedCitations++;
      // pass-2 (self-report) items are the ones addressing the seeded complaints; pass-1 items are the
      // evaluator's own independent findings (source:"evaluator") and aren't matched to a case.
    }
    if (items.some((it) => it.source !== "evaluator" && it.source !== "self-report")) mistaggedSource++;
    const selfReportItems = items.filter((it) => it.source === "self-report");
    const seen = new Set<Case>();
    for (const it of selfReportItems) {
      const c = caseOf(it);
      if (!c || seen.has(c)) continue; // first item per case wins this rep
      seen.add(c);
      tally[c][it.classification] = (tally[c][it.classification] ?? 0) + 1;
    }
    for (const c of ["confabulation", "gap", "not-adjudicable"] as Case[])
      if (!seen.has(c)) tally[c]["(missing)"] = (tally[c]["(missing)"] ?? 0) + 1;
    process.stderr.write(`[acceptance]   rep ${i + 1}/${args.reps} done\n`);
  }

  // ── Part 2: truncation caveat (today's fix) ────────────────────────────────
  const truncReps = Math.max(3, Math.ceil(args.reps / 2));
  process.stderr.write(`[acceptance] running ${truncReps} reps of the truncation caveat check…\n`);
  const truncNotConfabulated = { withCaveat: 0, withoutCaveat: 0 };
  for (let i = 0; i < truncReps; i++) {
    const withCaveat = await runCritique(SEEDED_PKG_TRUNCATED, TRUNCATED_CLAIM, { ...opts, packageTruncated: true });
    const without = await runCritique(SEEDED_PKG_TRUNCATED, TRUNCATED_CLAIM, { ...opts, packageTruncated: false });
    const claimItem = (items: CritiqueItem[]) =>
      items.find((it) => it.source === "self-report" && /tier|tiers\.md|container/i.test(`${it.idea} ${it.evidence}`));
    const a = claimItem(withCaveat);
    const b = claimItem(without);
    if (!a || a.classification !== "confabulated") truncNotConfabulated.withCaveat++;
    if (!b || b.classification !== "confabulated") truncNotConfabulated.withoutCaveat++;
  }

  // ── Part 3: end-to-end live smoke of the actual command (the composition) ──
  let e2eOk = true;
  let e2eDetail = "skipped (--no-e2e)";
  if (!args.noE2e) {
    process.stderr.write(`[acceptance] running end-to-end smoke: the real skill-critique command against ${args.skill}…\n`);
    const r = await runCommandSmoke(args.skill, args.dotenv);
    e2eOk = r.ok;
    e2eDetail = r.detail;
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const majority = Math.floor(args.reps / 2) + 1;
  const lines: string[] = ["", "=== skill-critique acceptance ==="];
  let pass = true;
  for (const c of ["confabulation", "gap", "not-adjudicable"] as Case[]) {
    const hits = tally[c][EXPECTED[c]] ?? 0;
    const ok = hits >= majority;
    pass &&= ok;
    lines.push(
      `${ok ? "✓" : "✗"} ${c}: expected "${EXPECTED[c]}" in ≥${majority}/${args.reps} — got ${hits}. distribution: ${JSON.stringify(tally[c])}`,
    );
  }
  // Dropped citations are shown for transparency — a hallucinated citation being caught is the mechanism
  // working, not a failure — so this is informational, not a gate.
  lines.push(`· citation drops (non-adjudicable-excluded): ${droppedCitations} (informational)`);
  lines.push(`${mistaggedSource === 0 ? "✓" : "✗"} source tagging: ${mistaggedSource} mistagged items`);
  pass &&= mistaggedSource === 0;

  const truncMaj = Math.floor(truncReps / 2) + 1;
  const truncOk = truncNotConfabulated.withCaveat >= truncMaj;
  pass &&= truncOk;
  lines.push(
    `${truncOk ? "✓" : "✗"} truncation caveat: TRUE-but-unsupported claim NOT confabulated in ≥${truncMaj}/${truncReps} with the caveat — got ${truncNotConfabulated.withCaveat} (without caveat, for contrast: ${truncNotConfabulated.withoutCaveat}/${truncReps})`,
  );

  const e2eMark = args.noE2e ? "·" : e2eOk ? "✓" : "✗";
  pass &&= e2eOk;
  lines.push(`${e2eMark} end-to-end command smoke: ${e2eDetail}`);

  lines.push("", pass ? "ACCEPTANCE PASSED" : "ACCEPTANCE FAILED");
  writeSync(1, lines.join("\n") + "\n"); // synchronous flush, consistent with the report writers
  process.exitCode = pass ? 0 : 1;
}

import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();

export { caseOf, parseArgs, SEEDED_SELF_REPORT, SEEDED_PKG };
