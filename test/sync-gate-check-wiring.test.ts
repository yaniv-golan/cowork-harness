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
  const sync = bodyOf("export function sync(opts: { declareUnobservable?: ObservedSpawnEnvDeclaration | null } = {}): SyncResult {");
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
  it("sync turns the observed spawn env's deltas into unknown deltas and returns its block", () => {
    expect(sync).toContain("for (const d of observedSpawnEnv.deltas) flag(unknown, d);");
    expect(sync).toContain("observedSpawnEnv: observedSpawnEnv.block,");
    expect(sync).toContain("previous: readPreviousObservedSpawnEnv(),");
  });
  it("extractFromAsar turns the post-construction scanner's flags into unknown deltas", () =>
    expect(extract).toContain("for (const f of postWrites.flags) flag(unknown, f);"));
  it("extractFromAsar's product-name gate checks all four bundle positions", () => {
    for (const shape of ['bundle.includes(`"${name}"`)', "bundle.includes(`{${name}:`)", "bundle.includes(`,${name}:`)", "reEsc(name)"])
      expect(extract).toContain(shape);
  });
});

// cmdSync runs the harness comparison and the schema guard; both are only guarantees if the CLI calls them before the
// unknown-delta write guard.
describe("cmdSync wires the observed spawn env", () => {
  const cli = readFileSync(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
  const compare = cli.indexOf("checkObservedAgainstHarness(res.observedSpawnEnv, harnessHostLoopKeys(");
  const push = cli.indexOf("res.unknownDeltas.push(...cmp.deltas);");
  const guard = cli.indexOf("if (res.unknownDeltas.length) {");
  it("compares against the harness and feeds its deltas to the write guard", () => {
    expect(compare).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(compare);
    expect(guard).toBeGreaterThan(push);
  });
  it("refuses a block that fails its schema", () => expect(cli).toContain("ObservedSpawnEnv.safeParse(res.observedSpawnEnv)"));
  it("writes the block into provenance", () => expect(cli).toContain("observedSpawnEnv: res.observedSpawnEnv,"));
});

// Release preflight: check 7b is a guarantee only if main() runs it.
describe("release preflight runs check 7b", () => {
  const pre = readFileSync(join(import.meta.dirname, "..", "scripts", "release-preflight.ts"), "utf8");
  it("lists checkSpawnEnvObserved among the hard checks", () =>
    expect(pre).toMatch(/hardResults: CheckResult\[\] = \[[\s\S]*checkSpawnEnvObserved\(newestBaseline\(\), allowUnobservedSpawnEnv\)/));
});
