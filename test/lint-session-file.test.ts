// `lint` on a session file: one INFO `not-a-scenario` and nothing else, on both paths (the `cowork-harness lint`
// wrapper and a direct `scenario.py lint`). The key set that recognises a session file is derived once (the session
// schema minus the scenario's top-level keys) and must be the same set in TypeScript and Python.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { SESSION_KEYS, SESSION_ONLY_KEYS, looksLikeSessionFile } from "../src/run/lint-load.js";

const CLI = resolve("dist/cli.js");
const SCENARIO_PY = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const PY = process.env.PYTHON ?? "python3";
const HAVE_PY = spawnSync(PY, ["--version"], { stdio: "ignore" }).status === 0;
const SESSIONS = "examples/sessions";
const sessionFiles = readdirSync(SESSIONS).filter((f) => f.endsWith(".yaml"));

describe("the session-file key set", () => {
  it("is the session schema's keys, and those minus the scenario's (`skills` is in both)", () => {
    const schema = JSON.parse(readFileSync("schema/session.schema.json", "utf8"));
    expect(SESSION_KEYS).toEqual(Object.keys(schema.properties).sort());
    expect(SESSION_ONLY_KEYS).toContain("model");
    expect(SESSION_ONLY_KEYS).not.toContain("skills");
  });

  it.skipIf(!HAVE_PY)("scenario.py derives the same sets", () => {
    const code =
      "import importlib.util,json,sys;s=importlib.util.spec_from_file_location('s',sys.argv[1]);m=importlib.util.module_from_spec(s);" +
      "s.loader.exec_module(m);print(json.dumps([sorted(m.SESSION_KEYS),sorted(m.SESSION_ONLY_KEYS)]))";
    const r = spawnSync(PY, ["-c", code, SCENARIO_PY], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([[...SESSION_KEYS], [...SESSION_ONLY_KEYS]]);
  });

  it("recognises a session file, and only one", () => {
    expect(looksLikeSessionFile({ model: "m", agent_max_turns: 3 })).toBe(true);
    expect(looksLikeSessionFile({ permission_mode: "acceptEdits", skills: ["x"] })).toBe(true);
    expect(looksLikeSessionFile({ skills: ["x"] })).toBe(false);
    expect(looksLikeSessionFile({ model: "m", prompt: "hi" })).toBe(false);
    expect(looksLikeSessionFile({ model: "m", mystery: 1 })).toBe(false);
    expect(looksLikeSessionFile([])).toBe(false);
    expect(looksLikeSessionFile(null)).toBe(false);
  });
});

type Finding = { severity: string; rule: string; file: string };
const perFile = (fs: Finding[]) =>
  Object.fromEntries(sessionFiles.map((f) => [f, fs.filter((x) => x.file.endsWith(`/${f}`)).map((x) => `${x.severity} ${x.rule}`)]));
const expected = Object.fromEntries(sessionFiles.map((f) => [f, ["INFO not-a-scenario"]]));

describe.runIf(existsSync(CLI))("lint examples/sessions/", () => {
  it("the wrapper: exit 0, exactly one INFO per file", () => {
    const r = spawnSync("node", [CLI, "lint", `${SESSIONS}/`, "--json"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(perFile(JSON.parse(r.stdout))).toEqual(expected);
  });

  it.skipIf(!HAVE_PY)("scenario.py directly: the same per-file result", () => {
    const r = spawnSync(PY, [SCENARIO_PY, "lint", "--json", `${SESSIONS}/`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(perFile(JSON.parse(r.stdout))).toEqual(expected);
  });
});
