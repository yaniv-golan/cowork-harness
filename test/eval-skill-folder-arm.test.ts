// `eval` with one arm a plugin root and the other that plugin's `skills/<name>` folder. The skill-folder arm is
// snapshotted under the declared plugin folder's name, so the agent loads the same `<plugin>:<skill>` id from both arms.
// Driven in-process as a dry run: nothing runs an agent or spends a token.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../src/types.js";
import type { DoctorCheck } from "../src/run/doctor.js";
import { parseEvalArgs, planEvalDryRun, type EvalJobSpec } from "../src/eval/command.js";

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eval-skillarm-")));
  for (const k of ["COWORK_HARNESS_RUNS_DIR", "COWORK_HARNESS_MODEL", "COWORK_HARNESS_JUDGE_MODEL", "COWORK_HARNESS_GITSET"])
    saved[k] = process.env[k];
  process.env.COWORK_HARNESS_RUNS_DIR = join(root, "runs-unused");
  process.env.COWORK_HARNESS_GITSET = "0"; // untracked fixture dirs: snapshot them raw
  delete process.env.COWORK_HARNESS_MODEL;
  delete process.env.COWORK_HARNESS_JUDGE_MODEL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function write(dir: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

/** A skills repo, with or without a manifest; `body` makes the two arms' skills differ. */
function repo(at: string, body: string, manifest: boolean): string {
  return write(join(root, at, "my-skills-repo"), {
    "README.md": "# repo\n",
    "AGENTS.md": "notes\n",
    "skills/demo-skill/SKILL.md": `---\nname: demo-skill\ndescription: d\n---\n${body}\n`,
    ...(manifest ? { ".claude-plugin/plugin.json": '{"name": "my-skills-repo"}' } : {}),
  });
}

function scenario(): string {
  write(root, { "session.yaml": "model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/my-skills-repo\n" });
  repo("declared", "declared", false);
  return write(join(root, "scenarios"), {
    "s.yaml": "baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: go\nassert:\n  - result: success\n",
  });
}

const TOKEN_OK = (): DoctorCheck => ({ id: "token", title: "Auth token", status: "ok", detail: "found", required: true });
const NO_RUN = async (_s: EvalJobSpec): Promise<RunResult> => {
  throw new Error("a dry run must never call runJob");
};

async function dryRun(before: string, after: string, extra: string[] = []): Promise<string[]> {
  const log: string[] = [];
  await planEvalDryRun(
    parseEvalArgs([
      join(scenario(), "s.yaml"),
      "--arm",
      `before=${before}`,
      "--arm",
      `after=${after}`,
      "--out",
      join(root, "eval"),
      "--dry-run",
      ...extra,
    ]),
    {
      runJob: NO_RUN,
      tokenCheck: TOKEN_OK,
      isolationCheck: () => undefined,
      judgeCheck: async (): Promise<never> => {
        throw new Error("a dry run must never probe the judge");
      },
      log: (s: string) => log.push(s),
      evalId: "plan1",
      now: () => new Date("2026-10-01T00:00:00Z"),
      readIndex: () => [],
      runsDirInfo: () => ({ runsDir: join(root, "runs"), runsDirRedirected: false }),
    },
  );
  return log;
}

const NOT_TRACKED = /no single skill to record invocation for/;

for (const manifest of [false, true])
  describe(`eval: a plugin-root arm against its skills/<name> folder (${manifest ? "with" : "no"} manifest)`, () => {
    it("--skill names the skill in both arms, so its invocation is recorded", async () => {
      const a = repo("a", "version A", manifest);
      const b = repo("b", "version B", manifest);
      const log = await dryRun(a, join(b, "skills", "demo-skill"), ["--skill", "demo-skill"]);
      expect(log.join("\n")).not.toMatch(NOT_TRACKED);
    });

    it("without --skill the root arm's single skill and the skill folder's own name agree too", async () => {
      const a = repo("a", "version A", manifest);
      const b = repo("b", "version B", manifest);
      expect((await dryRun(a, join(b, "skills", "demo-skill"))).join("\n")).not.toMatch(NOT_TRACKED);
    });

    it("says the arms ship different files beyond the skill, naming what only the root arm ships", async () => {
      const a = repo("a", "version A", manifest);
      const b = repo("b", "version B", manifest);
      const text = (await dryRun(a, join(b, "skills", "demo-skill"), ["--skill", "demo-skill"])).join("\n");
      expect(text).toMatch(/arms differ beyond the skill/);
      expect(text).toContain("README.md");
      expect(text).toContain("AGENTS.md");
    });

    it("control: a skill folder whose skill has another name is still not in both arms", async () => {
      const a = repo("a", "version A", manifest);
      const other = write(join(root, "other", "other-skill"), { "SKILL.md": "---\nname: other-skill\ndescription: d\n---\nx\n" });
      expect((await dryRun(a, other, ["--skill", "demo-skill"])).join("\n")).toMatch(/--skill demo-skill is not in both arms/);
    });
  });

describe("eval: two plugin-root arms", () => {
  it("control: --skill is tracked and no file-set notice is printed", async () => {
    const a = repo("a", "version A", false);
    const b = repo("b", "version B", false);
    const text = (await dryRun(a, b, ["--skill", "demo-skill"])).join("\n");
    expect(text).not.toMatch(NOT_TRACKED);
    expect(text).not.toMatch(/arms differ beyond the skill/);
  });
});
