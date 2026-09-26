import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";

// The session root and the agent's reported paths must be in the SAME path space. They are not the same
// space on every tier: at container the agent runs inside the sandbox and reports `/sessions/<id>/…`,
// while at hostloop it runs natively on the host and reports host paths. A host root measured against
// VM-reported paths puts nothing inside the root, so every presented file classifies `leaked: false` —
// a vacuous pass on exactly the copy-failure leak `no_scratchpad_leak` exists to catch, and it is
// container-gated, so that is the only lane where the key evaluates at all.

class MockSession implements AgentSession {
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(_id: string, _r: DecisionResponse) {
    return { delivered: true };
  }
  close() {}
}

const driveWithRoot = (events: AgentEvent[], root?: string, expectedAgentCwd?: string) => {
  const run = new Run(new MockSession(events), new ScriptedDecider([]));
  if (root !== undefined) run.setSessionRoot(root);
  if (expectedAgentCwd !== undefined) (run as unknown as { setExpectedAgentCwd(c: string): void }).setExpectedAgentCwd(expectedAgentCwd);
  return run.drive("go");
};
const initEv = (cwd: string): AgentEvent => ({ type: "init", tools: [], mcpServers: [], skills: [], cwd });
const presentUse = (id: string, files: string[]): AgentEvent => ({
  type: "tool_use",
  name: "mcp__cowork__present_files",
  input: { files: files.map((file_path) => ({ file_path })) },
  toolUseId: id,
});
const presentResult = (id: string, texts: string[]): AgentEvent => ({
  type: "tool_result",
  toolUseId: id,
  isError: false,
  text: texts.join(" "),
  textBlocks: texts,
});

// The two real geometries. VM_ROOT is what `resolveMounts(...).cwd` yields and what the container is
// launched with (`-w`); HOST_ROOT is `<outDir>/work/session`, correct at hostloop and only there.
const VM_ROOT = "/sessions/local_1";
const HOST_ROOT = "/Users/someone/.cowork-harness/runs/deliver/local_1/work/session";
// A genuine container leak: presented from the scratchpad, and the handler's copy-failure branch returned
// the source path unchanged ("remains in the scratchpad").
const LEAK = [initEv(VM_ROOT), presentUse("t1", [`${VM_ROOT}/secret.md`]), presentResult("t1", [`${VM_ROOT}/secret.md`])];

describe("container geometry: a copy-failure leak is visible", () => {
  it("with the root in the agent's own space, the leak is recorded", async () => {
    const rec = await driveWithRoot(LEAK, VM_ROOT);
    expect(rec.presentedFiles).toEqual([{ from: `${VM_ROOT}/secret.md`, to: `${VM_ROOT}/secret.md`, promoted: false, leaked: true }]);
    expect(rec.evidenceErrors.presentFilesMalformed).toBe(0);
  });

  it("a host root against VM paths does NOT report leaked:false — it fails closed as malformed", async () => {
    const rec = await driveWithRoot(LEAK, HOST_ROOT);
    // The important half is the ABSENCE of a `leaked: false` verdict. `leaked: true` is not derivable
    // here either — with the root in another space there is no way to know the path is scratchpad — so
    // the only honest outcome is unusable evidence, which makes no_scratchpad_leak cannot-verify.
    expect(rec.presentedFiles).toEqual([]);
    expect(rec.evidenceErrors.presentFilesMalformed).toBeGreaterThan(0);
  });

  it("live and replay agree: the same events classify identically with the root set and via the cwd fallback", async () => {
    // Replay never calls setSessionRoot, so it measures from the recorded cwd. At container that cwd IS
    // the session root, so the two lanes must produce the same verdict — a live green that replays red
    // (the shape a wrong-space root produced) is a recordable cassette that fails forever in CI.
    const live = await driveWithRoot(LEAK, VM_ROOT);
    const replay = await driveWithRoot(LEAK);
    expect(live.presentedFiles).toEqual(replay.presentedFiles);
    expect(live.presentedFiles[0]?.leaked).toBe(true);
  });
});

