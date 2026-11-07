// `hillclimb run`'s pre-spend preparation: each case's session and baseline, the one lever the loop tunes
// (exactly one local plugin, the same in every case), the model pins, and the tier the trace needs. Built
// over the repo's own eval scenarios (test/evals/scenarios), whose session installs the companion skill.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareCases } from "../src/hillclimb/command.js";
import { loadCases } from "../src/hillclimb/cases.js";
import { UsageError } from "../src/errors.js";

const EVALS = resolve(import.meta.dirname, "evals", "scenarios");
const SKILL = resolve(import.meta.dirname, "..", ".claude", "skills", "cowork-harness");

let dir: string;
const scenario = (file: string, extra = "", session = "./_session.yaml") =>
  writeFileSync(join(dir, file), `name: ${file}\nbaseline: latest\nsession: ${session}\nfidelity: container\nprompt: p\n${extra}`);
const session = (file: string, body: string) => writeFileSync(join(dir, file), body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-cmd-"));
  session("_session.yaml", `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prepareCases", () => {
  it("a selected case whose session pins plugins.config_dir is refused before any run: that dir is single-run", () => {
    session("_session.yaml", `model: claude-sonnet-5\nplugins:\n  config_dir: ./pinned\n  local_plugins:\n    - ${SKILL}\n`);
    scenario("a.yaml");
    const { cases } = loadCases(join(dir, "a.yaml"));
    expect(() => prepareCases(cases, { env: {} })).toThrow(
      "plugins.config_dir is single-run; this command runs it once per slot, every round",
    );
  });

  it("the repo's own eval scenarios: one lever (the companion skill), a concrete pin per case", () => {
    const { cases } = loadCases(join(EVALS, "eval-14-subagent-dispatch-and-declared-unused.yaml"));
    const p = prepareCases(cases, { env: {} });
    expect(realpathSync(p.lever)).toBe(realpathSync(SKILL));
    expect(p.pin(cases[0])).toBe("claude-sonnet-5");
    expect(p.session(cases[0]).plugins.local_plugins).toHaveLength(1);
  });

  it("--model overrides the session's model; an alias anywhere is refused before spend", () => {
    scenario("a.yaml");
    const { cases } = loadCases(dir);
    expect(prepareCases(cases, { modelFlag: "claude-opus-4-8", env: {} }).pin(cases[0])).toBe("claude-opus-4-8");
    expect(() => prepareCases(cases, { modelFlag: "sonnet", env: {} })).toThrow(UsageError);
    expect(() => prepareCases(cases, { modelFlag: "sonnet", env: {} })).toThrow(/hillclimb needs a CONCRETE agent model/);
  });

  it("an alias judge model is refused", () => {
    scenario("a.yaml", 'assert:\n  - semantic_matches:\n      rubric: ["x"]\n      judge_model: opus\n');
    const { cases } = loadCases(dir);
    expect(() => prepareCases(cases, { env: {} })).toThrow(/CONCRETE judge model/);
  });

  it("the lever is exactly one local plugin: none, two, or an inline session is refused", () => {
    session("two.yaml", `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n    - ${SKILL}\n`);
    scenario("a.yaml", "", "./two.yaml");
    expect(() => prepareCases(loadCases(dir).cases, { env: {} })).toThrow(/exactly one/);
    rmSync(join(dir, "a.yaml"));
    session("none.yaml", "model: claude-sonnet-5\n");
    scenario("b.yaml", "", "./none.yaml");
    expect(() => prepareCases(loadCases(dir).cases, { env: {} })).toThrow(/exactly one/);
  });

  it("every case must tune the SAME plugin", () => {
    const other = mkdtempSync(join(tmpdir(), "hc-plug-"));
    try {
      cpSync(SKILL, join(other, "cowork-harness"), { recursive: true });
      session("other.yaml", `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${join(other, "cowork-harness")}\n`);
      scenario("a.yaml");
      scenario("b.yaml", "", "./other.yaml");
      expect(() => prepareCases(loadCases(dir).cases, { env: {} })).toThrow(/SAME plugins.local_plugins entry/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("on_unanswered: prompt is refused (an unattended loop cannot answer)", () => {
    scenario("a.yaml", "on_unanswered: prompt\n");
    expect(() => prepareCases(loadCases(dir).cases, { env: {} })).toThrow(/on_unanswered: prompt/);
  });

  // Every protocol run gives the agent its managed config dir, where its sub-agent transcripts land, so a protocol case's
  // traces are complete without any switch: the refusal that used to guard the unmanaged branch is gone.
  it("the protocol tier is accepted: its sub-agent turns are traced from the managed config dir", () => {
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    writeFileSync(join(dir, "p", "a.yaml"), "name: a\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: p\n");
    const { cases } = loadCases(join(dir, "p"));
    expect(() => prepareCases(cases, { env: {} })).not.toThrow();
  });
});

describe("prepareCases — a --case selection scopes the per-case refusals", () => {
  const sel = (ids: string[]) => {
    const { cases } = loadCases(dir);
    return { cases, selected: cases.filter((c) => ids.includes(c.id)) };
  };

  it("on_unanswered: prompt, an inline session and an alias pin refuse only when their case is selected", () => {
    scenario("a.yaml");
    scenario("b.yaml", "on_unanswered: prompt\n");
    writeFileSync(join(dir, "c.yaml"), "name: c\nbaseline: latest\nfidelity: container\nprompt: p\n");
    session("alias.yaml", `model: sonnet\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    scenario("d.yaml", "", "./alias.yaml");
    const { cases, selected } = sel(["a"]);
    const p = prepareCases(cases, { env: {} }, selected);
    expect(p.pin(selected[0]!)).toBe("claude-sonnet-5");
    expect(() => prepareCases(cases, { env: {} }, sel(["a", "b"]).selected)).toThrow(/case b: on_unanswered: prompt/);
    expect(() => prepareCases(cases, { env: {} }, sel(["a", "c"]).selected)).toThrow(/case c: the scenario has no session file/);
    expect(() => prepareCases(cases, { env: {} }, sel(["a", "d"]).selected)).toThrow(/CONCRETE agent model/);
  });

  it("the one-plugin rule still covers an unselected case whose session parses", () => {
    session("two.yaml", `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n    - ${SKILL}\n`);
    scenario("a.yaml");
    scenario("b.yaml", "", "./two.yaml");
    expect(() => prepareCases(loadCases(dir).cases, { env: {} }, sel(["a"]).selected)).toThrow(/case b: .*exactly one/);
  });
});

