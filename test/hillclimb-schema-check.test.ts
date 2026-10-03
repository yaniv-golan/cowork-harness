import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkFlowDir,
  checkFlowSnapshot,
  isLinkSafeId,
  isPathSafeId,
  loadFlowSnapshot,
  SCHEMA_READING,
  type FlowSnapshot,
  type SchemaCheckReport,
  type SchemaProfile,
} from "../src/hillclimb/schema-check.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "hillclimb-flow");

/** A fresh deep copy of the committed fixture flow, so each test mutates its own. */
function base(): FlowSnapshot {
  return structuredClone(loadFlowSnapshot(FIXTURE));
}

type Row = Record<string, unknown>;

function rows(s: FlowSnapshot, v = "baseline"): Row[] {
  return s.variants[v]!.results!.trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
}

function setRows(s: FlowSnapshot, rs: Row[], v = "baseline"): void {
  s.variants[v]!.results = rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Mutate the first baseline row. */
function withRow(mut: (r: Row) => void, v = "baseline"): FlowSnapshot {
  const s = base();
  const rs = rows(s, v);
  mut(rs[0]!);
  setRows(s, rs, v);
  return s;
}

function state(s: FlowSnapshot): Record<string, unknown> {
  return JSON.parse(s.state!) as Record<string, unknown>;
}

function withState(mut: (st: Record<string, unknown>) => void): FlowSnapshot {
  const s = base();
  const st = state(s);
  mut(st);
  s.state = JSON.stringify(st);
  return s;
}

function check(s: FlowSnapshot, profile?: SchemaProfile): SchemaCheckReport {
  return checkFlowSnapshot(s, profile ? { profile } : {});
}

function rulesAt(r: SchemaCheckReport, level: "error" | "note"): string[] {
  return r.findings.filter((f) => f.level === level).map((f) => f.rule);
}

/** The ONLY findings are of `rule` at `level` — so a negative case cannot pass on some unrelated finding. */
function expectOnly(r: SchemaCheckReport, level: "error" | "note", rule: string): void {
  expect(r.findings.length, JSON.stringify(r.findings, null, 1)).toBeGreaterThan(0);
  for (const f of r.findings) {
    expect(f.level, JSON.stringify(f)).toBe(level);
    expect(f.rule, JSON.stringify(f)).toBe(rule);
  }
}

describe("schema-check: the fixture flow is clean", () => {
  it("has zero findings of either level, in both profiles", () => {
    for (const profile of ["harness", "schema"] as const) {
      const r = checkFlowDir(FIXTURE, { profile });
      expect(r.findings, JSON.stringify(r.findings, null, 1)).toEqual([]);
      expect(r.errors).toBe(0);
      expect(r.notes).toBe(0);
    }
  });

  it("labels its output as our reading, not the viewer's contract", () => {
    const r = checkFlowDir(FIXTURE);
    expect(r.reading).toBe(SCHEMA_READING);
    expect(r.reading).toContain("our reading of SCHEMA.md@8a1541c4a3ff");
    expect(r.disclaimer).toMatch(/proves nothing about the full report viewer/);
  });

  it("the loader actually read the fixture (the clean result is not over an empty snapshot)", () => {
    const s = loadFlowSnapshot(FIXTURE);
    expect(Object.keys(s.variants).sort()).toEqual(["baseline", "v1"]);
    expect(rows(s).length).toBe(6);
    expect(Object.keys(s.variants.baseline!.traces).length).toBe(6);
    expect(s.state).toBeDefined();
    expect(s.files!.some((f) => f.startsWith("inputs/"))).toBe(true);
  });
});

describe("schema-check: row fields", () => {
  it("prompt_id: missing is an error; the id/case_id alias is only a note", () => {
    // The row's trace is then an orphan (a note); the only ERROR is the missing id.
    const missing = check(
      withRow((r) => {
        delete r.prompt_id;
      }),
    );
    expect(rulesAt(missing, "error")).toEqual(["row.prompt_id"]);
    const aliased = check(
      withRow((r) => {
        r.id = r.prompt_id;
        delete r.prompt_id;
      }),
    );
    expectOnly(aliased, "note", "row.prompt_id");
  });

  it("prompt_id: link-safety (charset and not all dots)", () => {
    expect(isLinkSafeId("case_01.a-b")).toBe(true);
    expect(isLinkSafeId("case/01")).toBe(false);
    expect(isLinkSafeId("case#1")).toBe(false);
    expect(isLinkSafeId("..")).toBe(false);
    expect(isLinkSafeId("...")).toBe(false);
    // A non-link-safe id also orphans the trace and leaves the row without one, so restrict to row.* errors.
    const r = check(withRow((row) => (row.prompt_id = "case/01")));
    expect(rulesAt(r, "error")).toContain("row.prompt_id");
    const dots = check(withRow((row) => (row.prompt_id = "..")));
    expect(dots.findings.some((f) => f.rule === "row.prompt_id" && f.level === "error" && /not link-safe/.test(f.message))).toBe(true);
  });

  it("rep: must be present and a non-negative integer", () => {
    for (const bad of [-1, 1.5, "0", null]) {
      const r = check(withRow((row) => (row.rep = bad)));
      expect(rulesAt(r, "error"), String(bad)).toContain("row.rep");
    }
    const missing = check(
      withRow((row) => {
        delete row.rep;
      }),
    );
    expect(rulesAt(missing, "error")).toContain("row.rep");
  });

  it("rep (schema profile): missing is a note and defaults to the row's index among its case's rows", () => {
    // Drop rep from both extract-table rows: indexes 0 and 1 pair with the existing _rep0/_rep1 traces, so no
    // trace.missing / trace.orphan follows. A wrong default would produce both.
    const s = base();
    const rs = rows(s).map((r) => {
      if (r.prompt_id === "extract-table") delete r.rep;
      return r;
    });
    setRows(s, rs);
    expectOnly(check(s, "schema"), "note", "row.rep");
    expect(check(s, "schema").findings.length).toBe(2);
    expect(rulesAt(check(s), "error")).toEqual(["row.rep", "row.rep"]);
    // A defaulted rep can still collide with an explicit one.
    const d = base();
    const drs = rows(d);
    delete drs[1]!.rep; // extract-table, index 1 -> rep 1 ...
    drs[0]!.rep = 1; // ... and the first row now claims rep 1 explicitly
    setRows(d, drs);
    expect(rulesAt(check(d, "schema"), "error")).toContain("row.duplicate");
  });

  it("duplicate (prompt_id, rep) within a variant is an error", () => {
    const s = base();
    const rs = rows(s);
    setRows(s, [...rs, rs[0]!]);
    expectOnly(check(s), "error", "row.duplicate");
  });

  it("prompt must be a string", () => {
    expectOnly(
      check(
        withRow((r) => {
          delete r.prompt;
        }),
      ),
      "error",
      "row.prompt",
    );
  });

  it("tags must be string[]", () => {
    expectOnly(check(withRow((r) => (r.tags = "writing"))), "error", "row.tags");
    expectOnly(check(withRow((r) => (r.tags = ["writing", 3]))), "error", "row.tags");
    expect(check(withRow((r) => (r.tags = []))).findings).toEqual([]);
  });

  it("grade: a non-dict grade is an error in the harness profile (lite blanks the cell silently)", () => {
    for (const bad of [true, 1, [1], "1"]) {
      const r = check(withRow((row) => (row.grade = bad)));
      expect(rulesAt(r, "error"), JSON.stringify(bad)).toContain("row.grade");
    }
  });

  it("grade (schema profile): a bare bool/number is a note with no declared metrics, an error with them", () => {
    const noMetrics = (g: unknown) => {
      const s = withState((st) => delete st.metrics);
      const rs = rows(s).map((r) => {
        delete r.explanation;
        return r;
      });
      rs[0]!.grade = g;
      setRows(s, rs);
      return check(s, "schema");
    };
    for (const g of [true, 0.5]) {
      const r = noMetrics(g);
      expect(r.errors, JSON.stringify(r.findings)).toBe(0);
      expect(r.findings.some((f) => f.rule === "row.grade" && f.level === "note")).toBe(true);
    }
    // Arrays and strings are never a grade.
    for (const g of [[1], "1"]) expect(rulesAt(noMetrics(g), "error")).toContain("row.grade");
    // With metrics declared, a bare grade blanks every metric cell.
    expectOnly(
      check(
        withRow((row) => (row.grade = true)),
        "schema",
      ),
      "error",
      "row.grade",
    );
  });

  it("grade: every declared metric must be present", () => {
    const r = check(
      withRow((row) => {
        delete (row.grade as Row).a0;
      }),
    );
    expectOnly(r, "error", "row.grade");
    expect(r.findings[0]!.message).toMatch(/a0 is missing/);
  });

  describe("grade: a declared metric may be omitted only when its _present companion is 0 ", () => {
    const refused = (row: Row) => {
      const g = row.grade as Row;
      delete g.a1_c0;
      delete g.a1_c1;
      g.a1_present = 0;
      // A refused assert was never judged, so it has no rationale either.
      const e = row.explanation as Row | undefined;
      if (e) {
        delete e.a1_c0;
        delete e.a1_c1;
        if (Object.keys(e).length === 0) {
          delete row.explanation;
          delete (row.meta as Row).explanation_untrusted;
        }
      }
    };
    for (const profile of ["harness", "schema"] as const)
      it(`claims of an evidence-refused assert, covered by a1_present: 0, are clean (${profile})`, () => {
        expect(check(withRow(refused), profile).findings.filter((f) => f.level === "error")).toEqual([]);
      });

    it("the same omission with a1_present: 1 is still a missing metric", () => {
      const r = check(
        withRow((row) => {
          refused(row);
          (row.grade as Row).a1_present = 1;
        }),
      );
      expectOnly(r, "error", "row.grade");
      expect(r.findings.map((f) => f.message)).toEqual([
        expect.stringMatching(/a1_c0 is missing/),
        expect.stringMatching(/a1_c1 is missing/),
      ]);
    });

    it("a graded key alongside a companion that says it was not measured is a contradiction", () => {
      const r = check(withRow((row) => ((row.grade as Row).a1_present = 0)));
      expectOnly(r, "error", "row.grade");
      expect(r.findings[0]!.message).toMatch(/a1_c0 is present but a1_present is 0/);
    });

    it("a float metric omitted with <id>_present: 0 is clean", () => {
      const s = withState((st) => (st.metrics as Row[]).push({ id: "words", kind: "float", better: "lower" }));
      for (const v of Object.keys(s.variants)) {
        if (!s.variants[v]!.results) continue;
        const rs = rows(s, v);
        for (const r of rs) (r.grade as Row).words_present = 0;
        setRows(s, rs, v);
      }
      expect(check(s).findings.filter((f) => f.level === "error")).toEqual([]);
    });
  });

  describe("grade: a scenario metric declared after a row was written (the row's meta.metric_sigs lacks it)", () => {
    /** The fixture with `words` declared as the state-template declares a scenario metric. */
    const declared = (): FlowSnapshot =>
      withState((st) =>
        (st.metrics as Row[]).push(
          { id: "words_present", kind: "binary", label: "words measured" },
          { id: "words", kind: "float", better: "lower" },
        ),
      );
    const allRows = (s: FlowSnapshot) =>
      Object.keys(s.variants)
        .filter((v) => s.variants[v]!.results)
        .flatMap((v) => rows(s, v));
    const editAll = (s: FlowSnapshot, f: (r: Row, i: number) => void) => {
      let i = 0;
      for (const v of Object.keys(s.variants)) {
        if (!s.variants[v]!.results) continue;
        const rs = rows(s, v);
        for (const r of rs) f(r, i++);
        setRows(s, rs, v);
      }
    };
    const predateNotes = (r: SchemaCheckReport) => r.findings.filter((f) => /do not carry metric/.test(f.message));

    // The note used to say "added after they were written, or no scenario declares it any more" for every lacking row.
    // Deliberately split by where the lacking rows sit among the rows that carry the metric (variants in order —
    // baseline, v1, v2, ... — then file order): no row carries it, they come before the last one that does, or after it.
    it("no row carries it: no error, ONE aggregated note per metric, saying no row carries it", () => {
      const s = declared();
      const n = allRows(s).length;
      const r = check(s);
      expect(r.findings.filter((f) => f.level === "error")).toEqual([]);
      expect(predateNotes(r)).toEqual([
        expect.objectContaining({
          level: "note",
          message: `${n} rows do not carry metric words (baseline 6, v1 6) and no row does: no scenario declares it any more (then remove it from _state.json), or it was declared after every row was written (\`hillclimb regrade\` re-measures them)`,
        }),
      ]);
    });

    const carry = (r: Row) => {
      (r.meta as Row).metric_sigs = { words: "0123456789abcdef" };
      Object.assign(r.grade as Row, { words_present: 1, words: 40 });
    };
    /** The same snapshot with its variants listed v1 first: the order is the variants', never the listing's. */
    const v1First = (s: FlowSnapshot): FlowSnapshot => ({ ...s, variants: { v1: s.variants.v1!, baseline: s.variants.baseline! } });

    it("rows before the last row that carries it predate it", () => {
      const s = declared();
      const rs = rows(s, "v1");
      rs.forEach(carry);
      setRows(s, rs, "v1");
      for (const snap of [s, v1First(s)])
        expect(predateNotes(check(snap)).map((f) => f.message)).toEqual([
          "6 rows do not carry metric words (baseline 6): written before a row that does, so they predate it (or a re-measure listed them) — `hillclimb regrade` re-measures them; its mean covers the rows that carry it only",
        ]);
    });

    it("rows after the last row that carries it: no scenario declares it since the first of them, or a partial re-measure", () => {
      const s = declared();
      const rs = rows(s, "baseline");
      rs.forEach(carry);
      setRows(s, rs, "baseline");
      for (const snap of [s, v1First(s)])
        expect(predateNotes(check(snap)).map((f) => f.message)).toEqual([
          "6 rows do not carry metric words (v1 6): written after the last row that does — either no scenario declares it since v1 (then remove it from _state.json), or these rows were not re-measured (a regrade limited by --variant or --case, or rows it listed): `hillclimb regrade` re-measures them (its mean covers the rows that carry it only)",
        ]);
    });

    it("a carrier in the middle splits the lacking rows: those before it predate it; those after name both causes", () => {
      const s = declared();
      const rs = rows(s, "baseline");
      carry(rs[2]!);
      setRows(s, rs, "baseline");
      expect(predateNotes(check(s)).map((f) => f.message)).toEqual([
        expect.stringMatching(/^2 rows do not carry metric words \(baseline 2\): written before a row that does/),
        expect.stringMatching(
          /^9 rows do not carry metric words \(baseline 3, v1 6\): written after the last row that does — either no scenario declares it since baseline \(then remove it from _state.json\), or these rows were not re-measured \(a regrade limited by --variant or --case, or rows it listed\): `hillclimb regrade` re-measures them/,
        ),
      ]);
    });

    it("a row whose metric_sigs lacks the id predates it too; a row that carries it is not counted", () => {
      const s = declared();
      const n = allRows(s).length;
      editAll(s, (r, i) => {
        (r.meta as Row).metric_sigs = i === 0 ? { words: "0123456789abcdef" } : { other: "0123456789abcdef" };
        if (i === 0) Object.assign(r.grade as Row, { words_present: 1, words: 40 });
      });
      const r = check(s);
      expect(r.findings.filter((f) => f.level === "error")).toEqual([]);
      expect(predateNotes(r).map((f) => f.message)).toEqual([
        expect.stringMatching(new RegExp(`^${n - 1} rows do not carry metric words `)),
      ]);
    });

    it("a row whose metric_sigs HAS the id but whose grade lacks <id>_present is still an error", () => {
      const s = declared();
      editAll(s, (r, i) => i === 0 && ((r.meta as Row).metric_sigs = { words: "0123456789abcdef" }));
      const errs = check(s).findings.filter((f) => f.level === "error");
      expect(errs.map((f) => f.message)).toEqual([
        "declared metric words_present is missing from grade",
        "declared metric words is missing from grade",
      ]);
    });

    it("a row with no metric_sigs that does carry <id>_present: 1 knows the metric, so a missing <id> is still an error", () => {
      const s = declared();
      editAll(s, (r, i) => i === 0 && ((r.grade as Row).words_present = 1));
      expect(
        check(s)
          .findings.filter((f) => f.level === "error")
          .map((f) => f.message),
      ).toEqual(["declared metric words is missing from grade"]);
    });

    it("only a scenario metric (a declared float and its _present) is exempt: a row with no metric_sigs still needs pass", () => {
      const s = declared();
      editAll(s, (r, i) => i === 0 && delete (r.grade as Row).pass);
      expect(
        check(s)
          .findings.filter((f) => f.level === "error")
          .map((f) => f.message),
      ).toEqual(["declared metric pass is missing from grade"]);
    });

    it("the schema profile (a flow some other runner wrote: no metric_sigs) keeps every missing key an error", () => {
      const r = check(declared(), "schema");
      expect(r.findings.filter((f) => f.level === "error").length).toBeGreaterThan(0);
      expect(predateNotes(r)).toEqual([]);
    });

    it("a metric the rows carry but _state.json no longer declares (a removed metric) is no error", () => {
      const s = base();
      editAll(s, (r) => {
        Object.assign(r.grade as Row, { old_present: 1, old: 3 });
        (r.meta as Row).metric_sigs = { old: "0123456789abcdef" };
      });
      expect(check(s).findings.filter((f) => f.level === "error")).toEqual([]);
    });
  });

  it("grade: a binary-declared metric must be 0/1; a non-numeric value is an error", () => {
    expectOnly(check(withRow((row) => ((row.grade as Row).pass = 0.5))), "error", "row.grade");
    expectOnly(check(withRow((row) => ((row.grade as Row).extra = "yes"))), "error", "row.grade");
    // booleans are coerced by the report and accepted here.
    expect(check(withRow((row) => ((row.grade as Row).pass = true))).findings).toEqual([]);
  });

  it("explanation: values strings; keys a subset of grade keys in the harness profile only (ours, not upstream)", () => {
    const extra = withRow((row) => ((row.explanation as Row).a9 = "[untrusted judge] x"));
    expectOnly(check(extra), "error", "row.explanation");
    expect(check(extra, "schema").findings).toEqual([]);
    expectOnly(
      check(
        withRow((row) => ((row.explanation as Row).a1_c0 = 3)),
        "schema",
      ),
      "error",
      "row.explanation",
    );
  });

  it("explanation (harness profile): the untrusted prefix and meta flag are required; schema profile does not ask", () => {
    const noPrefix = withRow((row) => ((row.explanation as Row).a1_c0 = "plain text"));
    expectOnly(check(noPrefix), "error", "row.explanation");
    expect(check(noPrefix, "schema").findings).toEqual([]);
    const noFlag = withRow((row) => delete (row.meta as Row).explanation_untrusted);
    expectOnly(check(noFlag), "error", "row.explanation");
    expect(check(noFlag, "schema").findings).toEqual([]);
  });

  it("explanation with no declared metrics notes the judge-kind flip", () => {
    const s = withState((st) => delete st.metrics);
    const r = check(s);
    expect(r.errors).toBe(0);
    expect(rulesAt(r, "note")).toContain("row.explanation");
    expect(rulesAt(r, "note")).toContain("state.metrics");
  });

  it("usage: camelCase spelling of a read key is an error; an unknown extra key is a note; values non-negative ints", () => {
    expectOnly(check(withRow((row) => (row.usage = { inputTokens: 10, output_tokens: 2 }))), "error", "usage.key");
    expectOnly(check(withRow((row) => (row.usage = { input_tokens: 10, service_tier: "standard" }))), "note", "usage.key");
    expectOnly(check(withRow((row) => (row.usage = { input_tokens: -1 }))), "error", "usage.value");
    expectOnly(check(withRow((row) => (row.usage = "lots"))), "error", "usage.shape");
    expectOnly(check(withRow((row) => (row.judge_usage = { outputTokens: 1 }))), "error", "usage.key");
  });

  it("usage: the two cache counters may be null (SDK number | null); the token counts may not", () => {
    const nulls = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null };
    expect(check(withRow((row) => (row.usage = nulls))).findings).toEqual([]);
    expectOnly(check(withRow((row) => (row.usage = { ...nulls, input_tokens: null }))), "error", "usage.value");
  });

  it("perf fields: numeric when present; a declared one absent is a note", () => {
    expectOnly(check(withRow((row) => (row.cost_usd = "0.05"))), "error", "row.perf");
    expectOnly(check(withRow((row) => (row.in_tokens = null))), "error", "row.perf");
    expectOnly(
      check(
        withRow((row) => {
          delete row.skill_invoked;
        }),
      ),
      "note",
      "row.perf",
    );
  });

  it("status: ok and truncated are accepted in both profiles", () => {
    for (const profile of ["harness", "schema"] as const) {
      expect(
        check(
          withRow((row) => (row.status = "ok")),
          profile,
        ).findings,
      ).toEqual([]);
      expect(
        check(
          withRow((row) => (row.status = "truncated")),
          profile,
        ).findings,
      ).toEqual([]);
    }
  });

  it("status: absent is an error in the harness profile (scaffold parity), allowed in the schema profile", () => {
    const absent = withRow((row) => {
      delete row.status;
    });
    expectOnly(check(absent), "error", "row.status");
    expect(check(absent, "schema").findings).toEqual([]);
  });

  it("status: any other value is an error in the harness profile, a note in the schema profile", () => {
    const odd = withRow((row) => (row.status = "error"));
    expectOnly(check(odd), "error", "row.status");
    expectOnly(check(odd, "schema"), "note", "row.status");
  });

  it("model/stop_reason/judge_model must be strings; meta an object", () => {
    expectOnly(check(withRow((row) => (row.model = 5))), "error", "row.model");
    expectOnly(check(withRow((row) => (row.stop_reason = {}))), "error", "row.stop_reason");
    expectOnly(check(withRow((row) => (row.judge_model = ["x"]))), "error", "row.judge_model");
    // A non-object meta also loses meta.explanation_untrusted, so both errors fire.
    expect(rulesAt(check(withRow((row) => (row.meta = "x"))), "error").sort()).toEqual(["row.explanation", "row.meta"]);
  });

  it("malformed JSON line is an error; a missing trailing newline is a note", () => {
    const s = base();
    s.variants.baseline!.results += "{not json\n";
    expectOnly(check(s), "error", "row.json");
    const t = base();
    t.variants.baseline!.results = t.variants.baseline!.results!.replace(/\n$/, "");
    expectOnly(check(t), "note", "row.torn");
  });

  it("a non-object line is an error; an empty results file is an error", () => {
    const s = base();
    s.variants.baseline!.results += "[1,2]\n";
    expectOnly(check(s), "error", "row.shape");
    const e = base();
    e.variants.v1!.results = "\n";
    e.variants.v1!.traces = {};
    expectOnly(check(e), "error", "variant.results");
  });

  it("row attachments: kind, ref shape, and existence in the flow", () => {
    const set = (a: unknown) => check(withRow((row) => (row.attachments = a)));
    expectOnly(set([{ kind: "movie", ref: "inputs/df944d205d06-quarterly.csv" }]), "error", "attachments.kind");
    expectOnly(set([{ kind: "text", ref: "/etc/passwd" }]), "error", "attachments.ref");
    expectOnly(set([{ kind: "text", ref: "inputs/../../x" }]), "error", "attachments.ref");
    expectOnly(set([{ kind: "text", ref: "inputs/nope.csv" }]), "error", "attachments.ref");
    expectOnly(set({ ref: "x" }), "error", "attachments.shape");
    expect(set([{ kind: "url", ref: "https://example.com/a" }]).findings).toEqual([]);
    expect(set([{ ref: "data:text/plain;base64,aGk=" }]).findings).toEqual([]);
  });
});

