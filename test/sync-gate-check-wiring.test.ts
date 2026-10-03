import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The gate and anchor checks are unit-tested as functions, but each is only a guarantee if `sync` calls it — and
// `sync` needs a real Desktop install, so no unit test runs it. Dropping a call is silent to tsc and to the suite,
// so pin the call sites in the source text (the same pattern as the cmdSync → buildNextAgentBinary pin).
const src = readFileSync(join(import.meta.dirname, "..", "src", "sync", "cowork-sync.ts"), "utf8");
function bodyOf(header: string): string {
  const start = src.indexOf(header);
  return start < 0 ? "" : src.slice(start, src.indexOf("\n}\n", start));
}

describe("sync wires its gate notes and the auto-memory anchor", () => {
  const sync = bodyOf("export function sync(): SyncResult {");
  const extract = bodyOf("function extractFromAsar(");
  it("finds both functions", () => {
    expect(sync.length).toBeGreaterThan(0);
    expect(extract.length).toBeGreaterThan(0);
  });
  it("sync reads the asar through extractFromAsar", () => expect(sync).toMatch(/extractFromAsar\(/));
  it("sync puts checkSubagentOverrideGate's note in notes", () =>
    expect(sync).toContain("notes.push(...checkSubagentOverrideGate(gates));"));
  it("sync puts checkAutoMemoryGate's note in notes", () => expect(sync).toContain("notes.push(...checkAutoMemoryGate(gates));"));
  it("extractFromAsar turns checkAutoMemoryFacts' flags into unknown deltas", () =>
    expect(extract).toContain("for (const f of checkAutoMemoryFacts(bundleFiles)) flag(unknown, f);"));
});
