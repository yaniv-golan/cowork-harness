import { describe, it, expect } from "vitest";
import { Assertion } from "../src/types.js";
import { groupAssertionKeys } from "../src/cli.js";

// `assertions --list` groups assertion keys into families so a reader looking for one ("how do I prove a gate
// still fires?") isn't scanning a flat dump. The grouping is a READING AID, not a contract — the JSON
// envelope stays flat, and these titles are human text under SPEC §12.
//
// What this guard actually enforces: the `Other` bucket stays EMPTY. Adding an assertion key then forces
// a conscious family choice instead of silently appending to a list nobody reads — the same discipline
// `scenario-docs-sync` applies by demanding a doc row for every key.

const keys = Object.keys(Assertion.shape).map((key) => ({ key }));

describe("assertions --list families", () => {
  it("classifies every key exactly once, with nothing left over", () => {
    const groups = groupAssertionKeys(keys);
    const placed = groups.flatMap((g) => g.members.map((m) => m.key));

    // The failure this exists for: a newly added key falls through to `Other`.
    const other = groups.find((g) => g.title === "Other");
    expect(
      other?.members.map((m) => m.key) ?? [],
      "unclassified assertion key(s) — add them to a family in groupAssertionKeys (src/cli.ts)",
    ).toEqual([]);

    // No key silently duplicated into two families (first-match-wins should make this impossible, but
    // the ordering is hand-maintained and a future edit could split one rule into two overlapping ones).
    expect([...new Set(placed)].length).toBe(placed.length);
    // Nothing dropped.
    expect(placed.sort()).toEqual(keys.map((k) => k.key).sort());
  });

  it("puts the gate keys where someone hunting for a gate floor would look", () => {
    const gates = groupAssertionKeys(keys).find((g) => g.title.startsWith("Gates"));
    expect(gates?.members.map((m) => m.key).sort()).toEqual(
      [
        "gate_answer_count_min",
        "gate_answers_delivered",
        "question_asked",
        "question_context",
        "question_option_count",
        "question_options",
        "questions_count_max",
      ].sort(),
    );
  });

  it("order matters: a path-denial key is not swallowed by a broader family", () => {
    // `no_vm_path_file_op` and `transcript_no_host_path` read like tool/transcript keys but belong with
    // path denial; this pins the first-match-wins ordering that puts them there.
    const paths = groupAssertionKeys(keys).find((g) => g.title.startsWith("Path denial"));
    expect(paths?.members.map((m) => m.key)).toContain("no_vm_path_file_op");
    expect(paths?.members.map((m) => m.key)).toContain("transcript_no_host_path");
  });
});
