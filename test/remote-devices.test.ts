// The baseline `cloud` block: the extractor over a SYNTHETIC bundle, the strict schema, and the publishing
// rule over every committed baseline — names, hashes and counts only, never prose.
//
// The bundles here are synthetic: placeholder description text and invented minified names. The one real value
// is a public gate id (1265511872), used as a selector so the "no selector expression in the output" check has a
// recognizable literal to look for.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CLOUD_UNREACHABLE,
  cloudBlockFromReading,
  cloudSchemaRefusal,
  safeCloudBlock,
  extractCloudBlock,
  findRemoteDevicesToolList,
} from "../src/sync/remote-devices.js";
import { CloudBlock } from "../src/types.js";
import { diffBaselines, formatDiffLines, renderChangelog } from "../src/sync/baseline-diff.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TEXT = {
  plain: "FIXTURE plain description for the delete tool",
  on: "FIXTURE text when the gate is on",
  off: "FIXTURE text when the gate is off",
  head: "FIXTURE bash head ",
  outer: "FIXTURE outer-scope text that must not be picked",
  inner: "FIXTURE inner-scope text",
};

const MAIN = `"use strict";var aZ=["list_devices","get_device_info","device_bash","device_request_delete_permission"],bZ=["other"];`;
const TOOLS = [
  `"use strict";var Q=require("./main.js");`,
  `function g(e){return e}`,
  `var D="device_request_delete_permission";`,
  `function build(e){let n="${TEXT.outer}";`,
  `const tools=[{name:D,description:"${TEXT.plain}",inputSchema:{}},`,
  `{name:"get_device_info",description:g("1265511872")?"${TEXT.on}":"${TEXT.off}",inputSchema:{}}];`,
  `if(e){let n="${TEXT.inner}";tools.push({name:"device_bash",description:"${TEXT.head}"+n,inputSchema:{}})}`,
  `return tools}exports.build=build;`,
].join("");
const bundle = (extra: Record<string, string> = {}) => new Map(Object.entries({ "main.js": MAIN, "tools.js": TOOLS, ...extra }));

describe("extractCloudBlock — over a synthetic bundle", () => {
  const r = extractCloudBlock(bundle());

  it("reads the tool list from the all-string array holding list_devices and device_bash, in bundle order", () => {
    expect(r.deltas).toEqual([]);
    expect(r.tools).toEqual(["list_devices", "get_device_info", "device_bash", "device_request_delete_permission"]);
  });

  it("a plain literal is one branch; a ternary is two; each fingerprint is sha256 + code points of the rendered text", () => {
    const by = (n: string) => r.descriptions.filter((d) => d.name === n);
    expect(by("device_request_delete_permission").map((d) => [d.sha256, d.codePoints])).toEqual([
      [sha(TEXT.plain), [...TEXT.plain].length],
    ]);
    expect(new Set(by("get_device_info").map((d) => d.sha256))).toEqual(new Set([sha(TEXT.on), sha(TEXT.off)]));
    expect(new Set(by("get_device_info").map((d) => d.branch)).size).toBe(2);
  });

  it("a block-scoped let resolves to the binding in its own block, not a same-named outer one", () => {
    const bash = r.descriptions.filter((d) => d.name === "device_bash");
    expect(bash.map((d) => d.sha256)).toEqual([sha(TEXT.head + TEXT.inner)]);
  });

  it("a name outside the tool list is never fingerprinted", () => {
    expect(r.descriptions.every((d) => r.tools!.includes(d.name))).toBe(true);
  });

  it("no description text, and no selector expression, appears anywhere in the output", () => {
    const out = JSON.stringify(r);
    for (const t of Object.values(TEXT)) expect(out).not.toContain(t);
    expect(out).not.toContain("1265511872");
  });

  it("the output validates against the strict schema", () => {
    const block = { remoteDevicesTools: r.tools, remoteDevicesDescriptions: r.descriptions, unreachable: [...CLOUD_UNREACHABLE] };
    expect(CloudBlock.safeParse(block).success).toBe(true);
  });

  it("no tool list → a delta and no descriptions", () => {
    const x = extractCloudBlock(bundle({ "main.js": `var aZ=["other"];` }));
    expect(x.tools).toBeNull();
    expect(x.deltas.join("\n")).toMatch(/tool list .* was not found/);
  });

  it("an unparseable chunk holding a tool name → a delta naming the file, never its content", () => {
    const x = extractCloudBlock(bundle({ "broken.js": `var x="device_bash" ${TEXT.plain} (` }));
    expect(x.deltas.some((d) => d.includes("broken.js") && d.includes("did not parse"))).toBe(true);
    expect(x.deltas.join("\n")).not.toContain(TEXT.plain);
  });

  it("findRemoteDevicesToolList ignores an array that lacks either anchor", () => {
    expect(findRemoteDevicesToolList(new Map([["a.js", `var x=["list_devices","foo"],y=["device_bash"];`]]))).toBeNull();
  });
});

