import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import { evaluate, type AssertContext } from "../src/assert.js";
import { redactText, type RedactionPolicy } from "../src/redact.js";
import { redactCassette, replayCassette, assertRedactionVerdictPreserved } from "../src/run/cassette.js";

// `present_files_called` reads PRESENCE off the invocation count, not off the classified
// `presentedFiles` list — the two answer different questions and only one survives redaction. At
// hostloop a presented path is a real HOST path, so a host-path policy rewrites it to
// `[REDACTED:local-path:<hash>]/mnt/outputs/f`, which the classifier must drop as un-normalizable.
// Reading delivery off classification therefore claimed "the tool was never called" about a run that
// called it — and, because record replays the base and redacted cassettes and compares verdicts, no
// cassette asserting this key could be written at that tier at all.

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

const drive = (events: AgentEvent[]) => new Run(new MockSession(events), new ScriptedDecider([])).drive("go");
const initEv = (cwd: string): AgentEvent => ({ type: "init", tools: [], mcpServers: [], skills: [], cwd });
const presentUse = (toolUseId: string, filePaths: string[]): AgentEvent => ({
  type: "tool_use",
  name: "mcp__cowork__present_files",
  input: { files: filePaths.map((file_path) => ({ file_path })) },
  toolUseId,
});
const presentResult = (toolUseId: string, texts: string[]): AgentEvent => ({
  type: "tool_result",
  toolUseId,
  isError: false,
  text: texts.join(" "),
  textBlocks: texts,
});

/** The policy this repo actually ships — loaded, not hand-rolled, so a future edit to it that broke the
 *  redacted shape this test is about would surface here rather than silently voiding the premise. */
function shippedPolicy(): RedactionPolicy {
  const cfg = JSON.parse(readFileSync(join(__dirname, "..", ".cowork-redact.json"), "utf8")) as {
    patterns: { regex: string; label?: string; flags?: string }[];
  };
  return {
    patterns: cfg.patterns.map((p) => ({ re: new RegExp(p.regex, p.flags ?? "g"), label: p.label ?? "redacted" })),
    keyNames: [],
  };
}

// A hostloop run dir, in the pre-Desktop-2.7032.0 shape: the agent's cwd IS the outputs dir, several levels inside mnt/.
const HOST_CWD = "/Users/someone/.cowork-harness/runs/deliver/local_1/work/session/mnt/outputs";
const HOST_FILE = `${HOST_CWD}/report.html`;

describe("presentFilesCalls is invariant under host-path redaction", () => {
  it("the shipped policy really does produce the un-normalizable shape this fix is about", () => {
    const redacted = redactText(HOST_FILE, shippedPolicy());
    // Not merely "changed": specifically a leading [REDACTED:…] token with the mount tail intact — the
    // exact input that fails the classifier's absolute-path requirement.
    expect(redacted).toMatch(/^\[REDACTED:local-path:[0-9a-f]+\]\/mnt\/outputs\/report\.html$/);
    expect(redacted.startsWith("/")).toBe(false);
  });

  it("un-redacted: the call is counted AND classified (the base the redacted run is compared against)", async () => {
    const rec = await drive([
      initEv(HOST_CWD),
      presentUse("tu1", [HOST_FILE]),
      presentResult("tu1", [HOST_FILE]),
      { type: "result", isError: false },
    ]);
    expect(rec.presentFilesCalls).toBe(1);
    expect(rec.presentedFiles).toHaveLength(1);
    expect(rec.evidenceErrors.presentFilesMalformed).toBe(0);
  });

  it("redacted: classification is lost, the invocation count is NOT", async () => {
    const policy = shippedPolicy();
    // Redact the whole event surface the way redactCassette does — the init cwd included. Redacting only
    // the presented paths would leave an absolute cwd behind and quietly test a shape that never occurs.
    const red = (p: string) => redactText(p, policy);
    const rec = await drive([
      initEv(red(HOST_CWD)),
      presentUse("tu1", [red(HOST_FILE)]),
      presentResult("tu1", [red(HOST_FILE)]),
      { type: "result", isError: false },
    ]);
    // The classifier still drops it — this fix does NOT teach it to read redaction tokens.
    expect(rec.presentedFiles).toHaveLength(0);
    expect(rec.evidenceErrors.presentFilesMalformed).toBeGreaterThan(0);
    // ...but presence survives, which is what the assertion reads.
    expect(rec.presentFilesCalls).toBe(1);
  });

  it("a call whose files are unusable is NOT counted as a delivery", async () => {
    const rec = await drive([
      initEv(HOST_CWD),
      { type: "tool_use", name: "mcp__cowork__present_files", input: { files: [{ nope: 1 }] }, toolUseId: "tu1" },
      presentResult("tu1", []),
      { type: "result", isError: false },
    ]);
    expect(rec.presentFilesCalls).toBe(0);
    expect(rec.evidenceErrors.presentFilesMalformed).toBeGreaterThan(0);
  });
});

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    // Pinned on every case below: without it the TIER arm fires first, and ITS message also says
    // "cannot verify" — so a bare /cannot verify/ expectation would pass with this fix reverted.
    effectiveFidelity: "hostloop",
    ...over,
  };
}

