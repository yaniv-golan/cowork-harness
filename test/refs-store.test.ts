import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRefDoc, composeKey, freezeRef, readRefDoc, verifyStore, type RefSource } from "../src/refs/store.js";

let tmp: string;
let store: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "refs-")));
  store = join(tmp, "baseline", "ref");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SRC: RefSource = {
  command: "hillclimb run",
  variant: "baseline",
  rep: 0,
  runDir: "~/runs/x",
  resultSha256: "a".repeat(64),
  sessionId: "s1",
};
const K1 = composeKey("c1", false, undefined);
const K2 = composeKey("c1", false, ["outputs/report.md"]);

describe("composeKey", () => {
  it("is stable, order-insensitive over evidence_files, and moves with every input", () => {
    expect(composeKey("c1", false, ["b", "a"])).toBe(composeKey("c1", false, ["a", "b"]));
    expect(new Set([K1, K2, composeKey("c2", false, undefined), composeKey("c1", true, undefined)]).size).toBe(4);
    expect(K1).toMatch(/^[0-9a-f]{16}$/);
  });
  it("does not conflate an absent scope with an empty-string glob", () => {
    expect(composeKey("c1", false, undefined)).not.toBe(composeKey("c1", false, [""]));
  });
});

describe("freezeRef", () => {
  it("freezes once and reads back with integrity", () => {
    expect(freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, { harnessVersion: "4.3.0", composerId: "c1" }).status).toBe("frozen");
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ status: "ok", text: "DOC ONE" });
  });

  it("never overwrites: a second freeze reports exists and the bytes are unchanged", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "FIRST" }, { harnessVersion: "4.3.0", composerId: "c1" });
    const r = freezeRef(store, "case_1", { ...SRC, rep: 1 }, { [K1]: "SECOND" }, { harnessVersion: "4.3.0", composerId: "c1" });
    expect(r.status).toBe("exists");
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ status: "ok", text: "FIRST" });
  });

  it.each(["case_1", "case_1.html", "case_1.txt", "case_1.json"])(
    "a pre-existing %s (any scaffold REF_EXTS spelling) blocks the freeze",
    (name) => {
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, name), "hand-placed");
      expect(freezeRef(store, "case_1", SRC, { [K1]: "X" }, { harnessVersion: "4.3.0", composerId: "c1" }).status).toBe("exists");
      expect(readFileSync(join(store, name), "utf8")).toBe("hand-placed");
    },
  );

  it("a planted symlink at the entry name counts as present and is never followed", () => {
    mkdirSync(store, { recursive: true });
    mkdirSync(join(tmp, "elsewhere"));
    symlinkSync(join(tmp, "elsewhere"), join(store, "case_1"));
    expect(freezeRef(store, "case_1", SRC, { [K1]: "X" }, { harnessVersion: "4.3.0", composerId: "c1" }).status).toBe("exists");
    expect(readdirSync(join(tmp, "elsewhere"))).toEqual([]);
  });

  it("refuses a case id that is not path-safe", () => {
    expect(() => freezeRef(store, "../x", SRC, { [K1]: "X" }, { harnessVersion: "4.3.0", composerId: "c1" })).toThrow(/path-safe/);
  });

  it("refuses a symlinked store directory", () => {
    mkdirSync(join(tmp, "baseline"), { recursive: true });
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), store);
    expect(() => freezeRef(store, "case_1", SRC, { [K1]: "X" }, { harnessVersion: "4.3.0", composerId: "c1" })).toThrow(/symlink/);
  });

  it("leaves no temp dir behind on success", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "X" }, { harnessVersion: "4.3.0", composerId: "c1" });
    expect(readdirSync(store).filter((n) => n.startsWith("."))).toEqual([]);
  });
});

