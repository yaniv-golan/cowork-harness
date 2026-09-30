import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  agentTreeAgent,
  agentSpawnOptions,
  handlerOwnsAgent,
  hostAgentStopTiming,
  parseLsofCwd,
  parsePsSnapshot,
  RUN_TAG_ENV,
  type AgentTreeDeps,
  type ProcRow,
} from "../src/runtime/agent-tree.js";

// Every case drives the tree agent with an injected process table and an injected `kill`, so the
// assertions are about WHICH targets get signalled — including the ones that must never be (a bystander,
// the harness's own group, a recycled pid). No real process is signalled here; the live fixture is in
// agent-tree-live.test.ts.

const T0 = new Date(2026, 8, 30, 12, 0, 0).getTime(); // run start
const BEFORE = T0 - 60_000;
const AFTER = T0 + 5_000;
const ME = 501;
const SELF = 100; // the harness
const PARENT = 50; // the harness's parent (a shell)
const AGENT = 200;

function row(pid: number, ppid: number, pgid: number, over: Partial<ProcRow> = {}): ProcRow {
  return { pid, ppid, pgid, uid: ME, tty: undefined, start: AFTER, comm: `p${pid}`, ...over };
}

/** harness + its parent + the agent (its own group, as a detached spawn makes it). */
function base(): ProcRow[] {
  return [
    row(1, 0, 1, { uid: 0, start: BEFORE, comm: "launchd" }),
    row(PARENT, 1, PARENT, { tty: "ttys003", start: BEFORE, comm: "zsh" }),
    row(SELF, PARENT, SELF, { tty: "ttys003", start: BEFORE, comm: "node" }),
    row(AGENT, SELF, AGENT, { comm: "claude" }),
  ];
}

class FakeChild extends EventEmitter {
  pid = AGENT;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];
  stdinEnded = false;
  stdin = { end: () => void (this.stdinEnded = true) };
  kill(sig?: NodeJS.Signals) {
    this.killed.push(sig ?? "SIGTERM");
    return true;
  }
  exit() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

interface Harness {
  child: FakeChild;
  kills: Array<[number, NodeJS.Signals]>;
  warnings: string[];
  lsofCalls: number[][];
  snapshots: number;
  setRows(r: ProcRow[]): void;
  deps: Partial<AgentTreeDeps>;
}

function harness(opts: { rows?: ProcRow[]; platform?: NodeJS.Platform; detach?: boolean; env?: NodeJS.ProcessEnv } = {}): Harness {
  let rows = opts.rows ?? base();
  const h: Harness = {
    child: new FakeChild(),
    kills: [],
    warnings: [],
    lsofCalls: [],
    snapshots: 0,
    setRows: (r) => void (rows = r),
    deps: {},
  };
  let now = T0 + 10_000;
  h.deps = {
    platform: opts.platform ?? "darwin",
    detach: opts.detach ?? true,
    selfPid: SELF,
    uid: ME,
    env: opts.env ?? {},
    now: () => (now += 1000),
    snapshot: () => {
      h.snapshots++;
      return rows.map((r) => ({ ...r }));
    },
    snapshotAsync: async () => {
      h.snapshots++;
      return rows.map((r) => ({ ...r }));
    },
    kill: (target, sig) => void h.kills.push([target, sig]),
    lsofCwd: (pids) => {
      h.lsofCalls.push([...pids]);
      return new Map();
    },
    procPids: () => [],
    procEnviron: () => undefined,
    realpath: (p) => p,
    warn: (m) => void h.warnings.push(m),
  };
  return h;
}

const token = () => `r${randomBytes(6).toString("hex")}`;
const WORK = "/private/tmp/run-x/work";

describe("parsePsSnapshot", () => {
  it("reads macOS and procps rows, tty-less spellings, lstart as local time, and a comm with spaces", () => {
    const text = [
      "  501     1   501   501 ??       Wed Sep 30 12:53:45 2026     sleep",
      "  502   501   502  1000 ?        Wed Sep  3 01:02:03 2026     Google Chrome Helper",
      "  503   501   501   501 ttys003  Wed Sep 30 12:53:46 2026     zsh",
      "garbage line",
    ].join("\n");
    const rows = parsePsSnapshot(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      pid: 501,
      ppid: 1,
      pgid: 501,
      uid: 501,
      tty: undefined,
      start: new Date(2026, 8, 30, 12, 53, 45).getTime(),
      comm: "sleep",
    });
    expect(rows[1].tty).toBeUndefined();
    expect(rows[1].start).toBe(new Date(2026, 8, 3, 1, 2, 3).getTime());
    expect(rows[1].comm).toBe("Google Chrome Helper");
    expect(rows[2].tty).toBe("ttys003");
  });
});

