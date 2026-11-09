import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBaselineStaleness, resolveBaselineFiles, DEFAULT_FUTURE_SKEW_MS } from "../scripts/check-baseline-staleness.js";

const NOW = Date.parse("2026-07-19T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "baseline-staleness-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseline(name: string, capturedAt: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(capturedAt === undefined ? { note: "no capturedAt" } : { capturedAt }));
  return p;
}

describe("checkBaselineStaleness", () => {
  it("passes for a recent baseline", () => {
    const f = baseline("desktop-1.0.0.json", daysAgo(10));
    const r = checkBaselineStaleness([f], { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.newest?.file).toBe(f);
  });

  it("fails when the newest baseline is stale (>90 days)", () => {
    const f = baseline("desktop-1.0.0.json", daysAgo(120));
    const r = checkBaselineStaleness([f], { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/120 days old \(>90\)/);
  });

  it("fails on a NaN / unparseable capturedAt (the `NaN > 90 === false` false-green)", () => {
    const f = baseline("desktop-1.0.0.json", "not-a-date");
    const r = checkBaselineStaleness([f], { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/does not parse to a valid date/);
  });

  it("fails on a missing capturedAt field", () => {
    const f = baseline("desktop-1.0.0.json", undefined);
    const r = checkBaselineStaleness([f], { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/missing or non-string "capturedAt"/);
  });

  it("fails on a future-dated capturedAt (negative age would otherwise be < 90)", () => {
    const f = baseline("desktop-1.0.0.json", daysAhead(10));
    const r = checkBaselineStaleness([f], { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/in the future/);
  });

  it("tolerates a capturedAt within the small clock-skew allowance", () => {
    const f = baseline("desktop-1.0.0.json", new Date(NOW + DEFAULT_FUTURE_SKEW_MS - 1000).toISOString());
    const r = checkBaselineStaleness([f], { now: NOW });
    expect(r.ok).toBe(true);
  });

  it("a corrupt FIRST baseline cannot mask a stale LATER baseline", () => {
    // Iteration order = argument order. Corrupt file first, genuinely stale file second.
    const corrupt = baseline("desktop-0.0.0.json", "garbage");
    const stale = baseline("desktop-1.0.0.json", daysAgo(200));
    const r = checkBaselineStaleness([corrupt, stale], { now: NOW });
    expect(r.ok).toBe(false);
    // Both defects must surface — the corrupt file does not short-circuit the stale check.
    expect(r.errors.join("\n")).toMatch(/does not parse to a valid date/);
    expect(r.errors.join("\n")).toMatch(/200 days old/);
    // And the newest VALID baseline is the stale one, not the corrupt one that iterated first.
    expect(r.newest?.file).toBe(stale);
  });

  it("selects the newest among several valid baselines", () => {
    const old = baseline("desktop-1.0.0.json", daysAgo(80));
    const recent = baseline("desktop-1.1.0.json", daysAgo(5));
    const r = checkBaselineStaleness([old, recent], { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.newest?.file).toBe(recent);
  });

  it("fails when no baseline files are supplied", () => {
    const r = checkBaselineStaleness([], { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/no baseline files found/);
  });

  it("fails on an unreadable / non-existent baseline path", () => {
    const r = checkBaselineStaleness([join(dir, "does-not-exist.json")], { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/could not read\/parse/);
  });
});

describe("resolveBaselineFiles", () => {
  it("expands a directory to its desktop-*.json children only", () => {
    baseline("desktop-1.0.0.json", daysAgo(1));
    baseline("desktop-1.1.0.json", daysAgo(1));
    baseline("README.md", daysAgo(1)); // non-matching, ignored
    const files = resolveBaselineFiles([dir]);
    expect(files.sort()).toEqual([join(dir, "desktop-1.0.0.json"), join(dir, "desktop-1.1.0.json")].sort());
  });

  it("passes through an explicit file path unchanged", () => {
    const f = baseline("desktop-1.0.0.json", daysAgo(1));
    expect(resolveBaselineFiles([f])).toEqual([f]);
  });
});
