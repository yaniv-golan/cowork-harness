// Count bounds an assertion's own values can make empty, and the `tool_called` negative spelling.
//
//  - `tool_called: {count: {max: 0}}` with no `min` means "never called" (min 0), as the hook keys read
//    `{event, max: 0}`; any other lone `max` keeps the floor of 1.
//  - That spelling is a NEGATIVE check, so it carries every guard `tool_not_called` has (`negativeToolCall`).
//  - A range no count meets (`count.min > count.max`, `min_pass` above the rubric) is refused at load and by `lint`,
//    and tagged so a frozen cassette carrying one replays with a warning instead of being refused.
// All $0: synthetic contexts, the real schema, and copies of a committed cassette.
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { Assertion as AssertionSchema, Scenario, COUNT_BOUND_PARAMS, negativeToolCall, toolCalledEffectiveMin } from "../src/types.js";
import { tierVacuityRefusal } from "../src/run/execute.js";
import { readCassette, replayCassette, type Cassette } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";

const scenarioSchema: unknown = JSON.parse(readFileSync(resolve("schema/scenario.schema.json"), "utf8"));

type ToolCall = NonNullable<AssertContext["toolCalls"]>[number];

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    mountDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    toolCalls: [],
    toolResults: [],
    ...over,
  };
}
const call = (id: string, name: string, input: Record<string, string>, origin: ToolCall["origin"] = "main", parent?: string): ToolCall => ({
  toolUseId: id,
  name,
  input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { text: v }])),
  origin,
  parentToolUseId: parent,
});
const one = (a: unknown, c: AssertContext) => {
  const r = evaluate([a as never], c);
  expect(r).toHaveLength(1);
  return r[0] as { pass: boolean; message?: string; evidence?: string };
};
/** The issue the count-bound refines raise, or undefined: keyed on the TAG, not on "the schema refused it". */
const countBoundIssue = (a: unknown) => {
  const r = AssertionSchema.safeParse(a);
  if (r.success) return undefined;
  return r.error.issues.find(
    (i) => i.code === "custom" && (i.params as { kind?: string } | undefined)?.kind === COUNT_BOUND_PARAMS.kind,
  ) as ((typeof r.error.issues)[number] & { fix?: string }) | undefined;
};
const accepts = (a: unknown) => AssertionSchema.safeParse(a).success;

// The oracle: every key with a count range, or a scalar bound over a sibling array, and the shapes each must
// accept or refuse. The schema walk below fails when a new such key is not classified here.
const COUNT_KEYS: Record<string, { refuse: unknown[]; accept: unknown[] } | "not-a-count"> = {
  "tool_called.count": {
    refuse: [{ tool_called: { tool: "Bash", count: { min: 3, max: 1 } } }, { tool_called: { tool: "Bash", count: { min: 1, max: 0 } } }],
    accept: [
      { tool_called: { tool: "Bash", count: { max: 0 } } },
      { tool_called: { tool: "Bash", count: { min: 0, max: 0 } } },
      { tool_called: { tool: "Bash", count: { max: 3 } } },
      { tool_called: { tool: "Bash", count: { min: 2, max: 2 } } },
      { tool_called: { tool: "Bash", count: {} } },
    ],
  },
  hook_event_blocked: {
    refuse: [{ hook_event_blocked: { event: "Stop", min: 2, max: 1 } }],
    accept: [{ hook_event_blocked: { event: "Stop", max: 0 } }, { hook_event_blocked: { event: "Stop", max: 3 } }],
  },
  hook_decision: {
    refuse: [{ hook_decision: { event: "PreToolUse", decision: "deny", min: 2, max: 1 } }],
    accept: [{ hook_decision: { event: "PreToolUse", decision: "deny", max: 0 } }],
  },
  question_option_count: {
    refuse: [{ question_option_count: { matches: "x", min: 2, max: 1 } }],
    accept: [{ question_option_count: { matches: "x", max: 0 } }],
  },
  "semantic_matches.min_pass": {
    refuse: [{ semantic_matches: { rubric: ["a"], min_pass: 3 } }, { semantic_matches: { rubric: ["a", "b"], min_pass: 3 } }],
    accept: [
      { semantic_matches: { rubric: ["a"], min_pass: 1 } },
      { semantic_matches: { rubric: ["a"], min_pass: "all" } },
      { semantic_matches: { rubric: ["a"] } },
    ],
  },
  search_corpus_nearby_citations: "not-a-count", // max only: it cannot be empty
  "metrics[]": "not-a-count", // a value range, refused at load already (min < scale)
  "semantic_pairwise.pass_if": "not-a-count", // an enum
};

