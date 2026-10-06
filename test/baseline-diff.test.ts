import { describe, it, expect } from "vitest";
import { diffBaselines, renderChangelog, formatDiffLines } from "../src/sync/baseline-diff.js";

describe("diffBaselines — scalar changes", () => {
  it("reports a changed scalar field with from/to", () => {
    const d = diffBaselines({ agentVersion: "2.1.181" }, { agentVersion: "2.1.197" });
    expect(d).toEqual([{ path: "agentVersion", kind: "scalar", from: "2.1.181", to: "2.1.197", annotation: false }]);
  });

  it("emits nothing when a scalar is unchanged", () => {
    expect(diffBaselines({ agentVersion: "2.1.181" }, { agentVersion: "2.1.181" })).toEqual([]);
  });

  it("reports a key present only in b as 'added'", () => {
    const d = diffBaselines({}, { requireFullVmSandbox: true });
    expect(d).toEqual([{ path: "requireFullVmSandbox", kind: "added", to: true, annotation: false }]);
  });

  it("reports a key present only in a as 'removed'", () => {
    const d = diffBaselines({ requireFullVmSandbox: true }, {});
    expect(d).toEqual([{ path: "requireFullVmSandbox", kind: "removed", from: true, annotation: false }]);
  });
});

describe("diffBaselines — recursion into nested objects", () => {
  it("recurses and produces a dotted path for a nested scalar change", () => {
    const d = diffBaselines(
      { network: { mode: "gvisor", allowKind: "allowlist" } },
      { network: { mode: "userspace", allowKind: "allowlist" } },
    );
    expect(d).toEqual([{ path: "network.mode", kind: "scalar", from: "gvisor", to: "userspace", annotation: false }]);
  });

  it("recurses arbitrarily deep (provenance.gates.<name>.value.<field>)", () => {
    const a = { provenance: { gates: { hostLoop: { on: false } } } };
    const b = { provenance: { gates: { hostLoop: { on: true } } } };
    expect(diffBaselines(a, b)).toEqual([
      { path: "provenance.gates.hostLoop.on", kind: "scalar", from: false, to: true, annotation: false },
    ]);
  });
});

describe("diffBaselines — array fields (added/removed, not a scalar dump)", () => {
  it("reports added and removed members of an array field, not the whole array as changed", () => {
    const d = diffBaselines({ network: { allowDomains: ["a.com", "b.com"] } }, { network: { allowDomains: ["b.com", "c.com"] } });
    expect(d).toEqual([{ path: "network.allowDomains", kind: "array", added: ["c.com"], removed: ["a.com"], annotation: false }]);
  });

  it("emits nothing for an array with the same members in a different order (order-insensitive)", () => {
    expect(diffBaselines({ tools: ["Bash", "Read"] }, { tools: ["Read", "Bash"] })).toEqual([]);
  });

  it("diffs an array of objects (MountSpec[]) by structural membership", () => {
    const a = { mounts: [{ name: "outputs", mode: "rw" }] };
    const b = {
      mounts: [
        { name: "outputs", mode: "rw" },
        { name: "uploads", mode: "r" },
      ],
    };
    const d = diffBaselines(a, b);
    expect(d).toEqual([{ path: "mounts", kind: "array", added: [{ name: "uploads", mode: "r" }], removed: [], annotation: false }]);
  });
});

describe("diffBaselines — annotation-class keys ($-prefixed, 'note')", () => {
  it("still diffs annotation keys (never silently dropped) but tags them annotation:true", () => {
    const d = diffBaselines({ spawn: { $comment: "old note" } }, { spawn: { $comment: "new note" } });
    expect(d).toEqual([{ path: "spawn.$comment", kind: "scalar", from: "old note", to: "new note", annotation: true }]);
  });

  it("tags a 'note' key (not just $-prefixed) as annotation", () => {
    const d = diffBaselines({ provenance: { gates: { x: { note: "a" } } } }, { provenance: { gates: { x: { note: "b" } } } });
    expect(d[0].annotation).toBe(true);
  });

  it("does NOT tag a non-annotation key as annotation even if its value happens to be a string starting with $", () => {
    const d = diffBaselines({ mountLayout: { cwd: "$HOME/old" } }, { mountLayout: { cwd: "$HOME/new" } });
    expect(d[0].annotation).toBe(false);
  });
});

