import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { resolveStatusTarget } from "../src/run/status-target.js";
import type { RunRecord } from "../src/run/run.js";
import type { RunStatus } from "../src/types.js";
import {
  writeRunningStatus,
  startStatusTicker,
  finalizeRunStatus,
  markRunStatusCrashed,
  registerRunForCrashSafety,
  crashAllPendingRunStatuses,
  isStatusStale,
  readRunStatus,
  hasRunStatus,
  resolveStatusDir,
  followRunStatus,
  statusLine,
  type RunStatusMeta,
} from "../src/run/run-status.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cwh-status-"));
const meta = (over: Partial<RunStatusMeta> = {}): RunStatusMeta => ({
  pid: 12345,
  scenario: "my-scenario",
  fidelity: "container",
  sessionId: "local_abc",
  startedAt: Date.now(),
  ...over,
});
const record = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    runId: "run",
    result: "success",
    initTools: [],
    transcript: "",
    toolsCalled: new Set(),
    toolCounts: { Read: 2, Bash: 1 },
    models: [],
    subagentTools: new Set(),
    subagents: [{ toolUseId: "t1", dispatchAgentType: "Explore", declaredTools: [], toolsUsed: [] }],
    questions: [],
    decisions: [],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    ...over,
  }) as RunRecord;

describe("writeRunningStatus", () => {
  it("writes state:running with zero counts", () => {
    const dir = tmp();
    writeRunningStatus(dir, meta());
    const status = readRunStatus(dir);
    expect(status.state).toBe("running");
    expect(status.toolCounts).toEqual({});
    expect(status.subagentCount).toBe(0);
    expect(status.pid).toBe(12345);
    expect(status.result).toBeUndefined();
  });
});

describe("startStatusTicker", () => {
  it("periodically overwrites status.json with live counts from record()", async () => {
    const dir = tmp();
    const m = meta();
    writeRunningStatus(dir, m);
    const before = process.env.COWORK_HARNESS_STATUS_INTERVAL_MS;
    process.env.COWORK_HARNESS_STATUS_INTERVAL_MS = "5";
    const stop = startStatusTicker(dir, m, () => record());
    await new Promise((r) => setTimeout(r, 30));
    stop();
    // restore precisely — assigning `undefined` would coerce to the STRING "undefined" and pollute env
    // for any later envPositiveNumber("COWORK_HARNESS_STATUS_INTERVAL_MS") read in the same process.
    if (before === undefined) delete process.env.COWORK_HARNESS_STATUS_INTERVAL_MS;
    else process.env.COWORK_HARNESS_STATUS_INTERVAL_MS = before;
    const status = readRunStatus(dir);
    expect(status.state).toBe("running");
    expect(status.toolCounts).toEqual({ Read: 2, Bash: 1 });
    expect(status.subagentCount).toBe(1);
  });
});

describe("finalizeRunStatus", () => {
  it("writes a terminal state with result + durationMs", () => {
    const dir = tmp();
    const m = meta();
    writeRunningStatus(dir, m);
    finalizeRunStatus(dir, m, record(), "success", 4567);
    const status = readRunStatus(dir);
    expect(status.state).toBe("done");
    expect(status.result).toBe("success");
    expect(status.durationMs).toBe(4567);
    expect(status.toolCounts).toEqual({ Read: 2, Bash: 1 });
  });

  it("writes state:error for a non-success result", () => {
    const dir = tmp();
    const m = meta();
    finalizeRunStatus(dir, m, record({ result: "error" }), "error", 100);
    expect(readRunStatus(dir).state).toBe("error");
  });
});

describe("markRunStatusCrashed", () => {
  it("writes a terminal error status with no RunRecord required (the exit-handler crash path)", () => {
    const dir = tmp();
    const m = meta();
    writeRunningStatus(dir, m);
    markRunStatusCrashed(dir, m);
    const status = readRunStatus(dir);
    expect(status.state).toBe("error");
    expect(status.result).toBe("error");
    expect(status.toolCounts).toEqual({});
    expect(status.subagentCount).toBe(0);
  });
});

