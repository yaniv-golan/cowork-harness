// What the recorder removes from every cassette before writing it, beyond the model menu (model-menu-scrub.test.ts):
//  - a subscription account's `rate_limit_info` (utilization, reset times, overage state) — account usage, read by
//    nothing in the harness;
//  - the agent binary's own frame around a sub-agent's report (the "[Subagent hand-back]" line and the
//    "use SendMessage with to:" continuation hint) — agent-binary text that is not ours to publish. The report body
//    and the agentId stay;
//  - the description of each Claude Code BUILT-IN skill (a KNOWN_BUILTIN_SKILLS name) in the registry's `commands[]`
//    — the agent's own text — replaced by a placeholder; a plugin's own skills keep theirs.
// Plus the wiring: the scrub is held to the verdict-preservation check, and if that check cannot pass, the paid
// run is still written (unscrubbed, with a warning naming the scrub) rather than lost.
// The frame text below is SYNTHETIC: only the two sentinel markers are real, because they are what is matched.

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_SKILL_DESCRIPTION_PLACEHOLDER,
  freezeRecordedRun,
  scrubRecordedAgentData,
  scrubVerification,
} from "../src/run/cassette.js";
import { KNOWN_BUILTIN_SKILLS } from "../src/scan.js";
import { loadBaseline } from "../src/baseline.js";
import { ScenarioObject } from "../src/types.js";
import type { Cassette } from "../src/run/cassette.js";
import type { RunResult, Scenario } from "../src/types.js";

const LIVE = loadBaseline("latest").appVersion;
const line = (o: unknown) => JSON.stringify(o);
const cassetteOf = (events: string[]): Cassette => ({ events, controlOut: [] }) as unknown as Cassette;

const RATE = line({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1790000000,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageResetsAt: 1790100000,
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.42 }, seven_day: { utilization: 0.13 } },
  },
  uuid: "u-1",
  session_id: "s-1",
});

const FRAME = "[Subagent hand-back] SYNTHETIC FRAME PROSE STANDING IN FOR THE AGENT'S OWN WORDS. The report follows:";
const REPORT = "  `python3 --version` returns **Python 3.10.12**.\n  Only python3 is installed.";
const AGENT_LINE = "agentId: a874be9524f641d5e (use SendMessage with to: 'a874be9524f641d5e', summary: '<recap>' to continue this agent)";
const HANDBACK_TEXT = `${FRAME}\n${REPORT}\n${AGENT_LINE}\n<usage>subagent_tokens: 18345\ntool_uses: 1</usage>`;
const HANDBACK = line({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: HANDBACK_TEXT }] }] },
  tool_use_result: { content: [{ type: "text", text: HANDBACK_TEXT }] },
});

// A registry response with built-in skills, a plugin's own skill (same bare name after the colon as a built-in), a
// built-in command that is not in the skill roster, and a model menu. Descriptions are SYNTHETIC.
const PLUGIN_DESC = "(my-plugin) The plugin's own description, which assertions may read.";
const REGISTRY = line({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "init-1",
    response: {
      commands: [
        { name: "claude-api", description: "SYNTHETIC BUILT-IN PROSE ONE", argumentHint: "", builtin: true },
        { name: "my-plugin:code-review", description: PLUGIN_DESC, argumentHint: "[pr]", aliases: ["code-review"] },
        { name: "code-review", description: "SYNTHETIC BUILT-IN PROSE TWO", argumentHint: "[target]", builtin: true },
        { name: "compact", description: "SYNTHETIC NON-SKILL COMMAND PROSE", argumentHint: "", builtin: true },
      ],
      agents: [{ name: "general-purpose", description: "agent prose" }],
    },
  },
});