describe("count-bound keys: one table, the real schema", () => {
  for (const [key, row] of Object.entries(COUNT_KEYS)) {
    if (row === "not-a-count") continue;
    it(`${key}: refuses an empty range, accepts a satisfiable one`, () => {
      for (const a of row.refuse) expect(accepts(a), JSON.stringify(a)).toBe(false);
      for (const a of row.accept) expect(accepts(a), JSON.stringify(a)).toBe(true);
    });
  }

  it("the tool_called and min_pass refusals are tagged count-bound and carry a remedy in `fix`", () => {
    const tc = countBoundIssue({ tool_called: { tool: "Bash", count: { min: 3, max: 1 } } });
    expect(tc?.message).toMatch(/count\.min 3 is greater than count\.max 1/);
    expect(tc?.fix).toMatch(/Lower `count\.min`/);
    const mp = countBoundIssue({ semantic_matches: { rubric: ["a"], min_pass: 3 } });
    expect(mp?.message).toMatch(/min_pass 3 is more than the rubric's 1 claim/);
    expect(mp?.fix).toMatch(/Lower `min_pass`/);
  });

  it("the schema walk: every count-shaped property is classified in COUNT_KEYS", () => {
    const found: string[] = [];
    const walk = (o: unknown, path: string[]): void => {
      if (!o || typeof o !== "object") return;
      const props = (o as { properties?: Record<string, { type?: string }> }).properties;
      if (props) {
        if ("min" in props || "max" in props || "exactly" in props) found.push(path.join("."));
        // A scalar bound over a SIBLING array (min_pass vs rubric) lives inside one key's own object. At the
        // assertion level the siblings are other keys, and each `*_count_max` there is a single bound, which
        // cannot be empty.
        const assertionLevel = path.join(".") === "properties.assert.items";
        const arrays = assertionLevel ? [] : Object.entries(props).filter(([, v]) => v?.type === "array");
        for (const [k, v] of Object.entries(props))
          if (/min|max|pass/i.test(k) && k !== "min" && k !== "max" && arrays.length && JSON.stringify(v).includes('"integer"'))
            found.push([...path, k].join("."));
      }
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) walk(v, [...path, k]);
    };
    walk(scenarioSchema, []);
    const short = (p: string) =>
      p
        .replace(/^properties\.assert\.items\.properties\./, "")
        .replace(/\.anyOf\.\d+/g, "")
        .replace(/\.properties\./g, ".")
        .replace(/^properties\.metrics\.items$/, "metrics[]");
    const classified = new Set(Object.keys(COUNT_KEYS));
    const unclassified = [...new Set(found.map(short))].filter((p) => !classified.has(p));
    // The walk itself sees the known keys, the scalar-over-array one included.
    expect(found.map(short)).toEqual(expect.arrayContaining(["tool_called.count", "hook_decision", "semantic_matches.min_pass"]));
    expect(unclassified).toEqual([]);
  });
});