describe("registerRunForCrashSafety / crashAllPendingRunStatuses", () => {
  // crashAllPendingRunStatuses() is the exit-handler's body, called directly here to simulate "the
  // process is exiting NOW" without actually exiting the test process. This is what proves the
  // concurrency-safety property a single per-call process.on/process.off pair could NOT provide: multiple
  // in-process runs (record --concurrency) sharing ONE process-level listener, where a run that never
  // calls finalize() (the crash case) is correctly swept while a cleanly-finalized sibling is untouched.

  it("a finalized run is removed from the pending set — a later sweep does not re-mark it", () => {
    const dir = tmp();
    const m = meta();
    writeRunningStatus(dir, m);
    const { finalize } = registerRunForCrashSafety(dir, m);
    finalize(record(), "success", 100);
    crashAllPendingRunStatuses(); // simulates "the process exits now" — must be a no-op for this run
    expect(readRunStatus(dir).state).toBe("done"); // NOT overwritten back to "error"
  });

  it("a NEVER-finalized run (simulating a crash mid-batch) IS marked error by the sweep", () => {
    const dir = tmp();
    const m = meta();
    writeRunningStatus(dir, m);
    registerRunForCrashSafety(dir, m); // .finalize() deliberately never called
    crashAllPendingRunStatuses();
    expect(readRunStatus(dir).state).toBe("error");
  });

  it("two concurrent registrations don't leak into each other: finalizing one doesn't affect a sibling still pending", () => {
    const dirA = tmp();
    const dirB = tmp();
    const mA = meta({ sessionId: "a" });
    const mB = meta({ sessionId: "b" });
    writeRunningStatus(dirA, mA);
    writeRunningStatus(dirB, mB);
    const runA = registerRunForCrashSafety(dirA, mA);
    registerRunForCrashSafety(dirB, mB); // simulates B crashing (a non-UnansweredError throw) — never finalized
    runA.finalize(record(), "success", 50);
    crashAllPendingRunStatuses();
    expect(readRunStatus(dirA).state).toBe("done"); // A finalized cleanly — untouched by the sweep
    expect(readRunStatus(dirB).state).toBe("error"); // B never finalized — swept as crashed
  });
});

describe("isStatusStale", () => {
  const running = (updatedAt: string): RunStatus => ({
    schemaVersion: 1,
    state: "running",
    pid: 1,
    scenario: "s",
    fidelity: "container",
    sessionId: "local_x",
    startedAt: updatedAt,
    updatedAt,
    elapsedMs: 0,
    toolCounts: {},
    subagentCount: 0,
  });

  it("is false for a fresh running status", () => {
    expect(isStatusStale(running(new Date().toISOString()), 15_000)).toBe(false);
  });

  it("is true once updatedAt exceeds the threshold", () => {
    expect(isStatusStale(running(new Date(Date.now() - 20_000).toISOString()), 15_000)).toBe(true);
  });

  it("is true for an unparseable updatedAt — fail toward suspect, not toward blind trust", () => {
    expect(isStatusStale(running("not-a-valid-date"), 15_000)).toBe(true);
  });

  it("is ALWAYS false for a terminal status, no matter how old updatedAt is (done/error don't go stale)", () => {
    expect(isStatusStale({ ...running(new Date(0).toISOString()), state: "done", result: "success", durationMs: 1 }, 1)).toBe(false);
    expect(isStatusStale({ ...running(new Date(0).toISOString()), state: "error", result: "error", durationMs: 1 }, 1)).toBe(false);
  });
});

describe("hasRunStatus / readRunStatus", () => {
  it("hasRunStatus is false before any write, true after", () => {
    const dir = tmp();
    expect(hasRunStatus(dir)).toBe(false);
    writeRunningStatus(dir, meta());
    expect(hasRunStatus(dir)).toBe(true);
  });
});

describe("readRunStatus shape validation (F49)", () => {
  it("rejects a status.json that parses as valid JSON but is shape-invalid: `{}`", () => {
    const dir = tmp();
    writeFileSync(join(dir, "status.json"), "{}");
    expect(() => readRunStatus(dir)).toThrow(/shape/);
  });

  it("rejects a status.json with a wrong-typed `state` field: `{state:123}`", () => {
    const dir = tmp();
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: 123, updatedAt: new Date().toISOString() }));
    expect(() => readRunStatus(dir)).toThrow(/shape/);
  });

  it("accepts a genuinely valid status", () => {
    const dir = tmp();
    writeRunningStatus(dir, meta());
    const status = readRunStatus(dir);
    expect(status.state).toBe("running");
  });

  it("a shape-invalid-but-parseable status routes through followRunStatus's SAME corrupt-status deadline as a parse failure, instead of resolving as a fake terminal status", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "status.json"), "{}"); // parses fine, fails shape validation — `state` isn't even present
    await expect(followRunStatus(dir, () => {}, { pollMs: 5, corruptTimeoutMs: 20 })).rejects.toThrow(/corrupt|never parsed/);
  });
});

