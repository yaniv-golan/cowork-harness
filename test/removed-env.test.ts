// The two environment variables 5.0.0 removed refuse, naming the variable and what replaced it; empty counts as unset.
import { describe, it, expect } from "vitest";
import { removedEnvRefusal } from "../src/removed-env.js";

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
});
