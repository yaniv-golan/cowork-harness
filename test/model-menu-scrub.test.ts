// The agent's `initialize` control_response carries the ACCOUNT's model menu (`models[]`: which models
// this account is offered, their display copy and — on a pay-per-token account — per-Mtok pricing). It is
// account-shaped, nothing in the harness reads it, and a committed cassette would publish it. The recorder
// scrubs it unconditionally; these tests pin what is removed, what must survive, and that no verdict moves.

import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertRedactionVerdictPreserved, freezeRecordedRun, readCassette, scrubAccountModelMenu } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import { ScenarioObject } from "../src/types.js";
import type { Cassette } from "../src/run/cassette.js";
import type { RunResult, Scenario } from "../src/types.js";

const LIVE = loadBaseline("latest").appVersion;
const line = (o: unknown) => JSON.stringify(o);

const MENU = [
  { value: "default", resolvedModel: "claude-x-1", displayName: "Default (recommended)", description: "Use the default · $4/$20 per Mtok" },
  { value: "claude-y-2", displayName: "Y 2", description: "Y 2 · $1/$5 per Mtok", supportsEffort: true },
];
const initResponse = (extra: Record<string, unknown> = {}, requestId: string | undefined = "init-1") =>
  line({
    type: "control_response",
    response: {
      subtype: "success",
      ...(requestId ? { request_id: requestId } : {}),
      response: {
        commands: [{ name: "plugin-types" }],
        agents: [],
        models: MENU,
        account: { tokenSource: "X", apiProvider: "firstParty" },
        ...extra,
      },
    },
  });

const cassetteOf = (events: string[]): Cassette => ({ events, controlOut: [] }) as unknown as Cassette;

describe("scrubAccountModelMenu", () => {
  it("empties models[] on the initialize registry response and leaves every other field and line intact", () => {
    const other = line({ type: "system", subtype: "init", tools: ["Read"], model: "claude-x-1" });
    const out = scrubAccountModelMenu(cassetteOf([initResponse(), other]));
    const r = JSON.parse(out.events[0]).response.response;
    expect(r.models).toEqual([]);
    expect(r.commands).toEqual([{ name: "plugin-types" }]);
    expect(r.account).toEqual({ tokenSource: "X", apiProvider: "firstParty" });
    expect(out.events[0]).not.toMatch(/per Mtok|Default \(recommended\)|claude-y-2/);
    expect(out.events[1]).toBe(other); // byte-identical
  });

  it("also matches the shape fallback (commands + agents, no request_id)", () => {
    const out = scrubAccountModelMenu(cassetteOf([initResponse({}, undefined)]));
    expect(JSON.parse(out.events[0]).response.response.models).toEqual([]);
  });

  it("does not touch a `models` key or pricing text anywhere else (a user turn, a tool result, a non-registry response)", () => {
    const user = line({ type: "user", message: { content: [{ type: "text", text: "compare $4/$20 per Mtok pricing" }] } });
    const elsewhere = line({ type: "control_response", response: { request_id: "x-9", response: { models: MENU } } });
    const ev = [user, elsewhere];
    expect(scrubAccountModelMenu(cassetteOf(ev)).events).toEqual(ev);
  });

  it("is a no-op (same object) when there is nothing to scrub, and idempotent when there is", () => {
    const clean = cassetteOf([line({ type: "system", subtype: "init" })]);
    expect(scrubAccountModelMenu(clean)).toBe(clean);
    const once = scrubAccountModelMenu(cassetteOf([initResponse()]));
    expect(scrubAccountModelMenu(once)).toBe(once);
  });
});

// Every committed cassette: the scrub must not move a verdict or the fingerprint, and leaves no pricing behind.
const COMMITTED = [
  "examples/replays/example-multiselect-gate.cassette.json",
  "examples/replays/example-pdf-skill.cassette.json",
  "examples/replays/hostloop-computer-links.cassette.json",
  "test/fixtures/tool-call-dispatch/dispatch-shell.cassette.json",
].filter((f) => existsSync(f));

describe("the scrub over the committed cassettes", () => {
  it.each(COMMITTED)("%s: verdict and fingerprint preserved, no menu left", async (file) => {
    const read = readCassette(file);
    if (!("cassette" in read)) throw new Error(`unreadable ${file}`);
    const base = read.cassette;
    const scrubbed = scrubAccountModelMenu(base);
    expect(scrubbed.fingerprint).toEqual(base.fingerprint);
    expect(JSON.stringify(scrubbed.events)).not.toMatch(/per Mtok/);
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(assertRedactionVerdictPreserved(base, scrubbed, dirname(file))).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// The wiring: the recorder applies it on EVERY write — including `--no-redact`, which only disables the opt-in
// policy redaction. The account menu is not policy content.
describe("freezeRecordedRun scrubs the account model menu", () => {
  it.each([true, false])("noRedact=%s: the written cassette carries no model menu", async (noRedact) => {
    const outDir = mkdtempSync(join(tmpdir(), "menu-scrub-freeze-"));
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        initResponse(),
        line({ type: "system", subtype: "init", tools: [], skills: [] }),
        line({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    writeFileSync(join(outDir, "control-out.jsonl"), "");
    const scenario = ScenarioObject.parse({ name: "menu-scrub-freeze", fidelity: "container", prompt: "hi" }) as unknown as Scenario;
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
    try {
      const cassettePath = join(outDir, "c.cassette.json");
      await freezeRecordedRun(scenario, { noRedact, allowFailing: true, cassettePath }, [], result);
      const raw = readFileSync(cassettePath, "utf8");
      expect(raw).not.toMatch(/per Mtok/);
      const ev = (JSON.parse(raw).events as string[]).map((l) => JSON.parse(l));
      const init = ev.find((e) => e.type === "control_response");
      expect(init.response.response.models).toEqual([]);
      expect(init.response.response.commands).toEqual([{ name: "plugin-types" }]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