describe("resolveStatusDir", () => {
  it("returns a literal directory argument directly (works even before events.jsonl exists)", () => {
    const dir = tmp();
    expect(resolveStatusDir(dir)).toBe(dir);
  });

  it("throws for a nonexistent, non-run-id argument", () => {
    expect(() => resolveStatusDir("/no/such/dir/at/all")).toThrow();
  });

  it("expands a bare '~' to the home directory BEFORE the existsSync check runs (defense-in-depth for a human-pasted tildeified path — the printed [status] line itself is always the raw absolute path)", () => {
    // os.homedir() always exists, so this proves the tilde was expanded prior to the existsSync/statSync
    // check without depending on any specific layout under the real home directory.
    expect(resolveStatusDir("~")).toBe(homedir());
  });

  it("expands a '~/<subpath>' form to the home directory too — the shape a human would actually paste", () => {
    // Creates (and cleans up) a real scratch dir under the actual home directory — the only way to
    // exercise the "~/<subpath>" branch without depending on any pre-existing layout there.
    const sub = mkdtempSync(join(homedir(), ".cwh-status-test-"));
    try {
      const tildePath = join("~", relative(homedir(), sub));
      expect(resolveStatusDir(tildePath)).toBe(sub);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});

// Direct, always-running coverage of the `cmdStatus` root-resolution WIRING (src/run/status-target.ts).
// This is the primary coverage for the wiring: it imports `resolveStatusTarget` directly, so it runs on
// every `npm test` invocation — including CI, which runs `npm test` BEFORE `npm run build`, so the
// dist-spawn describe block below (`can` gated on `dist/cli.js` existing) silently skips there and must
// not be the only coverage of this behavior.
describe("resolveStatusTarget", () => {
  it("resolves a --run-dir ROOT (no status.json at the top) to the newest nested session, two levels down", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-status-target-root-"));
    const dir = join(root, "skill-x", "local_1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "done", startedAt: "2026-07-16T10:00:00.000Z" }));
    expect(resolveStatusTarget(root)).toBe(dir);
  });

  it("returns a literal run dir (status.json at the top) UNCHANGED — no nested scan performed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-status-target-literal-"));
    writeFileSync(join(dir, "status.json"), JSON.stringify({ state: "done", startedAt: "2026-07-16T10:00:00.000Z" }));
    expect(resolveStatusTarget(dir)).toBe(dir);
  });

  it("falls back to the original (unresolved) dir when no nested session qualifies, so cmdStatus's own error reports against it", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-status-target-empty-"));
    mkdirSync(join(root, "no-status-anywhere"), { recursive: true });
    expect(resolveStatusTarget(root)).toBe(root);
  });

  it("resolveStatusDir('~') still returns homedir() — confirmed directly alongside resolveStatusTarget, since the root-resolution wiring layers on top of it, not inside it", () => {
    expect(resolveStatusDir("~")).toBe(homedir());
  });
});

// CLI-level coverage for `cmdStatus`'s root-resolution wiring (findLatestRunUnderRoot via
// resolveStatusTarget): an EXTRA integration layer on top of the direct `resolveStatusTarget` unit tests
// above (which are what must always run — see that block's comment for why). `cmdStatus` itself isn't
// exported (it calls process.exit), so this drives the built CLI the same way test/cli-status.test.ts
// does; `describe.skipIf(!can)`-gated on `dist/cli.js` existing, so it silently skips on a pre-build
// `npm test` (e.g. this repo's CI, which runs tests before `build`) — intentional, since the wiring
// itself is already covered above regardless of build state.
describe("cmdStatus root-dir resolution", () => {
  const CLI = resolve("dist/cli.js");
  const can = existsSync(CLI);
  function run(args: string[]) {
    const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it.skipIf(!can)("resolves a --run-dir ROOT (no status.json at the top) to the newest nested session", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-status-root-"));
    const dir = join(root, "skill-x", "local_1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        schemaVersion: 1,
        state: "done",
        pid: 1,
        scenario: "skill-x",
        fidelity: "container",
        sessionId: "local_1",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMs: 100,
        toolCounts: {},
        subagentCount: 0,
      }),
    );
    const { code, out } = run(["status", root]);
    expect(code).toBe(0);
    expect(out).toContain("skill-x");
  });

  it.skipIf(!can)("still uses a literal run dir (status.json at the top) UNCHANGED, not a nested scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-status-literal-"));
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        schemaVersion: 1,
        state: "done",
        pid: 1,
        scenario: "top-level",
        fidelity: "container",
        sessionId: "local_1",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMs: 100,
        toolCounts: {},
        subagentCount: 0,
      }),
    );
    const { code, out } = run(["status", dir]);
    expect(code).toBe(0);
    expect(out).toContain("top-level");
  });

  it("resolveStatusDir('~') still returns homedir() — the root-resolution wiring lives in cmdStatus, not resolveStatusDir", () => {
    expect(resolveStatusDir("~")).toBe(homedir());
  });
});