describe("D1: tool_called {count: {max: 0}} means never called", () => {
  it("the floor: 0 only for a lone max of 0", () => {
    expect(toolCalledEffectiveMin({ max: 0 })).toBe(0);
    expect(toolCalledEffectiveMin({ max: 3 })).toBe(1);
    expect(toolCalledEffectiveMin({})).toBe(1);
    expect(toolCalledEffectiveMin(undefined)).toBe(1);
    expect(toolCalledEffectiveMin({ min: 0, max: 0 })).toBe(0);
  });

  it("negativeToolCall is true for tool_not_called and the 0..0 tool_called only", () => {
    expect(negativeToolCall("tool_not_called", { tool: "Bash" })).toBe(true);
    expect(negativeToolCall("tool_called", { tool: "Bash", count: { max: 0 } })).toBe(true);
    expect(negativeToolCall("tool_called", { tool: "Bash", count: { min: 0, max: 0 } })).toBe(true);
    for (const count of [undefined, {}, { min: 0 }, { max: 1 }, { max: 3 }, { min: 0, max: 2 }, { min: 1, max: 0 }])
      expect(negativeToolCall("tool_called", { tool: "Bash", count }), JSON.stringify(count)).toBe(false);
    expect(negativeToolCall("tool_called", "Bash")).toBe(false);
  });

  const neverPush = { tool_called: { tool: "Bash", input: { command: "git\\s+push" }, count: { max: 0 } } };

  it("passes when no in-scope call satisfies, and says what it did not check", () => {
    const r = one(
      neverPush,
      ctx({ toolCalls: [call("m1", "Bash", { command: "ls" }), call("s1", "Bash", { command: "git push" }, "subagent", "A")] }),
    );
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/^tool_called \(count\.max 0\): no Bash call satisfied every predicate/);
    expect(r.evidence).toMatch(/1 sub-?agent call not checked/);
  });

  it("fails 'unexpectedly called' when one does", () => {
    const r = one(neverPush, ctx({ toolCalls: [call("m1", "Bash", { command: "git push origin" })] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/tool unexpectedly called/);
  });

  it("a redacted field is evidence-unavailable, never a pass (the negative evidence direction)", () => {
    const r = one(neverPush, ctx({ toolCalls: [call("m1", "Bash", { command: "cd [REDACTED:path:0123456789ab] && make" })] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  it("2a stays rejected: a lone max above 0 still needs a call", () => {
    const r = one({ tool_called: { tool: "Bash", count: { max: 3 } } }, ctx({ toolCalls: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/tool not called/);
  });

  it("a tolerated min > max row reaching the evaluator unparsed fails naming the bound", () => {
    const r = one({ tool_called: { tool: "Bash", count: { min: 3, max: 1 } } }, ctx({ toolCalls: [call("m1", "Bash", {})] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/count\.min 3 is greater than count\.max 1/);
  });
});

describe("the negative spelling carries tool_not_called's guards", () => {
  const scenario = (assert: unknown[]) =>
    Scenario.parse({ name: "s", baseline: "latest", session: "(inline)", fidelity: "hostloop", prompt: "hi", assert });

  it("(a) a tier that never serves the tool refuses it, as it refuses tool_not_called", () => {
    const bl = loadBaseline("latest");
    const neg = tierVacuityRefusal(scenario([{ tool_called: { tool: "Bash", count: { max: 0 } } }]), bl);
    expect(neg).toContain('`tool_called: {tool: "Bash", count: {max: 0}}` can never be violated');
    expect(tierVacuityRefusal(scenario([{ tool_not_called: "Bash" }]), bl)).toBeDefined();
    // The positive check is never refused: it fails normally.
    expect(tierVacuityRefusal(scenario([{ tool_called: { tool: "Bash", count: { max: 3 } } }]), bl)).toBeUndefined();
    expect(tierVacuityRefusal(scenario([{ tool_called: { tool: "Bash" } }]), bl)).toBeUndefined();
  });
});

describe("cassettes: a frozen record carrying a count bound", () => {
  const SRC = resolve("examples/replays/example-pdf-skill.cassette.json");
  const dirs: string[] = [];
  afterEach(() => {
    process.stderr.write = realWrite;
  });
  const realWrite = process.stderr.write.bind(process.stderr);
  const mute = (): string[] => {
    const lines: string[] = [];
    process.stderr.write = ((s: string | Uint8Array) => (lines.push(String(s)), true)) as typeof process.stderr.write;
    return lines;
  };
  /** A copy of a committed cassette with `extra` appended to its frozen asserts. */
  const withAsserts = (extra: unknown[]): string => {
    const d = mkdtempSync(join(tmpdir(), "cwh-count-bounds-"));
    dirs.push(d);
    const c = JSON.parse(readFileSync(SRC, "utf8")) as { scenario: { assert: unknown[] } };
    c.scenario.assert = [...c.scenario.assert, ...extra];
    const p = join(d, "c.cassette.json");
    writeFileSync(p, JSON.stringify(c));
    return p;
  };
  const read = (p: string) => readCassette(p) as { cassette: Cassette } | { error: string };

  it("min > max is tolerated with a warning, and replays to a FAIL naming the bound", async () => {
    const err = mute();
    const r = read(withAsserts([{ tool_called: { tool: "Write", count: { min: 3, max: 1 } } }]));
    expect("cassette" in r).toBe(true);
    expect(err.join("")).toMatch(/::warning:: \[cassette\].*count\.min 3 is greater than count\.max 1.*can never pass/);
    const res = await replayCassette((r as { cassette: Cassette }).cassette, []);
    const row = res.assertions.find((a) => JSON.stringify(a.assertion).includes('"min":3'))!;
    expect(row.pass).toBe(false);
    expect((row as { message?: string }).message).toMatch(/count\.min 3 is greater than count\.max 1/);
  });

  it("an unmeetable min_pass is tolerated and, being live-only, still skipped on replay", () => {
    const err = mute();
    const r = read(withAsserts([{ semantic_matches: { rubric: ["a"], min_pass: 3 } }]));
    expect("cassette" in r).toBe(true);
    expect(err.join("")).toMatch(/::warning::.*min_pass 3 is more than the rubric/);
  });

  it("{max: 0} grades as never called: PASS over a tool that never ran, FAIL over one that did", async () => {
    mute();
    const r = read(
      withAsserts([{ tool_called: { tool: "WebFetch", count: { max: 0 } } }, { tool_called: { tool: "Write", count: { max: 0 } } }]),
    ) as { cassette: Cassette };
    const res = await replayCassette(r.cassette, []);
    const by = (tool: string) => res.assertions.find((a) => JSON.stringify(a.assertion).includes(`"tool":"${tool}","count"`))!;
    expect(by("WebFetch").pass).toBe(true);
    expect(by("Write").pass).toBe(false);
  });

  it("every other schema issue is still refused: a regex-shaped glob (docs/scenario.md:653), and a union failing on a sibling", () => {
    mute();
    for (const extra of [
      [{ tool_not_called: ".*" }],
      [{ tool_called: { tool: "Write", scope: "nope", count: { min: 3, max: 1 } } }],
      [{ tool_called: { tool: "Write", count: { min: 3, max: 1 } }, tool_not_called: ".*" }],
    ]) {
      const r = read(withAsserts(extra));
      expect("error" in r, JSON.stringify(extra)).toBe(true);
      expect((r as { error: string }).error).toMatch(/unrecognized assertion/);
    }
  });

  const CLI = resolve("dist/cli.js");
  describe.skipIf(!existsSync(CLI))("cassette commands keep their exit codes on a tolerated row", () => {
    const run = (args: string[], cwd: string) =>
      spawnSync("node", [CLI, ...args], {
        encoding: "utf8",
        cwd,
        timeout: 120_000,
        env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "1", COWORK_HARNESS_RUNS_DIR: join(cwd, ".runs"), NO_COLOR: "1" },
      });
    /** One dir holding the committed cassette as-is, one holding it with the row injected. */
    const pair = (extra: unknown[]) => {
      const root = mkdtempSync(join(tmpdir(), "cwh-count-bounds-cli-"));
      const clean = join(root, "clean");
      const dirty = join(root, "dirty");
      for (const d of [clean, dirty]) mkdirSync(d);
      cpSync(SRC, join(clean, "c.cassette.json"));
      cpSync(withAsserts(extra), join(dirty, "c.cassette.json"));
      return { root, clean, dirty };
    };

    it("replay: exit 1 with the assertion named, where the same cassette without the row replays as before", () => {
      const { root, clean, dirty } = pair([{ tool_called: { tool: "Write", count: { min: 3, max: 1 } } }]);
      const before = run(["replay", join(clean, "c.cassette.json")], root);
      const after = run(["replay", join(dirty, "c.cassette.json")], root);
      expect(after.status, after.stderr).toBe(before.status === 0 ? 1 : before.status);
      expect(after.stdout + after.stderr).toMatch(/count\.min 3 is greater than count\.max 1/);
      expect(after.stderr).toMatch(/::warning:: \[cassette\]/);
    });

    it.each([
      ["verify-cassettes", (d: string) => ["verify-cassettes", d]],
      ["rehash --dry-run", (d: string) => ["rehash", d, "--dry-run"]],
      ["record --rerecord-stale --dry-run", (d: string) => ["record", `${d}/`, "--rerecord-stale", "--dry-run"]],
    ])("%s: the same exit code as the clean copy", (_name, argv) => {
      const { root, clean, dirty } = pair([{ semantic_matches: { rubric: ["a"], min_pass: 3 } }]);
      const before = run(argv(clean), root);
      const after = run(argv(dirty), root);
      expect(after.status, after.stdout + after.stderr).toBe(before.status);
    });
  });
});

describe("judge spend: an unmeetable min_pass reaching the live pre-pass unparsed calls no judge", () => {
  it("refuses before the judge, naming the bound (the --rerecord-stale --from-embedded route)", async () => {
    let calls = 0;
    const judge: SemanticJudge = async (rubric) => {
      calls++;
      return rubric.map((claim, index) => ({ index, claim, pass: true }));
    };
    const a = { semantic_matches: { rubric: ["x"], min_pass: 3 } } as never;
    const c = ctx({ transcript: "x" });
    await runSemanticJudges([a], c, judge);
    expect(calls).toBe(0);
    const r = one(a, c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/min_pass 3 is more than the rubric's 1 claim/);
  });
});

// The exit code of each command on an authored empty bound. Every row asserts the message too, so a refusal for
// some other reason (a missing run dir, a model) cannot pass for this one.
const CLI_PATH = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI_PATH))("CLI: an authored empty bound is refused before any spend", () => {
  const BOUND = /min_pass 3 is more than the rubric's 1 claim/;
  const BAD = "  - semantic_matches: {rubric: [a], min_pass: 3}\n";
  const scenarioText = (assert: string, extra = "") =>
    `name: s\nprompt: hi\nfidelity: container\nsession: ../ok.yaml\n${extra}assert:\n  - result: success\n${assert}`;
  function fixture(): string {
    const d = mkdtempSync(join(tmpdir(), "cwh-count-bounds-cli-"));
    mkdirSync(join(d, "sc"));
    writeFileSync(join(d, "ok.yaml"), "model: claude-sonnet-5\n");
    writeFileSync(join(d, "sc", "bad.yaml"), scenarioText(BAD));
    return d;
  }
  function keptRun(root: string): string {
    const run = join(root, "kept");
    mkdirSync(join(run, "work", "session", "mnt", "outputs"), { recursive: true });
    const t1 = join(run, "turns", "1");
    mkdirSync(t1, { recursive: true });
    writeFileSync(
      join(t1, "result.json"),
      JSON.stringify({
        scenario: "s",
        fidelity: "container",
        baseline: "desktop-1.14271.0",
        result: "success",
        decisions: [],
        toolCounts: {},
        gateDeliveries: [],
        egress: [],
        assertions: [],
        subagents: [],
        outDir: run,
        workDir: join(run, "work", "session", "mnt"),
        durationMs: 1,
        scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
      }),
    );
    writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "s" }) + "\n");
    writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [], steps: [] }));
    return run;
  }
  const cli = (args: string[], cwd: string, extraEnv: Record<string, string> = {}) => {
    const r = spawnSync("node", [CLI_PATH, ...args], {
      encoding: "utf8",
      cwd,
      timeout: 120_000,
      env: {
        ...process.env,
        COWORK_HARNESS_FORBID_SPAWN: "1",
        COWORK_HARNESS_RUNS_DIR: join(cwd, ".runs"),
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        NO_COLOR: "1",
        ...extraEnv,
      },
    });
    return { code: r.status, all: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
  };

  it("lint: exit 1, the loader's scenario-invalid and count-bound-unsatisfiable, with the remedy", () => {
    const d = fixture();
    const r = cli(["lint", "--json", "sc/bad.yaml"], d);
    expect(r.code, r.all).toBe(1);
    const findings = JSON.parse(r.stdout) as Array<{ rule: string; message: string; fix: string }>;
    const invalid = findings.find((f) => f.rule === "scenario-invalid");
    expect(invalid?.message).toMatch(BOUND);
    expect(invalid?.fix).toMatch(/Lower `min_pass`/);
    expect(findings.some((f) => f.rule === "count-bound-unsatisfiable")).toBe(true);
  });

  it("lint: `count: {max: 0}` is clean but for the INFO pointing at tool_not_called", () => {
    const d = fixture();
    writeFileSync(join(d, "sc", "neg.yaml"), scenarioText("  - tool_called: {tool: Write, count: {max: 0}}\n"));
    const r = cli(["lint", "--json", "sc/neg.yaml"], d);
    expect(r.code, r.all).toBe(0);
    const rules = (JSON.parse(r.stdout) as Array<{ rule: string; severity: string }>).filter((f) => f.severity !== "INFO");
    expect(rules).toEqual([]);
    expect(r.stdout).toContain("tool-called-max-zero");
  });

  it.each([
    ["run", (d: string) => ["run", "sc/bad.yaml", "--output-format", "json"]],
    ["record <file> --dry-run", (d: string) => ["record", "sc/bad.yaml", "--dry-run", "--out", join(d, "o.cassette.json")]],
    ["record <file>", (d: string) => ["record", "sc/bad.yaml", "--out", join(d, "o.cassette.json")]],
    ["eval", () => ["eval", "sc/bad.yaml", "--arm", "a", "--arm", "b", "--dry-run"]],
    ["verify-run", (d: string) => ["verify-run", keptRun(d), "sc/bad.yaml"]],
    ["regrade", (d: string) => ["regrade", keptRun(d), "--scenario", "sc/bad.yaml"]],
  ])("%s: exit 2, naming the bound", (_name, argv) => {
    const d = fixture();
    const r = cli(argv(d), d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toMatch(BOUND);
  });

  it("record <dir/> and its --dry-run: the file is classified broken, exit 1", () => {
    for (const extra of [[], ["--dry-run"]]) {
      const d = fixture();
      // A dummy credential: the batch checks for one before it classifies files, and FORBID_SPAWN keeps it unused.
      const r = cli(["record", "sc/", ...extra], d, { CLAUDE_CODE_OAUTH_TOKEN: "dummy" });
      expect(r.code, r.all).toBe(1);
      expect(r.all).toMatch(BOUND);
    }
  });

  it("a multi-leg scenario whose leg asserts it: exit 2", () => {
    const d = fixture();
    writeFileSync(
      join(d, "sc", "legs.yaml"),
      `name: l\nfidelity: container\nsession: ../ok.yaml\nlegs:\n  - id: one\n    prompt: hi\n    assert:\n${BAD.replace(/^/gm, "    ").trimEnd()}\n`,
    );
    const r = cli(["run", "sc/legs.yaml", "--output-format", "json"], d);
    expect(r.code, r.all).toBe(2);
    expect(r.all).toMatch(BOUND);
  });
});

// The same defect reported in two languages: the loader's count-bound refine (TypeScript) and the
// `count-bound-unsatisfiable` lint rule (Python, for a direct `scenario.py lint`). Both sides are keyed on the
// count-bound finding itself, not on "the schema refused it", so a row where Zod refuses for another reason
// (`max: "1"`, a fractional min) must read "no" on BOTH sides, and Python's string-tolerant `_numeric` would make
// it disagree.
const PY = process.env.PYTHON ?? "python3";
const havePython = spawnSync(PY, ["--version"], { stdio: "ignore" }).status === 0;
describe.skipIf(!havePython)("count-bound: TS refine ↔ Python lint rule agree row by row", () => {
  const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
  const rows: Array<[string, unknown, boolean]> = [
    ["min > max", { tool_called: { tool: "Bash", count: { min: 3, max: 1 } } }, true],
    ["min 1, max 0", { tool_called: { tool: "Bash", count: { min: 1, max: 0 } } }, true],
    ["min_pass above the rubric", { semantic_matches: { rubric: ["a"], min_pass: 3 } }, true],
    ["max 0 alone (D1: satisfiable)", { tool_called: { tool: "Bash", count: { max: 0 } } }, false],
    ["min == max", { tool_called: { tool: "Bash", count: { min: 2, max: 2 } } }, false],
    ["min_pass at the rubric", { semantic_matches: { rubric: ["a"], min_pass: 1 } }, false],
    ["a numeric-string max", { tool_called: { tool: "Bash", count: { min: 2, max: "1" } } }, false],
    ["a fractional min", { tool_called: { tool: "Bash", count: { min: 1.5, max: 0 } } }, false],
    ["a boolean min", { tool_called: { tool: "Bash", count: { min: true, max: 0 } } }, false],
    ["a numeric-string max of 0", { tool_called: { tool: "Bash", count: { max: "0" } } }, false],
  ];
  it.each(rows)("%s", (_name, a, expected) => {
    expect(countBoundIssue(a) !== undefined, "TypeScript").toBe(expected);
    const d = mkdtempSync(join(tmpdir(), "cwh-count-sync-"));
    const f = join(d, "sc.yaml");
    writeFileSync(f, `name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\nassert:\n  - ${JSON.stringify(a)}\n`);
    const r = spawnSync(PY, [SCRIPT, "lint", "--json", f], { encoding: "utf8" });
    const rules = (JSON.parse(r.stdout || "[]") as Array<{ rule: string }>).map((x) => x.rule);
    expect(rules.includes("count-bound-unsatisfiable"), "Python").toBe(expected);
  });
});
