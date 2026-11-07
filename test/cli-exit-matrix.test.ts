import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT_FALLBACK_LINE } from "../src/run/exit.js";

// Every subcommand ends by asking to exit (src/run/exit.ts) and lets the event loop drain. What this pins, per
// subcommand: the exit code is the documented one, and the process ended by itself: the fallback (which fires 5 s
// after the command when something still holds the loop) did not fire. A regression where every refusal waits for
// the fallback would still exit with the right code; the fallback's line on stderr is what catches it. (No wall-time
// bound: on a loaded machine it would fail for reasons that say nothing about the fallback.)
const CLI = resolve("dist/cli.js");
const built = existsSync(CLI);

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const base = { ...process.env };
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "COWORK_HARNESS_OUTPUT_FORMAT"]) delete base[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...base, ...env }, timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function endedByItself(r: ReturnType<typeof cli>) {
  expect(r.stderr, "the exit fallback fired: something held the event loop after the command").not.toContain(EXIT_FALLBACK_LINE);
}

/** Commands with no JSON output at all, so a usage error under `--output-format json` prints none. Each with why. */
const NO_JSON_MODE: Record<string, string> = {
  // An interactive session in the operator's terminal; it has no machine-readable mode to report an envelope in.
  chat: "interactive, no JSON mode",
};

const COMMANDS = [
  "run",
  "skill",
  "record",
  "replay",
  "eval",
  "hillclimb",
  "critique",
  "doctor",
  "prune",
  "ref",
  "search-pool",
  "fixture",
  "decide",
  "regrade",
  "chat",
  "verify-cassettes",
  "status",
  "analyze-skill",
];

