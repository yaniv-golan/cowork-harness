import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Desktop's elicitation form sends its answers as the next user message. These two fixtures are that message, in
// the shape a real one has: each is modelled on one real Cowork reply (its title shape, its fields in order, which
// of them are a date, a multi-select, a quoted value, a ` / `-flattened value or a folded one, and how many lines a
// folded value spans), with every title, label and value replaced. The tests below pin both to the serializer.

/** The reply format, implemented here from the behaviour of Desktop 2.26454.2's form widget (read from its bundle,
 *  and matching six real replies): the reference the fixtures and the docs are checked against, not harness code. */
const FOLD_OVER = 200;
const QUOTE_OVER = 80;
const EMPTY_FORM = "proceeding with defaults.";

function labelOf(fieldName: string): string {
  const suffixes: Array<[string, string]> = [
    ["_other", " (other)"],
    ["_file", " file"],
    ["_text", ""],
  ];
  const hit = suffixes.find(([s]) => fieldName.endsWith(s));
  const base = (hit ? fieldName.slice(0, -hit[0].length) : fieldName).replaceAll("_", " ");
  return base.charAt(0).toUpperCase() + base.slice(1) + (hit ? hit[1] : "");
}

function serializeElicitation(title: string | undefined, answers: Record<string, string | string[]>): string {
  const head = title ? `${title} \u2014 ` : "";
  const shown: string[] = [];
  const folded: string[] = [];
  for (const [field, answer] of Object.entries(answers)) {
    if (answer === "" || (Array.isArray(answer) && answer.length === 0)) continue; // a [""] answer still shows, empty
    const text = Array.isArray(answer) ? answer.join(", ") : answer;
    const label = labelOf(field);
    if (text.length > FOLD_OVER) {
      shown.push(`${label}: (${text.length} chars \u2014 see below)`);
      folded.push(`[${label}]\n${text}`);
      continue;
    }
    const oneLine = text.replace(/\r?\n/g, " / ");
    shown.push(`${label}: ${oneLine.length > QUOTE_OVER ? `"${oneLine}"` : oneLine}`);
  }
  const line = head + (shown.length ? shown.join(" \u00b7 ") : EMPTY_FORM);
  return folded.length ? `${line}\n\n--- Full content ---\n${folded.join("\n\n")}` : line;
}

const DIR = resolve("examples/data/form-replies");
const read = (f: string) => readFileSync(resolve(DIR, f), "utf8");