describe("renderChangelog — known-field prose", () => {
  it("renders an agentVersion bump as prose", () => {
    const md = renderChangelog(diffBaselines({ agentVersion: "2.1.181" }, { agentVersion: "2.1.197" }));
    expect(md).toContain("staged agent bumped");
    expect(md).toContain("2.1.181");
    expect(md).toContain("2.1.197");
  });

  it("renders allowDomains add/remove as separate lines", () => {
    const md = renderChangelog(diffBaselines({ network: { allowDomains: ["a.com"] } }, { network: { allowDomains: ["b.com"] } }));
    expect(md).toContain("added");
    expect(md).toContain("b.com");
    expect(md).toContain("removed");
    expect(md).toContain("a.com");
  });

  it("renders a gate flip as prose naming the gate and field", () => {
    const md = renderChangelog(
      diffBaselines({ provenance: { gates: { hostLoop: { on: false } } } }, { provenance: { gates: { hostLoop: { on: true } } } }),
    );
    expect(md).toContain("hostLoop");
    expect(md).toContain("on");
  });

  it("renders an unknown/unmapped path as a generic line — never silently dropped", () => {
    const md = renderChangelog(diffBaselines({ someNewField: "x" }, { someNewField: "y" }));
    expect(md).toContain("someNewField");
    expect(md).toContain("x");
    expect(md).toContain("y");
  });

  it("groups annotation-class entries into a de-emphasized section, not interleaved with real drift", () => {
    const entries = diffBaselines({ agentVersion: "1", spawn: { $comment: "old" } }, { agentVersion: "2", spawn: { $comment: "new" } });
    const md = renderChangelog(entries);
    const annotationIdx = md.indexOf("Annotations");
    const agentVersionIdx = md.indexOf("staged agent bumped");
    expect(annotationIdx).toBeGreaterThan(-1);
    expect(agentVersionIdx).toBeGreaterThan(-1);
    expect(agentVersionIdx).toBeLessThan(annotationIdx); // real drift comes first
  });

  it("renders 'No differences.' for an empty diff (identical baselines)", () => {
    expect(renderChangelog([])).toBe("No differences.\n");
  });

  it("a field introduced in a newer baseline renders as 'introduced', not raw removed+added noise", () => {
    const md = renderChangelog(diffBaselines({}, { requireFullVmSandbox: true }));
    expect(md).toContain("introduced");
    expect(md).not.toContain("removed:");
  });
});

describe("formatDiffLines — plain-line output for `sync --diff` (replaces the one-level dump)", () => {
  it("formats a scalar change as 'path: from -> to'", () => {
    const lines = formatDiffLines(diffBaselines({ agentVersion: "2.1.181" }, { agentVersion: "2.1.197" }));
    expect(lines).toEqual(['agentVersion: "2.1.181" -> "2.1.197"']);
  });

  it("recurses correctly — a change three levels deep does NOT dump the whole top-level subtree (the old bug)", () => {
    const a = { provenance: { gates: { hostLoop: { on: false, source: "gate" } } } };
    const b = { provenance: { gates: { hostLoop: { on: true, source: "gate" } } } };
    const lines = formatDiffLines(diffBaselines(a, b));
    // exactly one line, naming the leaf path — NOT the whole `provenance` or `gates` subtree
    expect(lines).toEqual(["provenance.gates.hostLoop.on: false -> true"]);
  });

  it("formats an array diff as added/removed, not a full-array dump", () => {
    const lines = formatDiffLines(diffBaselines({ network: { allowDomains: ["a.com"] } }, { network: { allowDomains: ["b.com"] } }));
    expect(lines).toEqual(['network.allowDomains: +["b.com"] -["a.com"]']);
  });

  it("returns an empty array for identical baselines", () => {
    expect(formatDiffLines(diffBaselines({ x: 1 }, { x: 1 }))).toEqual([]);
  });
});

