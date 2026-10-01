import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRefDoc, addRefDocs, composeKey, freezeRef, readRefDoc, readRefEntry, verifyStore, type RefSource } from "../src/refs/store.js";
import { createHash } from "node:crypto";
import { FsRefusal } from "../src/hillclimb/fs.js";

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
const META = { harnessVersion: "4.3.0", composerId: "c1", scenario: "case_1", taskSha256: "f".repeat(64) };
const K1 = composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
const K2 = composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: ["outputs/report.md"] });

describe("composeKey", () => {
  it("is stable, order-insensitive over evidence_files, and moves with every input", () => {
    expect(composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: ["b", "a"] })).toBe(
      composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: ["a", "b"] }),
    );
    expect(
      new Set([
        K1,
        K2,
        composeKey("c2", { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined }),
        composeKey("c1", { includeSubagentText: true, includeForkResults: false, evidenceFiles: undefined }),
      ]).size,
    ).toBe(4);
    expect(K1).toMatch(/^[0-9a-f]{16}$/);
  });
  it("include_fork_results is part of the key", () => {
    expect(composeKey("c1", { includeSubagentText: false, includeForkResults: true, evidenceFiles: undefined })).not.toBe(K1);
  });
  it("does not conflate an absent scope with an empty-string glob", () => {
    expect(composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined })).not.toBe(
      composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: [""] }),
    );
  });
});

describe("freezeRef", () => {
  it("freezes once and reads back with integrity", () => {
    expect(freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, META).status).toBe("frozen");
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ status: "ok", text: "DOC ONE" });
  });

  it("never overwrites: a second freeze reports exists and the bytes are unchanged", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "FIRST" }, META);
    const r = freezeRef(store, "case_1", { ...SRC, rep: 1 }, { [K1]: "SECOND" }, META);
    expect(r.status).toBe("exists");
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ status: "ok", text: "FIRST" });
  });

  it.each(["case_1", "case_1.html", "case_1.txt", "case_1.json"])(
    "a pre-existing %s (any scaffold REF_EXTS spelling) blocks the freeze",
    (name) => {
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, name), "hand-placed");
      expect(freezeRef(store, "case_1", SRC, { [K1]: "X" }, META).status).toBe("exists");
      expect(readFileSync(join(store, name), "utf8")).toBe("hand-placed");
    },
  );

  it("a planted symlink at the entry name counts as present and is never followed", () => {
    mkdirSync(store, { recursive: true });
    mkdirSync(join(tmp, "elsewhere"));
    symlinkSync(join(tmp, "elsewhere"), join(store, "case_1"));
    expect(freezeRef(store, "case_1", SRC, { [K1]: "X" }, META).status).toBe("exists");
    expect(readdirSync(join(tmp, "elsewhere"))).toEqual([]);
  });

  it("refuses a case id that is not path-safe", () => {
    expect(() => freezeRef(store, "../x", SRC, { [K1]: "X" }, META)).toThrow(/path-safe/);
  });

  it("refuses a symlinked store directory", () => {
    mkdirSync(join(tmp, "baseline"), { recursive: true });
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), store);
    expect(() => freezeRef(store, "case_1", SRC, { [K1]: "X" }, META)).toThrow(/symlink/);
  });

  it("leaves no temp dir behind on success", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "X" }, META);
    expect(readdirSync(store).filter((n) => n.startsWith("."))).toEqual([]);
  });
});

describe("readRefDoc", () => {
  beforeEach(() => {
    freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, META);
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
    freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, META);
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
    freezeRef(store, "case_1", SRC, { [K1]: "A" }, META);
    freezeRef(store, "case_2", SRC, { [K1]: "B" }, META);
    expect(verifyStore(store)).toMatchObject({ entries: ["case_1", "case_2"], problems: [] });
    writeFileSync(join(store, "case_2", `doc-${K1}.txt`), "tampered");
    expect(verifyStore(store).problems.map((p) => p.caseId)).toEqual(["case_2"]);
  });
  it("reports a leftover temp dir as a NOTE, not a problem", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "A" }, META);
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