describe("CloudBlock schema — names, hashes and counts only", () => {
  const ok = {
    remoteDevicesTools: ["device_bash"],
    remoteDevicesDescriptions: [{ name: "device_bash", branch: "0123456789ab", sha256: "a".repeat(64), codePoints: 10 }],
    unreachable: ["repl_bridge"],
  };
  it.each([
    ["a description text field", { ...ok, remoteDevicesDescriptions: [{ ...ok.remoteDevicesDescriptions[0], text: "x" }] }],
    ["prose as a tool name", { ...ok, remoteDevicesTools: ["Run a shell command"] }],
    ["prose in unreachable", { ...ok, unreachable: ["the repl bridge"] }],
    [
      "a selector expression as the branch",
      { ...ok, remoteDevicesDescriptions: [{ ...ok.remoteDevicesDescriptions[0], branch: '_._("1")=T' }] },
    ],
    ["a short hash", { ...ok, remoteDevicesDescriptions: [{ ...ok.remoteDevicesDescriptions[0], sha256: "abc" }] }],
    ["an extra top-level key", { ...ok, note: "x" }],
    ["a wire name with __", { ...ok, remoteDevicesTools: ["internal__remote-devices__device_bash"] }],
  ])("rejects %s", (_l, v) => {
    expect(CloudBlock.safeParse(v).success).toBe(false);
  });
  it("accepts the well-formed block", () => {
    expect(CloudBlock.safeParse(ok).success).toBe(true);
  });
});

describe("committed baselines: the cloud block holds no prose", () => {
  const dir = join(import.meta.dirname, "..", "baselines");
  const files = readdirSync(dir).filter((f) => /^desktop-.+\.json$/.test(f));
  const withBlock = files.filter((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).cloud !== undefined);
  const SHAPES = [/^[a-z][a-z0-9_]{0,63}$/, /^[0-9a-f]{12}$/, /^[0-9a-f]{64}$/];

  it("at least one baseline carries it (so the checks below are not vacuous)", () => {
    expect(withBlock.length).toBeGreaterThan(0);
  });

  it.each(withBlock)("%s: strict schema, and every string is a name or a hash, every field one of the allowed set", (f) => {
    const block = JSON.parse(readFileSync(join(dir, f), "utf8")).cloud;
    expect(CloudBlock.safeParse(block).success).toBe(true);
    const allowedFields = new Set([
      "remoteDevicesTools",
      "remoteDevicesDescriptions",
      "unreachable",
      "name",
      "branch",
      "sha256",
      "codePoints",
    ]);
    const walk = (v: unknown, path: string): void => {
      if (typeof v === "string")
        expect(
          SHAPES.some((re) => re.test(v)),
          `${path}: ${JSON.stringify(v).slice(0, 40)}`,
        ).toBe(true);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          expect(allowedFields.has(k), `${path}.${k}`).toBe(true);
          walk(x, `${path}.${k}`);
        }
    };
    walk(block, "cloud");
  });

  it("the prose check can fail: a sentence placed in the block is caught", () => {
    const re = SHAPES.some((s) => s.test("Run a shell command on the user's machine"));
    expect(re).toBe(false);
  });
});

