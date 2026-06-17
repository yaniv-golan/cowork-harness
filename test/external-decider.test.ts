import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalDecider, PromptDecider, ABSTAIN, UnansweredError, type RunContext } from "../src/decide/decider.js";
import type { DecisionChannel } from "../src/decide/external-channel.js";
import { spawnChannel, fileChannel, streamGates, answerGate, writeDoneMarker } from "../src/decide/external-channel.js";
import type { DecisionRequest } from "../src/agent/session.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cwh-dir-"));
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
};

function memChannel(responses: (string | null)[]): { channel: DecisionChannel; sent: string[] } {
  const sent: string[] = [];
  let i = 0;
  return { sent, channel: { write: (l) => sent.push(l), readLine: async () => (i < responses.length ? responses[i++] : null) } };
}
const ctx = (transcript = ""): RunContext => ({ task: "", transcript: () => transcript, toolLog: () => [], runId: "local_x" });
const ask: DecisionRequest = {
  id: "req_3",
  kind: "question",
  questions: [{ question: "Which format?", options: [{ label: "Markdown" }, { label: "PDF" }] }],
};

describe("ExternalDecider", () => {
  it("emits a typed, self-describing request and answers by LABEL", async () => {
    const { channel, sent } = memChannel(['{"id":"req_3","answers":{"Which format?":"PDF"}}']);
    const d = await new ExternalDecider(channel).decide(ask, ctx());
    expect(d).not.toBe(ABSTAIN);
    const req = JSON.parse(sent[0]);
    expect(req).toMatchObject({ type: "decision_request", id: "req_3", kind: "question", runId: "local_x" });
    expect(req.reply_with).toContain('"Which format?"');
    expect((d as any).response).toEqual({ kind: "question", answers: { "Which format?": "PDF" } });
    expect((d as any).by).toBe("external");
  });

  it("coerces a 1-based INDEX answer to the option label (Opus L4)", async () => {
    const { channel } = memChannel(['{"answers":{"Which format?":2}}']); // id optional; 2 → PDF
    const d = await new ExternalDecider(channel).decide(ask, ctx());
    expect((d as any).response.answers).toEqual({ "Which format?": "PDF" });
  });

  it("permission: allow carries updatedInput; deny carries a message", async () => {
    const perm: DecisionRequest = { id: "p1", kind: "permission", tool: "Bash", input: { command: "ls" } };
    const allow = await new ExternalDecider(memChannel(['{"id":"p1","behavior":"allow"}']).channel).decide(perm, ctx());
    expect((allow as any).response).toEqual({ kind: "permission", behavior: "allow", updatedInput: { command: "ls" } });
    const deny = await new ExternalDecider(memChannel(['{"behavior":"deny"}']).channel).decide(perm, ctx());
    expect((deny as any).response).toMatchObject({ kind: "permission", behavior: "deny" });
  });

  it("SCRUBS injected secrets from the emitted request — no token leak (Opus C1)", async () => {
    const TOKEN = "sk-ant-oat01-SECRETVALUE123";
    const { channel, sent } = memChannel(['{"answers":{"Which format?":"Markdown"}}']);
    await new ExternalDecider(channel, [TOKEN]).decide(ask, ctx(`the user said ${TOKEN} earlier`));
    expect(sent[0]).not.toContain(TOKEN);
    expect(sent[0]).toContain("[REDACTED]");
  });

  it("a reply that doesn't answer the question (missing key) throws UnansweredError (#20: no fabricated option 1)", async () => {
    const { channel } = memChannel(['{"id":"req_3","answers":{"SOME OTHER KEY":"PDF"}}']); // key mismatch
    // #20: ExternalDecider is the terminal decider — a missing answer key used to silently default to
    // option 1 (a non-reproducible false-green). It now fails LOUD instead.
    await expect(new ExternalDecider(channel).decide(ask, ctx())).rejects.toThrow(UnansweredError);
  });

  it("a present-but-MISTYPED answer throws UnansweredError (terminal decider, no option-1 false-green)", async () => {
    // The helper keyed by the right question text but sent a label that matches nothing. ExternalDecider is
    // terminal, so coercing to option 1 would green a typo — now it fails loud, symmetric with missing-key.
    const { channel } = memChannel(['{"id":"req_3","answers":{"Which format?":"NOPE"}}']);
    await expect(new ExternalDecider(channel).decide(ask, ctx())).rejects.toThrow(UnansweredError);
  });

  it("EOF / closed channel → UnansweredError (no silent false-green)", async () => {
    await expect(new ExternalDecider(memChannel([null]).channel).decide(ask, ctx())).rejects.toThrow(UnansweredError);
  });

  it("invalid JSON → UnansweredError carrying the reply_with reminder in its hint", async () => {
    const err = await new ExternalDecider(memChannel(["not json"]).channel).decide(ask, ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(UnansweredError);
    expect(err.message).toMatch(/invalid JSON/);
    expect(err.hint).toContain('"answers"');
  });

  it("answering the WRONG request id → UnansweredError", async () => {
    await expect(new ExternalDecider(memChannel(['{"id":"WRONG","answers":{}}']).channel).decide(ask, ctx())).rejects.toThrow(
      /wrong request/,
    );
  });
});

describe("spawnChannel (channel B — helper round-trip)", () => {
  it("pipes a request to the helper's stdin and reads its stdout answer", async () => {
    // a line-flushed echo answerer: read one request, reply picking option 1's label by index
    const helper = `node -e "const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const r=JSON.parse(l);console.log(JSON.stringify({id:r.id,answers:{[r.questions[0].question]:1}}))})"`;
    const ch = spawnChannel(helper);
    try {
      ch.write(JSON.stringify(ask));
      const line = await ch.readLine();
      expect(JSON.parse(line!)).toEqual({ id: "req_3", answers: { "Which format?": 1 } });
    } finally {
      ch.close?.();
    }
  });

  it("write after the helper exits → throws (EPIPE surfaced, not a silent hang)", async () => {
    const ch = spawnChannel(`node -e "process.exit(0)"`);
    // Poll until the helper has exited, rather than a fixed sleep: under load `node` can take >120ms
    // just to start+exit, so the old `await 120ms; expect(write).toThrow()` raced (the pipe wasn't yet
    // broken → the buffered write didn't throw → flaky). Once the child is dead, write MUST throw.
    let threw = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        ch.write("{}");
      } catch {
        threw = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(threw).toBe(true);
    ch.close?.();
  });
});

describe("fileChannel (channel C — file rendezvous for the driving agent's Monitor)", () => {
  it("writes a SINGLE-LINE req file with mode 0600 (H1/M2)", () => {
    const dir = tmp();
    fileChannel(dir).write('{"a":1,"b":2}');
    const content = readFileSync(join(dir, "req-1.json"), "utf8");
    expect(content.trim()).toBe('{"a":1,"b":2}');
    expect(content.split("\n").filter(Boolean).length).toBe(1); // exactly one line → one Monitor event
    expect(statSync(join(dir, "req-1.json")).mode & 0o777).toBe(0o600);
  });

  it("a non-empty dir FAILS LOUD — no silent clear (H3)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "req-1.json"), "stale");
    expect(() => fileChannel(dir)).toThrow(/already has gate files/);
  });

  it("timeout → null (→ ExternalDecider UnansweredError, never silent)", async () => {
    const dir = tmp();
    process.env.COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS = "40";
    process.env.COWORK_HARNESS_DECIDER_DIR_POLL_MS = "10";
    const ch = fileChannel(dir);
    ch.write("{}");
    expect(await ch.readLine()).toBe(null);
    delete process.env.COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS;
    delete process.env.COWORK_HARNESS_DECIDER_DIR_POLL_MS;
  });

  it("round-trips a gate through req/resp files (the fake-agent dance) + index coercion", async () => {
    const dir = tmp();
    process.env.COWORK_HARNESS_DECIDER_DIR_POLL_MS = "15";
    const decideP = new ExternalDecider(fileChannel(dir)).decide(ask, ctx());
    // play the driving agent: wait for the gate, answer it atomically (temp + rename)
    await waitFor(() => existsSync(join(dir, "req-1.json")));
    const req = JSON.parse(readFileSync(join(dir, "req-1.json"), "utf8"));
    expect(req).toMatchObject({ type: "decision_request", kind: "question" });
    const t = join(dir, "resp-1.json.tmp");
    writeFileSync(t, JSON.stringify({ id: req.id, answers: { "Which format?": 2 } })); // index 2 → PDF
    renameSync(t, join(dir, "resp-1.json"));
    const d = await decideP;
    expect((d as any).response.answers).toEqual({ "Which format?": "PDF" });
    // O4: the consumed gate is renamed out of the req-*.json glob (so a watcher can't re-emit it)
    expect(existsSync(join(dir, "req-1.json.done"))).toBe(true);
    expect(existsSync(join(dir, "req-1.json"))).toBe(false);
    delete process.env.COWORK_HARNESS_DECIDER_DIR_POLL_MS;
  });

  it("snapshot() copies ONLY this scenario's new gates (per-scenario watermark — no cross-contamination)", () => {
    const dir = tmp();
    const ch = fileChannel(dir);
    ch.write("{}"); // scenario 1 → req-1
    const snap1 = tmp();
    ch.snapshot!(snap1);
    expect(existsSync(join(snap1, "req-1.json"))).toBe(true);
    ch.write("{}"); // scenario 2 → req-2 (same reused channel, monotonic seq)
    const snap2 = tmp();
    ch.snapshot!(snap2);
    // scenario 2's snapshot must contain ONLY req-2, NOT scenario 1's req-1 (the reuse-across-scenarios bug)
    expect(existsSync(join(snap2, "req-2.json"))).toBe(true);
    expect(existsSync(join(snap2, "req-1.json"))).toBe(false);
  });
});

