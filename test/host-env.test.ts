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

  it("a valid IANA host TZ flows through (resolved to the same zone)", () => {
    process.env.TZ = "America/New_York";
    expect(runtimeAuthEnv().TZ).toBe("America/New_York");
  });

  it("NORMALIZES a legacy/non-IANA host TZ to the IANA zone (matches Desktop), not the raw export", () => {
    // Desktop sends Intl.DateTimeFormat().resolvedOptions().timeZone unconditionally — never the shell's
    // raw value. Node resolves US/Eastern -> America/New_York, so forwarding the raw string would diverge.
    process.env.TZ = "US/Eastern";
    const tz = runtimeAuthEnv().TZ;
    expect(tz).toBe("America/New_York"); // the resolved IANA zone, NOT the raw "US/Eastern"
    expect(tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
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