describe("schema-check: errors.jsonl rows", () => {
  const withErr = (mut: (e: Row) => void): FlowSnapshot => {
    const s = base();
    const e = JSON.parse(s.variants.v1!.errors!.trim()) as Row;
    mut(e);
    s.variants.v1!.errors = JSON.stringify(e) + "\n";
    return s;
  };

  it("the scaffold's field set is accepted, with model/usage optional", () => {
    expect(
      check(
        withErr((e) => {
          delete e.model;
          delete e.usage;
        }),
      ).findings,
    ).toEqual([]);
  });

  it("each required field is checked", () => {
    for (const [k, rule] of [
      ["prompt_id", "error.prompt_id"],
      ["rep", "error.rep"],
      ["failure_class", "error.failure_class"],
      ["error", "error.error"],
      ["retries", "error.retries"],
      ["judge_retries", "error.judge_retries"],
      ["latency_s", "error.latency_s"],
    ] as const) {
      expectOnly(
        check(
          withErr((e) => {
            delete e[k];
          }),
        ),
        "error",
        rule,
      );
    }
  });

  it("an unknown failure class or extra key is a note; bad usage is an error", () => {
    expectOnly(check(withErr((e) => (e.failure_class = "judge_invalid"))), "note", "error.failure_class");
    expectOnly(check(withErr((e) => (e.surprise = 1))), "note", "error.key");
    expectOnly(check(withErr((e) => (e.usage = { inputTokens: 1 }))), "error", "usage.key");
    expectOnly(check(withErr((e) => (e.prompt_id = "a b"))), "error", "error.prompt_id");
  });

  it("malformed JSON is an error", () => {
    const s = base();
    s.variants.v1!.errors += "nope\n";
    expectOnly(check(s), "error", "error.json");
  });
});