describe("prepareCases — what defines the measurement, and what the agent can read", () => {
  it("derived paths: the scenario file, its session file and every uploaded input", () => {
    const up = join(dir, "input.csv");
    writeFileSync(up, "a,b\n");
    session("_session.yaml", `model: claude-sonnet-5\nuploads:\n  - ./input.csv\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    scenario("a.yaml");
    const { cases } = loadCases(dir);
    const p = prepareCases(cases, { env: {} });
    expect(
      p
        .derivedPaths(cases)
        .map((x) => realpathSync(x))
        .sort(),
    ).toEqual([join(dir, "a.yaml"), join(dir, "_session.yaml"), up].map((x) => realpathSync(x)).sort());
  });

  it("mount roots: every folder the session connects, every upload, and the plugin itself", () => {
    const folder = mkdtempSync(join(tmpdir(), "hc-folder-"));
    try {
      writeFileSync(join(dir, "input.csv"), "a,b\n");
      session(
        "_session.yaml",
        `model: claude-sonnet-5\nfolders:\n  - from: ${folder}\nuploads:\n  - ./input.csv\nplugins:\n  local_plugins:\n    - ${SKILL}\n`,
      );
      scenario("a.yaml");
      const { cases } = loadCases(dir);
      const roots = prepareCases(cases, { env: {} })
        .mountRoots(cases)
        .map((x) => realpathSync(x));
      expect(roots).toContain(realpathSync(folder));
      expect(roots).toContain(realpathSync(join(dir, "input.csv")));
      expect(roots).toContain(realpathSync(SKILL));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("derived paths: a workspace_fixture's files, as staging scans them (OS metadata skipped)", () => {
    mkdirSync(join(dir, "fx", "sub"), { recursive: true });
    writeFileSync(join(dir, "fx", "report.md"), "# draft\n");
    writeFileSync(join(dir, "fx", "sub", "data.csv"), "a,b\n");
    writeFileSync(join(dir, "fx", ".DS_Store"), "x"); // OS metadata: never staged, so never hashed
    scenario("a.yaml", "workspace_fixture: ./fx\n");
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      const { cases } = loadCases(dir);
      const derived = prepareCases(cases, { env: {} })
        .derivedPaths(cases)
        .map((x) => realpathSync(x));
      expect(derived).toContain(realpathSync(join(dir, "fx", "report.md")));
      expect(derived).toContain(realpathSync(join(dir, "fx", "sub", "data.csv")));
      expect(derived).not.toContain(realpathSync(join(dir, "fx", ".DS_Store")));
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
  });
});
