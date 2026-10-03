// A recorded transcript's non-assistant/user lines are never committed. Real runs' transcripts carry agent-binary
// text that is not ours to publish: the built-in sub-agent prompt (a `prompt_snapshot` attachment), the tool and
// agent listings, and the frame the binary wraps around a sub-agent's report. This guard covers every committed
// transcript (.jsonl under test/fixtures/ and examples/) AND every committed cassette (*.cassette.json, whose
// `events` are the same transcript lines as escaped JSON strings); the pre-commit hook stops a new one at the door.
import { describe, it, expect } from "vitest";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const jsonl = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? jsonl(p) : n.endsWith(".jsonl") ? [p] : [];
  });

const SENTINELS = [
  "You are an agent for Claude Code",
  "Anthropic's official CLI",
  "prompt_snapshot",
  "[Subagent hand-back]",
  "use SendMessage with to:",
];

const files = [...jsonl(join(REPO, "test", "fixtures")), ...jsonl(join(REPO, "examples"))];

// Every committed cassette, from git (a cassette can live outside test/fixtures and examples, e.g. test/evals).
const cassettes = execFileSync("git", ["ls-files", "*.cassette.json"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
// In a cassette the transcript lines are JSON STRINGS, so an attachment line appears with escaped quotes.
const ATTACHMENT = /"type":\s*"attachment"|\\"type\\":\s*\\"attachment\\"/;

describe("committed cassettes carry no agent-binary text", () => {
  it("there are cassettes to check (the guard is not vacuous)", () => {
    expect(cassettes.length).toBeGreaterThanOrEqual(4);
  });
  for (const f of cassettes)
    it(f, () => {
      const text = readFileSync(join(REPO, f), "utf8");
      expect(ATTACHMENT.test(text), `${f} has an attachment line`).toBe(false);
      for (const s of SENTINELS) expect(text.includes(s), `${f} contains ${s}`).toBe(false);
    });
});

// The hook half, end to end in a scratch repo (a stub CLI stands in for verify-cassettes, which is not what this
// tests): a staged cassette carrying a sentinel is blocked; the same cassette without it is not blocked for it.
describe("pre-commit hook: a staged cassette with agent-binary text is blocked", () => {
  // `scrubModule`: the body of the scratch repo's dist/run/cassette.js — absent by default (a stub-only dist).
  // `srcCassette`: the body of its src/run/cassette.ts, where the hook reads RECORDED_SCRUB_VERSION — by default the
  // real source whenever a scrub module is given; `null` leaves it out.
  const run = (cassetteBody: string, scrubModule?: string, srcCassette?: string | null): { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-transcript-hook-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    mkdirSync(join(dir, ".githooks"), { recursive: true });
    cpSync(join(REPO, ".githooks", "pre-commit"), join(dir, ".githooks", "pre-commit"));
    chmodSync(join(dir, ".githooks", "pre-commit"), 0o755);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "dist", "cli.js"),
      'process.stdout.write(process.argv.includes("json") ? \'{"results":[]}\' : "stub\\n"); process.exit(0);',
    );
    if (scrubModule !== undefined) {
      mkdirSync(join(dir, "dist", "run"), { recursive: true });
      writeFileSync(join(dir, "dist", "run", "cassette.js"), scrubModule);
      const src = srcCassette === undefined ? readFileSync(join(REPO, "src", "run", "cassette.ts"), "utf8") : srcCassette;
      if (src !== null) {
        mkdirSync(join(dir, "src", "run"), { recursive: true });
        writeFileSync(join(dir, "src", "run", "cassette.ts"), src);
      }
    }
    mkdirSync(join(dir, "test", "evals"), { recursive: true });
    writeFileSync(join(dir, "test", "evals", "x.cassette.json"), cassetteBody);
    git("add", "test/evals/x.cassette.json");
    try {
      return { code: 0, out: execFileSync("bash", [join(dir, ".githooks", "pre-commit")], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };
  const body = (text: string) =>
    JSON.stringify(
      { generator: "cowork-harness", events: [JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } })] },
      null,
      2,
    );
  it.each([["[Subagent hand-back] frame"], ["use SendMessage with to: 'x'"], ["prompt_snapshot"]])("blocks %s", (text) => {
    const r = run(body(text));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/carries agent-binary text/);
  });
  it("blocks an escaped attachment line inside a cassette", () => {
    const r = run(
      JSON.stringify({ generator: "cowork-harness", events: [JSON.stringify({ type: "attachment", attachment: {} })] }, null, 2),
    );
    expect(r.out).toMatch(/carries agent-binary text/);
  });
  it("control: a clean cassette is not blocked for agent-binary text", () => {
    expect(run(body("[subagent report]\n  the body")).out).not.toMatch(/carries agent-binary text/);
  });

  // The built-in description check runs the recorder's own scrub, so it needs the REAL built module.
  const REAL_SCRUB = join(REPO, "dist", "run", "cassette.js");
  const realScrub = `export * from ${JSON.stringify(REAL_SCRUB)};\n`;
  const registry = (description: string) =>
    JSON.stringify(
      {
        generator: "cowork-harness",
        events: [
          JSON.stringify({
            type: "control_response",
            response: {
              request_id: "init-1",
              response: {
                commands: [
                  { name: "claude-api", description, builtin: true },
                  { name: "my-plugin:my-skill", description: "the plugin's own text" },
                ],
                agents: [{ name: "my-plugin:my-agent", description: "the plugin's own agent text" }],
              },
            },
          }),
        ],
      },
      null,
      2,
    );
  it("blocks a staged cassette carrying a built-in command's description", () => {
    if (!statSync(REAL_SCRUB, { throwIfNoEntry: false })) throw new Error("dist/run/cassette.js missing — run `npm run build`");
    const r = run(registry("SYNTHETIC BUILT-IN PROSE"), realScrub);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/carries the description or argument hint of a Claude Code built-in agent or command/);
    expect(r.out).toContain("test/evals/x.cassette.json");
  });
  it("control: the placeholder (and a plugin's own description) is not blocked by it", async () => {
    if (!statSync(REAL_SCRUB, { throwIfNoEntry: false })) throw new Error("dist/run/cassette.js missing — run `npm run build`");
    const { BUILTIN_DESCRIPTION_PLACEHOLDER } = await import("../src/run/cassette.js");
    const r = run(registry(BUILTIN_DESCRIPTION_PLACEHOLDER), realScrub);
    expect(r.out).not.toMatch(/built-in agent or command/);
    expect(r.code).toBe(0);
  });
  // A STALE dist: built before the scrub learned something new, it would pass what the current recorder removes.
  // The hook compares the built RECORDED_SCRUB_VERSION with the source's and blocks on any mismatch.
  it.each([
    ["an older version", `export * from ${JSON.stringify(REAL_SCRUB)};\nexport const RECORDED_SCRUB_VERSION = 1;\n`, undefined],
    ["no version at all (predates the export)", `export { scrubRecordedAgentData } from ${JSON.stringify(REAL_SCRUB)};\n`, undefined],
    ["a source that names no version", realScrub, null],
  ] as const)("blocks a stale dist — %s — even on a clean cassette", async (_label, mod, src) => {
    if (!statSync(REAL_SCRUB, { throwIfNoEntry: false })) throw new Error("dist/run/cassette.js missing — run `npm run build`");
    const { BUILTIN_DESCRIPTION_PLACEHOLDER } = await import("../src/run/cassette.js");
    const r = run(registry(BUILTIN_DESCRIPTION_PLACEHOLDER), mod, src);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/dist\/ is stale/);
    expect(r.out).toMatch(/npm run build/);
  });
  it("blocks when the check cannot run (the probe crashes), rather than passing", () => {
    const r = run(registry("SYNTHETIC BUILT-IN PROSE"), 'throw new Error("broken build");\n');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/could not check a staged cassette for built-in descriptions/);
  });
});