describe("schema-check: traces (Turn[])", () => {
  const withTrace = (mut: (turns: Row[]) => unknown): FlowSnapshot => {
    const s = base();
    const name = "extract-table_rep0.json";
    const turns = JSON.parse(s.variants.baseline!.traces[name]!) as Row[];
    const out = mut(turns);
    s.variants.baseline!.traces[name] = JSON.stringify(out ?? turns);
    return s;
  };

  it("roles are limited to the five SCHEMA.md names", () => {
    expectOnly(check(withTrace((t) => void (t[0]!.role = "developer"))), "error", "trace.role");
  });

  it("content must be a string (no nested content blocks)", () => {
    expectOnly(check(withTrace((t) => void (t[1]!.content = [{ type: "text", text: "hi" }]))), "error", "trace.content");
  });

  it("tool_call needs a name; name elsewhere must be a string", () => {
    expectOnly(check(withTrace((t) => void delete t[2]!.name)), "error", "trace.name");
    expectOnly(check(withTrace((t) => void (t[4]!.name = 7))), "error", "trace.name");
    expect(check(withTrace((t) => void (t[4]!.name = "subagent:1"))).findings).toEqual([]);
  });

  it("thinking must be a string; an unknown key is a note", () => {
    expectOnly(check(withTrace((t) => void (t[4]!.thinking = { text: "x" }))), "error", "trace.thinking");
    expectOnly(check(withTrace((t) => void (t[4]!.parent_tool_use_id = "x"))), "note", "trace.key");
  });

  it("turn attachments are checked like row attachments", () => {
    expectOnly(check(withTrace((t) => void (t[4]!.attachments = [{ kind: "text", ref: "../x" }]))), "error", "attachments.ref");
  });

  it("a trace that is not a list, or not JSON, is an error", () => {
    expectOnly(check(withTrace(() => ({ turns: [] }))), "error", "trace.shape");
    const s = base();
    s.variants.baseline!.traces["extract-table_rep0.json"] = "{";
    expectOnly(check(s), "error", "trace.json");
  });

  it("trace name must be <link-safe id>_rep<k>.json; orphan and missing traces are notes", () => {
    const s = base();
    s.variants.baseline!.traces["weird name.json"] = "[]";
    expectOnly(check(s), "error", "trace.name");
    const o = base();
    o.variants.baseline!.traces["ghost_rep0.json"] = "[]";
    expectOnly(check(o), "note", "trace.orphan");
    const m = base();
    delete m.variants.baseline!.traces["extract-table_rep1.json"];
    expectOnly(check(m), "note", "trace.missing");
  });

  it("a flat <id>.json trace is rep 0, as lite links it", () => {
    const s = base();
    const t = s.variants.baseline!.traces;
    t["extract-table.json"] = t["extract-table_rep0.json"]!;
    delete t["extract-table_rep0.json"];
    expect(check(s).findings).toEqual([]);
    // It stands in for rep 0 only: without the _rep1 file, rep 1 is still missing.
    delete t["extract-table_rep1.json"];
    expectOnly(check(s), "note", "trace.missing");
    // A flat trace with no rep-0 row is an orphan, not a naming error.
    const o = base();
    o.variants.baseline!.traces["ghost.json"] = "[]";
    expectOnly(check(o), "note", "trace.orphan");
  });
});