describe("scrubRecordedAgentData", () => {
  it("withholds a built-in skill's description in the registry and keeps the name, every other field, and a plugin's own skill", () => {
    const { cassette, kinds } = scrubRecordedAgentData(cassetteOf([REGISTRY]));
    expect(kinds).toEqual(["builtin-skill-description"]);
    const ev = JSON.parse(cassette.events[0]);
    const before = JSON.parse(REGISTRY);
    expect(ev.response.response.commands).toEqual([
      { name: "claude-api", description: BUILTIN_SKILL_DESCRIPTION_PLACEHOLDER, argumentHint: "", builtin: true },
      before.response.response.commands[1], // the plugin's skill: untouched, though its alias is a built-in name
      { name: "code-review", description: BUILTIN_SKILL_DESCRIPTION_PLACEHOLDER, argumentHint: "[target]", builtin: true },
      before.response.response.commands[3], // a built-in command outside the skill roster: out of scope here
    ]);
    expect({ ...ev, response: { ...ev.response, response: { ...ev.response.response, commands: [] } } }).toEqual({
      ...before,
      response: { ...before.response, response: { ...before.response.response, commands: [] } },
    });
    expect(cassette.events[0]).not.toMatch(/SYNTHETIC BUILT-IN PROSE/);
  });

  it("touches a built-in name only inside the initialize registry response", () => {
    const elsewhere = line({ type: "user", commands: [{ name: "claude-api", description: "SYNTHETIC BUILT-IN PROSE ONE" }] });
    const r = scrubRecordedAgentData(cassetteOf([elsewhere]));
    expect(r.kinds).toEqual([]);
    expect(r.cassette.events[0]).toBe(elsewhere);
  });

  it("empties rate_limit_info and keeps the event's shape and every other line byte-identical", () => {
    const other = line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const { cassette, kinds } = scrubRecordedAgentData(cassetteOf([RATE, other]));
    const ev = JSON.parse(cassette.events[0]);
    expect(ev.rate_limit_info).toEqual({});
    expect(ev).toMatchObject({ type: "rate_limit_event", uuid: "u-1", session_id: "s-1" });
    expect(cassette.events[0]).not.toMatch(/utilization|resetsAt|overage/);
    expect(cassette.events[1]).toBe(other);
    expect(kinds).toEqual(["rate-limit-info"]);
  });

  it("replaces the hand-back frame and the continuation hint wherever they occur, keeping the report and agentId", () => {
    const { cassette, kinds } = scrubRecordedAgentData(cassetteOf([HANDBACK]));
    const raw = cassette.events[0];
    expect(raw).not.toContain("[Subagent hand-back]");
    expect(raw).not.toContain("use SendMessage with to:");
    expect(raw).not.toContain("SYNTHETIC FRAME PROSE");
    const ev = JSON.parse(raw);
    for (const text of [ev.message.content[0].content[0].text, ev.tool_use_result.content[0].text]) {
      expect(text.startsWith("[subagent report]\n")).toBe(true);
      expect(text).toContain(REPORT); // the body, indentation intact
      expect(text).toContain("agentId: a874be9524f641d5e\n");
      expect(text).toContain("<usage>subagent_tokens: 18345");
    }
    expect(kinds).toEqual(["subagent-hand-back-frame"]);
  });

  it("reports every kind it removed, and is a no-op (same object) on a clean cassette", () => {
    const init = line({
      type: "control_response",
      response: { request_id: "init-1", response: { commands: [], agents: [], models: [{ value: "m", description: "· $1/$2 per Mtok" }] } },
    });
    expect(scrubRecordedAgentData(cassetteOf([init, RATE, HANDBACK, REGISTRY])).kinds).toEqual([
      "model-menu",
      "rate-limit-info",
      "subagent-hand-back-frame",
      "builtin-skill-description",
    ]);
    const clean = cassetteOf([line({ type: "system", subtype: "init" })]);
    const r = scrubRecordedAgentData(clean);
    expect(r.cassette).toBe(clean);
    expect(r.kinds).toEqual([]);
  });

  it("is idempotent", () => {
    const once = scrubRecordedAgentData(cassetteOf([RATE, HANDBACK, REGISTRY])).cassette;
    expect(scrubRecordedAgentData(once).cassette).toBe(once);
  });
});

