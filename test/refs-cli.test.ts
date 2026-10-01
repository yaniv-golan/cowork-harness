import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeFromRun, verifyStores, type FreezeDeps, type ComposedForFreeze } from "../src/refs/cli.js";
import { composeKey, freezeRef, readRefDoc } from "../src/refs/store.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "refs-cli-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const K1 = composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
const K2 = composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: ["outputs/a.md"] });
const composed = (over: Partial<ComposedForFreeze> = {}): ComposedForFreeze => ({
  caseId: "case_1",
  source: { command: "ref freeze", runDir: "~/runs/r1", resultSha256: "a".repeat(64), sessionId: "s1" },
  harnessVersion: "4.3.0",
  composerId: "c1",
  scenario: "case_1",
  taskSha256: "1".repeat(64),
  docs: [{ key: K1, text: "DOC", live: "match" }],
  ...over,
});
const deps = (c: ComposedForFreeze | { refused: string }): FreezeDeps => ({ compose: () => c });
const base = () => ({ runDir: "/r", scenarioFile: "/s.yaml", out: join(tmp, "refs"), allowUnchecked: false });

describe("freezeFromRun", () => {
  it("freezes a run whose recomposed documents match the live fingerprints (exit 0)", () => {
    const r = freezeFromRun(base(), deps(composed()));
    expect(r.exitCode).toBe(0);
    expect(readRefDoc(join(tmp, "refs"), "case_1", K1)).toMatchObject({ status: "ok", text: "DOC" });
  });

  it("refuses when a recomposed document DIFFERS from what the live judge read — never overridable", () => {
    const r = freezeFromRun({ ...base(), allowUnchecked: true }, deps(composed({ docs: [{ key: K1, text: "X", live: "differs" }] })));
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/differs/);
    expect(readRefDoc(join(tmp, "refs"), "case_1", K1).status).toBe("missing");
  });

  it("refuses an unchecked document unless --allow-unchecked, and then records it as unchecked", () => {
    const c = composed({ docs: [{ key: K1, text: "U", live: "unknown" }] });
    expect(freezeFromRun(base(), deps(c)).exitCode).toBe(2);
    expect(freezeFromRun({ ...base(), allowUnchecked: true }, deps(c)).exitCode).toBe(0);
    expect(readRefDoc(join(tmp, "refs"), "case_1", K1)).toMatchObject({ status: "ok", unchecked: true });
  });

  it("refuses a scenario with no pairwise assert, and a refused composition", () => {
    expect(freezeFromRun(base(), deps(composed({ docs: [] }))).exitCode).toBe(2);
    const r = freezeFromRun(base(), deps({ refused: "work dir pruned" }));
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/pruned/);
  });

  it("an existing entry from the SAME run gains only new compose keys; nothing is rewritten", () => {
    expect(freezeFromRun(base(), deps(composed())).exitCode).toBe(0);
    const again = freezeFromRun(
      base(),
      deps(
        composed({
          docs: [
            { key: K1, text: "CHANGED", live: "match" },
            { key: K2, text: "NEW", live: "match" },
          ],
        }),
      ),
    );
    expect(again.exitCode).toBe(0);
    expect(readRefDoc(join(tmp, "refs"), "case_1", K1)).toMatchObject({ text: "DOC" });
    expect(readRefDoc(join(tmp, "refs"), "case_1", K2)).toMatchObject({ text: "NEW" });
  });

  it("an existing entry with nothing to add, or from a DIFFERENT run, is refused (exit 2)", () => {
    freezeFromRun(base(), deps(composed()));
    expect(freezeFromRun(base(), deps(composed())).exitCode).toBe(2);
    const other = composed({ source: { command: "ref freeze", runDir: "~/runs/r2", resultSha256: "b".repeat(64) } });
    expect(freezeFromRun(base(), deps(other)).exitCode).toBe(2);
  });

  it("--case-id overrides the scenario-derived id, and must be path-safe", () => {
    expect(freezeFromRun({ ...base(), caseId: "custom" }, deps(composed())).exitCode).toBe(0);
    expect(readRefDoc(join(tmp, "refs"), "custom", K1).status).toBe("ok");
    expect(freezeFromRun({ ...base(), caseId: "../x" }, deps(composed())).exitCode).toBe(2);
  });
});

describe("verifyStores", () => {
  it("exit 0 when clean, 1 on any integrity problem, and reports per store", () => {
    freezeRef(join(tmp, "a"), "c", composed().source, { [K1]: "D" }, { harnessVersion: "t", composerId: "c1" });
    expect(verifyStores([join(tmp, "a")]).exitCode).toBe(0);
    writeFileSync(join(tmp, "a", "c", `doc-${K1}.txt`), "tampered");
    const r = verifyStores([join(tmp, "a")]);
    expect(r.exitCode).toBe(1);
    expect(r.stores[0]!.problems).toHaveLength(1);
  });
});

describe("freezeFromRun — task identity and atomicity", () => {
  it("a fresh freeze with checked and unchecked documents writes them in ONE step", () => {
    const r = freezeFromRun(
      { ...base(), allowUnchecked: true },
      deps(
        composed({
          docs: [
            { key: K1, text: "A", live: "match" },
            { key: K2, text: "B", live: "unknown" },
          ],
        }),
      ),
    );
    expect(r).toMatchObject({ exitCode: 0, frozen: [K1, K2], added: [] });
    expect(readRefDoc(join(tmp, "refs"), "case_1", K2)).toMatchObject({ text: "B", unchecked: true });
    expect(readRefDoc(join(tmp, "refs"), "case_1", K1)).toMatchObject({ text: "A", taskSha256: "1".repeat(64), scenario: "case_1" });
  });
  it("adding to an entry frozen for a different task is refused", () => {
    freezeFromRun(base(), deps(composed()));
    const other = composed({ taskSha256: "2".repeat(64), docs: [{ key: K2, text: "X", live: "match" }] });
    const r = freezeFromRun(base(), deps(other));
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/different task/);
  });
});