describe("sync --diff / changelog rendering of the cloud block", () => {
  const block = (descs: object[], tools = ["device_bash", "list_devices"]) => ({
    cloud: { remoteDevicesTools: tools, remoteDevicesDescriptions: descs, unreachable: ["repl_bridge"] },
  });
  const fp = (name: string, h: string) => ({ name, branch: "0123456789ab", sha256: h.repeat(64), codePoints: 5 });

  it("first introduction is one count line, not a dump of hashes", () => {
    const out = formatDiffLines(diffBaselines({}, block([fp("device_bash", "a")]))).join("\n");
    expect(out).toBe("cloud block now recorded: 2 remote-devices tool(s), 1 description fingerprint(s), 1 unreachable feature(s)");
  });

  it("a changed fingerprint is named per tool, with no hash and no generic line", () => {
    const out = renderChangelog(diffBaselines(block([fp("device_bash", "a")]), block([fp("device_bash", "b")])));
    expect(out).toContain("- remote-devices `device_bash`: description fingerprint(s) changed (+1 −1 branch records)");
    expect(out).not.toContain("a".repeat(64));
    expect(out).not.toContain("`cloud.");
  });

  it("a tool appearing or disappearing is named", () => {
    const out = renderChangelog(diffBaselines(block([]), block([], ["device_bash", "new_tool"])));
    expect(out).toContain("- remote-devices tool(s) APPEARED: `new_tool`");
    expect(out).toContain("- remote-devices tool(s) DISAPPEARED: `list_devices`");
  });
});

describe("check:versions — warns when the newest baseline lacks the cloud block", () => {
  it("required from CLOUD_BLOCK_FROM on; older newest baselines are exempt; present passes", async () => {
    const { checkCloudBlockPresent, CLOUD_BLOCK_FROM } = await import("../scripts/check-versions.js");
    expect(checkCloudBlockPresent(CLOUD_BLOCK_FROM, {})).toHaveLength(1);
    expect(checkCloudBlockPresent("9.0.0", { provenance: {} })).toHaveLength(1);
    expect(checkCloudBlockPresent("2.19675.0", {})).toEqual([]);
    expect(checkCloudBlockPresent("2.9939.4", {})).toEqual([]); // numeric, not lexical: 9939 < 19675
    expect(checkCloudBlockPresent("10.0.0", {})).toHaveLength(1); // numeric, not lexical: 10 > 2
    expect(checkCloudBlockPresent(CLOUD_BLOCK_FROM, { cloud: {} })).toEqual([]);
  });
});

describe("sync's write: the cloud block is never carried forward", () => {
  it("this release's block replaces the previous one; no block extracted → none written, not the previous release's", async () => {
    const { withSyncedCloudBlock } = await import("../src/sync/remote-devices.js");
    const prev = { appVersion: "1", cloud: { remoteDevicesTools: ["old_tool"] } };
    expect(withSyncedCloudBlock(prev, { remoteDevicesTools: ["new_tool"] })).toEqual({
      appVersion: "1",
      cloud: { remoteDevicesTools: ["new_tool"] },
    });
    const none = withSyncedCloudBlock(prev, null);
    expect(none).toEqual({ appVersion: "1" });
    expect("cloud" in none).toBe(false);
  });
});

describe("sync's wiring of an extraction result", () => {
  it("a clean reading becomes the block, with the unreachable list, and no notes", () => {
    const r = cloudBlockFromReading({ tools: ["device_bash"], descriptions: [], deltas: [] });
    expect(r.notes).toEqual([]);
    expect(r.cloud).toEqual({ remoteDevicesTools: ["device_bash"], remoteDevicesDescriptions: [], unreachable: [...CLOUD_UNREACHABLE] });
  });
  it("any delta → NO block (never a partial one) and a WARNING note per delta saying the baseline is written without it", () => {
    const r = cloudBlockFromReading({ tools: ["device_bash"], descriptions: [], deltas: ["cloud: x.js did not parse"] });
    expect(r.cloud).toBeNull();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^WARNING: cloud: x\.js did not parse\. The baseline is written WITHOUT a cloud block/);
  });
  it("no tool list → no block", () => {
    expect(cloudBlockFromReading({ tools: null, descriptions: [], deltas: ["cloud: no list"] }).cloud).toBeNull();
  });
});