describe("relative store paths", () => {
  it("a relative store dir works end to end (method paths are built from the resolved root)", () => {
    const prev = process.cwd();
    process.chdir(tmp); // the default forks pool allows it; restored below
    try {
      const rel = "./relstore/ref"; // a CLI spelling: './' prefix, nested, no '..'
      expect(freezeRef(rel, "case_1", SRC, { [K1]: "R" }, META).status).toBe("frozen");
      expect(readRefDoc(rel, "case_1", K1)).toMatchObject({ status: "ok", text: "R" });
      expect(addRefDoc(rel, "case_1", K2, "R2", { resultSha256: SRC.resultSha256, composerId: "c1" }).status).toBe("added");
      expect(verifyStore(rel)).toMatchObject({ entries: ["case_1"], problems: [] });
    } finally {
      process.chdir(prev);
    }
  });
});

describe("review fixes — identity, atomic multi-doc freeze, concurrent add", () => {
  it("records the scenario name and task hash, and returns them on read", () => {
    freezeRef(
      store,
      "case_1",
      SRC,
      { [K1]: "D" },
      { harnessVersion: "t", composerId: "c1", scenario: "case 1", taskSha256: "f".repeat(64) },
    );
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ status: "ok", scenario: "case 1", taskSha256: "f".repeat(64) });
  });
  it("freezes several documents at once, each with its own unchecked flag", () => {
    freezeRef(store, "case_1", SRC, { [K1]: "A", [K2]: { text: "B", unchecked: true } }, META);
    expect(readRefDoc(store, "case_1", K1)).not.toHaveProperty("unchecked");
    expect(readRefDoc(store, "case_1", K2)).toMatchObject({ text: "B", unchecked: true });
  });
  it("a half-written document beside an add is a typed refusal (FsRefusal), never a raw errno", () => {
    // The exact race (two adds both pass inspection, one wins the exclusive create) cannot be produced
    // synchronously; addRefDoc maps that EEXIST to "exists". What IS observable: the debris such a race or crash
    // leaves is an integrity refusal the CLI reports as exit 2.
    freezeRef(store, "case_1", SRC, { [K1]: "A" }, META);
    writeFileSync(join(store, "case_1", `doc-${K2}.txt`), "raced");
    expect(() => addRefDoc(store, "case_1", K2, "B", { resultSha256: SRC.resultSha256, composerId: "c1" })).toThrow(FsRefusal);
  });
});

describe("task identity and ref.json protection", () => {
  const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
  const entry = (): string => join(store, "case_1");
  const refJson = (): string => join(entry(), "ref.json");
  const sidecars = (): string[] => readdirSync(entry()).filter((n) => n.startsWith("doc-") && n.endsWith(".json"));
  /** Rewrite ref.json AND every sidecar's recorded ref.json hash consistently — a forge the hash cannot see. */
  function forge(edit: (m: Record<string, unknown>) => void): void {
    const m = JSON.parse(readFileSync(refJson(), "utf8")) as Record<string, unknown>;
    edit(m);
    const bytes = JSON.stringify(m, null, 2) + "\n";
    writeFileSync(refJson(), bytes);
    for (const s of sidecars()) {
      const side = JSON.parse(readFileSync(join(entry(), s), "utf8")) as Record<string, unknown>;
      side.refJsonSha256 = sha(bytes);
      writeFileSync(join(entry(), s), JSON.stringify(side, null, 2) + "\n");
    }
  }
  const everyReader = (): Array<{ status: string; why?: string }> => [
    readRefDoc(store, "case_1", K1) as { status: string; why?: string },
    readRefEntry(store, "case_1") as { status: string; why?: string },
    { status: verifyStore(store).problems.length ? "integrity" : "ok", why: verifyStore(store).problems[0]?.why },
  ];

  beforeEach(() => {
    freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, META);
  });

  it("every sidecar records the sha256 of the ref.json bytes it was frozen with", () => {
    const want = sha(readFileSync(refJson(), "utf8"));
    for (const s of sidecars()) expect(JSON.parse(readFileSync(join(entry(), s), "utf8")).refJsonSha256).toBe(want);
  });

  it("deleting taskSha256 from ref.json is an integrity failure for every reader", () => {
    const m = JSON.parse(readFileSync(refJson(), "utf8")) as Record<string, unknown>;
    delete m.taskSha256;
    writeFileSync(refJson(), JSON.stringify(m, null, 2) + "\n");
    for (const r of everyReader()) expect(r.status).toBe("integrity");
  });

  it("an entry without a task identity — even with consistent hashes — is integrity, by its own message", () => {
    forge((m) => delete m.taskSha256);
    for (const r of everyReader())
      expect(r).toMatchObject({ status: "integrity", why: expect.stringMatching(/frozen without a task identity/) });
  });

  it("an entry without a scenario name — even with consistent hashes — is integrity", () => {
    forge((m) => delete m.scenario);
    for (const r of everyReader())
      expect(r).toMatchObject({ status: "integrity", why: expect.stringMatching(/frozen without a task identity/) });
  });

  it("editing `scenario` in ref.json (a hash mismatch) is an integrity failure for every reader", () => {
    const m = JSON.parse(readFileSync(refJson(), "utf8")) as Record<string, unknown>;
    m.scenario = "another scenario";
    writeFileSync(refJson(), JSON.stringify(m, null, 2) + "\n");
    for (const r of everyReader()) expect(r).toMatchObject({ status: "integrity", why: expect.stringMatching(/ref\.json/) });
  });

  it("editing taskSha256 in ref.json is an integrity failure (a retargeted reference)", () => {
    const m = JSON.parse(readFileSync(refJson(), "utf8")) as Record<string, unknown>;
    m.taskSha256 = "0".repeat(64);
    writeFileSync(refJson(), JSON.stringify(m, null, 2) + "\n");
    expect(readRefDoc(store, "case_1", K1).status).toBe("integrity");
  });

  it("addRefDoc records the hash of the UNCHANGED ref.json, which it never rewrites", () => {
    const before = readFileSync(refJson(), "utf8");
    expect(addRefDoc(store, "case_1", K2, "DOC TWO", { resultSha256: SRC.resultSha256, composerId: "c1" }).status).toBe("added");
    expect(readFileSync(refJson(), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(entry(), `doc-${K2}.json`), "utf8")).refJsonSha256).toBe(sha(before));
    expect(readRefDoc(store, "case_1", K2)).toMatchObject({ status: "ok", text: "DOC TWO" });
    expect(verifyStore(store).problems).toEqual([]);
  });
});

