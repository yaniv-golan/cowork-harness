// Every place that tells an author what `device_bridge: true` does names the cassette version it stamps and the
// tools it serves. Those claims are checked against the code, so a format bump or a new device tool cannot leave
// them behind.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_REQUIRED_VERSION } from "../src/run/cassette.js";
import { DEVICE_BRIDGE_ASK_TOOLS, DEVICE_BRIDGE_TOOLS } from "../src/runtime/device-container.js";
import { ScenarioObject } from "../src/types.js";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const stamped = KEY_REQUIRED_VERSION.device_bridge!(true);
const served = [...DEVICE_BRIDGE_TOOLS, ...DEVICE_BRIDGE_ASK_TOOLS].map((t) => t.replace(/^mcp__remote-devices__/, ""));

const sites: Array<[string, string]> = [
  [
    "the scenario schema's description (types.ts)",
    (ScenarioObject.shape as Record<string, { description?: string }>).device_bridge!.description ?? "",
  ],
  ["schema/scenario.schema.json", JSON.parse(read("schema/scenario.schema.json")).properties.device_bridge.description],
  [
    "the skill's scenario-schema reference",
    // The commented key and its indented continuation lines.
    /# device_bridge: true[^\n]*(\n {20,}#[^\n]*)*/.exec(read(".claude/skills/cowork-harness/references/scenario-schema.md"))![0],
  ],
  ["docs/scenario.md", read("docs/scenario.md")],
];

describe("device_bridge claims match the code", () => {
  it.each(sites)("%s names the version a bridge recording stamps", (_, text) => {
    const claims = [...text.matchAll(/stamps cassette v(\d+)/gi)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims).toEqual(claims.map(() => stamped));
  });
  it.each(sites.slice(0, 3))("%s names every tool the bridge serves", (_, text) => {
    for (const t of served) expect(text, t).toContain(t);
  });
});