describe("readRefDoc", () => {
  beforeEach(() => {
    freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, { harnessVersion: "4.3.0", composerId: "c1" });
  });
  it("missing entry / missing compose key are distinct from integrity", () => {
    expect(readRefDoc(store, "case_2", K1).status).toBe("missing");
    expect(readRefDoc(store, "case_1", K2).status).toBe("missing");
  });
  it("a flipped byte is an integrity failure, never served", () => {
    const f = readdirSync(join(store, "case_1")).find((n) => n.endsWith(".txt"))!;
    writeFileSync(join(store, "case_1", f), "DOC 0NE");
    const r = readRefDoc(store, "case_1", K1);
    expect(r.status).toBe("integrity");
    expect("text" in r).toBe(false);
  });
  it("a doc replaced by a symlink is an integrity failure and its target is never read", () => {
    const f = readdirSync(join(store, "case_1")).find((n) => n.endsWith(".txt"))!;
    writeFileSync(join(tmp, "secret"), "SECRET");
    rmSync(join(store, "case_1", f));
    symlinkSync(join(tmp, "secret"), join(store, "case_1", f));
    const r = readRefDoc(store, "case_1", K1);
    expect(r.status).toBe("integrity");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
  it("an unexpected extra file in the entry is an integrity failure", () => {
    writeFileSync(join(store, "case_1", "planted.txt"), "x");
    expect(readRefDoc(store, "case_1", K1).status).toBe("integrity");
  });
});

describe("addRefDoc", () => {
  beforeEach(() => {
    freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, { harnessVersion: "4.3.0", composerId: "c1" });
  });
  it("adds a new compose key from the SAME source run, leaving the existing doc untouched", () => {
    const before = readFileSync(join(store, "case_1", `doc-${K1}.txt`));
    expect(addRefDoc(store, "case_1", K2, "DOC TWO", { resultSha256: SRC.resultSha256, composerId: "c1" }).status).toBe("added");
    expect(readRefDoc(store, "case_1", K2)).toMatchObject({ status: "ok", text: "DOC TWO" });
    expect(readFileSync(join(store, "case_1", `doc-${K1}.txt`))).toEqual(before);
  });
  it("refuses a different source run", () => {
    expect(() => addRefDoc(store, "case_1", K2, "X", { resultSha256: "b".repeat(64), composerId: "c1" })).toThrow(/source run/);
  });
  it("never rewrites an existing compose key", () => {
    expect(addRefDoc(store, "case_1", K1, "OTHER", { resultSha256: SRC.resultSha256, composerId: "c1" }).status).toBe("exists");
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ status: "ok", text: "DOC ONE" });
  });
  it("records an unchecked doc as such", () => {
    addRefDoc(store, "case_1", K2, "DOC TWO", { resultSha256: SRC.resultSha256, composerId: "c1", unchecked: true });
    expect(readRefDoc(store, "case_1", K2)).toMatchObject({ status: "ok", unchecked: true });
  });
});

describe("verifyStore", () => {
  it("is clean for a good store and lists problems per entry", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "A" }, { harnessVersion: "4.3.0", composerId: "c1" });
    freezeRef(store, "case_2", SRC, { [K1]: "B" }, { harnessVersion: "4.3.0", composerId: "c1" });
    expect(verifyStore(store)).toMatchObject({ entries: ["case_1", "case_2"], problems: [] });
    writeFileSync(join(store, "case_2", `doc-${K1}.txt`), "tampered");
    expect(verifyStore(store).problems.map((p) => p.caseId)).toEqual(["case_2"]);
  });
  it("reports a leftover temp dir as a NOTE, not a problem", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "A" }, { harnessVersion: "4.3.0", composerId: "c1" });
    mkdirSync(join(store, ".tmp-dead"));
    const v = verifyStore(store);
    expect(v.problems).toEqual([]);
    expect(v.notes.join("\n")).toMatch(/\.tmp-dead/);
  });
  it("a missing store is reported, not thrown", () => {
    expect(existsSync(join(tmp, "nope"))).toBe(false);
    expect(verifyStore(join(tmp, "nope")).problems[0]?.why).toMatch(/does not exist/);
  });
});
