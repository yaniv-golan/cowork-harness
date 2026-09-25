import { describe, it, expect } from "vitest";
import { resolveVmBaselineArg, type VmBaselineArgDeps } from "../src/runtime/vm-baseline-arg.js";
import { loadBaseline, listBaselineNames } from "../src/baseline.js";
import type { PlatformBaseline } from "../src/types.js";

// Platform-independent half of the `vm <sub> <baseline>` fix: the CLI tests in cli-json.test.ts are
// darwin-only (cmdVm refuses other platforms before parsing), so this is what Linux CI exercises.

const enoent = (name: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${name}.json'`), { code: "ENOENT" });
const fake = (id: string) => ({ appVersion: id }) as unknown as PlatformBaseline;

// Two baselines deriving the SAME VM, as real ones do when their guest config hashes match.
const deps: VmBaselineArgDeps = {
  load: (n) => {
    if (n === "desktop-2.0.0" || n === "desktop-1.0.0" || n === "latest") return fake(n);
    if (n.includes("/")) throw new Error(`baseline name "${n}" must be a bare filename`);
    throw enoent(n);
  },
  list: () => ["desktop-2.0.0", "desktop-1.0.0"],
  instanceOf: () => "cowork-vm-aaaa1111",
};

describe("resolveVmBaselineArg", () => {
  for (const sub of ["init", "status", "delete", "prune"]) {
    it(`${sub}: a valid baseline resolves`, () => {
      const r = resolveVmBaselineArg(sub, "desktop-2.0.0", deps);
      expect(r.ok).toBe(true);
    });

    it(`${sub}: a VM name is a usage error naming what the argument is, and the baselines that own it`, () => {
      const r = resolveVmBaselineArg(sub, "cowork-vm-aaaa1111", deps);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toBe(
        `vm ${sub}: "cowork-vm-aaaa1111" is a VM name, not a baseline — the argument names the baseline the VM is derived from`,
      );
      // both owners listed: the mapping is many-to-one, which is why a VM name is not accepted
      expect(r.hint).toMatch(/is the VM for desktop-2\.0\.0, desktop-1\.0\.0/);
      expect(r.hint).toMatch(/valid baselines \(newest first\): desktop-2\.0\.0, desktop-1\.0\.0/);
    });

    it(`${sub}: an unknown baseline is a usage error listing the valid ones, with no ENOENT text`, () => {
      const r = resolveVmBaselineArg(sub, "desktop-9.9.9", deps);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toMatch(new RegExp(`^vm ${sub}: no baseline named "desktop-9\\.9\\.9" — the argument is a baseline`));
      expect(r.message).not.toMatch(/ENOENT/);
      expect(r.hint).toMatch(/desktop-2\.0\.0, desktop-1\.0\.0/);
    });
  }

  it("an orphan VM name (no baseline derives it here) points at `vm prune`", () => {
    const r = resolveVmBaselineArg("delete", "cowork-vm-bbbb2222", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/No committed baseline derives cowork-vm-bbbb2222.*`vm prune`/);
  });

  it("a non-ENOENT load failure (path separator) keeps its reason instead of throwing", () => {
    const r = resolveVmBaselineArg("status", "../x", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/no baseline named "\.\.\/x" \(baseline name "\.\.\/x" must be a bare filename\)/);
  });

  it("with the real baselines: an unknown name lists the committed baselines newest first", () => {
    const names = listBaselineNames();
    expect(names.length).toBeGreaterThan(0);
    expect(() => loadBaseline(names[0])).not.toThrow();
    const r = resolveVmBaselineArg("delete", "desktop-0.0.0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain(`valid baselines (newest first): ${names[0]}`);
  });
});
