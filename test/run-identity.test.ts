import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCommit } from "../src/run/cassette.js";
import { buildTrace } from "../src/run/trace-view.js";

/** A git repo dir with one commit; returns { dir, sha }. */
function gitRepo(seed = "# skill v1\n"): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "skillgit-"));
  writeFileSync(join(dir, "SKILL.md"), seed);
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const sha = git("rev-parse", "HEAD").trim();
  return { dir, sha };
}

/** Write a session YAML that mounts `pluginDir` as a local skill; return its path. */
function sessionFor(pluginDir: string): string {
  const d = mkdtempSync(join(tmpdir(), "sess-"));
  const p = join(d, "session.yaml");
  writeFileSync(p, `skills:\n  local: [${pluginDir}]\n`);
  return p;
}

describe("skillCommit — git provenance for the iterate-across-fixes loop", () => {
  it("returns the skill dir's HEAD commit when it is a git repo", () => {
    const { dir, sha } = gitRepo();
    expect(skillCommit(sessionFor(dir))).toBe(sha);
  });

  it("returns null for a non-git skill dir (best-effort, never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-"));
    writeFileSync(join(dir, "SKILL.md"), "# not a repo\n");
    expect(skillCommit(sessionFor(dir))).toBeNull();
  });

  it("returns null when the mounted dirs span more than one repo (ambiguous provenance)", () => {
    const a = gitRepo("# a\n");
    const b = gitRepo("# b\n"); // distinct repo → distinct HEAD
    const d = mkdtempSync(join(tmpdir(), "sess-"));
    const p = join(d, "session.yaml");
    writeFileSync(p, `skills:\n  local: [${a.dir}, ${b.dir}]\n`);
    expect(skillCommit(p)).toBeNull();
  });

  it("returns null for an inline / skill-less session (no dirs to resolve)", () => {
    expect(skillCommit("(inline)")).toBeNull();
  });
});

// ── trace --full-results: full capture for SUCCESSFUL calls, not just errors (grounding substrate) ──
function assistant(content: unknown[], parent?: string) {
  return { type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}), message: { content } };
}
function toolResult(toolUseId: string, text: string, isError = false) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] } };
}
function eventsFile(events: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-"));
  const f = join(dir, "events.jsonl");
  writeFileSync(f, events.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}

describe("trace --full-results", () => {
  const multiLine = "line1\nline2\nline3 — the detail a grader needs";
  const events = [
    assistant([{ type: "tool_use", id: "toolu_ok", name: "Bash", input: { command: "python3 extract.py --verbose" } }]),
    toolResult("toolu_ok", multiLine, false), // SUCCESSFUL call
  ];

  it("default: a successful row exposes only the 120-char first line (resultTextFull absent)", () => {
    const rows = buildTrace(eventsFile(events), { tools: true });
    const ok = rows.find((r) => r.kind === "tool" && r.resultStatus === "ok")!;
    expect(ok.resultText).toBe("line1");
    expect(ok.resultTextFull).toBeUndefined();
    expect(ok.detailFull).toBeUndefined();
  });

  it("with fullResults: the successful row gains the full multi-line result + full input", () => {
    const rows = buildTrace(eventsFile(events), { tools: true, fullResults: true });
    const ok = rows.find((r) => r.kind === "tool" && r.resultStatus === "ok")!;
    expect(ok.resultText).toBe("line1"); // first-line slice unchanged
    expect(ok.resultTextFull).toBe(multiLine);
    expect(ok.detailFull).toContain("extract.py --verbose");
  });
});
