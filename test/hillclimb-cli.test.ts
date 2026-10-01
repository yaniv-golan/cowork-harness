// `hillclimb check` and `hillclimb state-template`, below the process boundary: what each reports and its exit
// code. The command wrappers in src/hillclimb/cli.ts only parse, print and exit; the spawned CLI is covered
// by the guard tests (cli-structural-guard, cli-help).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkReport, stateTemplateFor } from "../src/hillclimb/cli.js";
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
});