describe("schema-check: variant dirs", () => {
  const withEntry = (name: string, kind: "dir" | "symlink" | "file"): FlowSnapshot => {
    const s = base();
    s.entries.push({ name, kind });
    return s;
  };

  it("the scaffold's variant regex: v0/v01 (lite accepts, scaffold refuses) and descriptive names are errors", () => {
    for (const bad of ["v0", "v01", "v1-better", "variant_a"]) expectOnly(check(withEntry(bad, "dir")), "error", "variant.name");
    expect(check(withEntry("v0", "dir")).findings[0]!.message).toMatch(/scaffold refuses/);
  });

  it("lite's non-variant dirs, dot/underscore dirs and plain files are allowed", () => {
    for (const ok of ["trajectory", "inputs", "out", "ref", ".git", "_scratch"]) expect(check(withEntry(ok, "dir")).findings).toEqual([]);
    expect(check(withEntry("report.html", "file")).findings).toEqual([]);
  });

  it("a v0 dir is reported by name, and its rows are still checked (the lite builder reads them)", () => {
    const s = base();
    s.entries.push({ name: "v0", kind: "dir" });
    const v0 = structuredClone(s.variants.v1!);
    s.variants.v0 = v0;
    expectOnly(check(s), "error", "variant.name");
    const rs = rows(s, "v0");
    rs[0]!.tags = "oops";
    setRows(s, rs, "v0");
    const r = check(s);
    expect(new Set(rulesAt(r, "error"))).toEqual(new Set(["variant.name", "row.tags"]));
    expect(r.findings.find((f) => f.rule === "row.tags")!.file).toBe("v0/results.jsonl");
  });

  it("a symlinked variant dir is an error; a missing baseline is an error", () => {
    expectOnly(check(withEntry("v2", "symlink")), "error", "variant.symlink");
    const s = base();
    s.entries = s.entries.filter((e) => e.name !== "baseline");
    delete s.variants.baseline;
    expectOnly(check(s), "error", "variant.baseline");
  });

  it("the loader records a symlink anywhere in the tree as an error and never follows it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-schema-"));
    try {
      const flow = join(dir, "flow");
      cpSync(FIXTURE, flow, { recursive: true });
      symlinkSync(join(flow, "baseline", "results.jsonl"), join(flow, "v1", "traces", "extract-table_rep0.json.link"));
      mkdirSync(join(dir, "elsewhere"));
      symlinkSync(join(dir, "elsewhere"), join(flow, "v2"));
      const r = checkFlowDir(flow);
      expect(rulesAt(r, "error").sort()).toEqual(["flow.symlink", "flow.symlink", "variant.symlink"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("schema-check: _state.json", () => {
  it("invalid JSON or a non-object is an error; absent is a note", () => {
    const s = base();
    s.state = "{";
    expect(rulesAt(check(s), "error")).toEqual(["state.json"]);
    const a = base();
    a.state = "[]";
    expect(rulesAt(check(a), "error")).toEqual(["state.json"]);
    const n = base();
    delete n.state;
    const r = check(n);
    expect(r.errors).toBe(0);
    expect(rulesAt(r, "note")).toContain("state.absent");
  });

  it("metrics: list shape, id, kind, duplicate, label length, better, scale, min", () => {
    // A non-list metrics is ignored by the report, so the judge-flip note follows (12 rows carry explanations).
    const notList = check(withState((st) => (st.metrics = { pass: "binary" })));
    expect(rulesAt(notList, "error")).toEqual(["state.metrics"]);
    expect(new Set(rulesAt(notList, "note"))).toEqual(new Set(["row.explanation"]));
    const m = (extra: Row) =>
      withState((st) => {
        const ms = st.metrics as Row[];
        ms[ms.length - 1] = { ...ms[ms.length - 1], ...extra };
      });
    expectOnly(check(m({ kind: "percent" })), "error", "state.metrics");
    expectOnly(check(m({ better: "up" })), "error", "state.metrics");
    expectOnly(check(m({ scale: "10" })), "error", "state.metrics");
    // `min`, a float's floor: a string would silently disable headroom's lower-is-better end.
    expectOnly(check(m({ min: "0" })), "error", "state.metrics");
    expect(check(m({ min: 0.5 })).findings).toEqual([]);
    expectOnly(check(m({ label: "a very long label indeed" })), "note", "state.metrics");
    expectOnly(check(m({ kind: undefined })), "note", "state.metrics");
    expectOnly(
      check(withState((st) => (st.metrics = [...(st.metrics as Row[]), { id: "pass", kind: "binary" }]))),
      "error",
      "state.metrics",
    );
    expectOnly(check(withState((st) => (st.metrics = [...(st.metrics as Row[]), { kind: "binary" }]))), "error", "state.metrics");
  });

  it("the legacy `criteria` key is read as metrics (with a note), and its metrics are enforced", () => {
    const legacy = withState((st) => {
      st.criteria = st.metrics;
      delete st.metrics;
    });
    expectOnly(check(legacy), "note", "state.metrics");
    const s = withState((st) => {
      st.criteria = [...(st.metrics as Row[]), { id: "quality", kind: "judge" }];
      delete st.metrics;
    });
    expect(rulesAt(check(s), "error").length).toBe(12);
    expect(new Set(rulesAt(check(s), "error"))).toEqual(new Set(["row.grade"]));
  });

  it("a declared metric missing from every row is reported per row", () => {
    const r = check(withState((st) => (st.metrics = [...(st.metrics as Row[]), { id: "quality", kind: "judge" }])));
    expect(r.findings.every((f) => f.rule === "row.grade" && /quality is missing/.test(f.message))).toBe(true);
    expect(r.errors).toBe(12);
  });

  it("perf_fields: list of {id, label?, unit?}", () => {
    expectOnly(check(withState((st) => (st.perf_fields = "cost_usd"))), "error", "state.perf_fields");
    expectOnly(check(withState((st) => (st.perf_fields = [{ label: "x" }]))), "error", "state.perf_fields");
    expectOnly(check(withState((st) => (st.perf_fields = [{ id: "cost_usd", unit: 1 }]))), "error", "state.perf_fields");
  });

  it("split ids: list, path-safe, disjoint; an absent id is a note", () => {
    expect(isPathSafeId("case_01")).toBe(true);
    expect(isPathSafeId("case/01")).toBe(false);
    expect(isPathSafeId("x".repeat(130))).toBe(false);
    expectOnly(check(withState((st) => (st.test_ids = "summarize-report"))), "error", "state.split");
    const unsafe = check(withState((st) => (st.test_ids = ["summarize-report", "case/9"])));
    expectOnly(unsafe, "error", "state.split");
    expectOnly(check(withState((st) => (st.test_ids = ["summarize-report", "extract-table"]))), "error", "state.split");
    expectOnly(check(withState((st) => (st.val_ids = ["not-run-yet"]))), "note", "state.split");
    expectOnly(check(withState((st) => (st.val_ids = [{ id: 1 }]))), "error", "state.split");
  });

  it("harness_paths must be a list (a non-string entry is a note: the scaffold stringifies it); harness_sha a string", () => {
    expectOnly(check(withState((st) => (st.harness_paths = ["a", 1]))), "note", "state.harness_paths");
    expectOnly(check(withState((st) => (st.harness_paths = "a"))), "error", "state.harness_paths");
    expectOnly(check(withState((st) => (st.harness_sha = 12))), "error", "state.harness_sha");
  });

  it("harness_skill (the --skill an approval hashed, written by the runner) is accepted as a string, an error otherwise", () => {
    const ok = check(withState((st) => ((st.harness_sha = "a".repeat(64)), (st.harness_skill = "deck-review"))));
    expect(ok.findings).toEqual([]);
    expectOnly(check(withState((st) => (st.harness_skill = 3))), "error", "state.harness_skill");
  });

  it("harness_files (the per-entry hashes an approval records) is accepted as name -> sha256 hex; anything else is a note, never an error", () => {
    const ok = check(
      withState(
        (st) => ((st.harness_sha = "a".repeat(64)), (st.harness_files = { "evals/a.yaml": "b".repeat(64), "<baseline>": "c".repeat(64) })),
      ),
    );
    expect(ok.findings).toEqual([]);
    for (const bad of [["evals/a.yaml"], "x", null, { "evals/a.yaml": 3 }, { "evals/a.yaml": "not-hex" }])
      expectOnly(check(withState((st) => (st.harness_files = bad))), "note", "state.harness_files");
  });
});

describe("schema-check: summary.json", () => {
  it("must be a JSON object with a string model", () => {
    const s = base();
    s.variants.v1!.summary = "{";
    expectOnly(check(s), "error", "summary.json");
    const m = base();
    m.variants.v1!.summary = JSON.stringify({ model: 3 });
    expectOnly(check(m), "error", "summary.model");
  });
  it("model_requested, effort and effort_sent, when present, are strings", () => {
    for (const k of ["model_requested", "effort", "effort_sent"]) {
      const s = base();
      s.variants.v1!.summary = JSON.stringify({ [k]: ["high"] });
      expectOnly(check(s), "error", `summary.${k}`);
    }
    const ok = base();
    ok.variants.v1!.summary = JSON.stringify({ model: "m", model_requested: "m", effort: "mixed", effort_sent: "high" });
    expect(check(ok).findings.filter((f) => f.rule.startsWith("summary"))).toEqual([]);
  });
  it("effort_selector, when present, is false or mixed", () => {
    for (const [v, bad] of [
      [false, false],
      ["mixed", false],
      [true, true],
      ["none", true],
    ] as const) {
      const s = base();
      s.variants.v1!.summary = JSON.stringify({ effort_selector: v });
      if (bad) expectOnly(check(s), "error", "summary.effort_selector");
      else expect(check(s).findings.filter((f) => f.rule.startsWith("summary"))).toEqual([]);
    }
  });
});
