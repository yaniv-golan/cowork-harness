// A secret the on-disk artifacts redact must not reach the terminal either. `executeScenario` writes
// result.json scrubbed but returns the raw in-memory RunResult, and every printer (the json envelope, the
// text renderer and footer, verify-run, record, replay, eval) formats that in-memory object — so a
// planted secret that result.json shows as [REDACTED] used to be printed verbatim to stdout/stderr, which
// is usually a CI log. It also landed raw in an eval dir's runs.jsonl, which is built from the same object.
//
// Every case below drives the REAL CLI (dist/cli.js) with only the agent replaced: the stub `claude`
// (test/helpers/stub-agent.ts) at the protocol tier. No agent, no model call, no spend. The secret is
// planted two ways: in the agent's answer (the realistic channel) and as an assertion literal in the
// scenario (which reaches assertion messages, verdict signals and the failure footer).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);
const SECRET = "SEKRETplanted7Qx9";
// `record` and `eval` refuse to start without a credential; a made-up one is supplied. It is itself a
// scrubbed value (a KNOWN_SECRET_KEYS variable), so the same assertions cover it.
const FAKE_TOKEN = "stub-placeholder-tok-5Zr2";

const say = (text: string, isError = false) =>
  [
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
    `printf '%s\\n' '{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"${text}"}]},"session_id":"stub"}'`,
    `printf '%s\\n' '{"type":"result","subtype":"${isError ? "error_during_execution" : "success"}","is_error":${isError},"result":"${text}","session_id":"stub","num_turns":1,"total_cost_usd":0.001,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  ].join("\n");

const ANSWER = `The key is ${SECRET} ok`;
const STUB = [
  // The semantic judge's call (`-p --output-format json`) — only `eval` makes one.
  `case " $* " in *" --output-format json "*)`,
  `  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":true}]}","total_cost_usd":0.001,"modelUsage":{"claude-judge-stub-1":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
  `  exit 0;;`,
  `esac`,
  say(ANSWER),
  "cat >/dev/null",
].join("\n");

// Fails on purpose (the planted literal is absent), so the text footer prints the failed assertion AND the
// transcript dump — both carry the secret.
const FAILING_SCENARIO = `baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n  - transcript_contains: "${SECRET} nope"\n`;
const PASSING_SCENARIO = `baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n  - transcript_not_contains: "${SECRET} never"\n`;

function fixture(extra: Record<string, string> = {}): StubFixture {
  return makeStubFixture(STUB, { COWORK_HARNESS_SCRUB_VALUES: SECRET, ...extra });
}

async function cli(f: StubFixture, args: string[], ms = 30_000) {
  const c = spawnCli(f, args);
  const r = await exited(c, ms);
  return { ...r, stdout: c.stdoutText(), stderr: c.stderrText() };
}

/** Assert the secret is gone AND the scrub visibly ran — absence alone would also pass on a field that
 *  was never printed. */
