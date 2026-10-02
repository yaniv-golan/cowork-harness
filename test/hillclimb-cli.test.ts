// `hillclimb check` and `hillclimb state-template`, below the process boundary: what each reports and its exit
// code. The command wrappers in src/hillclimb/cli.ts only parse, print and exit; the spawned CLI is covered
// by the guard tests (cli-structural-guard, cli-help).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { checkReport, stateTemplateFor, writeMetricsMd } from "../src/hillclimb/cli.js";
import { UsageError } from "../src/errors.js";

const CLEAN_FLOW = resolve(import.meta.dirname, "fixtures", "hillclimb-flow");
const SKILL = resolve(import.meta.dirname, "..", ".claude", "skills", "cowork-harness");
let cwd: string;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "hc-cli-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("checkReport", () => {
  it("a clean flow exits 0", () => {
    cpSync(CLEAN_FLOW, join(cwd, "flow"), { recursive: true });
    const r = checkReport("flow", cwd);
    expect(r.exitCode).toBe(0);
    expect(r.report.errors).toBe(0);
  });

  it("a float metric with no `better` is an error: exit 1", () => {
    cpSync(CLEAN_FLOW, join(cwd, "flow"), { recursive: true });
    const st = JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8"));
    writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify({ ...st, metrics: [...st.metrics, { id: "words", kind: "float" }] }));
    const r = checkReport("flow", cwd);
    expect(r.exitCode).toBe(1);
    expect(r.report.findings.map((f) => f.rule)).toContain("state.metrics");
  });

  it("an out-of-range float is a warning, never an error: exit 0", () => {
    cpSync(CLEAN_FLOW, join(cwd, "flow"), { recursive: true });
    const st = JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8"));
    writeFileSync(
      join(cwd, "flow", "_state.json"),
      JSON.stringify({ ...st, metrics: [...st.metrics, { id: "score", kind: "float", better: "higher", scale: 1 }] }),
    );
    const res = join(cwd, "flow", "baseline", "results.jsonl");
    const rows = readFileSync(res, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    rows.forEach((r, i) => Object.assign(r.grade, { score_present: 1, score: i === 0 ? 12.5 : 0.5 }));
    writeFileSync(res, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = checkReport("flow", cwd);
    expect(r.exitCode).toBe(0);
    expect(r.warnings).toContainEqual(
      expect.stringMatching(/^warning: grade\.score = 12\.5 is outside its declared range \[0, 1\] \(variant baseline/),
    );
  });

  it("a missing flow dir is a usage error", () => {
    expect(() => checkReport("nope", cwd)).toThrow(UsageError);
  });
});

describe("stateTemplateFor", () => {
  it("harness_paths are the measurement's files, relative to cwd", () => {
    mkdirSync(join(cwd, "evals"));
    writeFileSync(join(cwd, "evals", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    writeFileSync(join(cwd, "evals", "a.yaml"), "name: a\nbaseline: latest\nsession: ./_session.yaml\nfidelity: container\nprompt: p\n");
    const t = stateTemplateFor("evals", cwd, {});
    expect([...t.state.harness_paths].sort()).toEqual(["evals/_session.yaml", "evals/a.yaml"]);
    expect(t.state.metrics[0].id).toBe("pass");
  });

  describe("scenario metrics", () => {
    const head = "baseline: latest\nsession: ./_session.yaml\nfidelity: container\nprompt: p\n";
    const words = (better = "lower") =>
      `metrics:\n  - id: words\n    artifact: outputs/stats.json\n    path: totals.words\n    better: ${better}\n    unbounded: true\n    min: 5\n`;
    const ratio = "metrics:\n  - id: ratio\n    artifact: outputs/stats.json\n    path: ratio\n    better: higher\n    scale: 1\n";
    beforeEach(() => {
      mkdirSync(join(cwd, "evals"));
      writeFileSync(join(cwd, "evals", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
      writeFileSync(join(cwd, "evals", "a.yaml"), `name: a\n${head}${words()}`);
      writeFileSync(join(cwd, "evals", "b.yaml"), `name: b\n${head}${ratio}`);
      writeFileSync(join(cwd, "evals", "c.yaml"), `name: c\n${head}`);
    });

    it("declares the union over the cases: companions after pass, floats last, each with better (scale and min only when declared)", () => {
      const t = stateTemplateFor("evals", cwd, {});
      expect(t.state.metrics.map((m) => m.id)).toEqual(["pass", "pass_present", "words_present", "ratio_present", "words", "ratio"]);
      expect(t.state.metrics.find((m) => m.id === "words")).toEqual({
        id: "words",
        kind: "float",
        label: "words",
        better: "lower",
        min: 5,
      });
      expect(t.state.metrics.find((m) => m.id === "ratio")).toEqual({
        id: "ratio",
        kind: "float",
        label: "ratio",
        better: "higher",
        scale: 1,
      });
      expect(t.state.metrics.find((m) => m.id === "words_present")).toMatchObject({ kind: "binary" });
    });

    it("metrics.md defines each metric: the file and path it is read from, its direction and its range", () => {
      const md = stateTemplateFor("evals", cwd, {}).metricsMd;
      expect(md).toMatch(/`words`.*`totals\.words` in `outputs\/stats\.json`.*lower is better.*no upper bound.*floor 5/);
      expect(md).toMatch(/`ratio`.*`ratio` in `outputs\/stats\.json`.*higher is better.*bounded above by 1/);
    });

    it("with --flow, a float _state.json declares that no scenario declares any more is named: remove its entries", () => {
      mkdirSync(join(cwd, "flow"));
      const st = stateTemplateFor("evals", cwd, {}).state;
      writeFileSync(
        join(cwd, "flow", "_state.json"),
        JSON.stringify({
          ...st,
          metrics: [...st.metrics, { id: "gone_present", kind: "binary" }, { id: "gone", kind: "float", better: "higher" }],
        }),
      );
      expect(stateTemplateFor("evals", cwd, {}, { flow: "flow" }).notes).toContainEqual(
        "no scenario declares metric gone any more; remove its entries (gone and gone_present) from _state.json's metrics",
      );
      // Every metric still declared: no such note.
      writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify(st));
      expect(stateTemplateFor("evals", cwd, {}, { flow: "flow" }).notes.filter((n) => /no scenario declares/.test(n))).toEqual([]);
    });

    it("one id declared two ways is a usage error", () => {
      writeFileSync(join(cwd, "evals", "c.yaml"), `name: c\n${head}${words("higher")}`);
      expect(() => stateTemplateFor("evals", cwd, {})).toThrow(/metric "words" is declared differently in a and c/);
    });
  });
});

describe("stateTemplateFor --skill", () => {
  const multi = () => {
    const plugin = join(cwd, "plug");
    for (const n of ["a", "b"]) {
      mkdirSync(join(plugin, "skills", n), { recursive: true });
      writeFileSync(join(plugin, "skills", n, "SKILL.md"), `---\nname: ${n}\n---\n${n}\n`);
    }
    mkdirSync(join(cwd, "evals"));
    writeFileSync(join(cwd, "evals", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
    writeFileSync(join(cwd, "evals", "a.yaml"), "name: a\nbaseline: latest\nsession: ./_session.yaml\nfidelity: container\nprompt: p\n");
  };

  const perfIds = (t: ReturnType<typeof stateTemplateFor>) => t.state.perf_fields.map((f) => f.id);

  it("a known skill keeps skill_invoked in perf_fields and adds nothing else: harness_skill is the runner's to write", () => {
    multi();
    const t = stateTemplateFor("evals", cwd, {}, { skill: "b" });
    expect(perfIds(t)).toContain("skill_invoked");
    expect(t.notes).toEqual([]);
    expect(t.state).not.toHaveProperty("harness_skill");
  });

  it("several skills and no --skill: skill_invoked is left out of perf_fields, and the note says to pass --skill, listing them", () => {
    multi();
    const t = stateTemplateFor("evals", cwd, {});
    expect(perfIds(t)).not.toContain("skill_invoked");
    expect(perfIds(t)).toContain("cost_usd");
    expect(t.notes).toEqual([expect.stringMatching(/several skills \(a, b\).*pass --skill <name>/)]);
    expect({ ...t.state, perf_fields: [] }).toEqual({ ...stateTemplateFor("evals", cwd, {}, { skill: "b" }).state, perf_fields: [] });
  });

  it("hillclimb check then notes no absent skill_invoked per row; declared, it would", () => {
    multi();
    const t = stateTemplateFor("evals", cwd, {});
    cpSync(CLEAN_FLOW, join(cwd, "flow"), { recursive: true });
    for (const v of ["baseline", "v1"]) {
      const f = join(cwd, "flow", v, "results.jsonl");
      const lines = readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      writeFileSync(f, lines.map(({ skill_invoked: _drop, ...r }) => JSON.stringify(r)).join("\n") + "\n");
    }
    const st = JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8")) as Record<string, unknown>;
    const notesWith = (perf: unknown) => {
      writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify({ ...st, perf_fields: perf }));
      return checkReport("flow", cwd).report.findings.filter((f) => /skill_invoked/.test(f.message));
    };
    expect(notesWith(t.state.perf_fields)).toEqual([]);
    expect(notesWith(stateTemplateFor("evals", cwd, {}, { skill: "a" }).state.perf_fields).length).toBeGreaterThan(0);
  });

  it("a single-skill plugin keeps skill_invoked with no note", () => {
    multi();
    rmSync(join(cwd, "plug", "skills", "b"), { recursive: true });
    const t = stateTemplateFor("evals", cwd, {});
    expect(perfIds(t)).toContain("skill_invoked");
    expect(t.notes).toEqual([]);
  });

  it("an unknown skill is a usage error naming the plugin's skills", () => {
    multi();
    expect(() => stateTemplateFor("evals", cwd, {}, { skill: "nope" })).toThrow(UsageError);
    expect(() => stateTemplateFor("evals", cwd, {}, { skill: "nope" })).toThrow(
      /--skill nope: .* registers no skill nope — its skills: a, b/,
    );
  });

  it("resolves against the plugin's git-tracked files, as a snapshot copies them: an untracked skill is refused", () => {
    multi();
    const git = (...a: string[]) => spawnSync("git", a, { cwd: join(cwd, "plug"), encoding: "utf8" });
    git("init", "-q");
    git("add", "skills/a");
    const saved = process.env.COWORK_HARNESS_GITSET;
    delete process.env.COWORK_HARNESS_GITSET;
    try {
      expect(() => stateTemplateFor("evals", cwd, {}, { skill: "b" })).toThrow(/--skill b: .*untracked.*git add/);
      expect(stateTemplateFor("evals", cwd, {}).notes).toEqual([]); // one tracked skill: a
    } finally {
      if (saved !== undefined) process.env.COWORK_HARNESS_GITSET = saved;
    }
  });
});

describe("stateTemplateFor: workspace_fixture", () => {
  const withGitsetOff = <T>(fn: () => T): T => {
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
  };
  const setup = (fixture: string) => {
    mkdirSync(join(cwd, "evals"));
    writeFileSync(join(cwd, "evals", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    writeFileSync(
      join(cwd, "evals", "a.yaml"),
      `name: a\nbaseline: latest\nsession: ./_session.yaml\nfidelity: container\nprompt: p\nworkspace_fixture: ${fixture}\n`,
    );
  };

  it("harness_paths lists the fixture's files", () => {
    setup("../fx");
    mkdirSync(join(cwd, "fx"));
    writeFileSync(join(cwd, "fx", "report.md"), "# draft\n");
    const t = withGitsetOff(() => stateTemplateFor("evals", cwd, {}));
    expect(t.state.harness_paths).toContain("fx/report.md");
  });

  it("a fixture staging would refuse is a usage error", () => {
    setup("../missing");
    expect(() => withGitsetOff(() => stateTemplateFor("evals", cwd, {}))).toThrow(UsageError);
  });
});

describe("writeMetricsMd (state-template --flow)", () => {
  it("writes metrics.md into the flow dir, creating the dir", () => {
    expect(writeMetricsMd("flow", cwd, "# Metrics\n", []).status).toBe("written");
    expect(readFileSync(join(cwd, "flow", "metrics.md"), "utf8")).toBe("# Metrics\n");
  });

  it("a re-run with the same legend leaves it alone", () => {
    writeMetricsMd("flow", cwd, "# Metrics\n", []);
    expect(writeMetricsMd("flow", cwd, "# Metrics\n", []).status).toBe("unchanged");
    expect(existsSync(join(cwd, "flow", "metrics.md.new"))).toBe(false);
  });

  it("a re-run never clobbers an edited copy: the new legend goes to metrics.md.new", () => {
    writeMetricsMd("flow", cwd, "# Metrics\n", []);
    writeFileSync(join(cwd, "flow", "metrics.md"), "# Metrics\nmy notes\n");
    expect(writeMetricsMd("flow", cwd, "# Metrics\nnew metric\n", []).status).toBe("new");
    expect(readFileSync(join(cwd, "flow", "metrics.md"), "utf8")).toBe("# Metrics\nmy notes\n");
    expect(readFileSync(join(cwd, "flow", "metrics.md.new"), "utf8")).toBe("# Metrics\nnew metric\n");
  });

  it("a planted link at metrics.md is never followed", () => {
    mkdirSync(join(cwd, "flow"));
    writeFileSync(join(cwd, "outside.md"), "host file");
    symlinkSync(join(cwd, "outside.md"), join(cwd, "flow", "metrics.md"));
    expect(() => writeMetricsMd("flow", cwd, "# Metrics\n", [])).toThrow();
    expect(readFileSync(join(cwd, "outside.md"), "utf8")).toBe("host file");
  });

  it("a secret in the legend (rubric text) is redacted", () => {
    writeMetricsMd("flow", cwd, "# Metrics\nsk-secret-123\n", ["sk-secret-123"]);
    expect(readFileSync(join(cwd, "flow", "metrics.md"), "utf8")).not.toContain("sk-secret-123");
  });
});

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
describe.skipIf(!existsSync(CLI))("hillclimb state-template, through the CLI", () => {
  const setup = () => {
    mkdirSync(join(cwd, "evals"));
    writeFileSync(join(cwd, "evals", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    writeFileSync(join(cwd, "evals", "a.yaml"), "name: a\nbaseline: latest\nsession: ./_session.yaml\nfidelity: container\nprompt: p\n");
  };
  const run = (...a: string[]) => spawnSync("node", [CLI, "hillclimb", "state-template", "evals", ...a], { cwd, encoding: "utf8" });

  it("text mode without --flow writes nothing and says where the legend is", () => {
    setup();
    const r = run();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).metrics[0].id).toBe("pass");
    expect(r.stderr).toMatch(/--flow.*metrics\.md|metrics_md/);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });

  it("the note fires even when the default flow exists, and names the default path to copy", () => {
    setup();
    mkdirSync(join(cwd, ".claude", "hillclimb", "flow"), { recursive: true });
    const r = run();
    expect(r.stderr).toContain("--flow .claude/hillclimb/flow");
    expect(existsSync(join(cwd, ".claude", "hillclimb", "flow", "metrics.md"))).toBe(false);
  });

  it("an unknown --skill exits 2 before printing a skeleton", () => {
    setup();
    const r = run("--skill", "nope");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    // The fixture plugin is a root-SKILL.md plugin: hillclimb's refusal for --skill on one, not an unknown-flag error.
    expect(r.stderr).toMatch(
      /--skill nope: this plugin has one skill, cowork-harness, tracked without --skill; pass --skill cowork-harness or drop it/,
    );
  });

  it("--flow writes metrics.md beside the skeleton and says so", () => {
    setup();
    const r = run("--flow", "flow");
    expect(r.status).toBe(0);
    expect(readFileSync(join(cwd, "flow", "metrics.md"), "utf8")).toMatch(/^# Metrics/);
    expect(r.stderr).toMatch(/wrote flow\/metrics\.md/);
  });

  it("run --dry-run --output-format json: the envelope's ok is the verdict, and the cost object is present", () => {
    setup();
    const r = spawnSync("node", [CLI, "hillclimb", "run", "evals", "--flow", "flow", "--dry-run", "--output-format", "json"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: join(cwd, "runs") },
    });
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    // eval's dry-run shape: the estimate under plan.cost, so a top-level cost can only ever mean spend.
    expect(env).toMatchObject({ dryRun: true, scheduled: 1, scored: 0, failed: 0, plan: { cost: { jobs: 1, lowerBound: true } } });
    expect(env).not.toHaveProperty("cost");
    // The covered summary, validated against its published schema (which must exist: no skip when absent).
    const schemaPath = resolve(import.meta.dirname, "..", "schema", "schedule-cost.json");
    expect(existsSync(schemaPath)).toBe(true);
    const validate = new Ajv({ strict: true }).compile(JSON.parse(readFileSync(schemaPath, "utf8")));
    expect(validate(env.plan.cost), JSON.stringify(validate.errors)).toBe(true);
  });

  it("run --output-format json: a pre-spend refusal is the shared error envelope, its reason in error.message", () => {
    const r = spawnSync("node", [CLI, "hillclimb", "run", "nope", "--flow", "flow", "--dry-run", "--output-format", "json"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: join(cwd, "runs") },
    });
    expect(r.status).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ command: "hillclimb run", ok: false, dryRun: true, scheduled: 0, exitCode: 2 });
    expect(env.error.category).toBe("usage");
    expect(env.error.message).toMatch(/nope/);
  });

  it("run --output-format json: an argv error names the same command as a refusal", () => {
    const r = spawnSync("node", [CLI, "hillclimb", "run", "evals", "--bogus", "--output-format", "json"], { cwd, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: "hillclimb run", ok: false, error: { category: "usage" } });
  });
});
