import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// `diff`'s RUN-vs-RUN mode (as opposed to the baseline-diff mode covered by cli-diff.test.ts) had NO
// coverage at all before or after the per-turn layout — `loadRunSide`'s repointing (cli.ts) is otherwise
// exercised only indirectly. This file closes that gap directly: it drives the real CLI over real run
// dirs, the same "a fabricated dir can't catch a writer/reader that never resolves" principle the rest of
// this effort's test work follows.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function runDir(root: string, name: string, transcript: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
    }) +
      "\n" +
      JSON.stringify({ type: "result", is_error: false }),
  );
  const turn1 = join(dir, "turns", "1");
  mkdirSync(turn1, { recursive: true });
  writeFileSync(
    join(turn1, "run.jsonl"),
    [JSON.stringify({ t: "run", scenario: name }), JSON.stringify({ t: "transcript", text: transcript })].join("\n"),
  );
  writeFileSync(join(turn1, "result.json"), JSON.stringify({ scenario: name, result: "success", effectiveFidelity: "container" }));
  return dir;
}

function diff(args: string[]) {
  const r = spawnSync("node", [CLI, "diff", ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!can)("cli diff — run mode reads through the seam (turns/1/), not the root", () => {
  it("detects a real transcript difference between two current-layout run dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-diff-run-"));
    const a = runDir(root, "a", "the skill flagged the blank field");
    const b = runDir(root, "b", "the skill flagged nothing");
    const r = diff([a, b, "--view", "transcript"]);
    // Transcript drift is advisory-only (the gateable exit code is tools/artifacts/meta), so this still
    // exits 0 — but before the seam repoint, `loadRunSide` read root run.jsonl (which the per-turn layout
    // never creates), so BOTH sides silently reduced to an empty transcript and NO drift printed at all,
    // regardless of real drift. The printed diff below is what proves the real text was actually read.
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("the skill flagged the blank field");
    expect(r.stdout).toContain("the skill flagged nothing");
  });

  it("reports NO transcript difference between two run dirs with the SAME turns/1/ transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-diff-run-same-"));
    const a = runDir(root, "a", "identical text");
    const b = runDir(root, "b", "identical text");
    const r = diff([a, b]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });

  it("reads meta (effectiveFidelity) from turns/1/result.json, not an absent root copy", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-diff-run-meta-"));
    const a = join(root, "a");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "events.jsonl"), JSON.stringify({ type: "result", is_error: false }));
    mkdirSync(join(a, "turns", "1"), { recursive: true });
    writeFileSync(
      join(a, "turns", "1", "result.json"),
      JSON.stringify({ scenario: "a", result: "success", effectiveFidelity: "container" }),
    );
    const b = join(root, "b");
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, "events.jsonl"), JSON.stringify({ type: "result", is_error: false }));
    mkdirSync(join(b, "turns", "1"), { recursive: true });
    writeFileSync(
      join(b, "turns", "1", "result.json"),
      JSON.stringify({ scenario: "b", result: "success", effectiveFidelity: "hostloop" }),
    );
    const r = diff([a, b, "--view", "meta", "--output-format", "json"]);
    const payload = JSON.parse(r.stdout);
    // A root read here (pre-seam) left `meta` at `{}` on both sides — no effectiveFidelity field to diff.
    expect(payload.views.meta, "meta came back empty — turns/1/result.json was not read").not.toEqual([]);
  });

  it("KNOWN GAP: a genuinely LEGACY dir (root-only, no turns/) is NOT refused by diff, unlike verify-run/inspect/scaffold — it silently degrades to empty meta", () => {
    // Documented, not celebrated: `diff` never got the `requireTurns` refusal the other single-target
    // commands did (see turn-layout.ts's classifyRunDir / requireTurns). `latestTurn(runDir) ?? 1` falls
    // back to a turn number that resolves to `turns/1/…` — which does not exist on a legacy dir — so this
    // reproduces the exact silent-empty-meta/transcript defect the seam repoint fixed everywhere else.
    // Pinned here so a future fix (adding the refusal) is a deliberate, visible diff against a documented
    // expectation, and so this gap does not masquerade as "covered" by omission.
    const root = mkdtempSync(join(tmpdir(), "cwh-diff-run-legacy-"));
    const a = join(root, "a");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "events.jsonl"), JSON.stringify({ type: "result", is_error: false }));
    writeFileSync(join(a, "run.jsonl"), JSON.stringify({ t: "transcript", text: "legacy transcript text" }));
    writeFileSync(join(a, "result.json"), JSON.stringify({ scenario: "a", result: "success", effectiveFidelity: "container" }));
    const b = runDir(root, "b", "legacy transcript text");
    const r = diff([a, b, "--view", "meta", "--output-format", "json"]);
    const payload = JSON.parse(r.stdout);
    // Every entry has a `to` (from side b's real turns/1/result.json) but no `from` at all — proving side
    // a's meta came back completely empty, exactly the "guard-invisible root read silently produced {}"
    // defect this effort fixed for every OTHER single-target command's result-derived view.
    expect(payload.views.meta.length, "expected diff entries — side a's legacy result.json should not have been read").toBeGreaterThan(0);
    for (const entry of payload.views.meta) {
      expect(
        entry.from,
        `field "${entry.field}" unexpectedly had a "from" value — diff may have grown a real legacy read path; update this test, don't just re-fabricate the gap`,
      ).toBeUndefined();
    }
  });
});
