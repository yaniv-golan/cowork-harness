// What the recorder removes from every cassette before writing it, beyond the model menu (model-menu-scrub.test.ts):
//  - a subscription account's `rate_limit_info` (utilization, reset times, overage state) — account usage, read by
//    nothing in the harness;
//  - the agent binary's own frame around a sub-agent's report (the "[Subagent hand-back]" line and the
//    "use SendMessage with to:" continuation hint) — agent-binary text that is not ours to publish. The report body
//    and the agentId stay;
//  - the description of each BUILT-IN agent, command and skill in the registry's `agents[]`/`commands[]` — the
//    agent's own text — replaced by a placeholder; the plugin under test's own entries keep theirs.
// Plus the wiring: the scrub is held to the verdict-preservation check, and if that check cannot pass, the paid
// run is still written (unscrubbed, with a warning naming the scrub) rather than lost.
// The frame text below is SYNTHETIC: only the two sentinel markers are real, because they are what is matched.

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_DESCRIPTION_PLACEHOLDER, freezeRecordedRun, scrubRecordedAgentData, scrubVerification } from "../src/run/cassette.js";
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

// A registry response: built-in commands (skill and non-skill, marked `builtin: true`), the plugin under test's own
// command (namespaced, unmarked, aliased to a built-in name), a scenario's config-dir skill (bare, unmarked), built-in
// agents (bare), the plugin's own agent (namespaced), and entries from a plugin the recording marks built-in.
// Descriptions are SYNTHETIC.
const PLUGIN_DESC = "(my-plugin) The plugin's own description, which assertions may read.";
const PLUGIN_AGENT_DESC = "The plugin's own agent description.";
const LOCAL_SKILL_DESC = "A scenario's config-dir skill, the user's own text.";
const REGISTRY = line({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "init-1",
    response: {
      commands: [
        { name: "claude-api", description: "SYNTHETIC BUILT-IN PROSE ONE", argumentHint: "", builtin: true },
        { name: "my-plugin:code-review", description: PLUGIN_DESC, argumentHint: "[pr]", aliases: ["code-review"] },
        { name: "compact", description: "SYNTHETIC BUILT-IN PROSE TWO", argumentHint: "", builtin: true },
        { name: "my-local-skill", description: LOCAL_SKILL_DESC, argumentHint: "" },
        { name: "cc-plugin-x:tool", description: "SYNTHETIC BUILT-IN PROSE THREE", argumentHint: "" },
      ],
      agents: [
        { name: "general-purpose", description: "SYNTHETIC BUILT-IN PROSE FOUR" },
        { name: "Explore", description: "SYNTHETIC BUILT-IN PROSE FIVE", model: "haiku" },
        { name: "my-plugin:reviewer", description: PLUGIN_AGENT_DESC, model: "sonnet" },
        { name: "cc-plugin-x:helper", description: "SYNTHETIC BUILT-IN PROSE SIX" },
      ],
    },
  },
});
const INIT_WITH_PLUGINS = line({
  type: "system",
  subtype: "init",
  plugins: [
    { name: "my-plugin", path: "/sessions/x/mnt/.local-plugins/my-plugin", source: "my-plugin@inline" },
    { name: "cc-plugin-x", path: "builtin", source: "cc-plugin-x@builtin" },
  ],
});
const W = BUILTIN_DESCRIPTION_PLACEHOLDER;

