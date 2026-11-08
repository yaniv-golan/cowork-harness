// The environment variables 5.0.0 removed or renamed refuse, naming the variable and what replaced it; empty counts as
// unset.
import { describe, it, expect } from "vitest";
import { REFUSED_ENV_NAMES, removedEnvRefusal } from "../src/removed-env.js";

describe("removedEnvRefusal", () => {
  it("nothing set, or set empty: no refusal", () => {
    expect(removedEnvRefusal({})).toBeUndefined();
    expect(removedEnvRefusal({ COWORK_MANAGED_CONFIG: "", COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE: "" })).toBeUndefined();
  });

  it.each(["1", "0", "true"])("COWORK_MANAGED_CONFIG=%s refuses (any non-empty value, 0 included)", (v) => {
    const r = removedEnvRefusal({ COWORK_MANAGED_CONFIG: v });
    expect(r).toMatch(/^COWORK_MANAGED_CONFIG was removed in 5\.0\.0 — fidelity protocol always gives the agent a managed config dir/);
    expect(r).toContain("a Keychain or /login session is not used");
  });

  it("COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE refuses with its own remedy", () => {
    const r = removedEnvRefusal({ COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE: "1" });
    expect(r).toMatch(
      /^COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE was removed in 5\.0\.0 — a pinned plugins\.config_dir is now used only by the run/,
    );
  });

  it("both set: one line each", () => {
    const r = removedEnvRefusal({ COWORK_MANAGED_CONFIG: "1", COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE: "1" })!;
    expect(r.split("\n")).toHaveLength(2);
  });

  // Written out here, not read from src/removed-env.ts, so dropping a pair there fails this table.
  const RENAMED = [
    "LOCKDOWN",
    "LIMA_INSTANCE",
    "LIMACTL",
    "VM_PROVISION_TIMEOUT_S",
    "VM_PROXY_PORT",
    "VM_GATEWAY",
    "CONTAINER_RUNTIME",
    "SKIP_CAPABILITY_PROBE",
  ];
  it.each(RENAMED)("COWORK_%s refuses, naming its COWORK_HARNESS_ replacement", (suffix) => {
    expect(removedEnvRefusal({ [`COWORK_${suffix}`]: "1" })).toBe(
      `COWORK_${suffix} was renamed in 5.0.0 to COWORK_HARNESS_${suffix}. Set that instead.`,
    );
    expect(removedEnvRefusal({ [`COWORK_${suffix}`]: "" })).toBeUndefined();
    expect(removedEnvRefusal({ [`COWORK_HARNESS_${suffix}`]: "1" })).toBeUndefined();
  });

  it("the old name refuses even when the new one is also set", () => {
    expect(removedEnvRefusal({ COWORK_LOCKDOWN: "1", COWORK_HARNESS_LOCKDOWN: "1" })).toMatch(/^COWORK_LOCKDOWN was renamed/);
  });

  it("REFUSED_ENV_NAMES lists every removed and renamed name", () => {
    expect([...REFUSED_ENV_NAMES].sort()).toEqual(
      ["COWORK_MANAGED_CONFIG", "COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE", ...RENAMED.map((s) => `COWORK_${s}`)].sort(),
    );
  });
});
