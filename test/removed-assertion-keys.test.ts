// An assertion key a past release accepted and this one refuses is named in the refusal, with what replaced it — in a
// scenario file (single-prompt or `legs:`) and in a cassette's frozen scenario — instead of a bare "unrecognized key".
// The cassette refusal is re-recordable: the remedy is a re-record from a scenario without the key, which
// `record <dir/> --rerecord-stale` can do on its own (a check-only `rehash` cannot).
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioPure, loadMultiLegScenario } from "../src/run/execute.js";
import { readCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { REMOVED_ASSERTION_KEYS, removedAssertionRefusal } from "../src/types.js";
import { DEFAULT_USER_VISIBLE_ROOTS, recordedControlOut } from "./helpers/minimal-cassette.js";

const KEY = "allow_l0_host_config_contamination";
const WHY = REMOVED_ASSERTION_KEYS[KEY]!;

function file(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "removed-keys-"));
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("removed assertion keys", () => {
  it("the removal text says why and what to do", () => {
    expect(WHY).toBe(
      "removed in 5.0.0: fidelity protocol always gives the agent a managed config dir, so it never reads your installed plugins, skills or MCP servers and there is nothing left to allow. To test against your installed set, use `plugins.from_host`. Delete the line",
    );
  });

  it("a scenario file using one is refused by name", () => {
    const p = file("s.yaml", `name: s\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n  - ${KEY}: true\n`);
    expect(() => loadScenarioPure(p)).toThrow(`invalid scenario ${p}: \`${KEY}\` was ${WHY}`);
  });

  it("a legs: file using one in any leg is refused by name", () => {
    const p = file(
      "m.yaml",
      `name: m\nfidelity: container\nlegs:\n  - id: a\n    prompt: one\n  - id: b\n    prompt: two\n    assert:\n      - ${KEY}: true\n`,
    );
    expect(() => loadMultiLegScenario(p)).toThrow(`invalid scenario ${p}: \`${KEY}\` was ${WHY}`);
  });

  it("an unrelated unknown key keeps the generic schema error", () => {
    expect(removedAssertionRefusal({ assert: [{ not_a_key: true }] })).toBeUndefined();
  });

  it("a cassette whose frozen scenario uses one is refused by name, as re-recordable", () => {
    const p = file(
      "c.cassette.json",
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION,
        events: [],
        scenario: { prompt: "hi", session: "session.yaml", assert: [{ [KEY]: true }] },
        controlOut: recordedControlOut(),
        userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS],
      }),
    );
    expect(readCassette(p)).toEqual({
      error: `cassette's frozen scenario uses \`${KEY}\`, ${WHY} from the scenario, then re-record it`,
      rerecordable: true,
    });
  });

  it("a NEWER cassette is not judged by this build's removal list (it may know the key)", () => {
    const p = file(
      "n.cassette.json",
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION + 1,
        events: [],
        scenario: { prompt: "hi", session: "session.yaml", assert: [{ [KEY]: true }] },
        controlOut: recordedControlOut(),
        userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS],
      }),
    );
    const r = readCassette(p);
    expect("error" in r && r.error).not.toContain("removed in 5.0.0");
  });
});