describe("sync's schema refusal before the write", () => {
  it("a well-formed block is not refused", () => {
    expect(cloudSchemaRefusal({ remoteDevicesTools: ["device_bash"], remoteDevicesDescriptions: [], unreachable: [] })).toBeNull();
  });
  it("a block carrying text is refused, and the message names the path but never the value", () => {
    const leak = "FIXTURE leaked description sentence";
    const msg = cloudSchemaRefusal({ remoteDevicesTools: [leak], remoteDevicesDescriptions: [], unreachable: [] });
    expect(msg).toMatch(/refusing to write baseline \(issue paths: remoteDevicesTools\.0\)/);
    expect(msg).not.toContain(leak);
  });
});

describe("CLOUD_UNREACHABLE", () => {
  it("keeps the three device_bash refusal codes that need Desktop's VM lifecycle or a server-asserted session id", () => {
    for (const c of ["workspace_starting", "workspace_failed", "session_id_unavailable"]) expect(CLOUD_UNREACHABLE).toContain(c);
  });
  it("a change to the list is rendered as an added/removed line", () => {
    const b = (u: string[]) => ({ cloud: { remoteDevicesTools: ["device_bash"], remoteDevicesDescriptions: [], unreachable: u } });
    const out = renderChangelog(diffBaselines(b(["repl_bridge"]), b(["memory_context"])));
    expect(out).toContain("- cloud.unreachable: added `memory_context`");
    expect(out).toContain("- cloud.unreachable: removed `repl_bridge`");
  });
});

describe("findRemoteDevicesToolList accepts digits in a name", () => {
  it("reads a list whose names contain digits", () => {
    expect(findRemoteDevicesToolList(new Map([["a.js", `var x=["list_devices","device_bash","tool_v2"];`]]))).toEqual([
      "list_devices",
      "device_bash",
      "tool_v2",
    ]);
  });
});

describe("an extractor that THROWS does not take the rest of sync down", () => {
  it("the throw becomes a cloud WARNING and no block; the rest of the baseline is still written", () => {
    const secretish = "FIXTURE error text that must not be echoed";
    const r = safeCloudBlock(new Map(), () => {
      throw new TypeError(secretish);
    });
    expect(r.cloud).toBeNull();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^WARNING: cloud: the remote-devices extractor threw \(TypeError\).*written WITHOUT a cloud block/);
    expect(r.notes[0]).not.toContain(secretish);
  });
  it("a normal extraction passes straight through", () => {
    expect(safeCloudBlock(bundle()).cloud?.remoteDevicesTools).toContain("device_bash");
  });
});

describe("a branch relabel (same text) renders apart from a text change", () => {
  const b = (descs: object[]) => ({ cloud: { remoteDevicesTools: ["device_bash"], remoteDevicesDescriptions: descs, unreachable: [] } });
  const rec = (branch: string, h: string) => ({ name: "device_bash", branch, sha256: h.repeat(64), codePoints: 5 });
  it("same sha, new branch → a relabel line and no 'changed' line", () => {
    const out = renderChangelog(diffBaselines(b([rec("aaaaaaaaaaaa", "1")]), b([rec("bbbbbbbbbbbb", "1")])));
    expect(out).toContain("- remote-devices `device_bash`: 1 branch record(s) relabeled, same text");
    expect(out).not.toContain("fingerprint(s) changed");
  });
  it("a new sha is still a change", () => {
    const out = renderChangelog(diffBaselines(b([rec("aaaaaaaaaaaa", "1")]), b([rec("aaaaaaaaaaaa", "2")])));
    expect(out).toContain("description fingerprint(s) changed (+1 −1 branch records)");
    expect(out).not.toContain("relabeled");
  });
});