describe("parseLsofCwd", () => {
  it("maps each pid to its cwd from -Fpn output", () => {
    const m = parseLsofCwd("p123\nfcwd\nn/private/tmp/x\np124\nfcwd\nn/y z\n");
    expect([...m]).toEqual([
      [123, "/private/tmp/x"],
      [124, "/y z"],
    ]);
  });
});

describe("agentSpawnOptions", () => {
  it("detaches the agent and tags its env with the per-run token", () => {
    const tag = token();
    const o = agentSpawnOptions({ cwd: "/w", env: { A: "1" }, stdio: ["pipe", "pipe", "pipe"] as const }, tag);
    expect(o.detached).toBe(process.platform !== "win32");
    expect(o.env).toEqual({ A: "1", [RUN_TAG_ENV]: tag });
    expect(o.cwd).toBe("/w");
  });

  it("the tag key contains no word the agent's subprocess env scrub deletes", () => {
    // The staged agent removes credential-shaped names (TOKEN, KEY, SECRET, AUTH, PAT, ...) from the env of
    // every Bash child; a tag named like a credential would never reach the processes it exists to find.
    expect(RUN_TAG_ENV).toBe("COWORK_HARNESS_RUN_TAG");
    expect(RUN_TAG_ENV).not.toMatch(/TOKEN|KEY|SECRET|PASS|AUTH|PAT\b|CRED|COOKIE|DSN|WEBHOOK|JWT/);
  });
});

describe("handlerOwnsAgent — which tiers the termination handler stops", () => {
  it("protocol, hostloop and microvm are registered; container is reaped by its own container thunk", () => {
    expect(handlerOwnsAgent("protocol")).toBe(true);
    expect(handlerOwnsAgent("hostloop")).toBe(true);
    expect(handlerOwnsAgent("microvm")).toBe(true);
    expect(handlerOwnsAgent("container")).toBe(false);
  });
});

describe("hostAgentStopTiming — Claude Desktop's agent stop timing", () => {
  it("waits 2 s for a natural exit, then SIGTERM; SIGKILL after 5 s at hostloop (as Desktop), 2 s at protocol", () => {
    expect(hostAgentStopTiming("hostloop")).toEqual({ settleMs: 2000, graceMs: 5000 });
    expect(hostAgentStopTiming("protocol")).toEqual({ settleMs: 2000, graceMs: 2000 });
  });

  it("the tree agent carries its grace period for the termination handler", () => {
    const h = harness();
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, graceMs: 5000 }, h.deps);
    expect(a.graceMs).toBe(5000);
  });
});