/** The shape of a reply's compact line, field by field. */
function shape(reply: string): string[] {
  const head = reply.split("\n\n--- Full content ---\n")[0]!;
  const rest = head.slice(head.indexOf(" — ") + 3);
  return rest.split(" · ").map((pair) => {
    const value = pair.slice(pair.indexOf(": ") + 2);
    if (/^\(\d+ chars — see below\)$/.test(value)) return "fold";
    if (/^\d{4}-\d\d-\d\d$/.test(value)) return "date";
    if (value.startsWith('"')) return value.includes(" / ") ? "quoted-flattened" : "quoted";
    if (/^[a-z_]+$/.test(value)) return "pill";
    return value.includes(", ") ? "multi" : "plain";
  });
}
/** Lines per folded value, in order. */
function foldLines(reply: string): number[] {
  const folds = reply.split("\n\n--- Full content ---\n")[1];
  if (folds === undefined) return [];
  return folds.split(/\n\n(?=\[)/).map((block) => block.split("\n").length - 1);
}

describe("Desktop form-reply fixtures match the 2.26454.2 serializer byte for byte", () => {
  it("pitch-review.txt: a date, a multi-select, a short value and two folded values (one spanning several lines)", () => {
    const expected = serializeElicitation("Pitch review details", {
      next_board_meeting: "2026-11-12",
      stage_focus: ["Seed", "Series A"],
      team_size: "Six engineers and two in sales",
      recent_traction_text:
        "Revenue grew from a pilot with two design partners to eleven paying teams over the last two quarters. " +
        "Most of the growth came from referrals inside existing customers rather than outbound, and the average " +
        "contract doubled once teams moved from the trial tier to the annual plan. Churn so far is one team, which " +
        "left after an acquisition. Usage is concentrated in weekly planning sessions, with a long tail of ad hoc " +
        "reviews that we have not yet tried to grow on purpose.",
      concerns:
        "Pricing: we have not tested a higher tier yet.\n" +
        "Hiring: the second sales hire is still open after three months.\n" +
        "Competition: a larger vendor announced a similar feature last month.\n" +
        "Runway: fourteen months at the current burn, less if hiring lands.\n" +
        "Board: one seat changes hands after this round.",
    });
    expect(read("pitch-review.txt")).toBe(expected);
  });

  it("deck-review.txt: a pill value, two quoted values (one flattened from blank-line paragraphs) and two folded values", () => {
    const expected = serializeElicitation("Deck review details", {
      audience: "seed_vc_partner",
      company_pitch:
        "We help small finance teams close the month in days instead of weeks by reconciling bank feeds against the ledger automatically.",
      market_notes:
        "The buyers are finance leads at companies with ten to two hundred employees. They already pay for an accounting " +
        "system and a bank feed, and the close is still a spreadsheet exercise. We sell per entity, not per seat.",
      competition:
        "Two incumbents bundle reconciliation into their accounting suites, but both stop at matching transactions and " +
        "leave exceptions to a manual queue. A handful of newer tools target the same gap from the audit side, with " +
        "longer onboarding and a higher floor price than ours.",
      questions_text:
        "Is the market slide too long for a first meeting? \n\nShould the traction chart lead the deck? \n\nWhich metric belongs on slide two? \n\nAnything missing.",
    });
    expect(read("deck-review.txt")).toBe(expected);
  });
});

describe("the fixtures keep the shape of the real replies they were modelled on", () => {
  it("pitch-review.txt: date, multi, plain, fold, fold; the second folded value spans 5 lines", () => {
    const reply = read("pitch-review.txt");
    expect(shape(reply)).toEqual(["date", "multi", "plain", "fold", "fold"]);
    expect(foldLines(reply)).toEqual([1, 5]);
    expect(reply.endsWith("\n")).toBe(false);
  });

  it("deck-review.txt: pill, quoted, fold, fold, quoted-flattened; both folded values are one line", () => {
    const reply = read("deck-review.txt");
    expect(shape(reply)).toEqual(["pill", "quoted", "fold", "fold", "quoted-flattened"]);
    expect(foldLines(reply)).toEqual([1, 1]);
    // A blank line inside a short value flattens to two separators; a trailing space before each newline doubles
    // the space before the first (the real reply carries the same `  /  / `).
    expect(reply).toContain("  /  / ");
  });
});

describe("the serializer facts the docs state", () => {
  it("multi-select values are comma-joined; ` / ` replaces newlines only", () => {
    expect(serializeElicitation("T", { picks: ["A", "B"] })).toBe("T — Picks: A, B");
    expect(serializeElicitation("T", { note: "one\ntwo" })).toBe("T — Note: one / two");
  });
  it("quotes a value longer than 80 characters after flattening, and folds one longer than 200 raw characters", () => {
    expect(serializeElicitation("T", { v: "x".repeat(80) })).toBe(`T — V: ${"x".repeat(80)}`);
    expect(serializeElicitation("T", { v: "x".repeat(81) })).toBe(`T — V: "${"x".repeat(81)}"`);
    expect(serializeElicitation("T", { v: "x".repeat(201) })).toBe(
      `T — V: (201 chars — see below)\n\n--- Full content ---\n[V]\n${"x".repeat(201)}`,
    );
  });
  it("labels drop `_text`, map `_file` and `_other`; empty answers are left out; no header means no title prefix", () => {
    expect(serializeElicitation("T", { contract_text: "a", contract_file: "b", side_other: "c", skipped: "" })).toBe(
      "T — Contract: a · Contract file: b · Side (other): c",
    );
    expect(serializeElicitation("T", { a: "", b: [] })).toBe("T — proceeding with defaults.");
    expect(serializeElicitation(undefined, { a: "x" })).toBe("A: x");
  });
});
