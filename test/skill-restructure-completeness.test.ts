import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// Completeness check for the split of the companion skill's SKILL.md into a short entrypoint plus
// references/. The lists below are FROZEN from SKILL.md as it stood before the split (commit ec7ca3f):
// every section heading, and the first line of every numbered bold item (the 27 gotchas plus the two
// numbered workflows). Each must still appear, as a whole line, in SKILL.md or one of references/*.md.
// A section or gotcha dropped in the move goes red here even if every other guard stays green.
//
// Frozen on purpose: deriving the list from the current files would make the check pass by
// construction. When a later change legitimately rewords one of these lines, update the list in the
// same commit — that edit is the review signal.
const SKILL_DIR = resolve(".claude/skills/cowork-harness");

const FROZEN_HEADINGS = [
  "## Preflight — make sure the harness can actually run",
  "## Orient — the three loops",
  "## Part I — AUTHOR a scenario",
  "### Two files: session vs scenario",
  "### Discovery: how the skill-under-test gets mounted",
  "### Choose a fidelity tier",
  "### Choose an answer path (gates: AskUserQuestion + tool-permission)",
  '#### External deciders and the "first" shorthand',
  "### Assertions: two orthogonal axes",
  "#### Which assertion for which question (goal → key)",
  "### web_fetch (never auto-allowed, two-path)",
  "### Scaffold a valid scenario, then lint before you push",
  "## Part II — RUN, RECORD & LOCK",
  "### Run, then lock determinism",
  "#### Validate a skill against real documents (not a cassette)",
  "#### Interpreting verdict signals",
  "### Measure — before/after, with/without (`--repeat`, `--ablate-skill`)",
  "### Checking whether a background run is alive",
  "### Place assertions in the right CI lane",
  "## Part III — Debug",
  "### Triage — a run misbehaved, or a green looks wrong",
  "### Inspecting a run's observability output",
  "### Debugging with `chat`",
  '## Gotchas — the "✓ passed ≠ correct" landmines',
  "## References",
];

const FROZEN_NUMBERED_ITEMS = [
  '1. **Explore with the LLM decider.** `cowork-harness skill <dir> --decider-llm --intent "<one line of what',
  "2. **Script the load-bearing gates — especially binary confirm gates.** Once you know which gates fire",
  "3. **Budget ~1 re-run per file.** If a gate whiffs, the run does not vanish — it exits non-zero but",
  "4. **Inspect the outputs to judge correctness.** `cowork-harness inspect <run-dir>` shows what the run",
  "5. **For image-only / scanned PDFs, use the full-parity image.** The default agent image omits OCR and",
  "6. **Iterate across fixes — verify before you trust, and don't cross-pair generations.** A green run is",
  // Reworded when a run that resolves no model became a refusal: the item now says where to pin it.
  "1. **Pin the model in the session.** A run that resolves no model is refused, but one pinned only by",
  // Reworded after the split: "commit the skill" became one way to freeze a recoverable source.
  "2. **Freeze a recoverable source first**: commit it, or snapshot the skill folder next to the run dir.",
  "3. **Check which arm you actually ran** before analysing anything: `ablated` and",
  // Reworded after the split: "not invoked" no longer means "answered from priors" (see Recipe 5, step 3).
  "4. **Classify each rep three ways**: invocation (`skillsInvoked`), observed source access (did it read",
  "1. **An assertion passed but tested nothing on the PR gate.** *Why:* on a manifest-less cassette",
  "2. **A steered gate answer never reached the model.** *Why:* `serializeDecision` must emit",
  "3. **A multi-key `assert:` item is an AND.** A single list item with more than one key passes iff",
  '4. **`tool_called` doesn\'t mean "attempted".** Tool counts are authoritative and de-duped: a tool',
  "5. **`subagent_declared_but_unused` fires on declared-but-didn't-use-THAT-tool**, even if the",
  "6. **`dispatch_count_max` is your author-chosen budget UNDER Cowork's production cap, not a",
  "7. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary",
  "8. **Read-only mounts are enforced; delete-deny is a HARNESS gap — production DOES enforce it.**",
  "9. **Keep `.env` out of any mounted folder** — it is copied into the sandbox and the token could",
  "10. **A base64 artifact that was scrubbed at record time will fail artifact assertions at replay.**",
  '11. **An external decider returning `"first"` does not select option 1.** The `"first"` keyword',
  "12. **`prompt_asset_missing` is a WARN, not a hard failure — greens can hide it.** The",
  "13. **`result: success` means the agent didn't error, NOT that the task completed — always assert on",
  '14. **A positional `choose` (`first` / index) is order-dependent.** `choose: "2"` survives label drift',
  "15. **A scripted `choose:` matching no offered option HARD-fails the run — `on_unanswered: first` does NOT",
  "16. **Batch record keeps going — you don't need a one-at-a-time wrapper.** `record <dir>` and `record <dir>",
  "17. **Editing `scenarios/*.yaml` does NOT change a plain `replay` — the WHOLE scenario is frozen, not just",
  "18. **`questions_count_max` counts sub-questions, not gates.** One `AskUserQuestion` tool call can",
  "19. **`gate_answers_delivered` passes vacuously when no gate fires — pair it, or drop it.** Whether a",
  "20. **A `mode: r` connected folder's contents are recorded body-less, not excluded.** `record` captures a",
  "21. **A `fidelity: cowork` cassette can go stale in a way `skill`/`format` drift won't catch.** Its recorded",
  "22. **`lint` floods CI with INFO advisories that don't apply to you.** *Why:* two rules —",
  "23. **`verify-cassettes`/`replay` report a `discovery-surface` note on cassettes you just recorded fine.**",
  "24. **Never name the file-delivery tool in a `SKILL.md`.** *Why:* Cowork has **two**, one per product",
  "25. **Three host-inventory flags — two on `record`, one on `verify-cassettes`.** `record",
  "26. **A `skill`-lane `PASS` does not mean the skill ran, or that the run was the one you wanted.** *Why:*",
  // Reworded when `skill`/`probe-dispatch` gained `--allow-stall`: the lane can now perform the opt-out.
  "27. **`stalled` also fails a complete answer that closes by offering a follow-up.** *Why:* the",
];

function payloadLines(): Set<string> {
  const refs = readdirSync(join(SKILL_DIR, "references")).filter((f) => f.endsWith(".md"));
  const texts = [
    readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"),
    ...refs.map((f) => readFileSync(join(SKILL_DIR, "references", f), "utf8")),
  ];
  return new Set(texts.flatMap((t) => t.split("\n")));
}

describe("skill restructure: nothing from the pre-split SKILL.md was dropped", () => {
  const lines = payloadLines();

  it("the frozen lists are the size they were frozen at (guards an accidental truncation)", () => {
    expect(FROZEN_HEADINGS.length).toBe(25);
    expect(FROZEN_NUMBERED_ITEMS.length).toBe(37);
  });

  it.each(FROZEN_HEADINGS)("heading still present: %s", (h) => {
    // The References heading was retitled in the entrypoint; every other heading moved byte-identical.
    if (h === "## References") expect([...lines].some((l) => l.startsWith("## References"))).toBe(true);
    else expect(lines.has(h)).toBe(true);
  });

  it.each(FROZEN_NUMBERED_ITEMS)("numbered item still present: %s", (item) => {
    expect(lines.has(item)).toBe(true);
  });
});
