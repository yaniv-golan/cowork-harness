import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { PER_TURN_ARTIFACTS } from "../src/run/turn-layout.js";

// The guard the plan promised as its mitigation for "biggest risk: a reader I did not find" — and which
// was then never written. Its absence is exactly why `verify-run` and `diff` shipped reading root
// `run.jsonl`/`trace.json`, which the per-turn layout no longer creates: verify-run reported
// "evidence unavailable" for every transcript/question assertion on any new run, and diff silently
// compared an empty transcript.
//
// A promised guard that does not exist is worse than no promise: the plan counted it as coverage.

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Files allowed to construct a per-turn artifact path directly.
 *
 *  Kept MINIMAL and justified per entry — this repo shipped a 39/40-dead allowlist, so an entry that is
 *  not defensible here is a bug, not a convenience. Each of these legitimately addresses the RUN-DIR ROOT
 *  rather than a turn. */
const ALLOWED = new Map<string, string>([
  ["src/run/turn-layout.ts", "the seam itself"],
  ["src/run/execute.ts", "the WRITER — it owns the layout it writes, and holds the legacy archive path"],
  ["src/run/chat.ts", "chat is legacy-shaped by contract: no turns, no resume"],
  ["src/run/runs-gc.ts", "existence marker only — never reads content"],
  ["src/runtime/resource-sampler.ts", "writer; takes an explicit turn and builds its own path"],
]);

/** Sites that deliberately read the run-dir root `result.json` — the documented COMPAT COPY of the latest
 *  turn. They are correct today, so this is not a defect list; it is the exact, enforced inventory of what
 *  a clean break (dropping the compat copy) would have to repoint, each with a turn-selection decision.
 *
 *  Tracked rather than allowlisted-and-forgotten: an allowlist would let the guard report "all clear"
 *  while this debt grew silently. The COUNT is pinned, so a new root reader fails CI and has to justify
 *  itself here. */
const COMPAT_ROOT_READERS = new Map<string, string>([
  ["src/cli.ts", "verify-run's result load + run-dir resolution — latest turn is correct for both"],
  ["src/run/inspect-view.ts", "inspect shows the latest turn"],
  ["src/run/latest-run.ts", "recency + verdict subset for listings"],
  ["src/run/run-index.ts", "the legacy-dir branch; turn dirs are enumerated separately"],
  ["src/run/scaffold.ts", "scaffolds from the latest turn"],
  ["src/run/trace-view.ts", "the trace footer's sibling result"],
]);

describe("per-turn artifact paths go through the seam", () => {
  const hits: { file: string; line: string }[] = [];
  for (const abs of srcFiles(resolve("src"))) {
    const rel = abs.replace(resolve(".") + "/", "");
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "");
      // A path construction into a run dir, naming one of the four per-turn artifacts.
      if (!/join\([^)]*(?:runDir|outDir|dir|file)[^)]*,\s*"([^"]+)"\)/.test(line)) continue;
      for (const a of PER_TURN_ARTIFACTS) if (line.includes(`"${a}"`)) hits.push({ file: rel, line: raw.trim().slice(0, 120) });
    }
  }

  it("the scan is not vacuous (it can see path constructions at all)", () => {
    // Guards the guard: a regex that matches nothing would make every assertion below pass silently.
    const writer = readFileSync(resolve("src/run/execute.ts"), "utf8");
    expect(/join\([^)]*outDir[^)]*,\s*"result\.json"\)/.test(writer), "the scan pattern no longer matches the writer").toBe(true);
    expect(srcFiles(resolve("src")).length).toBeGreaterThan(50);
  });

  it("no UNTRACKED file builds a per-turn artifact path by hand", () => {
    // A site that is neither the seam, a writer, nor a known compat-root reader will read the wrong turn
    // — or a file that does not exist — on a multi-turn dir. That is how verify-run and diff shipped
    // broken: both read root `run.jsonl`/`trace.json`, which the per-turn layout never creates.
    const untracked = hits.filter((h) => !COMPAT_ROOT_READERS.has(h.file));
    expect(
      untracked.map((h) => `${h.file}: ${h.line}`),
      "route these through turnArtifactPath()/resolveGraded()",
    ).toEqual([]);
  });

  it("only result.json is read from the root — the sidecars have no compat copy", () => {
    // `result.json` is the ONLY artifact with a root compat copy. A root read of run.jsonl / trace.json /
    // resources.jsonl resolves to a file that does not exist under the per-turn layout, which is exactly
    // the verify-run and diff defects.
    const sidecarReads = hits.filter((h) => !h.line.includes('"result.json"'));
    expect(
      sidecarReads.map((h) => `${h.file}: ${h.line}`),
      "no root compat copy exists for these",
    ).toEqual([]);
  });

  it("pins the compat-copy debt: exactly these files depend on the root alias", () => {
    // The clean-break inventory. If this count moves, either a new root reader appeared (justify it) or
    // one was repointed (shrink the list) — both should be deliberate.
    expect([...new Set(hits.map((h) => h.file))].sort()).toEqual([...COMPAT_ROOT_READERS.keys()].sort());
  });

  it("every allowlist entry is still a real file with a stated reason", () => {
    // An allowlist that outlives its files is how the 39/40-dead one happened.
    for (const [rel, why] of ALLOWED) {
      expect(() => statSync(resolve(rel)), `allowlisted file no longer exists: ${rel}`).not.toThrow();
      expect(why.length, `allowlist entry ${rel} has no justification`).toBeGreaterThan(10);
    }
  });
});