describe("diffBaselines — a field introduced in a newer baseline is 'added', not drift noise", () => {
  it("an older baseline missing a field entirely vs a newer one that has it renders as added, not removed+added", () => {
    // simulates two real baselines where the older predates a field (e.g. requireFullVmSandbox)
    const older = { appVersion: "1.15200.0" };
    const newer = { appVersion: "1.18286.0", requireFullVmSandbox: true };
    const d = diffBaselines(older, newer);
    expect(d).toContainEqual({ path: "requireFullVmSandbox", kind: "added", to: true, annotation: false });
    expect(d.find((e) => e.path === "appVersion")).toEqual({
      path: "appVersion",
      kind: "scalar",
      from: "1.15200.0",
      to: "1.18286.0",
      annotation: false,
    });
  });
});

describe("renderChangelog — fcache snapshot identity + served-key drift", () => {
  const render = (a: unknown, b: unknown) => renderChangelog(diffBaselines(a, b));

  it("a content16 change is reported as CONTENT drift, not as a refetch", () => {
    const out = render(
      { provenance: { fcache: { content16: "aaaa", featureCount: 241 } } },
      {
        provenance: { fcache: { content16: "bbbb", featureCount: 241 } },
      },
    );
    expect(out).toMatch(/fcache CONTENT changed \(`aaaa` → `bbbb`\)/);
  });

  it("a timestamp-only move is reported as a refetch that may not have mattered", () => {
    const out = render(
      { provenance: { fcache: { content16: "aaaa", embeddedTimestamp: 1 } } },
      {
        provenance: { fcache: { content16: "aaaa", embeddedTimestamp: 2 } },
      },
    );
    expect(out).toMatch(/refetched \(timestamp only/);
    expect(out).not.toMatch(/CONTENT changed/); // the whole point of separating the two
  });

  it("a WITHDRAWN served key says the code default now applies", () => {
    // The real 1.22209.3 → 1.24012.0 case: the gate stayed present and on, but a key it had been
    // serving was withdrawn — which hands control to a code default that may differ.
    const out = render(
      { provenance: { gates: { "cfg:1978029737": { value: { pluginsFullSyncStalenessMs: 0 } } } } },
      {
        provenance: { gates: { "cfg:1978029737": { value: {} } } },
      },
    );
    expect(out).toMatch(/STOPPED serving key `pluginsFullSyncStalenessMs`/);
    expect(out).toMatch(/falls back to the code default/);
  });

  it("a NEWLY served key is reported as taking over from the code default", () => {
    const out = render(
      { provenance: { gates: { "cfg:1978029737": { value: {} } } } },
      {
        provenance: { gates: { "cfg:1978029737": { value: { coworkWebFetchDedup: true } } } },
      },
    );
    expect(out).toMatch(/now SERVES key `coworkWebFetchDedup`/);
  });
});

// provenance.desktopInitSurface has block-level rendering (renderInitSurfaceEntries). Each case asserts
// the DEDICATED line AND that no generic `provenance.desktopInitSurface…` line leaked through — the generic
// fallback already names paths and values, so a test asserting only the tool name would pass with no
// renderer at all.
describe("renderChangelog / formatDiffLines — Desktop init surface", () => {
  const srv = (toolsAll: string[], toolsSome: string[] = [], presence = "all") => ({ presence, toolsAll, toolsSome });
  const block = (servers: Record<string, unknown>, observed = true, appVersion = "2.1.0", agentVersion = "2.1.10") => ({
    provenance: { desktopInitSurface: { agentVersion, appVersion, observed, servers } },
  });
  const observed = block({
    cowork: srv(["present_files", "save_skill"], ["create_artifact"]),
    plugins: srv(["list_plugins"]),
    skills: srv(["list_skills"]),
  });
  const GENERIC = "`provenance.desktopInitSurface";
  const md = (a: object, b: object) => renderChangelog(diffBaselines(a, b));
  const plain = (a: object, b: object) => formatDiffLines(diffBaselines(a, b)).join("\n");

  it("first introduction renders the whole surface (the differ emits one whole-object added and never recurses)", () => {
    const out = md({ provenance: {} }, observed);
    expect(out).toContain(
      "- Desktop init surface now recorded: `cowork` (all): `present_files`, `save_skill`; in some sessions only: `create_artifact`",
    );
    expect(out).not.toContain(GENERIC);
  });

  it("a tool disappearing is named", () => {
    const next = block({
      cowork: srv(["present_files"], ["create_artifact"]),
      plugins: srv(["list_plugins"]),
      skills: srv(["list_skills"]),
    });
    const out = md(observed, next);
    expect(out).toContain("- Desktop server `cowork`: tool(s) DISAPPEARED: `save_skill`");
    expect(out).not.toContain(GENERIC);
    expect(plain(observed, next)).toContain("Desktop server `cowork`: tool(s) DISAPPEARED: `save_skill`");
  });

  it("a tool appearing is named", () => {
    const next = block({
      cowork: srv(["present_files", "propose_skills", "save_skill"], ["create_artifact"]),
      plugins: srv(["list_plugins"]),
      skills: srv(["list_skills"]),
    });
    expect(md(observed, next)).toContain("- Desktop server `cowork`: tool(s) APPEARED: `propose_skills`");
  });

  it("an all↔some move is one line flagged as mix-sensitive, not an appear plus a disappear", () => {
    const next = block({
      cowork: srv(["present_files"], ["create_artifact", "save_skill"]),
      plugins: srv(["list_plugins"]),
      skills: srv(["list_skills"]),
    });
    const out = md(observed, next);
    expect(out).toContain(
      "- Desktop server `cowork`: `save_skill` moved from every session to some sessions (sensitive to the mix of session kinds read",
    );
    expect(out).not.toContain("APPEARED");
    expect(out).not.toContain("DISAPPEARED");
    expect(out).not.toContain(GENERIC);
  });

  it("a server appearing and disappearing are named", () => {
    const { skills: _s, ...withoutSkills } = observed.provenance.desktopInitSurface.servers;
    const next = block(withoutSkills);
    expect(md(observed, next)).toContain("- Desktop server `skills` DISAPPEARED (declared: `list_skills`)");
    expect(md(next, observed)).toContain("- Desktop server `skills` APPEARED: `list_skills`");
    expect(md(observed, next)).not.toContain(GENERIC);
  });

  it("observed → UNOBSERVED is ONE line; the per-server removals it causes are suppressed, in both renderers", () => {
    const next = block({}, false, "2.2.0", "2.1.11");
    const out = md(observed, next);
    expect(out).toContain("- Desktop init surface UNOBSERVED at `2.2.0` / agent `2.1.11`");
    expect(out).not.toContain("DISAPPEARED");
    expect(out).not.toContain(GENERIC);
    const text = plain(observed, next);
    expect(text).toContain("Desktop init surface UNOBSERVED");
    expect(text).not.toContain("provenance.desktopInitSurface.servers");
  });

  it("unobserved → observed says so and lists what appeared", () => {
    const prev = block({}, false);
    const out = md(prev, observed);
    expect(out).toContain("- Desktop init surface now OBSERVED (was unobserved)");
    expect(out).toContain("- Desktop server `cowork` APPEARED: `present_files`, `save_skill`");
    expect(out).not.toContain(GENERIC);
  });

  it("an unrecognized leaf under the block still renders generically (never dropped)", () => {
    const a = { provenance: { desktopInitSurface: { ...observed.provenance.desktopInitSurface, oddity: 1 } } };
    const b = { provenance: { desktopInitSurface: { ...observed.provenance.desktopInitSurface, oddity: 2 } } };
    expect(md(a, b)).toContain("`provenance.desktopInitSurface.oddity`: `1` → `2`");
  });
});
