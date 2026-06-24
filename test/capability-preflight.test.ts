import { describe, it, expect } from "vitest";
import { capabilityPreflightWarning } from "../src/runtime/image-capabilities.js";

describe("capabilityPreflightWarning — warn before a paid run, not after", () => {
  it("returns a build remedy when a declared capability is omitted by the image", () => {
    const w = capabilityPreflightWarning(["ocr"], ["ocr", "pdf_tables"]);
    expect(w).toBeTruthy();
    expect(w).toContain("ocr");
    expect(w).toContain("COWORK_FULL_PARITY");
  });

  it("returns null when every declared capability is present", () => {
    expect(capabilityPreflightWarning(["ocr"], ["pdf_tables"])).toBeNull();
    expect(capabilityPreflightWarning(["ocr"], [])).toBeNull();
  });

  it("returns null when nothing is declared, or the probe could not run (omitted=null)", () => {
    expect(capabilityPreflightWarning([], ["ocr"])).toBeNull();
    expect(capabilityPreflightWarning(["ocr"], null)).toBeNull();
  });
});