function scrubbed(text: string, what: string): void {
  expect(text.includes(SECRET), `${what} carries the planted secret:\n${text.slice(0, 4000)}`).toBe(false);
  expect(text.includes(FAKE_TOKEN), `${what} carries the placeholder credential`).toBe(false);
  expect(text, `${what} shows no [REDACTED] marker — the case is not armed`).toContain("[REDACTED]");
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function onlyResultJson(f: StubFixture): string {
  const found = filesUnder(f.runsDir).filter((p) => p.endsWith("/result.json"));
  expect(found, "exactly one result.json").toHaveLength(1);
  return readFileSync(found[0], "utf8");
}

function writePlugin(dir: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
}

describe.runIf(can)("stdout/stderr are scrubbed with the same secret set as result.json", () => {
  it("run --output-format json: the envelope is one parseable document with the secret redacted", async () => {
    const f = fixture();
    try {
      writeFileSync(f.scenario, FAILING_SCENARIO);
      const r = await cli(f, ["run", f.scenario, "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(1);
      scrubbed(r.stdout, "run json stdout");
      expect(r.stderr.includes(SECRET)).toBe(false);
      const env = JSON.parse(r.stdout);
      expect(env.results[0].finalMessage).toBe("The key is [REDACTED] ok");
      expect(env.results[0].verdict.failures[0].message).toContain("[REDACTED]");
      // Parity with the file: the published result says what result.json says.
      const disk = onlyResultJson(f);
      expect(disk.includes(SECRET)).toBe(false);
      expect(JSON.parse(disk).finalMessage).toBe(env.results[0].finalMessage);
    } finally {
      f.cleanup();
    }
  });

  it("run (text): the failure footer and transcript dump on stderr are redacted", async () => {
    const f = fixture();
    try {
      writeFileSync(f.scenario, FAILING_SCENARIO);
      const r = await cli(f, ["run", f.scenario]);
      expect(r.code, r.stderr).toBe(1);
      scrubbed(r.stderr, "run text stderr");
      expect(r.stderr).toContain("transcript missing");
      expect(r.stdout.includes(SECRET)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("skill, json and text", async () => {
    const f = fixture();
    try {
      writePlugin(join(f.cwd, "demo"));
      const base = ["skill", join(f.cwd, "demo"), "say hi", "--fidelity", "protocol"];
      const j = await cli(f, [...base, "--output-format", "json"]);
      // Exit 1, not 0: an L0 run against the fixture's own config dir fails the contamination guard. The
      // run itself completes, which is all this case needs.
      expect(j.code, j.stderr).toBe(1);
      scrubbed(j.stdout, "skill json stdout");
      expect(JSON.parse(j.stdout).results[0].finalMessage).toBe("The key is [REDACTED] ok");
      expect(j.stderr.includes(SECRET)).toBe(false);
      const t = await cli(f, base);
      expect(t.code, t.stderr).toBe(1);
      expect(t.stdout.includes(SECRET)).toBe(false);
      expect(t.stderr.includes(SECRET), t.stderr).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("verify-run re-grades a kept run: the scenario's assertion literals are redacted in json and text", async () => {
    const f = fixture();
    try {
      writeFileSync(f.scenario, FAILING_SCENARIO);
      await cli(f, ["run", f.scenario]);
      const resultJson = filesUnder(f.runsDir).find((p) => p.endsWith("/result.json"))!;
      const runDir = join(resultJson, "..", "..", "..");
      const j = await cli(f, ["verify-run", runDir, f.scenario, "--output-format", "json"]);
      expect(j.code, j.stderr).toBe(1);
      scrubbed(j.stdout, "verify-run json stdout");
      JSON.parse(j.stdout);
      const t = await cli(f, ["verify-run", runDir, f.scenario]);
      expect(t.stdout.includes(SECRET)).toBe(false);
      scrubbed(t.stderr, "verify-run text stderr");
    } finally {
      f.cleanup();
    }
  });

  it("record then replay: neither envelope carries the secret", async () => {
    const f = fixture({ ANTHROPIC_API_KEY: FAKE_TOKEN });
    try {
      writeFileSync(f.scenario, PASSING_SCENARIO);
      const cassette = join(f.cwd, "stub.cassette.json");
      const rec = await cli(f, ["record", f.scenario, "--out", cassette, "--output-format", "json"]);
      expect(rec.code, rec.stderr).toBe(0);
      scrubbed(rec.stdout, "record json stdout");
      JSON.parse(rec.stdout);
      const rep = await cli(f, ["replay", cassette, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
      scrubbed(rep.stdout, "replay json stdout");
      JSON.parse(rep.stdout);
    } finally {
      f.cleanup();
    }
  });

  it("eval: stdout, runs.jsonl and the report files carry no secret", async () => {
    // The agent turn ends in error so runs.jsonl keeps its (capped) finalMessage. (The rubric does NOT carry
    // the literal: the manifest freezes the authored scenario verbatim, as a cassette does.) The finalMessage is cut at 300 chars, so a secret straddling the cut would evade a
    // scrub applied after the slice — the padding puts a second copy straddling exactly there.
    const pad = "x".repeat(300 - SECRET.length - 1 - 6);
    const errStub = [
      `case " $* " in *" --output-format json "*)`,
      `  printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":true}]}","total_cost_usd":0.001,"modelUsage":{"claude-judge-stub-1":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
      `  exit 0;;`,
      `esac`,
      say(`${SECRET} ${pad}${SECRET} tail`, true),
      "cat >/dev/null",
    ].join("\n");
    const f = makeStubFixture(errStub, { COWORK_HARNESS_SCRUB_VALUES: SECRET, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    try {
      for (const d of ["declared", "a", "b"]) writePlugin(join(f.cwd, d, "demo"));
      writeFileSync(join(f.cwd, "session.yaml"), "model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/demo\n");
      writeFileSync(
        join(f.cwd, "q.yaml"),
        `baseline: latest\nsession: ./session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - semantic_matches:\n      rubric:\n        - "mentions the key"\n`,
      );
      const out = join(f.root, "eval");
      const r = await cli(
        f,
        [
          "eval",
          "q.yaml",
          "--arm",
          "a=./a/demo",
          "--arm",
          "b=./b/demo",
          "--reps",
          "2",
          "--allow-underpowered",
          "--allow-identical-arms",
          "--judge-model",
          "claude-judge-stub-1",
          "--out",
          out,
          "--output-format",
          "json",
        ],
        120_000,
      );
      expect(existsSync(join(out, "runs.jsonl")), r.stdout + r.stderr).toBe(true);
      expect(r.stdout.includes(SECRET), "eval stdout").toBe(false);
      expect(r.stderr.includes(SECRET), "eval stderr").toBe(false);
      JSON.parse(r.stdout);
      const files = filesUnder(out);
      expect(files.map((p) => relative(out, p))).toEqual(expect.arrayContaining(["runs.jsonl", "report.json", "report.md"]));
      for (const p of files) {
        const body = readFileSync(p, "utf8");
        expect(body.includes(SECRET), `${relative(out, p)} carries the secret`).toBe(false);
        // The 300-char cap must not leave a secret PREFIX behind either.
        expect(body.includes(SECRET.slice(0, 6)), `${relative(out, p)} carries a truncated secret`).toBe(false);
      }
      scrubbed(readFileSync(join(out, "runs.jsonl"), "utf8"), "runs.jsonl");
    } finally {
      f.cleanup();
    }
  });
});

// The fix scrubs at the two seams every terminal printer goes through: `writeAllSync` for fd 1/2
// (src/io.ts), and the process.stdout/stderr stream wrap `main()` installs (which also covers `console.*`,
// `warn()` and the direct `process.stderr.write` callers). A write to fd 1/2 by NUMBER bypasses both, so
// none may exist outside src/io.ts.
describe("no terminal printer bypasses the scrubbing seams", () => {
  it("src/ has no raw fd-1/2 writeSync outside src/io.ts", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && p !== join("src", "io.ts")) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
              if (/\bwriteSync\(\s*([12]|process\.std(out|err)\.fd)\b/.test(code)) offenders.push(`${p}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});

// The stream seam, in isolation: the printers that bypass writeAllSync (warn(), console.*, direct
// process.stderr.write callers such as the LLM decider's question echo) — string and Buffer chunks alike.
describe.runIf(existsSync(resolve("dist/io.js")))("installTerminalScrub", () => {
  it("scrubs process.stdout/stderr.write, console.* and warn(); a clean Buffer passes byte-identical", () => {
    const script = `
      const io = await import(${JSON.stringify(resolve("dist/io.js"))});
      io.installTerminalScrub(); io.installTerminalScrub(); // idempotent: no double wrap
      process.stdout.write("s:${SECRET}\\n");
      process.stdout.write(Buffer.from("b:${SECRET}\\n"));
      process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));
      console.log("c:${SECRET}");
      process.stderr.write("e:${SECRET}\\n");
      console.error("ce:${SECRET}");
      io.warn("w:${SECRET}");
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, COWORK_HARNESS_SCRUB_VALUES: SECRET },
    });
    expect(r.status, r.stderr.toString()).toBe(0);
    const out = r.stdout;
    expect(out.includes(Buffer.from(SECRET))).toBe(false);
    expect(out.toString("latin1")).toBe("s:[REDACTED]\nb:[REDACTED]\n\xff\xfe\nc:[REDACTED]\n");
    expect(r.stderr.toString()).toBe("e:[REDACTED]\nce:[REDACTED]\n::warning:: w:[REDACTED]\n");
  });
});