describe("hostloop geometry stays correct", () => {
  it("from 2.7032.0 the agent runs at /var/empty: the expected process cwd is accepted, not counted malformed", async () => {
    // The agent reports its realpath (/private/var/empty), which is outside the session tree by design. The
    // space check exists to catch a root in the WRONG path space; the harness knows where it spawned the
    // agent, so it accepts that one cwd (realpath-compared) and still rejects any other outside cwd.
    const OUT = `${HOST_ROOT}/mnt/outputs/report.html`;
    const events = [initEv("/private/var/empty"), presentUse("t1", [OUT]), presentResult("t1", [OUT])];
    const rec = await driveWithRoot(events, HOST_ROOT, "/var/empty");
    expect(rec.evidenceErrors.presentFilesMalformed).toBe(0);
    expect(rec.presentedFiles).toEqual([{ from: OUT, to: OUT, promoted: false, leaked: false }]);
    const other = await driveWithRoot([initEv("/elsewhere"), presentUse("t1", [OUT]), presentResult("t1", [OUT])], HOST_ROOT, "/var/empty");
    expect(other.evidenceErrors.presentFilesMalformed).toBeGreaterThan(0);
  });

  const OUTPUTS = `${HOST_ROOT}/mnt/outputs`;
  const FILE = `${OUTPUTS}/report.html`;

  it("a passthrough delivery from the outputs dir is neither promoted nor leaked", async () => {
    // cwd is INSIDE the root here (the native agent is spawned in mnt/outputs) — the space check must
    // accept that, not just the container case where cwd equals the root.
    const rec = await driveWithRoot([initEv(OUTPUTS), presentUse("t1", [FILE]), presentResult("t1", [FILE])], HOST_ROOT);
    expect(rec.presentedFiles).toEqual([{ from: FILE, to: FILE, promoted: false, leaked: false }]);
    expect(rec.evidenceErrors.presentFilesMalformed).toBe(0);
  });

  it("a delivery out of a connected folder outside the session tree is not treated as a space mismatch", async () => {
    // hostloop's present_files roots include each connected folder's real host source, which legitimately
    // sits outside the session tree. The space check keys on CWD-vs-root, never on "nothing is under the
    // root", precisely so this stays a classified passthrough instead of unusable evidence.
    const folderFile = "/Users/someone/projects/acme/deck.pdf";
    const rec = await driveWithRoot([initEv(OUTPUTS), presentUse("t1", [folderFile]), presentResult("t1", [folderFile])], HOST_ROOT);
    expect(rec.presentedFiles).toEqual([{ from: folderFile, to: folderFile, promoted: false, leaked: false }]);
    expect(rec.evidenceErrors.presentFilesMalformed).toBe(0);
  });
});

// The defect was in the WIRING, not in the classifier: `execute.ts` derived a host path itself and handed
// it to every tier. These pin the seam that fix depends on — each runtime reporting the root it actually
// used — because no unit test can spawn docker to observe it end to end.
describe("the session root comes from the spawn, not from a second derivation", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8");

  it("container reports the bind target it launched the agent with", () => {
    const s = src("runtime/container.ts");
    // The BIND TARGET, not the agent's cwd: guest paths anchor on the dir `sessionHost` is bound at.
    expect(s).toContain("const sessionRoot = m.sessionRoot;");
    expect(s).toContain("return { child, containerName, sdkMcp, sessionRoot };");
  });

  it("hostloop reports its HOST session tree", () => {
    expect(src("runtime/hostloop.ts")).toContain("sessionRoot: sessionHost");
  });

  it("execute.ts sets the root from the spawn result and never re-derives one", () => {
    const s = src("run/execute.ts");
    expect(s).toContain("if (spawnedSessionRoot !== undefined) run.setSessionRoot(spawnedSessionRoot);");
    // The regression itself: a self-derived host path handed to every non-protocol tier.
    expect(s).not.toContain('run.setSessionRoot(join(outDir, "work", "session"))');
  });

  it("chat sets it on both serving tiers too", () => {
    const s = src("run/chat.ts");
    expect(s).toContain("run.setSessionRoot(hl.sessionRoot)");
    expect(s).toContain("run.setSessionRoot(ct.sessionRoot)");
  });
});
