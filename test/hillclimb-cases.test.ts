// Case resolution for `hillclimb run`. A case id is pathSafeId(<scenario file stem>) — what the user typed
// and what trace filenames carry (addendum Q1) — with the scenario's own name kept in meta. The id space is
// validated before anything is spent (S l.411-438).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCases, selectCases, splitIdNotes } from "../src/hillclimb/cases.js";
import { UsageError } from "../src/errors.js";

let dir: string;
const scenario = (file: string, name: string) =>
  writeFileSync(join(dir, file), `name: ${JSON.stringify(name)}\nfidelity: protocol\nprompt: do the thing\n`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-cases-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadCases", () => {
  it("ids are pathSafeId(file stem); the scenario name is kept beside it", () => {
    scenario("alpha.yaml", "Alpha case");
    scenario("beta two.yml", "beta");
    const { cases } = loadCases(dir);
    expect(cases.map((c) => [c.id, c.stem, c.name])).toEqual([
      ["alpha", "alpha", "Alpha case"],
      [expect.stringMatching(/^beta_two-[0-9a-f]{8}$/), "beta two", "beta"],
    ]);
    expect(cases[1].originalId).toBe("beta two");
    expect(cases[0].originalId).toBeUndefined();
  });

  it("skips YAML without prompt: in a directory (a session file), and says so", () => {
    scenario("alpha.yaml", "a");
    writeFileSync(join(dir, "_session.yaml"), "model: claude-sonnet-4-6\n");
    const { cases, skipped } = loadCases(dir);
    expect(cases.map((c) => c.id)).toEqual(["alpha"]);
    expect(skipped).toEqual(["_session.yaml"]);
  });

  it("case-insensitive twins are refused before spend (S l.415-423)", () => {
    scenario("Case.yaml", "x");
    scenario("case.yml", "y");
    expect(() => loadCases(dir)).toThrow(UsageError);
    expect(() => loadCases(dir)).toThrow(/duplicate case id/);
  });

  it("two rubric claims that normalize alike are refused before spend (they would share a row key)", () => {
    writeFileSync(
      join(dir, "dup.yaml"),
      'name: dup\nfidelity: protocol\nprompt: p\nassert:\n  - semantic_matches:\n      rubric: ["Claim one", "claim  one"]\n',
    );
    expect(() => loadCases(dir)).toThrow(UsageError);
    expect(() => loadCases(dir)).toThrow(/duplicate rubric claim/);
  });

  it("an all-dot stem is refused (the lite report refuses ^\\.+$ ids)", () => {
    scenario("...yaml", "dots");
    expect(() => loadCases(dir)).toThrow(/not a usable case id/);
  });

  it("a missing target or an empty directory is a refusal, never zero cases", () => {
    expect(() => loadCases(join(dir, "nope"))).toThrow(UsageError);
    expect(() => loadCases(dir)).toThrow(UsageError);
  });
});

describe("selectCases (--case)", () => {
  beforeEach(() => {
    scenario("alpha.yaml", "Alpha case");
    scenario("beta.yaml", "beta-name");
  });

  it("no selector selects everything", () => {
    expect(selectCases(loadCases(dir).cases, []).map((c) => c.id)).toEqual(["alpha", "beta"]);
  });

  it("matches the file stem or the scenario name", () => {
    expect(selectCases(loadCases(dir).cases, ["Alpha case"]).map((c) => c.id)).toEqual(["alpha"]);
    expect(selectCases(loadCases(dir).cases, ["beta"]).map((c) => c.id)).toEqual(["beta"]);
  });

  it("a miss is a refusal that lists every id with its name", () => {
    expect(() => selectCases(loadCases(dir).cases, ["gamma"])).toThrow(
      /no case matches "gamma".*alpha \(Alpha case\).*beta \(beta-name\)/s,
    );
  });

  it("a selector matching two different cases is ambiguous and refused", () => {
    scenario("gamma.yaml", "alpha"); // its name equals another file's stem
    expect(() => selectCases(loadCases(dir).cases, ["alpha"])).toThrow(/ambiguous/);
  });
});

describe("splitIdNotes (_state.json train/val/test ids, S l.424-438)", () => {
  const ids = ["alpha", "beta"];
  it("a matching id is silent; a well-formed absent id is a note (trimmed subset run)", () => {
    expect(splitIdNotes({ train_ids: ["alpha"], test_ids: ["gamma"] }, ids)).toEqual([
      "note: split id 'gamma' matches no loaded case (expected for a trimmed subset run)",
    ]);
  });

  it("an id that is not path-safe can never match a row: refused before spend", () => {
    expect(() => splitIdNotes({ test_ids: ["case/1"] }, ids)).toThrow(/split id 'case\/1' is not a path-safe id/);
  });

  it("a split list that is not a list is refused", () => {
    expect(() => splitIdNotes({ val_ids: "alpha" }, ids)).toThrow(/val_ids must be a list of ids/);
  });

  it("numeric ids join by String(), as the adapter does", () => {
    expect(splitIdNotes({ train_ids: [7] }, ["7"])).toEqual([]);
  });
});