describe("scrubRecordedAgentData", () => {
  it("withholds every built-in agent, command and skill description; the plugin under test's own entries keep theirs", () => {
    const { cassette, kinds } = scrubRecordedAgentData(cassetteOf([REGISTRY, INIT_WITH_PLUGINS]));
    expect(kinds).toEqual(["builtin-description"]);
    const ev = JSON.parse(cassette.events[0]);
    const before = JSON.parse(REGISTRY);
    const bc = before.response.response.commands;
    const ba = before.response.response.agents;
    expect(ev.response.response.commands).toEqual([
      { ...bc[0], description: W },
      bc[1], // the plugin under test's own skill: untouched, though its alias is a built-in name
      { ...bc[2], description: W }, // a built-in command that is not a skill
      bc[3], // a scenario's config-dir skill: bare, but unmarked
      { ...bc[4], description: W }, // from a plugin the recording marks built-in
    ]);
    expect(ev.response.response.agents).toEqual([
      { ...ba[0], description: W },
      { ...ba[1], description: W },
      ba[2], // the plugin under test's own agent: untouched
      { ...ba[3], description: W },
    ]);
    const strip = (x: typeof before) => ({
      ...x,
      response: { ...x.response, response: { ...x.response.response, commands: [], agents: [] } },
    });
    expect(strip(ev)).toEqual(strip(before));
    expect(cassette.events[0]).not.toMatch(/SYNTHETIC BUILT-IN PROSE/);
    for (const d of [PLUGIN_DESC, PLUGIN_AGENT_DESC, LOCAL_SKILL_DESC]) expect(cassette.events[0]).toContain(d);
    expect(cassette.events[1]).toBe(INIT_WITH_PLUGINS);
  });

  it("an older agent with no `builtin` marker on any command falls back to the KNOWN_BUILTIN_SKILLS names", () => {
    const reg = (commands: unknown[]) =>
      line({ type: "control_response", response: { request_id: "init-1", response: { commands, agents: [] } } });
    const descs = (l: string) =>
      JSON.parse(scrubRecordedAgentData(cassetteOf([l])).cassette.events[0]).response.response.commands.map(
        (c: { description: string }) => c.description,
      );
    expect(
      descs(
        reg([
          { name: "claude-api", description: "SYNTHETIC BUILT-IN PROSE" },
          { name: "my-local-skill", description: LOCAL_SKILL_DESC },
        ]),
      ),
    ).toEqual([W, LOCAL_SKILL_DESC]);
    // ...but once the marker is present, an unmarked row is NOT built-in even under a roster name
    expect(
      descs(
        reg([
          { name: "compact", description: "SYNTHETIC BUILT-IN PROSE", builtin: true },
          { name: "run", description: LOCAL_SKILL_DESC },
        ]),
      ),
    ).toEqual([W, LOCAL_SKILL_DESC]);
  });

  it("touches a built-in entry only inside the initialize registry response", () => {
    // Same commands[] shape, inside a control_response that is NOT the initialize response (another request id, no
    // agents[] alongside): only the registry gate keeps it out.
    const elsewhere = line({
      type: "control_response",
      response: {
        request_id: "req-7",
        response: { commands: [{ name: "claude-api", description: "SYNTHETIC BUILT-IN PROSE ONE", builtin: true }] },
      },
    });
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
      "builtin-description",
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
let builtinEntriesSeen = 0;
let pluginEntriesKept = 0;
describe("committed cassettes carry no account data, agent hand-back frame or built-in agent/command description", () => {
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
          response?: {
            models?: unknown[];
            commands?: Array<{ name?: unknown; description?: unknown; builtin?: unknown }>;
            agents?: Array<{ name?: unknown; description?: unknown }>;
          };
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
        // An independent oracle, not the scrub's own predicate: a `builtin: true` command, a roster-named skill, and
        // a bare-named agent must all carry the placeholder; a namespaced, unmarked command must NOT.
        for (const c of Array.isArray(body.commands) ? body.commands : []) {
          if (typeof c?.name !== "string" || c.description === undefined) continue;
          if (c.builtin === true || KNOWN_BUILTIN_SKILLS.has(c.name)) {
            builtinEntriesSeen++;
            expect(c.description, `${file}: built-in command ${c.name} description`).toBe(BUILTIN_DESCRIPTION_PLACEHOLDER);
          } else if (c.name.includes(":")) {
            pluginEntriesKept++;
            expect(c.description, `${file}: plugin command ${c.name} description`).not.toBe(BUILTIN_DESCRIPTION_PLACEHOLDER);
          }
        }
        for (const ag of Array.isArray(body.agents) ? body.agents : []) {
          if (typeof ag?.name !== "string" || ag.description === undefined || ag.name.includes(":")) continue;
          builtinEntriesSeen++;
          expect(ag.description, `${file}: built-in agent ${ag.name} description`).toBe(BUILTIN_DESCRIPTION_PLACEHOLDER);
        }
      }
    }
    // ...and a re-scrub finds nothing left to remove
    expect(scrubRecordedAgentData(c as unknown as Cassette).kinds).toEqual([]);
  });
  // Runs after the per-file cases (vitest runs a describe's tests in order): both branches actually executed.
  it("the built-in description check saw built-in registry entries and a kept plugin entry (not vacuous)", () => {
    expect(builtinEntriesSeen).toBeGreaterThan(0);
    expect(pluginEntriesKept).toBeGreaterThan(0);
  });
  it("the plugin under test keeps its own description in example-pdf-skill", () => {
    const c = JSON.parse(readFileSync("examples/replays/example-pdf-skill.cassette.json", "utf8")) as { events: string[] };
    const reg = c.events.map((l) => JSON.parse(l)).find((e) => e.type === "control_response" && e.response?.response?.commands);
    const own = reg.response.response.commands.find((x: { name: string }) => x.name === "my-pdf-skill:my-pdf-skill");
    expect(own.description).toBe("(my-pdf-skill) Example skill under test. Summarize a PDF and write action items.");
  });
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
        line({ type: "system", subtype: "init", tools: [], skills: [], plugins: JSON.parse(INIT_WITH_PLUGINS).plugins }),
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
    expect(raw).toContain(BUILTIN_DESCRIPTION_PLACEHOLDER);
    for (const d of [PLUGIN_DESC, PLUGIN_AGENT_DESC, LOCAL_SKILL_DESC]) expect(raw).toContain(d);
  });

  it.each([
    ["the check throws", () => Promise.reject(new Error("replay crashed"))],
    ["the check reports a verdict change", () => Promise.reject(new Error("redaction changed assertion failures"))],
  ])("%s → still writes the cassette, UNSCRUBBED, with a warning that names the scrub", async (_label, impl) => {
    vi.spyOn(scrubVerification, "verify").mockImplementation(impl as () => Promise<void>);
    const { raw, stderr } = await freeze();
    expect(raw).toContain("utilization"); // unscrubbed — the run is kept, not silently altered
    expect(stderr).toMatch(
      /::warning:: record: the recorder's account-data scrub \(rate-limit-info, subagent-hand-back-frame, builtin-description\) could not be verified/,
    );
    expect(stderr).toMatch(/written UNSCRUBBED/);
    expect(stderr).not.toMatch(/narrow the redaction policy/);
  });
});
