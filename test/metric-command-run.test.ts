// Executing a command metric end to end over a real scratch repo: the staged bytes only, the closure (undeclared
// code fails loudly, a forged .pyc never runs), the env allowlist, argv without a shell, caps and time, determinism.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioMetric } from "../src/types.js";
import { resolveCommandMetrics, resolvedCommand } from "../src/metric-command/resolve.js";
import { runCommandMetric } from "../src/metric-command/run.js";
import { resetInterpreterCache } from "../src/metric-command/interpreters.js";

let root: string;
let repo: string;
const EVENTS = Buffer.from('{"type":"user"}\n{"type":"assistant","leak":"SECRET-1"}\n{"type":"assistant","leak":"x"}\n');

function write(rel: string, body: string) {
  const p = join(repo, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}
function track() {
  execFileSync("git", ["add", "-A"], { cwd: repo });
}
async function measure(m: object, events: Buffer | null = EVENTS, o: { mutateAfterResolve?: () => void } = {}) {
  const d = ScenarioMetric.parse({ id: "n", better: "lower", unbounded: true, ...m }) as ScenarioMetric & { command: string[] };
  track();
  resolveCommandMetrics({ metrics: [d] }, join(repo, "scenarios", "s.yaml"));
  o.mutateAfterResolve?.();
  return runCommandMetric({ metric: d, resolved: resolvedCommand(d)!, events: events ?? undefined, secrets: ["SECRET-1"] });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cmdrun-")));
  repo = join(root, "repo");
  mkdirSync(join(repo, "scenarios"), { recursive: true });
  writeFileSync(join(repo, "scenarios", "s.yaml"), "x: 1\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Node command metrics", () => {
  it("counts lines of the events file and reports the number with its record", async () => {
    write(
      "metrics/count.mjs",
      "import {readFileSync} from 'node:fs'; console.log(readFileSync(process.argv[2],'utf8').split('\\n').filter(Boolean).length)",
    );
    const r = await measure({ command: ["../metrics/count.mjs"] });
    expect(r.value).toBe(3);
    expect(r.command.script).toBe("metrics/count.mjs");
    expect(r.command.eventsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.command.interpreter).toContain(process.version);
  });

  it("the env is exactly the allowlist, whatever the parent holds", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.NODE_OPTIONS = "--max-old-space-size=100";
    process.env.COWORK_HARNESS_SCRUB_VALUES = "zzz";
    try {
      write("metrics/env.mjs", "console.error(JSON.stringify(Object.keys(process.env).sort())); console.log(1)");
      const r = await measure({ command: ["../metrics/env.mjs"] });
      expect(r.value).toBe(1);
      const keys = JSON.parse(r.stderr.split("\n")[0]).filter((k: string) => k !== "__CF_USER_TEXT_ENCODING");
      expect(keys).toEqual([
        "COWORK_HARNESS_METRIC_ID",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONHASHSEED",
        "PYTHONIOENCODING",
        "TMPDIR",
        "TZ",
      ]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.NODE_OPTIONS;
      delete process.env.COWORK_HARNESS_SCRUB_VALUES;
    }
  });

  it("args arrive literal (no shell), after the events path", async () => {
    write("metrics/argv.mjs", "console.error(JSON.stringify(process.argv.slice(3))); console.log(0)");
    const r = await measure({ command: ["../metrics/argv.mjs", "$(touch pwned)", "*"] });
    expect(JSON.parse(r.stderr.split("\n")[0])).toEqual(["$(touch pwned)", "*"]);
    expect(existsSync(join(repo, "scenarios", "pwned"))).toBe(false);
  });

  it("the permission model denies a read outside the temp dir and a require from an outer node_modules", async () => {
    write("node_modules/outer/index.js", "module.exports = 5");
    write("metrics/outer.cjs", "console.log(require('outer'))");
    expect((await measure({ command: ["../metrics/outer.cjs"] })).unavailable).toBe("command_failed");
    write(
      "metrics/read.mjs",
      `import {readFileSync} from 'node:fs'; readFileSync(${JSON.stringify(join(repo, "scenarios", "s.yaml"))}); console.log(1)`,
    );
    expect((await measure({ command: ["../metrics/read.mjs"] })).unavailable).toBe("command_failed");
  });

  it("an undeclared sibling is not staged, so importing it fails loudly; declaring it makes it work", async () => {
    write("metrics/helper.mjs", "export const V = 4");
    write("metrics/use.mjs", "import {V} from './helper.mjs'; console.log(V)");
    expect((await measure({ command: ["../metrics/use.mjs"] })).unavailable).toBe("command_failed");
    expect((await measure({ command: ["../metrics/use.mjs"], deps: ["../metrics/helper.mjs"] })).value).toBe(4);
  });

  it("stdout grammar, caps and time", async () => {
    write("metrics/junk.mjs", "console.log('1 2')");
    expect((await measure({ command: ["../metrics/junk.mjs"] })).unavailable).toBe("command_output");
    write("metrics/flood.mjs", "process.stdout.write('1'.repeat(1<<20))");
    expect((await measure({ command: ["../metrics/flood.mjs"] })).unavailable).toBe("command_output");
    write("metrics/noisy.mjs", "process.stderr.write('w'.repeat(1<<20)); console.log(7)");
    expect((await measure({ command: ["../metrics/noisy.mjs"] })).value).toBe(7);
    write("metrics/sleep.mjs", "setTimeout(()=>console.log(1), 60000)");
    expect((await measure({ command: ["../metrics/sleep.mjs"], timeout_ms: 1000 })).unavailable).toBe("command_timeout");
    write("metrics/fail.mjs", "console.log(3); process.exit(2)");
    expect((await measure({ command: ["../metrics/fail.mjs"] })).unavailable).toBe("command_failed");
  });

  it("two runs that disagree are nondeterministic; a Node script cannot write at all (read-only permission)", async () => {
    write("metrics/clock.mjs", "console.log(process.hrtime.bigint().toString())");
    expect((await measure({ command: ["../metrics/clock.mjs"] })).unavailable).toBe("nondeterministic");
    write("metrics/w.mjs", "import {writeFileSync} from 'node:fs'; writeFileSync('c', '1'); console.log(1)");
    expect((await measure({ command: ["../metrics/w.mjs"] })).unavailable).toBe("command_failed");
  });

  it("stderr is kept scrubbed", async () => {
    write("metrics/echo.mjs", "import {readFileSync} from 'node:fs'; console.error(readFileSync(process.argv[2],'utf8')); console.log(1)");
    const r = await measure({ command: ["../metrics/echo.mjs"] });
    expect(r.stderr).toContain("[REDACTED]");
    expect(r.stderr).not.toContain("SECRET-1");
  });

  it("a file edited after resolution is command_changed (the bytes that run must be the bytes signed)", async () => {
    write("metrics/c.mjs", "console.log(1)");
    const r = await measure({ command: ["../metrics/c.mjs"] }, EVENTS, {
      mutateAfterResolve: () => write("metrics/c.mjs", "console.log(2)"),
    });
    expect(r.unavailable).toBe("command_changed");
  });

  it("no events is no_events, never a run", async () => {
    write("metrics/c.mjs", "console.log(1)");
    const r = await measure({ command: ["../metrics/c.mjs"] }, null);
    expect(r.unavailable).toBe("no_events");
    expect(r.command.eventsSha256).toBeUndefined();
  });
});

// CI names its floor interpreter (3.9) in COWORK_TEST_PYTHON; locally, every interpreter found here runs the suite.
const pythons = [
  ...(process.env.COWORK_TEST_PYTHON
    ? [execFileSync(process.env.COWORK_TEST_PYTHON, ["-c", "import sys;print(sys.executable)"]).toString().trim()]
    : []),
  "/usr/bin/python3",
  join(process.env.HOME ?? "", ".pyenv/versions/3.11.4/bin/python3"),
]
  .filter((p, i, all) => all.indexOf(p) === i)
  .filter((p) => {
    try {
      execFileSync(p, ["-c", "import sys; assert sys.version_info >= (3, 9)"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

describe.each(pythons)("Python command metrics under %s", (py) => {
  const savedPath = process.env.PATH;
  beforeEach(() => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    execFileSync("ln", ["-s", py, join(bin, "python3")]);
    process.env.PATH = `${bin}:${savedPath}`;
    resetInterpreterCache();
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    resetInterpreterCache();
  });

  it("a plain import and a by-path load of declared deps read the STAGED copies", async () => {
    write("metrics/_dep.py", "VALUE = 7\n");
    write(
      "metrics/count.py",
      "import sys, os, importlib.util, _dep\ns = importlib.util.spec_from_file_location('d2', os.path.join(os.path.dirname(__file__), '_dep.py'))\nm = importlib.util.module_from_spec(s); s.loader.exec_module(m)\nprint(_dep.VALUE + m.VALUE + len(open(sys.argv[1]).read().splitlines()))\n",
    );
    expect((await measure({ command: ["../metrics/count.py"], deps: ["../metrics/_dep.py"] })).value).toBe(17);
  });

  it("a forged __pycache__ .pyc beside a declared dep never runs (it is not in the stage)", async () => {
    write("metrics/_dep.py", "VALUE = 1\n");
    write("metrics/use.py", "import _dep\nprint(_dep.VALUE)\n");
    // Forge: compile VALUE = 999 into the dep's cache slot with the real file's mtime and size in the header.
    const forged = join(root, "forge");
    mkdirSync(forged);
    writeFileSync(join(forged, "_dep.py"), "VALUE = 9\n");
    const st = statSync(join(repo, "metrics", "_dep.py"));
    utimesSync(join(forged, "_dep.py"), st.atime, st.mtime);
    execFileSync(py, [
      "-c",
      `import py_compile,sys; py_compile.compile(${JSON.stringify(join(forged, "_dep.py"))}, cfile=${JSON.stringify(join(repo, "metrics", "__pycache__", `_dep.cpython-${execFileSync(py, ["-c", "import sys;print('%d%d'%sys.version_info[:2])"]).toString().trim()}.pyc`))})`,
    ]);
    const r = await measure({ command: ["../metrics/use.py"], deps: ["../metrics/_dep.py"] });
    expect(r.value).toBe(1);
  });

  it("closure: an undeclared sibling, an undeclared by-path load, a third-party import each fail loudly", async () => {
    write("metrics/helper.py", "V = 3\n");
    write("metrics/a.py", "import helper\nprint(helper.V)\n");
    expect((await measure({ command: ["../metrics/a.py"] })).unavailable).toBe("command_failed");
    write(
      "metrics/b.py",
      `import importlib.util\ns = importlib.util.spec_from_file_location('h', ${JSON.stringify(join(repo, "metrics", "helper.py"))})\nm = importlib.util.module_from_spec(s); s.loader.exec_module(m)\nprint(m.V)\n`,
    );
    const b = await measure({ command: ["../metrics/b.py"] });
    expect(b.unavailable).toBe("command_failed");
    expect(b.why).toMatch(/metric sandbox: read outside the stage/);
    write("metrics/c.py", "import yaml\nprint(1)\n");
    expect((await measure({ command: ["../metrics/c.py"] })).unavailable).toBe("command_failed");
  });

  it("a counter file written into cwd does not leak from run 1 into run 2 (each run gets a fresh temp dir)", async () => {
    write(
      "metrics/counter.py",
      "import os\nn = int(open('c').read()) + 1 if os.path.exists('c') else 1\nopen('c', 'w').write(str(n))\nprint(n)\n",
    );
    const r = await measure({ command: ["../metrics/counter.py"] });
    expect(r.unavailable).toBeUndefined();
    expect(r.value).toBe(1);
  });

  it("a json.py beside the script in the repo does not shadow the stdlib (it is not staged)", async () => {
    write("metrics/json.py", "def loads(s): return 999\n");
    write("metrics/j.py", "import json\nprint(json.loads('5'))\n");
    expect((await measure({ command: ["../metrics/j.py"] })).value).toBe(5);
  });

  it("the audit hook refuses a UDP send, a repo listing and a subprocess, naming the event", async () => {
    write("metrics/udp.py", "import socket\nsocket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('127.0.0.1', 9))\nprint(1)\n");
    expect((await measure({ command: ["../metrics/udp.py"] })).why).toMatch(/metric sandbox: socket.sendto/);
    write("metrics/ls.py", `import os\nprint(len(os.listdir(${JSON.stringify(repo)})))\n`);
    expect((await measure({ command: ["../metrics/ls.py"] })).why).toMatch(/metric sandbox: os.listdir/);
    write("metrics/sub.py", "import subprocess\nsubprocess.run(['true'])\nprint(1)\n");
    expect((await measure({ command: ["../metrics/sub.py"] })).why).toMatch(/metric sandbox: subprocess.Popen/);
  });
});
