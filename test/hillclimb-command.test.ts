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
  it("the repo's own eval scenarios: one lever (the companion skill), a concrete pin per case", () => {
    const { cases } = loadCases(join(EVALS, "eval-14-subagent-dispatch-and-declared-unused.yaml"));
    const p = prepareCases(cases, { env: { COWORK_MANAGED_CONFIG: "0" } });
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

  it("the protocol tier without a managed config dir is refused: its sub-agent turns could not be traced", () => {
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p", "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${SKILL}\n`);
    writeFileSync(join(dir, "p", "a.yaml"), "name: a\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: p\n");
    const { cases } = loadCases(join(dir, "p"));
    // managedConfigMode reads COWORK_MANAGED_CONFIG and the auth tokens from process.env itself.
    const keys = ["COWORK_MANAGED_CONFIG", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      process.env.COWORK_MANAGED_CONFIG = "0";
      expect(() => prepareCases(cases, { env: {} })).toThrow(/managed config/);
      process.env.COWORK_MANAGED_CONFIG = "1";
      expect(() => prepareCases(cases, { env: {} })).not.toThrow();
    } finally {
      for (const k of keys)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
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