// Every COMMITTED cassette must already be clean: this is what stops a hand re-stamp, an older recording or a
// rewrite path from re-publishing any of it.
const tracked = execFileSync("git", ["ls-files", "*.cassette.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
// Built-in registry entries seen across the committed cassettes; the guard below must have looked at some.
let builtinSkillEntriesSeen = 0;
describe("committed cassettes carry no account data, agent hand-back frame or built-in skill description", () => {
  it("there are committed cassettes to check (not vacuous)", () => expect(tracked.length).toBeGreaterThanOrEqual(4));
  it.each(tracked)("%s", (file) => {
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("per Mtok");
    expect(raw).not.toContain("[Subagent hand-back]");
    expect(raw).not.toContain("use SendMessage with to:");
    const c = JSON.parse(raw) as { events?: string[] };
    for (const l of c.events ?? []) {
      let e: {
        type?: string;
        rate_limit_info?: object;
        response?: {
          request_id?: string;
          response?: { models?: unknown[]; commands?: Array<{ name?: unknown; description?: unknown }>; agents?: unknown };
        };
      };
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.rate_limit_info !== undefined) expect(e.rate_limit_info, `${file}: rate_limit_info`).toEqual({});
      const body = e.type === "control_response" ? e.response?.response : undefined;
      if (body && (e.response?.request_id === "init-1" || ("commands" in body && "agents" in body))) {
        expect(body.models ?? [], `${file}: initialize models`).toEqual([]);
        for (const c of Array.isArray(body.commands) ? body.commands : []) {
          if (typeof c?.name !== "string" || !KNOWN_BUILTIN_SKILLS.has(c.name) || c.description === undefined) continue;
          builtinSkillEntriesSeen++;
          expect(c.description, `${file}: built-in skill ${c.name} description`).toBe(BUILTIN_SKILL_DESCRIPTION_PLACEHOLDER);
        }
      }
    }
    // ...and a re-scrub finds nothing left to remove
    expect(scrubRecordedAgentData(c as unknown as Cassette).kinds).toEqual([]);
  });
  // Runs after the per-file cases (vitest runs a describe's tests in order): the built-in branch actually executed.
  it("the built-in skill description check saw built-in registry entries (not vacuous)", () =>
    expect(builtinSkillEntriesSeen).toBeGreaterThan(0));
});

// The record tail: wired through scrubVerification.verify, and a failing verification never loses the paid run.
describe("freezeRecordedRun and the scrub's verdict-preservation check", () => {
  afterEach(() => vi.restoreAllMocks());
  const freeze = async () => {
    const outDir = mkdtempSync(join(tmpdir(), "scrub-freeze-"));
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        REGISTRY,
        line({ type: "system", subtype: "init", tools: [], skills: [] }),
        RATE,
        HANDBACK,
        line({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    writeFileSync(join(outDir, "control-out.jsonl"), "");
    const scenario = ScenarioObject.parse({ name: "scrub-freeze", fidelity: "container", prompt: "hi" }) as unknown as Scenario;
    const result = {
      mode: "run",
      command: "record",
      scenario: scenario.name,
      prompt: scenario.prompt,
      fidelity: "container",
      effectiveFidelity: "container",
      result: "success",
      baseline: LIVE,
      outDir,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE, hashFormat: "jcs1" },
      assertions: [],
      egress: [],
    } as unknown as RunResult;
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cassettePath = join(outDir, "c.cassette.json");
    await freezeRecordedRun(scenario, { noRedact: true, allowFailing: true, cassettePath }, [], result);
    const stderr = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    return { raw: readFileSync(cassettePath, "utf8"), stderr };
  };

  it("calls the verification with the unscrubbed and scrubbed cassettes, and writes the scrubbed one", async () => {
    const verify = vi.spyOn(scrubVerification, "verify");
    const { raw } = await freeze();
    expect(verify).toHaveBeenCalledTimes(1);
    const [base, scrubbed] = verify.mock.calls[0] as [Cassette, Cassette];
    expect(JSON.stringify(base.events)).toContain("utilization");
    expect(JSON.stringify(scrubbed.events)).not.toContain("utilization");
    expect(raw).not.toMatch(/utilization|\[Subagent hand-back\]|SYNTHETIC BUILT-IN PROSE/);
    expect(raw).toContain(BUILTIN_SKILL_DESCRIPTION_PLACEHOLDER);
    expect(raw).toContain(PLUGIN_DESC);
  });

  it.each([
    ["the check throws", () => Promise.reject(new Error("replay crashed"))],
    ["the check reports a verdict change", () => Promise.reject(new Error("redaction changed assertion failures"))],
  ])("%s → still writes the cassette, UNSCRUBBED, with a warning that names the scrub", async (_label, impl) => {
    vi.spyOn(scrubVerification, "verify").mockImplementation(impl as () => Promise<void>);
    const { raw, stderr } = await freeze();
    expect(raw).toContain("utilization"); // unscrubbed — the run is kept, not silently altered
    expect(stderr).toMatch(
      /::warning:: record: the recorder's account-data scrub \(rate-limit-info, subagent-hand-back-frame, builtin-skill-description\) could not be verified/,
    );
    expect(stderr).toMatch(/written UNSCRUBBED/);
    expect(stderr).not.toMatch(/narrow the redaction policy/);
  });
});