describe.skipIf(!built)("exit matrix: each subcommand exits by itself with its documented code", () => {
  const cwd = mkdtempSync(join(tmpdir(), "exit-matrix-"));

  for (const c of COMMANDS) {
    it(`${c} --help exits 0`, () => {
      const r = cli([c, "--help"], cwd);
      expect(r.code, r.stderr).toBe(0);
      expect((r.stdout + r.stderr).length).toBeGreaterThan(0);
      endedByItself(r);
    });

    it(`${c} with an unknown flag is a usage error: exit 2, and a JSON envelope under --output-format json`, () => {
      const t = cli([c, "--no-such-flag"], cwd);
      expect(t.code, t.stderr).toBe(2);
      endedByItself(t);
      const j = cli([c, "--no-such-flag", "--output-format", "json"], cwd);
      expect(j.code, j.stderr).toBe(2);
      endedByItself(j);
      if (c in NO_JSON_MODE) expect(j.stdout, NO_JSON_MODE[c]).toBe("");
      else expect(JSON.parse(j.stdout)).toMatchObject({ ok: false, error: { category: "usage" } });
    });
  }

  // critique's module can also be run directly (`node dist/critique/command.js`, `tsx src/critique/command.ts`). That
  // entry has the same top level as this one, so a requested exit keeps its code and prints no stack.
  for (const args of [[], ["--no-such-flag"]])
    it(`critique run directly${args.length ? ` with ${args[0]}` : " with no arguments"} is a usage error: exit 2, no stack`, () => {
      const r = spawnSync(process.execPath, [resolve("dist/critique/command.js"), ...args], { cwd, encoding: "utf8", timeout: 30_000 });
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).not.toMatch(/ExitRequested|\n\s+at /);
      expect(r.stderr).not.toContain(EXIT_FALLBACK_LINE);
    });

  it("an unknown command exits 2", () => {
    const r = cli(["no-such-command"], cwd);
    expect(r.code).toBe(2);
    endedByItself(r);
  });

  it("a could-not-verify analysis exits 3 (boundary)", () => {
    const d = mkdtempSync(join(tmpdir(), "exit-matrix-art-"));
    try {
      writeFileSync(
        join(d, "viewer.html"),
        `<!doctype html><html><body><button id="b">go</button><script>const url = ${"${broken}"}; fetch("/api/x",{method:"POST"})</script></body></html>`,
      );
      const r = cli(["analyze-skill", join(d, "viewer.html")], d);
      expect(r.code, r.stderr).toBe(3);
      endedByItself(r);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("decide with no matching rule exits 1 and prints exactly one JSON document", () => {
    const r = cli(["decide", "--question", "Pick one", "--answer", "nothing-like-it=A", "--output-format", "json"], cwd);
    expect(r.code, r.stderr).toBe(1);
    const docs = r.stdout.trim().split("\n").filter(Boolean);
    expect(docs, r.stdout).toHaveLength(1);
    expect(JSON.parse(docs[0])).toMatchObject({ command: "decide", ok: false, matched: false });
    endedByItself(r);
  });

  // Without jsdom the runtime confirmer runs nothing, so this case would prove nothing: a visible skip, not a pass.
  it.runIf(existsSync(resolve("node_modules/jsdom")))(
    "a page's async throw under analyze-skill --runtime is recorded as a page crash, not an uncaught error",
    () => {
      // The CLI's process-level handler is the first `unhandledRejection` listener; the runtime confirmer installs a
      // second one that records a page's throw. The first must leave the error to it (and not end the process).
      const d = mkdtempSync(join(tmpdir(), "exit-matrix-page-"));
      try {
        writeFileSync(
          join(d, "viewer.html"),
          "<!DOCTYPE html><html><body><button id='s'>Save</button><script>\n" +
            'Promise.reject(new Error("page-async-rejection"));\n' +
            "document.getElementById('s').addEventListener('click',function(){ fetch('/api/save',{method:'POST'}); });\n" +
            "</script></body></html>\n",
        );
        const r = cli(["analyze-skill", join(d, "viewer.html"), "--runtime", "--output-format", "json"], d);
        expect(r.code, r.stderr).toBe(0);
        expect(r.stderr).not.toMatch(/\n\s+at /);
        const c = JSON.parse(r.stdout).runtimeConfirmations[0];
        expect(c.available, "jsdom is installed, so the confirmer must have run").not.toBe(false);
        expect(JSON.stringify(c.evidence)).toContain("unhandled rejection: Error: page-async-rejection");
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(process.platform === "win32")(
    "chat --raw waits for the interactive session (longer than the exit fallback) and exits with its code",
    () => {
      // A stand-in container runtime that keeps the "session" open for 6 s, past the 5 s fallback, then exits 7.
      const d = mkdtempSync(join(tmpdir(), "exit-matrix-raw-"));
      try {
        mkdirSync(join(d, "skill"));
        writeFileSync(join(d, "rt"), "#!/bin/sh\nsleep 6\nexit 7\n");
        chmodSync(join(d, "rt"), 0o755);
        writeFileSync(join(d, "agent"), "not an agent");
        const t0 = Date.now();
        const env: NodeJS.ProcessEnv = { ...process.env, COWORK_CONTAINER_RUNTIME: join(d, "rt"), COWORK_AGENT_BINARY: join(d, "agent") };
        delete env.COWORK_HARNESS_FORBID_SPAWN;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        const r = spawnSync(process.execPath, [CLI, "chat", "skill", "--raw", "--model", "claude-sonnet-5"], {
          cwd: d,
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        });
        expect(r.status, r.stderr).toBe(7);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(5900);
        expect(r.stderr).not.toContain(EXIT_FALLBACK_LINE);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("critique whose task turn cannot run is an instrument failure: exit 2, the report, and no 'unexpected failure'", () => {
    // The task turn is refused before any agent starts (the unit lane forbids spawning one). critique reports that
    // as an instrument failure and asks to exit 2 from inside its own try; the outer catch must pass the request
    // through. If it caught it instead, the exit code would still be 2, but with an "unexpected failure" stack.
    const d = mkdtempSync(join(tmpdir(), "exit-matrix-critique-"));
    try {
      mkdirSync(join(d, "skill"));
      mkdirSync(join(d, "home"));
      writeFileSync(join(d, "skill", "SKILL.md"), "---\nname: s\ndescription: d\n---\nbody\n");
      const r = cli(["critique", "skill", "--prompt", "do it", "--model", "claude-sonnet-5", "--output-format", "json"], d, {
        HOME: join(d, "home"),
        COWORK_HARNESS_FORBID_SPAWN: "1",
      });
      expect(r.code, r.stderr).toBe(2);
      expect(JSON.parse(r.stdout)).toMatchObject({ infraFailurePhase: "task turn" });
      expect(r.stderr).not.toContain("unexpected failure");
      expect(r.stderr).not.toContain(EXIT_FALLBACK_LINE);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it("a scenario file that does not exist is a usage error with a JSON envelope", () => {
    const r = cli(["run", join(cwd, "missing.yaml"), "--output-format", "json"], cwd);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { category: "usage" } });
    endedByItself(r);
  });
});
