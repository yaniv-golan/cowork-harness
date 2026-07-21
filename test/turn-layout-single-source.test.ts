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
  [
    "src/run/run-index.ts",
    "the legacy-dir indexer: a genuinely-legacy dir's root result.json is its ONLY copy (no compat copy " +
      "exists anymore to confuse this with), so reading it here is deliberate, not debt — kept until the " +
      "legacy branch itself is removed; turns/ dirs are enumerated separately and never hit this line",
  ],
  ["src/runtime/resource-sampler.ts", "writer; takes an explicit turn and builds its own path"],
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
    // The writer itself moved off this pattern (it now writes ONLY through turnWriteDir), so anchor the
    // liveness check on the still-allowlisted legacy-dir reader instead — the one production site left
    // that genuinely matches the scan pattern.
    const legacyReader = readFileSync(resolve("src/run/run-index.ts"), "utf8");
    expect(/join\([^)]*outDir[^)]*,\s*"result\.json"\)/.test(legacyReader), "the scan pattern no longer matches anything").toBe(true);
    expect(srcFiles(resolve("src")).length).toBeGreaterThan(50);
  });

  it("no reader outside the seam/writers/the legacy-dir indexer builds a per-turn artifact path by hand", () => {
    // A site that is neither the seam, a writer, nor the one still-needed legacy-dir reader will read the
    // wrong turn — or a file that does not exist — on a multi-turn dir. That is how verify-run and diff
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