describe("followRunStatus", () => {
  it("emits one line per status update, then resolves once terminal", async () => {
    const dir = tmp();
    const m = meta();
    writeRunningStatus(dir, m);
    const lines: string[] = [];
    const donePromise = followRunStatus(dir, (l) => lines.push(l), { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 15));
    finalizeRunStatus(dir, m, record(), "success", 999);
    await donePromise;
    expect(lines.length).toBeGreaterThanOrEqual(2); // the initial "running" line + the terminal line
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].state).toBe("running");
    expect(parsed[parsed.length - 1].state).toBe("done");
  });

  it("with once:true, resolves after a single poll without waiting for a terminal state", async () => {
    const dir = tmp();
    writeRunningStatus(dir, meta());
    const lines: string[] = [];
    await followRunStatus(dir, (l) => lines.push(l), { pollMs: 5, once: true });
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).state).toBe("running");
  });

  it("with once:true against an EMPTY dir (no status.json ever), does NOT resolve immediately on the phantom first tick — falls through to the firstSeen deadline and rejects (F50)", async () => {
    const dir = tmp(); // empty — status.json never appears
    await expect(followRunStatus(dir, () => {}, { pollMs: 5, once: true, firstSeenTimeoutMs: 20 })).rejects.toThrow(/no status\.json/);
  });

  it("with once:true against a persistently CORRUPT status.json, does NOT resolve immediately either — falls through to the corrupt deadline and rejects (F50)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "status.json"), "{ this is not valid json");
    await expect(followRunStatus(dir, () => {}, { pollMs: 5, once: true, corruptTimeoutMs: 20 })).rejects.toThrow(/corrupt|never parsed/);
  });

  it("rejects if status.json never appears within firstSeenTimeoutMs (fail loud, not a silent hang)", async () => {
    const dir = tmp(); // empty — no status.json ever written (e.g. a crashed run pre-M1-fix, or a wrong dir)
    await expect(followRunStatus(dir, () => {}, { pollMs: 5, firstSeenTimeoutMs: 20 })).rejects.toThrow(/no status\.json/);
  });

  it("rejects when status.json EXISTS but is persistently corrupt — no infinite poll (#48)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "status.json"), "{ this is not valid json"); // file exists, never parses
    await expect(followRunStatus(dir, () => {}, { pollMs: 5, corruptTimeoutMs: 20 })).rejects.toThrow(/corrupt|never parsed/);
  });

  it(
    "rejects if a running status goes STALE — the SIGKILL case, where status.json already exists so " +
      "firstSeenTimeoutMs alone would never fire and this would otherwise poll forever",
    async () => {
      const dir = tmp();
      // Write the fixture directly (not via writeRunningStatus, which always stamps updatedAt with
      // Date.now() at write time) so `updatedAt` is genuinely in the past, simulating a process that
      // wrote "running" once and then went silent (SIGKILL — nothing runs afterward to update it).
      const stale: RunStatus = {
        schemaVersion: 1,
        state: "running",
        pid: 1,
        scenario: "s",
        fidelity: "container",
        sessionId: "local_x",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(), // 60s stale
        elapsedMs: 60_000,
        toolCounts: {},
        subagentCount: 0,
      };
      writeFileSync(join(dir, "status.json"), JSON.stringify(stale));
      await expect(followRunStatus(dir, () => {}, { pollMs: 5, firstSeenTimeoutMs: 5_000, staleMs: 1 })).rejects.toThrow(
        /stopped updating/,
      );
    },
  );
});

describe("statusLine", () => {
  const p = "/Users/someone/.cowork-harness/runs/skill-x/local_abc";
  it("emits the RAW [status] line by default (machine-capture contract — must round-trip verbatim)", () => {
    expect(statusLine(p, false)).toBe(`[status] ${p}\n`);
  });
  it("suppresses it under --compact/--demo so the shareable no-host-path mode can't leak an absolute path", () => {
    expect(statusLine(p, true)).toBeNull();
  });
});
