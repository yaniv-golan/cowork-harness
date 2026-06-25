import { describe, it, expect } from "vitest";
import { capabilityPreflightWarning, capabilityPreflightDecision } from "../src/runtime/image-capabilities.js";

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

describe("capabilityPreflightDecision — fail fast unless explicitly opted out", () => {
  it("ABORTS on a definite gap when allow_missing_capability is NOT asserted", () => {
    const d = capabilityPreflightDecision(["ocr"], ["ocr"], false);
    expect(d.abort).toBe(true);
    expect(d.message).toContain("ocr");
  });

  it("does NOT abort (warns + proceeds) when allow_missing_capability IS asserted", () => {
    const d = capabilityPreflightDecision(["ocr"], ["ocr"], true);
    expect(d.abort).toBe(false);
    expect(d.message).toContain("ocr"); // still surfaces the gap as a notice
  });

  it("does NOT abort when there is no gap or the probe was indefinite", () => {
    expect(capabilityPreflightDecision(["ocr"], ["pdf_tables"], false)).toEqual({ abort: false, message: null });
    expect(capabilityPreflightDecision(["ocr"], null, false)).toEqual({ abort: false, message: null });
    expect(capabilityPreflightDecision([], ["ocr"], false)).toEqual({ abort: false, message: null });
  });
});