describe("addRefDocs — every key is checked before any is written", () => {
  beforeEach(() => {
    freezeRef(store, "case_1", SRC, { [K1]: "DOC ONE" }, META);
  });
  it("a malformed second key refuses the whole add and writes nothing", () => {
    const before = readdirSync(join(store, "case_1")).sort();
    expect(() =>
      addRefDocs(
        store,
        "case_1",
        [
          { key: K2, text: "DOC TWO" },
          { key: "not-a-key", text: "BAD" },
        ],
        { resultSha256: SRC.resultSha256, composerId: "c1", taskSha256: META.taskSha256 },
      ),
    ).toThrow(FsRefusal);
    expect(readdirSync(join(store, "case_1")).sort()).toEqual(before);
    expect(verifyStore(store).problems).toEqual([]);
  });
  it("a different task refuses and writes nothing", () => {
    const before = readdirSync(join(store, "case_1")).sort();
    expect(() =>
      addRefDocs(store, "case_1", [{ key: K2, text: "X" }], {
        resultSha256: SRC.resultSha256,
        composerId: "c1",
        taskSha256: "0".repeat(64),
      }),
    ).toThrow(/different task/);
    expect(readdirSync(join(store, "case_1")).sort()).toEqual(before);
  });
  it("adds the new keys and reports the existing ones", () => {
    expect(
      addRefDocs(
        store,
        "case_1",
        [
          { key: K1, text: "OTHER" },
          { key: K2, text: "DOC TWO" },
        ],
        { resultSha256: SRC.resultSha256, composerId: "c1", taskSha256: META.taskSha256 },
      ),
    ).toEqual({ added: [K2], existing: [K1] });
    expect(readRefDoc(store, "case_1", K1)).toMatchObject({ text: "DOC ONE" });
  });
  it("freezeRef refuses an entry without a task identity and writes nothing", () => {
    expect(() => freezeRef(store, "case_9", SRC, { [K1]: "X" }, { ...META, taskSha256: "" })).toThrow(/task identity/);
    expect(() => freezeRef(store, "case_9", SRC, { [K1]: "X" }, { ...META, scenario: undefined as unknown as string })).toThrow(
      /task identity/,
    );
    expect(existsSync(join(store, "case_9"))).toBe(false);
  });
  it("freezeRef refuses a malformed key and writes nothing", () => {
    expect(() => freezeRef(store, "case_9", SRC, { "not-a-key": "X" }, META)).toThrow(/compose key/);
    expect(existsSync(join(store, "case_9"))).toBe(false);
  });
});
