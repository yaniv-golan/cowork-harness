import { describe, it, expect, vi, afterEach } from "vitest";
import { noteRunsLocation } from "../src/run/trace-view.js";

// F5: --demo passes suppress:true so the "runs →" header is hidden while runs stay in the durable
// default (no temp redirect → scaffold/trace still resolve the run later).

const spyStderr = () => {
  const calls: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
    calls.push(String(c));
    return true;
  });
  return calls;
};

const withoutRunsEnv = (fn: () => void) => {
  const prev = process.env.COWORK_HARNESS_RUNS_DIR;
  delete process.env.COWORK_HARNESS_RUNS_DIR; // the header only prints when no override is set
  try {
    fn();
  } finally {
    if (prev !== undefined) process.env.COWORK_HARNESS_RUNS_DIR = prev;
  }
};

afterEach(() => vi.restoreAllMocks());

describe("F5 — noteRunsLocation suppress", () => {
  it("prints the runs→ header by default (no override, not json/quiet)", () => {
    withoutRunsEnv(() => {
      const calls = spyStderr();
      noteRunsLocation({ json: false, quiet: false });
      expect(calls.join("")).toMatch(/runs →/);
    });
  });

  it("suppresses the header under suppress:true (--demo) — runs dir is unchanged", () => {
    withoutRunsEnv(() => {
      const calls = spyStderr();
      noteRunsLocation({ json: false, quiet: false, suppress: true });
      expect(calls.join("")).not.toMatch(/runs →/);
    });
  });

  it("still suppressed under json or quiet (unchanged)", () => {
    withoutRunsEnv(() => {
      const calls = spyStderr();
      noteRunsLocation({ json: true, quiet: false });
      noteRunsLocation({ json: false, quiet: true });
      expect(calls.join("")).toBe("");
    });
  });
});