describe("agentTreeAgent — descendant walk and group kill", () => {
  it("terminate() SIGTERMs the agent's group and each descendant's group; forceKill() SIGKILLs them", () => {
    const rows = [
      ...base(),
      row(300, AGENT, 300, { comm: "sh" }), // a detached Bash tree
      row(301, 300, 300, { comm: "sleep" }),
      row(400, AGENT, AGENT, { comm: "mcp-server" }), // a non-detached MCP server
      row(500, 1, 500, { comm: "stranger" }),
    ];
    const h = harness({ rows });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.terminate();
    expect(h.child.stdinEnded).toBe(true);
    const term = h.kills.filter(([, s]) => s === "SIGTERM").map(([t]) => t);
    expect(new Set(term)).toEqual(new Set([-AGENT, -300]));
    h.kills.length = 0;
    a.forceKill();
    const kill = h.kills.filter(([, s]) => s === "SIGKILL").map(([t]) => t);
    expect(kill).toContain(-AGENT);
    expect(kill).toContain(-300);
    expect(kill).not.toContain(-500);
    expect(kill).not.toContain(500);
  });

  it("forceKill() is unconditional: it reaches descendants tracked earlier after the leader has exited", () => {
    const rows = [...base(), row(300, AGENT, 300), row(301, 300, 300), row(400, AGENT, AGENT)];
    const h = harness({ rows });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.refresh();
    // The leader exits; its children are reparented to init, keeping their groups.
    h.child.exit();
    h.setRows([...base().filter((r) => r.pid !== AGENT), row(300, 1, 300), row(301, 300, 300), row(400, 1, AGENT)]);
    expect(a.alive()).toBe(false);
    a.forceKill();
    const kill = h.kills.filter(([, s]) => s === "SIGKILL").map(([t]) => t);
    expect(kill).toContain(-300);
    expect(kill).toContain(-AGENT); // the MCP server keeps the dead leader's group alive
  });

  it("a recycled pid is not the process it replaced: its children are not walked and its group is not signalled", () => {
    const rows = [...base(), row(300, AGENT, 300, { start: AFTER }), row(301, 300, 300, { start: AFTER })];
    const h = harness({ rows });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.refresh();
    // 300 and 301 exit; pid 300 is reassigned to an unrelated session leader, which forks 302.
    const LATER = AFTER + 60_000;
    h.setRows([...base(), row(300, 1, 300, { start: LATER, comm: "stranger" }), row(302, 300, 300, { start: LATER })]);
    a.refresh();
    a.forceKill();
    const targets = h.kills.map(([t]) => t);
    expect(targets).not.toContain(-300);
    expect(targets).not.toContain(300);
    expect(targets).not.toContain(302);
  });

  it("a tracked group with no live tracked member is not signalled, even if the number is in use again", () => {
    const rows = [...base(), row(300, AGENT, 300), row(301, 300, 300)];
    const h = harness({ rows });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.refresh();
    // Both tracked members are gone; a stranger now sits in a group that reuses the number 300.
    h.setRows([...base(), row(700, 1, 300, { start: AFTER + 60_000, comm: "stranger" })]);
    a.forceKill();
    expect(h.kills.map(([t]) => t)).not.toContain(-300);
    expect(h.kills.map(([t]) => t)).not.toContain(700);
  });

  it("never signals the harness's own group or an ancestor's group: a descendant sharing it is killed by pid", () => {
    const rows = [...base(), row(800, AGENT, SELF, { comm: "in-harness-group" }), row(801, AGENT, PARENT, { comm: "in-parent-group" })];
    const h = harness({ rows });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.terminate();
    a.forceKill();
    const targets = h.kills.map(([t]) => t);
    for (const bad of [-SELF, -PARENT, SELF, PARENT, -1, 1, 0]) expect(targets).not.toContain(bad);
    expect(targets).toContain(800);
    expect(targets).toContain(801);
  });

  it("a second-signal forceKill({ fast }) reuses the last snapshot instead of taking a new one", () => {
    const rows = [...base(), row(300, AGENT, 300)];
    const h = harness({ rows });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.terminate();
    const before = h.snapshots;
    h.kills.length = 0;
    a.forceKill({ fast: true });
    expect(h.snapshots).toBe(before);
    expect(h.kills.map(([t]) => t)).toContain(-300);
  });

  it("a stop that cannot list processes says so once, and still kills the agent by pid", () => {
    const h = harness();
    h.deps.snapshot = () => {
      h.snapshots++;
      return undefined;
    };
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, workDir: WORK }, h.deps);
    a.terminate();
    a.forceKill();
    expect(h.kills).toEqual([]);
    expect(h.child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    const lines = h.warnings.filter((w) => w.includes("could not list processes"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::warning:: \[teardown\] .*by pid only/);
  });

  it("a stop whose own listing fails uses the earlier one, and says so once", () => {
    const rows = [...base(), row(300, AGENT, 300)];
    const h = harness({ rows });
    let fail = false;
    h.deps.snapshot = () => {
      h.snapshots++;
      return fail ? undefined : rows.map((r) => ({ ...r }));
    };
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    a.refresh();
    fail = true;
    a.terminate();
    a.forceKill();
    expect(h.kills).toContainEqual([-300, "SIGTERM"]);
    expect(h.kills).toContainEqual([-300, "SIGKILL"]);
    const lines = h.warnings.filter((w) => w.includes("could not list processes"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::warning:: \[teardown\] .*from an earlier listing/);
  });

  it("without detach (Windows) it signals the agent by pid only and never lists processes", () => {
    const h = harness({ detach: false });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, workDir: WORK }, h.deps);
    a.terminate();
    a.forceKill();
    a.onFrame({ type: "result" });
    expect(h.snapshots).toBe(0);
    expect(h.kills).toEqual([]);
    expect(h.child.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("agentTreeAgent — refresh cadence", () => {
  it("refreshes on result and tool_result frames, never on partial-message stream events, at most every 250 ms", () => {
    const h = harness();
    let now = T0;
    h.deps.now = () => now;
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    const s0 = h.snapshots;
    a.onFrame({ type: "stream_event", event: { type: "content_block_delta" } });
    expect(h.snapshots).toBe(s0);
    now += 1000;
    a.onFrame({ type: "result", subtype: "success" });
    expect(h.snapshots).toBe(s0 + 1);
    now += 100;
    a.onFrame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } });
    expect(h.snapshots).toBe(s0 + 1); // throttled
    now += 300;
    a.onFrame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } });
    expect(h.snapshots).toBe(s0 + 2);
    now += 1000;
    a.onFrame({ type: "assistant", message: { content: [{ type: "text", text: "tool_result" }] } });
    expect(h.snapshots).toBe(s0 + 2);
  });
});