describe("gates stream + answer (the in-band transport the harness owns)", () => {
  it("streamGates emits one line per pending gate + a terminal {done:true}", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "req-1.json"), '{"id":"a","kind":"question","questions":[{"question":"Q1?","options":[{"label":"Y"}]}]}\n');
    writeFileSync(join(dir, "req-2.json"), '{"id":"b","kind":"question","questions":[{"question":"Q2?","options":[{"label":"N"}]}]}\n');
    writeDoneMarker(dir);
    const lines: string[] = [];
    await streamGates(dir, (l) => lines.push(l), { pollMs: 5 });
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ seq: 1, id: "a" }); // seq injected for `answer`
    expect(parsed[1]).toMatchObject({ seq: 2, id: "b" });
    expect(parsed[parsed.length - 1]).toEqual({ done: true }); // explicit completion (no silence-ambiguity)
  });

  it("answerGate writes an atomic resp with the echoed id + answers", () => {
    const dir = tmp();
    writeFileSync(join(dir, "req-3.json"), '{"id":"c","kind":"question","questions":[{"question":"Go?","options":[{"label":"Yes"}]}]}\n');
    answerGate(dir, 3, { "Go?": "Yes" });
    expect(JSON.parse(readFileSync(join(dir, "resp-3.json"), "utf8"))).toEqual({ id: "c", answers: { "Go?": "Yes" } });
  });

  it("streamGates skips a malformed req file but still emits the valid ones and completes", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "req-1.json"), "{ this is not json"); // malformed — must not block the stream
    writeFileSync(join(dir, "req-2.json"), '{"id":"b","kind":"question","questions":[{"question":"Q2?","options":[{"label":"N"}]}]}\n');
    writeDoneMarker(dir);
    const lines: string[] = [];
    await streamGates(dir, (l) => lines.push(l), { pollMs: 5 });
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.find((p) => p.id === "b")).toMatchObject({ seq: 2 }); // valid gate still flows
    expect(parsed.some((p) => p.seq === 1)).toBe(false); // the malformed file is never emitted as a gate
    expect(parsed[parsed.length - 1]).toEqual({ done: true });
  });
});

