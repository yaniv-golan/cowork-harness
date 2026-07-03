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
