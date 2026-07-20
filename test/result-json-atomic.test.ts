import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Structural guards for the `result.json` atomic-write fix and the hostloop infra-error fold.
 *
 * `result.json` is the canonical, gate-deciding evidence file — a torn write on crash/disk-full loses
 * it, and no reader repairs a partial file (all do bare `JSON.parse(readFileSync(...))`). These tests
 * read the producer source as TEXT and assert every `result.json` write site goes through the atomic
 * (temp+rename) helper, mirroring the existing `seam-guards.test.ts` convention: a source-text assertion
 * that fails loud if a future edit reintroduces a bare `writeFileSync` at these call sites, rather than
 * relying on an integration test that would need a real (or faked) agent spawn to exercise.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const executeSrc = readFileSync(join(SRC, "run", "execute.ts"), "utf8");
const chatSrc = readFileSync(join(SRC, "run", "chat.ts"), "utf8");
const hostloopSrc = readFileSync(join(SRC, "runtime", "hostloop.ts"), "utf8");

/** Asserts every forced `docker rm -f <containerName>` call site in `src` is IMMEDIATELY preceded, in
 *  source order, by its own `hostloopMarkTearingDown?.()` call — not just that both calls occur somewhere
 *  in the file `>= 2` times each (a count-only check still passes if a future edit moves the mark call to
 *  AFTER its `rm -f`, which is the exact bug this guards against). Interleaves both call sites by source
 *  offset and requires strict mark→rm alternation, so a swapped-order teardown path breaks the pairing
 *  rather than silently matching against some OTHER path's mark call. */
function assertMarkPrecedesForcedRemoval(src: string) {
  const markIdxs = [...src.matchAll(/hostloopMarkTearingDown\?\.\(\)/g)].map((m) => m.index!);
  const rmIdxs = [...src.matchAll(/spawnSync\(runner,\s*\["rm",\s*"-f",\s*containerName\]/g)].map((m) => m.index!);
  expect(rmIdxs.length).toBeGreaterThanOrEqual(2); // both the Ctrl-C thunk and the normal-path finally
  const events = [...markIdxs.map((idx) => ({ idx, kind: "mark" as const })), ...rmIdxs.map((idx) => ({ idx, kind: "rm" as const }))].sort(
    (a, b) => a.idx - b.idx,
  );
  for (let i = 0; i < events.length; i += 2) {
    expect(events[i]?.kind, `expected hostloopMarkTearingDown?.() before forced removal #${i / 2 + 1}`).toBe("mark");
    expect(events[i + 1]?.kind, `expected docker rm -f immediately after its mark call (#${i / 2 + 1})`).toBe("rm");
  }
}

describe("result.json writes are atomic", () => {
  it("execute.ts writes result.json only via writeTextAtomic (partial + success paths), never a bare writeFileSync", () => {
    const resultJsonLines = executeSrc
      .split("\n")
      .filter((l) => l.includes('"result.json"') && /writeFileSync\(|writeTextAtomic\(/.test(l));
    // both the partial-result salvage write and the success-path write
    expect(resultJsonLines.length).toBeGreaterThanOrEqual(2);
    for (const line of resultJsonLines) {
      expect(line).not.toMatch(/\bwriteFileSync\(/);
      expect(line).toMatch(/\bwriteTextAtomic\(/);
    }
  });

  it("chat.ts writes result.json only via writeTextAtomic, never a bare writeFileSync", () => {
    const resultJsonLines = chatSrc.split("\n").filter((l) => l.includes('"result.json"'));
    expect(resultJsonLines.length).toBeGreaterThanOrEqual(1);
    for (const line of resultJsonLines) {
      expect(line).not.toMatch(/\bwriteFileSync\(/);
      expect(line).toMatch(/\bwriteTextAtomic\(/);
    }
  });

  it("both producers import writeTextAtomic from io.js", () => {
    expect(executeSrc).toMatch(/import\s*{[^}]*writeTextAtomic[^}]*}\s*from\s*"\.\.\/io\.js"/);
    expect(chatSrc).toMatch(/import\s*{[^}]*writeTextAtomic[^}]*}\s*from\s*"\.\.\/io\.js"/);
  });
});

describe("hostloop sidecar infra errors reach the live RunRecord", () => {
  it("execute.ts folds hostloop's live infraErrors into record.infraErrors", () => {
    expect(executeSrc).toMatch(/hostloopInfraErrors\?\.length\)\s*record\.infraErrors\.push\(\.\.\.hostloopInfraErrors\)/);
  });

  it("chat.ts folds hostloop's live infraErrors into record.infraErrors", () => {
    expect(chatSrc).toMatch(/hostloopInfraErrors\?\.length\)\s*record\.infraErrors\.push\(\.\.\.hostloopInfraErrors\)/);
  });

  it("execute.ts marks the sidecar as tearing-down before every forced container removal", () => {
    // Both the normal-path finally and the Ctrl-C cleanup thunk must call this before their own
    // `docker rm -f`, or a naive fix reds every hostloop run (see hostloop.ts's watchHostLoopSidecar doc).
    assertMarkPrecedesForcedRemoval(executeSrc);
  });

  it("chat.ts marks the sidecar as tearing-down before every forced container removal", () => {
    assertMarkPrecedesForcedRemoval(chatSrc);
  });

  it("spawnHostLoop's exit handling treats a signal-only kill (code null, signal set) as unexpected", () => {
    // The prior bug: `if (code !== 0 && code !== null)` silently ignored a SIGKILL/OOM kill, which
    // reports code===null exactly like the case the guard meant to treat as clean. Guard against that
    // specific buggy conjunction reappearing, tolerant of whitespace variants around the operators.
    expect(hostloopSrc).not.toMatch(/code\s*!==\s*0\s*&&\s*code\s*!==\s*null/);
  });
});

describe("assertMarkPrecedesForcedRemoval catches the ordering bug it's meant to catch", () => {
  const goodFixture = `
    hostloopMarkTearingDown?.();
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    // ... unrelated code between the two teardown paths ...
    hostloopMarkTearingDown?.();
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
  `;
  // Same two calls, same COUNT (>= 2 each) as goodFixture — a count-only check can't tell these apart —
  // but the second path's mark call was moved to AFTER its own `rm -f`, the exact regression this guards.
  const reorderedFixture = `
    hostloopMarkTearingDown?.();
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    hostloopMarkTearingDown?.();
  `;

  it("does not throw when every removal is preceded by its own mark call", () => {
    expect(() => assertMarkPrecedesForcedRemoval(goodFixture)).not.toThrow();
  });

  it("throws when a mark call is moved to after its `rm -f`, despite matching counts", () => {
    expect(() => assertMarkPrecedesForcedRemoval(reorderedFixture)).toThrow();
  });
});
