import { describe, it, expect } from "vitest";
import { resolveVmBaselineArg, type VmBaselineArgDeps } from "../src/runtime/vm-baseline-arg.js";
import { loadBaseline, listBaselineNames } from "../src/baseline.js";
import { UnknownBaselineError, UsageError } from "../src/errors.js";
import type { PlatformBaseline } from "../src/types.js";

// Platform-independent half of the fix. The CLI tests in cli-json.test.ts cover each entry point
// end to end; the `vm` ones are darwin-only (cmdVm refuses other platforms before parsing), so this is
// what Linux CI exercises for `vm`, plus loadBaseline's own contract that every entry point relies on.

describe("loadBaseline: a user-supplied name that names no baseline", () => {
  it("throws UnknownBaselineError (a UsageError) listing the committed baselines, not ENOENT", () => {
    const names = listBaselineNames();
    expect(names.length).toBeGreaterThan(0);
    let caught: unknown;
    try {
      loadBaseline("desktop-0.0.0");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownBaselineError);
    expect(caught).toBeInstanceOf(UsageError); // what main().catch maps to category usage, exit 2
    const e = caught as UnknownBaselineError;
    expect(e.baselineName).toBe("desktop-0.0.0");
    expect(e.message).toMatch(/^no baseline named "desktop-0\.0\.0" — a baseline is `latest`/);
    expect(e.message).not.toMatch(/ENOENT/);
    expect(e.hint).toBe(`valid baselines (newest first): ${names.join(", ")}`);
  });

  it("an absolute path that does not exist says 'no baseline file at'", () => {
    expect(() => loadBaseline("/no/such/baseline.json")).toThrow(/^no baseline file at "\/no\/such\/baseline\.json"/);
  });

  it("a name with a path separator keeps safeNamedBaseline's reason", () => {
    expect(() => loadBaseline("../x")).toThrow(UnknownBaselineError);
    expect(() => loadBaseline("../x")).toThrow(/no baseline named "\.\.\/x" \(.*must be a bare filename/);
  });

  it("valid names still load: latest, a bare name, and the name with .json", () => {
    const newest = listBaselineNames()[0];
    expect(loadBaseline("latest").appVersion).toBe(loadBaseline(newest).appVersion);
    expect(() => loadBaseline(`${newest}.json`)).not.toThrow();
  });

  it("listBaselineNames is newest first by version, not lexically", () => {
    const names = listBaselineNames();
    const v = (n: string) =>
      n
        .replace(/^desktop-/, "")
        .split(".")
        .map(Number);
    for (let i = 1; i < names.length; i++) {
      const [a, b] = [v(names[i - 1]), v(names[i])];
      const cmp = a[0] - b[0] || a[1] - b[1] || (a[2] ?? 0) - (b[2] ?? 0);
      expect(cmp, `${names[i - 1]} before ${names[i]}`).toBeGreaterThan(0);
    }
  });
});

const fake = (id: string) => ({ appVersion: id }) as unknown as PlatformBaseline;

// Two baselines deriving the SAME VM, as real ones do when their guest config hashes match. `load`
// throws the way loadBaseline does.
const deps: VmBaselineArgDeps = {
  load: (n) => {
    if (n === "desktop-2.0.0" || n === "desktop-1.0.0" || n === "latest") return fake(n);
    throw new UnknownBaselineError(n, `no baseline named "${n}" — a baseline is \`latest\``, "valid baselines …");
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

    it(`${sub}: an unknown baseline keeps loadBaseline's message, prefixed, and lists the valid ones`, () => {
      const r = resolveVmBaselineArg(sub, "desktop-9.9.9", deps);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toBe(`vm ${sub}: no baseline named "desktop-9.9.9" — a baseline is \`latest\``);
      expect(r.hint).toMatch(new RegExp(`^run \`vm ${sub}\` with no argument .* desktop-2\\.0\\.0, desktop-1\\.0\\.0$`));
    });
  }

  it("an orphan VM name (no baseline derives it here) points at `vm prune`", () => {
    const r = resolveVmBaselineArg("delete", "cowork-vm-bbbb2222", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/No committed baseline derives cowork-vm-bbbb2222.*`vm prune`/);
  });

  it("a load failure that is not a UsageError is reported, not thrown", () => {
    const boom: VmBaselineArgDeps = {
      ...deps,
      load: () => {
        throw new Error("disk on fire");
      },
    };
    const r = resolveVmBaselineArg("status", "desktop-2.0.0", boom);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('vm status: failed to load baseline "desktop-2.0.0" (disk on fire)');
  });

  it("with the real baselines: an unknown name lists the committed baselines newest first", () => {
    const names = listBaselineNames();
    const r = resolveVmBaselineArg("delete", "desktop-0.0.0");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/^vm delete: no baseline named "desktop-0\.0\.0"/);
      expect(r.hint).toContain(`valid baselines (newest first): ${names[0]}`);
    }
  });
});
