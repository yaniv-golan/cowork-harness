import { describe, it, expect, afterEach } from "vitest";
import { runtimeAuthEnv } from "../src/runtime/host-env.js";

// WI-7 (docs/internal finding, TZ parity): Desktop always injects the resolved IANA zone into the
// agent env (Intl.DateTimeFormat().resolvedOptions().timeZone), unconditionally. The harness used to
// forward TZ ONLY when the host shell exported it — so a run on a host without TZ set spawned the
// agent with no timezone, diverging from Cowork (date rendering / "today" resolution in prompts and
// outputs). runtimeAuthEnv is the single seam all real-agent tiers spread (hostloop/container/microvm).
describe("runtimeAuthEnv TZ parity (WI-7)", () => {
  const prev = process.env.TZ;
  afterEach(() => {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  });

  it("passes the host TZ through when it is set", () => {
    process.env.TZ = "America/New_York";
    expect(runtimeAuthEnv().TZ).toBe("America/New_York");
  });

  it("falls back to the resolved IANA zone when the host does NOT export TZ (never absent)", () => {
    delete process.env.TZ;
    const tz = runtimeAuthEnv().TZ;
    expect(tz).toBeDefined();
    expect(typeof tz).toBe("string");
    expect(tz!.length).toBeGreaterThan(0);
    // matches what Desktop resolves the same way
    expect(tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
