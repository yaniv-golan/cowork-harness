import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { computeAgentVersionNote, computeStaleness, readCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";

// A cassette's `fingerprint.baseline` can be re-stamped by hand across an agent bump, leaving a stream
// recorded by one agent build filed under a baseline that pins another. The init frame already freezes
// the agent's own `claude_code_version`, so the check DERIVES the recorded version from it (no new field),
// and reports a disagreement as a non-gating `agent-version:` note. Every other case is silent.

const LATEST = loadBaseline("latest");
const NOTE = "agent-version:";

const init = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "system", subtype: "init", ...extra });
const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });

function cassette(o: { events?: string[]; baseline?: string | null } = {}): any {
  return {
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "agent-version",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    effectiveFidelity: "container",
    events: o.events ?? [init({ claude_code_version: "9.9.9", tools: ["mcp__skills__list_skills"] }), result],
    controlOut: [],
    ...(o.baseline === null ? {} : { fingerprint: { baseline: o.baseline ?? LATEST.appVersion, hashFormat: "jcs1" } }),
  };
}
const staleness = (c: any, dir?: string) => computeStaleness(c, dir);
const agentNotes = (c: any, dir?: string) => staleness(c, dir).notes.filter((n) => n.startsWith(NOTE));

describe("agent-version note — derived from the recorded init frame", () => {
  it("FIRES when the init frame's agent differs from the fingerprint baseline's agentVersion (bare appVersion spelling)", () => {
    const notes = agentNotes(cassette());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("9.9.9");
    expect(notes[0]).toContain(LATEST.agentVersion);
    expect(notes[0]).toContain(LATEST.appVersion);
  });

  it("FIRES for the `desktop-<version>` spelling too", () => {
    expect(agentNotes(cassette({ baseline: `desktop-${LATEST.appVersion}` }))).toHaveLength(1);
  });

  it("is SILENT when the recorded agent equals the baseline's (the note must compare, not just see a frame)", () => {
    expect(agentNotes(cassette({ events: [init({ claude_code_version: LATEST.agentVersion }), result] }))).toEqual([]);
  });

  it.each([
    ["no init frame", { events: [result] }],
    ["init frame without claude_code_version", { events: [init(), result] }],
    ["non-string claude_code_version", { events: [init({ claude_code_version: 2 }), result] }],
    ["unparseable event lines only", { events: ["{not json", result] }],
    ["no fingerprint", { baseline: null }],
    ["a baseline name no committed file answers to", { baseline: "0.0.1" }],
    ["a path-shaped baseline name", { baseline: "../../etc/hosts" }],
    ["an absolute baseline path", { baseline: "/tmp/desktop-1.0.0.json" }],
  ] as const)("is SILENT with %s — and adds no finding", (_label, o) => {
    const c = cassette(o as any);
    const withVersion = staleness(c);
    expect(withVersion.notes.filter((n) => n.startsWith(NOTE))).toEqual([]);
    // Same cassette with the init frame's version stripped: findings must be identical (never a finding).
    const stripped = { ...c, events: (c.events as string[]).map((l) => l.replace(/"claude_code_version":"9\.9\.9",?/, "")) };
    expect(withVersion.findings).toEqual(staleness(stripped).findings);
  });

  it("a mismatch is a note only — the findings are unchanged", () => {
    const mismatch = cassette();
    const match = cassette({ events: [init({ claude_code_version: LATEST.agentVersion, tools: ["mcp__skills__list_skills"] }), result] });
    expect(staleness(mismatch).findings).toEqual(staleness(match).findings);
  });
});

// Every committed cassette, at every version and tier it was written under: the derivation must read the
// real frames (not only synthetic ones), stay silent where recording and baseline agree, and fire when
// the recorded agent is changed.
function committedCassettes(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".cassette.json")) out.push(p);
    }
  };
  for (const root of ["examples/replays", "test/fixtures", "test/evals"]) if (existsSync(root)) walk(root);
  return out.sort();
}

describe("agent-version note — every committed cassette", () => {
  const files = committedCassettes();

  it("finds the committed cassettes (guards the walk against rot)", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files)("%s: silent as committed; fires only if its recorded agent disagrees with its baseline", (file) => {
    // Through the harness's own reader, as verify-cassettes/replay do. A file that reader rejects (an eval
    // fixture that is not a full cassette) never reaches staleness from any command, so the derivation is
    // checked on its raw JSON directly instead.
    const read = readCassette(file);
    const readable = "cassette" in read;
    const c = readable ? read.cassette : JSON.parse(readFileSync(file, "utf8"));
    const dir = dirname(file);
    const notesOf = (x: any) => (readable ? agentNotes(x, dir) : computeAgentVersionNote(x));
    const initLine = (c.events as string[]).find((l) => {
      try {
        const m = JSON.parse(l);
        return m?.type === "system" && m?.subtype === "init";
      } catch {
        return false;
      }
    });
    const recorded = initLine ? JSON.parse(initLine).claude_code_version : undefined;
    const fpBaseline: string | undefined = c.fingerprint?.baseline;
    let pinned: string | undefined;
    try {
      pinned = fpBaseline ? loadBaseline(fpBaseline.startsWith("desktop-") ? fpBaseline : `desktop-${fpBaseline}`).agentVersion : undefined;
    } catch {
      pinned = undefined;
    }
    const expectFire = typeof recorded === "string" && pinned !== undefined && recorded !== pinned;
    expect(notesOf(c)).toHaveLength(expectFire ? 1 : 0);

    // Mutate the recorded agent: a cassette that carries a version and a resolvable baseline must now fire.
    if (typeof recorded === "string" && pinned !== undefined) {
      const mutated = { ...c, events: (c.events as string[]).map((l) => (l === initLine ? l.replace(recorded, "0.0.0-mutated") : l)) };
      const n = notesOf(mutated);
      expect(n, `${file}: a changed recorded agent must be noted`).toHaveLength(1);
      expect(n[0]).toContain("0.0.0-mutated");
    }
  });
});

// End to end: the note reaches verify-cassettes' JSON envelope without changing `ok` or the exit code.
const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("agent-version note — verify-cassettes is non-gating", () => {
  it("exit 0, ok: true, the note in results[0].notes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cwh-agent-version-"));
    writeFileSync(join(cwd, "c.cassette.json"), JSON.stringify(cassette()));
    const r = spawnSync("node", [CLI, "verify-cassettes", "c.cassette.json", "--output-format", "json"], { encoding: "utf8", cwd });
    const env = JSON.parse(r.stdout);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(env.ok).toBe(true);
    expect((env.results[0].notes as string[]).filter((n) => n.startsWith(NOTE))).toHaveLength(1);
  });
});