describe("committed transcripts carry no agent-binary text", () => {
  it("there are transcripts to check (the guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files)
    it(relative(REPO, f), () => {
      const text = readFileSync(f, "utf8");
      expect(/"type":\s*"attachment"/.test(text), `${relative(REPO, f)} has an attachment line`).toBe(false);
      for (const s of SENTINELS) expect(text.includes(s), `${relative(REPO, f)} contains ${s}`).toBe(false);
    });
});

// Tests that build SYNTHETIC transcript lines in code (not a .jsonl fixture). They must carry the frame SHAPES
// only: "prompt_snapshot" is allowed as the shape's type name, but the withheld built-in parts stay placeholder
// strings, so a re-capture from a real run can never bring the built-in prompt back in through a test file.
const SYNTHETIC_SHAPE_TESTS: Array<{ file: string; placeholder: string }> = [
  {
    file: "test/hillclimb-subagent-system.test.ts",
    placeholder: 'const BUILTIN = ["BUILTIN-PART-0", "BUILTIN-PART-1", "BUILTIN-PART-2", "BUILTIN-PART-3"];',
  },
  {
    file: "test/hillclimb-e2e.test.ts",
    placeholder: 'const BUILTIN = ["BUILTIN-PART-0", "BUILTIN-PART-1", "BUILTIN-PART-2", "BUILTIN-PART-3"];',
  },
];

describe("in-code synthetic transcript lines carry shapes, never agent-binary text", () => {
  for (const { file, placeholder } of SYNTHETIC_SHAPE_TESTS)
    it(file, () => {
      const text = readFileSync(join(REPO, file), "utf8");
      for (const s of SENTINELS.filter((x) => x !== "prompt_snapshot")) expect(text.includes(s), `${file} contains ${s}`).toBe(false);
      expect(text.includes(placeholder), `${file}: the withheld parts must stay the literal placeholders`).toBe(true);
      // the placeholder array is the only systemPrompt source
      expect(text.match(/systemPrompt:/g)?.length, `${file}: one systemPrompt literal`).toBe(1);
    });
});
