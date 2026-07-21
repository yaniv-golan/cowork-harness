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
//
// This scan was originally written to PIN the root-compat-copy debt (a COMPAT_ROOT_READERS inventory of
// sites deliberately still reading the run-dir root's `result.json`, tracked rather than allowlisted so
// the debt couldn't grow silently). The compat copy is gone now — `execute.ts` no longer writes a root
// `result.json` on any current-layout dir — and every one of those sites was repointed through the seam.
// The scan now asserts the STRONGER claim its debt-pinning predecessor could only gesture at: ZERO root
// reads of any per-turn artifact remain outside the seam/writers/a still-needed legacy-dir reader.

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
  ["src/run/chat.ts", "a WRITER of its own turn-1 artifacts (turnWriteDir/beginTurn), same as execute.ts — not a legacy exception"],
  ["src/runtime/resource-sampler.ts", "writer; takes an explicit turn and builds its own path"],
  [
    "src/run/migrate-run-dir.ts",
    "the MIGRATOR: reading a legacy dir's ROOT artifacts is its entire purpose — it is the one component " +
      "whose input is by definition the pre-layout shape, so a root read here is the subject matter, not " +
      "debt. Every DESTINATION it builds goes through turnArtifactPath(); the only hand-built path left is " +
      "the `resources.retry-<A>.jsonl` archive name, which is not a PER_TURN_ARTIFACT at all",
  ],
]);

/** A path construction into a run dir naming one of the four per-turn artifacts. */
const SCAN = /join\([^)]*(?:runDir|outDir|dir|file)[^)]*,\s*"([^"]+)"\)/;

describe("per-turn artifact paths go through the seam", () => {
  const hits: { file: string; line: string }[] = [];
  for (const abs of srcFiles(resolve("src"))) {
    const rel = abs.replace(resolve(".") + "/", "");
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "");
      // A path construction into a run dir, naming one of the four per-turn artifacts.
      if (!SCAN.test(line)) continue;
      for (const a of PER_TURN_ARTIFACTS) if (line.includes(`"${a}"`)) hits.push({ file: rel, line: raw.trim().slice(0, 120) });
    }
  }

  it("the scan is not vacuous (it can see path constructions at all)", () => {
    // Guards the guard: a regex that matches nothing would make every assertion below pass silently.
    //
    // Anchored on a LITERAL SAMPLE, deliberately — not on a real source line. The previous version
    // anchored on the legacy-dir indexer's root read, which was then deleted, so the liveness check
    // failed the moment the codebase got MORE correct. An anchor that rots when the code improves is
    // worse than none: it trains you to edit the guard whenever it complains.
    const SAMPLE = 'const p = join(outDir, "result.json");';
    expect(SCAN.test(SAMPLE), "the scan pattern no longer matches a known root read").toBe(true);
    expect(srcFiles(resolve("src")).length).toBeGreaterThan(50);
  });

  it("no reader outside the seam and the writers builds a per-turn artifact path by hand", () => {
    // A site that is neither the seam nor a writer will read the wrong turn — or a file that does not
    // exist — on a multi-turn dir. run-index's entry is gone with its legacy branch: an allowlist that
    // outlives its justification is how this repo shipped a 39/40-dead one. That is how verify-run and diff
    // shipped broken: both read root `run.jsonl`/`trace.json`, which the per-turn layout never creates.
    // Every COMPAT root reader that inventory once pinned (verify-run, inspect, latest-run, scaffold,
    // trace-view) has been repointed through turnArtifactPath()/latestTurn() — this must now be empty.
    expect(
      hits.map((h) => `${h.file}: ${h.line}`),
      "route these through turnArtifactPath()/resolveGraded(), or add a justified ALLOWED entry",
    ).toEqual([]);
  });

  it("every allowlist entry is still a real file with a stated reason", () => {
    // An allowlist that outlives its files is how the 39/40-dead one happened.
    for (const [rel, why] of ALLOWED) {
      expect(() => statSync(resolve(rel)), `allowlisted file no longer exists: ${rel}`).not.toThrow();
      expect(why.length, `allowlist entry ${rel} has no justification`).toBeGreaterThan(10);
    }
  });
});