describe("agentTreeAgent — the end-of-turn refresh", () => {
  it("a result frame always refreshes, even right after another refresh (the last chance before teardown)", () => {
    const h = harness();
    let now = T0;
    h.deps.now = () => now;
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    const s0 = h.snapshots; // the construction-time listing
    now += 10;
    a.onFrame({ type: "result", subtype: "success" });
    expect(h.snapshots).toBe(s0 + 1);
    now += 10;
    a.onFrame({ type: "result", subtype: "success" });
    expect(h.snapshots).toBe(s0 + 2);
  });
});

describe("agentTreeAgent — the drive-loop refresh does not block the event loop", () => {
  it("a result frame lists synchronously: the listing is in place before the agent can exit (once per turn)", () => {
    const rows = [...base(), row(300, AGENT, 300)];
    const h = harness({ rows });
    let now = T0;
    h.deps.now = () => now;
    h.deps.snapshotAsync = () => new Promise(() => {}); // never lands
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    h.setRows([...base(), row(300, AGENT, 300), row(301, 300, 300)]);
    now += 1000;
    a.onFrame({ type: "result", subtype: "success" });
    h.setRows([...base().filter((r) => r.pid !== AGENT), row(300, 1, 300), row(301, 300, 300)]);
    h.child.exit();
    a.forceKill({ fast: true }); // the last listing only
    expect(h.kills.map(([k]) => k)).toContain(-300);
  });
  it("a tool_result frame lists processes asynchronously; a timer fires while a slow ps runs, and the listing still lands", async () => {
    const rows = [...base(), row(300, AGENT, 300, { comm: "mcp" })];
    const h = harness({ rows: base() });
    let slow = false; // the construction-time listing is fast; every later one takes 300 ms
    let useSync = true;
    h.deps.snapshot = () => {
      if (!useSync) return undefined; // the kill below must rely on what the asynchronous listing tracked
      if (slow) {
        const until = Date.now() + 300;
        while (Date.now() < until) {
          /* a slow ps, blocking */
        }
        return rows.map((r) => ({ ...r }));
      }
      return base();
    };
    h.deps.snapshotAsync = () => new Promise((res) => setTimeout(() => res(rows.map((r) => ({ ...r }))), 300));
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 }, h.deps);
    slow = true;
    let timerFired = false;
    setTimeout(() => (timerFired = true), 20);
    const t = Date.now();
    a.onFrame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } });
    expect(Date.now() - t).toBeLessThan(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(timerFired).toBe(true);
    await a.idle();
    useSync = false;
    a.forceKill({ fast: true });
    expect(h.kills.map(([k]) => k)).toContain(-300);
  });
});

