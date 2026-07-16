import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import type { AuthoredFile, AuthoredFilesHealth } from "../src/run/artifacts.js";

// Static Tier A `no_lost_write_back` assertion — runs the shipped `analyze-artifact` analyzer over the
// files a run authored so a scenario can gate on "the agent didn't emit an interactive artifact whose
// Submit is lost under Cowork". See docs/internal/2026-07-16-static-tierA-in-run-loop-spec.md.

const LOST_FORM = `<!DOCTYPE html><html><body><form method="post" action="/submit"><button>Save</button></form></body></html>`;
const CLEAN_REMOTE = `<!DOCTYPE html><html><body><script>fetch('https://api.example.com/x',{method:'POST'})</script></body></html>`;
const SUSPECT = `<!DOCTYPE html><html><body><script>fetch('/save',{method:'POST'}).then(r=>{if(r.ok){document.body.innerHTML='ok';}})</script></body></html>`;

/** A temp workRoot shaped `<root>/session/mnt` so the scratchpad remap (dirname(workRoot)) is exercisable. */
function mkWorkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nlwb-"));
  const workRoot = join(root, "session", "mnt");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  return workRoot;
}

function write(workRoot: string, rel: string, content: string): void {
  const abs = join(workRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

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
    // Default: a run WITH a pre-run manifest that authored nothing.
    preRunHashes: {},
    authoredFiles: [],
    ...over,
  };
}

const authored = (paths: string[]): AuthoredFile[] => paths.map((p) => ({ path: p, content: "" }));
const one = (r: ReturnType<typeof evaluate>) => r[0];

describe("no_lost_write_back — core verdicts", () => {
  it("FAILS on a lost write-back authored under outputs/", () => {
    const wr = mkWorkRoot();
    write(wr, "outputs/report.html", LOST_FORM);
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: authored(["outputs/report.html"]) })));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/lost interactive-artifact write-back/i);
    expect(r.message).toContain("outputs/report.html");
  });

  it("PASSES clean when the only authored artifact posts to a remote origin", () => {
    const wr = mkWorkRoot();
    write(wr, "outputs/ok.html", CLEAN_REMOTE);
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: authored(["outputs/ok.html"]) })));
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/no lost interactive-artifact write-back/i);
  });

  it("PASSES clean when the run authored nothing (empty authored set, manifest present)", () => {
    const wr = mkWorkRoot();
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr })));
    expect(r.pass).toBe(true);
  });

  it("PASSES with an advisory on a -suspect finding (response is consulted)", () => {
    const wr = mkWorkRoot();
    write(wr, "outputs/s.html", SUSPECT);
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: authored(["outputs/s.html"]) })));
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/advisory/i);
  });
});

describe("no_lost_write_back — scratchpad synthetic-prefix remap (correctness bug #2 regression)", () => {
  it("resolves a `scratchpad/<rel>` authored path to its real on-disk path under dirname(workRoot)", () => {
    const wr = mkWorkRoot(); // <root>/session/mnt
    // Scratchpad file lives at the SESSION ROOT (parent of mnt), i.e. dirname(workRoot).
    write(join(wr, ".."), "gen.html", LOST_FORM); // -> <root>/session/gen.html
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: authored(["scratchpad/gen.html"]) })));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("scratchpad/gen.html"); // display rel, not the raw absolute path
  });
});

describe("no_lost_write_back — read-write connected-mount policy", () => {
  it("FAILS on a lost write-back in a newly ADDED file on a rw connected mount", () => {
    const wr = mkWorkRoot();
    write(wr, ".projects/acme/report.html", LOST_FORM);
    const r = one(
      evaluate(
        [{ no_lost_write_back: true }],
        // no preRunHashes entry for the path → newly added → the skill's own artifact → hard fail
        ctx({ workRoot: wr, authoredFiles: authored([".projects/acme/report.html"]), preRunHashes: {} }),
      ),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toContain(".projects/acme/report.html");
  });

  it("DOWNGRADES to advisory when the lost file was a PRE-EXISTING file the skill only modified on a rw mount", () => {
    const wr = mkWorkRoot();
    write(wr, ".projects/acme/report.html", LOST_FORM);
    const r = one(
      evaluate(
        [{ no_lost_write_back: true }],
        // a prior hash for the path → pre-existing → not attributable to the skill → advisory, not fail
        ctx({
          workRoot: wr,
          authoredFiles: authored([".projects/acme/report.html"]),
          preRunHashes: { ".projects/acme/report.html": "deadbeef" },
        }),
      ),
    );
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/advisory/i);
    expect(r.evidence).toMatch(/pre-existing/i);
  });
});

describe("no_lost_write_back — evidence-unavailable (fail-closed, never a silent clean)", () => {
  it("could-not-verify on microvm (no pre-run manifest)", () => {
    const wr = mkWorkRoot();
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, preRunHashes: undefined, authoredFiles: [] })));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/i);
    expect(r.message).toMatch(/microvm/i);
  });

  it("could-not-verify when authoredFiles was never wired for the lane", () => {
    const wr = mkWorkRoot();
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, preRunHashes: {}, authoredFiles: undefined })));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/i);
  });

  it("could-not-verify when the scratchpad walk was skipped on --resume", () => {
    const wr = mkWorkRoot();
    const health: AuthoredFilesHealth = { omittedPaths: [], totalCapExhausted: false, readErrors: [], scratchpadSkippedOnResume: true };
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: [], authoredFilesHealth: health })));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/i);
    expect(r.message).toMatch(/resume/i);
  });

  it("could-not-verify on an authored source that is unreadable (read-back error)", () => {
    const wr = mkWorkRoot();
    // A readError path that does not exist on disk → analyzeArtifacts records a select/read failure.
    const health: AuthoredFilesHealth = {
      omittedPaths: [],
      totalCapExhausted: false,
      readErrors: [{ path: "outputs/gone.html", error: "EIO" }],
    };
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: [], authoredFilesHealth: health })));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/i);
  });
});

describe("no_lost_write_back — omitted-at-cap paths are still analyzed (never silently clean)", () => {
  it("CATCHES a lost write-back listed only in omittedPaths (dropped at the capture cap, but on disk)", () => {
    const wr = mkWorkRoot();
    write(wr, "outputs/big.html", LOST_FORM);
    const health: AuthoredFilesHealth = { omittedPaths: ["outputs/big.html"], totalCapExhausted: true, readErrors: [] };
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: [], authoredFilesHealth: health })));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/lost interactive-artifact write-back/i);
  });
});

describe("no_lost_write_back — non-source authored files are ignored", () => {
  it("PASSES clean when the run authored only non-Tier-A files (e.g. a .md report)", () => {
    const wr = mkWorkRoot();
    write(wr, "outputs/report.md", "# just markdown, no artifact");
    const r = one(evaluate([{ no_lost_write_back: true }], ctx({ workRoot: wr, authoredFiles: authored(["outputs/report.md"]) })));
    expect(r.pass).toBe(true);
  });
});