describe("present_files_called reads presence, not classification", () => {
  it("passes on the invocation count alone, with presentedFiles emptied by redaction", () => {
    const [r] = evaluate(
      [{ present_files_called: true }],
      ctx({ presentFilesCalls: 1, presentedFiles: [], evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 1 } }),
    );
    expect(r.pass).toBe(true);
  });

  it("called but every file unusable → cannot verify, NOT a claim it was never called", () => {
    const [r] = evaluate(
      [{ present_files_called: true }],
      ctx({ presentFilesCalls: 0, presentedFiles: [], evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 2 } }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/WAS called/);
    expect(r.message).toMatch(/cannot verify/);
    expect(r.message).not.toMatch(/never called/);
    // The count must NOT appear: record's self-check strips [REDACTED…] from failing messages but not
    // digits, so a malformed count that differs between the base and redacted replays would trip its
    // message compare and refuse an otherwise-writable cassette.
    expect(r.message).not.toMatch(/\d/);
  });

  it("genuinely never called still fails as never called (the true negative is not swallowed)", () => {
    const [r] = evaluate([{ present_files_called: true }], ctx({ presentFilesCalls: 0, presentedFiles: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/never called/);
  });

  it("a run predating the field falls back to presentedFiles, exactly as before", () => {
    const [r] = evaluate(
      [{ present_files_called: true }],
      ctx({ presentFilesCalls: undefined, presentedFiles: [{ from: "/x", to: "/mnt/outputs/x", promoted: true, leaked: false }] }),
    );
    expect(r.pass).toBe(true);
  });

  it("the tier gate still outranks presence (a counted call on an unserved tier is cannot-verify)", () => {
    const [r] = evaluate([{ present_files_called: true }], ctx({ effectiveFidelity: "microvm", presentFilesCalls: 3 }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/container\/hostloop tiers/);
  });
});

// The case that could never be recorded, and therefore has never executed in CI: `record`'s redaction
// self-check replays the base and redacted cassettes and refuses to write when the verdict differs. With
// presence read off classification, the redacted replay flipped present_files_called to false and every
// such record was refused. These drive the real `assertRedactionVerdictPreserved`.
describe("record's redaction self-check accepts a hostloop present_files cassette", () => {
  const hostloopCassette = (assertions: unknown[]) => ({
    scenario: {
      name: "deliver",
      baseline: "latest",
      session: "(inline)",
      fidelity: "hostloop" as const,
      prompt: "write the report and present it",
      answers: [],
      expect_denied: [],
      assert: assertions,
    },
    effectiveFidelity: "hostloop",
    events: [
      JSON.stringify({ type: "system", subtype: "init", tools: [], cwd: HOST_CWD }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cowork__present_files", input: { files: [{ file_path: HOST_FILE }] } }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false, content: [{ type: "text", text: HOST_FILE }] }],
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ],
  });

  it("CONTROL: the un-redacted cassette genuinely PASSES present_files_called (not a shared tier-gate fail)", async () => {
    const r = await replayCassette(hostloopCassette([{ present_files_called: true }]) as never, []);
    const a = r.assertions.find((x) => (x.assertion as Record<string, unknown>).present_files_called !== undefined);
    expect(a?.pass, a?.message).toBe(true);
  });

  it("the redacted cassette is written, not refused", async () => {
    const base = hostloopCassette([{ present_files_called: true }]) as never;
    const red = redactCassette(base, shippedPolicy());
    // The host path really is gone — this is a redaction that did its job, not a no-op that trivially agrees.
    expect(JSON.stringify(red)).not.toContain("/Users/someone");
    await expect(assertRedactionVerdictPreserved(base, red)).resolves.toBeUndefined();
  });

  it("GUARD-SENSITIVITY: the self-check still refuses when redaction really does flip an asserted value", async () => {
    const base = hostloopCassette([{ transcript_contains: "/Users/someone" }, { present_files_called: true }]) as never;
    const withText = {
      ...(base as unknown as { events: string[] }),
      events: [
        ...(base as unknown as { events: string[] }).events.slice(0, 1),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `wrote ${HOST_FILE}` }] } }),
        ...(base as unknown as { events: string[] }).events.slice(1),
      ],
    } as never;
    const red = redactCassette(withText, shippedPolicy());
    await expect(assertRedactionVerdictPreserved(withText, red)).rejects.toThrow(/redaction changed assertion failures/);
  });
});