describe("orphan sweep on macOS: same uid, ppid 1, no tty, started during the run, cwd under the work dir", () => {
  const orphan = (pid: number, over: Partial<ProcRow> = {}) => row(pid, 1, pid - 1, { comm: `orphan${pid}`, ...over });

  function sweep(rows: ProcRow[], cwds: Record<number, string>, env: NodeJS.ProcessEnv = {}, workDir: string | null = WORK) {
    const h = harness({ rows: [...base(), ...rows], env });
    h.deps.lsofCwd = (pids) => {
      h.lsofCalls.push([...pids]);
      return new Map(pids.filter((p) => cwds[p] !== undefined).map((p) => [p, cwds[p]]));
    };
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, ...(workDir ? { workDir } : {}) }, h.deps);
    a.forceKill();
    return h;
  }
  const killedPids = (h: Harness) => h.kills.filter(([t, s]) => t > 0 && s === "SIGKILL").map(([t]) => t);

  it("kills the orphan and prints one warning naming pid, comm and cwd", () => {
    const h = sweep([orphan(901)], { 901: `${WORK}/outputs` });
    expect(killedPids(h)).toEqual([901]);
    expect(h.warnings.filter((w) => w.includes("orphan sweep killed"))).toEqual([
      `::warning:: [teardown] orphan sweep killed pid 901 (orphan901) cwd=${WORK}/outputs\n`,
    ]);
  });

  it("(a) a same-uid, ppid-1, tty-less process whose cwd is a SIBLING of the work dir is not signalled", () => {
    const h = sweep([orphan(902), orphan(903)], { 902: `${WORK}-other`, 903: "/private/tmp/run-x" });
    expect(killedPids(h)).toEqual([]);
  });

  it("(b) cwd under the work dir but with a tty, a live parent, an earlier start, or another uid: not a candidate", () => {
    const rows = [
      orphan(911, { tty: "ttys004" }),
      row(912, 50, 911, { comm: "has-parent" }),
      orphan(913, { start: BEFORE }),
      orphan(914, { uid: 502 }),
    ];
    const cwds = { 911: WORK, 912: WORK, 913: WORK, 914: WORK };
    const h = sweep(rows, cwds);
    expect(killedPids(h)).toEqual([]);
    for (const pid of [911, 912, 913, 914]) expect(h.lsofCalls.flat()).not.toContain(pid);
  });

  it("a process started in the run's first second still counts as started during the run (lstart is whole seconds)", () => {
    const h = harness({ rows: [...base(), orphan(915, { start: T0 })] });
    h.deps.lsofCwd = (pids) => new Map(pids.map((p) => [p, WORK]));
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0 + 700, workDir: WORK }, h.deps);
    a.forceKill();
    expect(killedPids(h)).toEqual([915]);
  });

  it("never the harness itself or its ancestry, even when they match every other condition", () => {
    const rows = [
      ...base().map((r) =>
        r.pid === PARENT || r.pid === SELF ? { ...r, ppid: r.pid === PARENT ? 1 : PARENT, tty: undefined, start: AFTER } : r,
      ),
    ];
    const h = harness({ rows });
    h.deps.lsofCwd = (pids) => new Map(pids.map((p) => [p, WORK]));
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, workDir: WORK }, h.deps);
    a.forceKill();
    expect(h.kills.map(([t]) => t)).not.toContain(PARENT);
    expect(h.kills.map(([t]) => t)).not.toContain(SELF);
  });

  it("does not run lsof when no process passes the cheap filters", () => {
    const h = sweep([orphan(921, { start: BEFORE })], {});
    expect(h.lsofCalls).toEqual([]);
  });

  it("a process the descendant walk already killed is not reported again as an orphan", () => {
    const rows = [row(300, AGENT, 300), row(301, 300, 300)];
    const h = harness({ rows: [...base(), ...rows] });
    h.deps.lsofCwd = (pids) => new Map(pids.map((p) => [p, WORK])); // before construction: deps are read then
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, workDir: WORK }, h.deps);
    a.refresh();
    // 300 is reparented to init (ppid 1) with its cwd in the work dir, like any orphan; 906 is a real orphan.
    h.setRows([...base(), row(300, 1, 300), row(301, 300, 300), orphan(906)]);
    a.forceKill();
    const swept = h.warnings.filter((w) => w.includes("orphan sweep killed"));
    expect(swept).toHaveLength(1); // the sweep ran …
    expect(swept[0]).toContain("pid 906"); // … and reported only the real orphan
  });

  it("an orphan in the harness's own process group is never swept, even with its cwd in the work dir", () => {
    const h = harness({ rows: [...base(), row(907, 1, SELF, { comm: "harness-grandchild" })] });
    h.deps.lsofCwd = (pids) => new Map(pids.map((p) => [p, WORK]));
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, workDir: WORK }, h.deps);
    a.forceKill();
    expect(h.kills.map(([t]) => t)).not.toContain(907);
    expect(h.lsofCalls.flat()).not.toContain(907);
  });

  it("an lsof failure skips the sweep with a warning and never throws", () => {
    const h = harness({ rows: [...base(), orphan(931)] });
    h.deps.lsofCwd = () => ({ error: "spawnSync lsof ENOENT" });
    const a = agentTreeAgent(h.child, { runTag: token(), runStartMs: T0, workDir: WORK }, h.deps);
    expect(() => a.forceKill()).not.toThrow();
    expect(killedPids(h)).toEqual([]);
    expect(h.warnings.some((w) => w.startsWith("::warning::") && w.includes("orphan sweep skipped"))).toBe(true);
  });

  it("COWORK_HARNESS_NO_ORPHAN_SWEEP=1 turns the sweep off", () => {
    const h = sweep([orphan(941)], { 941: WORK }, { COWORK_HARNESS_NO_ORPHAN_SWEEP: "1" });
    expect(h.lsofCalls).toEqual([]);
    expect(killedPids(h)).toEqual([]);
  });

  it("no work dir (hostloop) means no macOS sweep", () => {
    const h = sweep([orphan(951)], { 951: WORK }, {}, null);
    expect(h.lsofCalls).toEqual([]);
    expect(killedPids(h)).toEqual([]);
  });
});