// #49 — fileChannel exit-listener leak: close() must remove the listener so multiple channels
// in one process don't accumulate "exit" handlers past the MaxListenersExceededWarning threshold.
describe("fileChannel — #49 exit listener removed on close()", () => {
  it("close() removes the exit listener registered on open, keeping listener count stable", () => {
    const before = process.listenerCount("exit");
    const ch1 = fileChannel(tmp());
    const ch2 = fileChannel(tmp());
    // Two open channels → two listeners added
    expect(process.listenerCount("exit")).toBe(before + 2);
    ch1.close?.();
    expect(process.listenerCount("exit")).toBe(before + 1);
    ch2.close?.();
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("close() writes done.json so a `gates --follow` watcher is released even if the embedder keeps running", () => {
    const dir = tmp();
    const ch = fileChannel(dir);
    expect(existsSync(join(dir, "done.json"))).toBe(false);
    ch.close?.();
    expect(existsSync(join(dir, "done.json"))).toBe(true);
  });
});

describe("decider Phase-5 fixes (#35 elicit cancel, #36 JSON-safe reply_with)", () => {
  it("#35 — a TTY elicit can return cancel (not just accept/decline)", async () => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const elicit = { id: "e1", kind: "elicit", server: "s", prompt: "go?", schema: {} } as unknown as DecisionRequest;
      const action = async (reply: string) =>
        ((await new PromptDecider(async () => reply).decide(elicit, ctx())) as { response: { action: string } }).response.action;
      expect(await action("cancel")).toBe("cancel");
      expect(await action("accept")).toBe("accept");
      expect(await action("nope")).toBe("decline");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });

  it("#36 — reply_with builds a JSON-safe key for question text with quotes/newlines/backslashes", async () => {
    const tricky = 'He said "hi"\npath C:\\x';
    const req: DecisionRequest = { id: "q1", kind: "question", questions: [{ question: tricky, options: [{ label: "Yes" }] }] };
    const { channel, sent } = memChannel([JSON.stringify({ id: "q1", answers: { [tricky]: "Yes" } })]);
    await new ExternalDecider(channel).decide(req, ctx());
    // the advertised reply_with must carry the question as a properly-escaped JSON key
    expect(JSON.parse(sent[0]).reply_with).toContain(JSON.stringify(tricky) + ":");
  });
});