describe("orphan sweep on Linux: the run's env tag, never the cwd", () => {
  function linux(tag: string, environs: Record<number, string>, rows: ProcRow[], workDir: string | null = WORK) {
    const h = harness({ rows: [...base(), ...rows], platform: "linux" });
    h.deps.procPids = () => Object.keys(environs).map(Number);
    h.deps.procEnviron = (pid) => environs[pid];
    const a = agentTreeAgent(h.child, { runTag: tag, runStartMs: T0, ...(workDir ? { workDir } : {}) }, h.deps);
    a.forceKill();
    return h;
  }
  const killedPids = (h: Harness) => h.kills.filter(([t, s]) => t > 0 && s === "SIGKILL").map(([t]) => t);

  it("kills a process carrying exactly this run's tag, with a warning", () => {
    const tag = token();
    const h = linux(tag, { 961: `PATH=/bin\0${RUN_TAG_ENV}=${tag}\0HOME=/h\0` }, [row(961, 1, 960, { comm: "sleep" })]);
    expect(killedPids(h)).toEqual([961]);
    expect(h.warnings.some((w) => w.includes("orphan sweep killed pid 961 (sleep)"))).toBe(true);
    expect(h.lsofCalls).toEqual([]);
  });

  it("(c) the same cwd with no tag, another run's tag, or a tag that only shares a prefix: not signalled", () => {
    const tag = token();
    const other = token();
    const h = linux(
      tag,
      {
        962: `PATH=/bin\0HOME=/h\0`,
        963: `${RUN_TAG_ENV}=${other}\0`,
        964: `${RUN_TAG_ENV}=${tag}x\0`,
        965: `X_${RUN_TAG_ENV}=${tag}\0`,
      },
      [row(962, 1, 962), row(963, 1, 963), row(964, 1, 964), row(965, 1, 965)],
    );
    expect(killedPids(h)).toEqual([]);
  });

  it("sweeps by tag at hostloop too (no work dir)", () => {
    const tag = token();
    const h = linux(tag, { 966: `${RUN_TAG_ENV}=${tag}\0` }, [row(966, 1, 966)], null);
    expect(killedPids(h)).toEqual([966]);
  });

  it("never kills the harness itself, even if its env carried the tag", () => {
    const tag = token();
    const h = linux(tag, { [SELF]: `${RUN_TAG_ENV}=${tag}\0` }, []);
    expect(h.kills.map(([t]) => t)).not.toContain(SELF);
  });
});
