import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runsWriteRoot } from "../src/run/trace-view.js";

describe("runsWriteRoot — writers honor COWORK_HARNESS_RUNS_DIR (no write/read root drift)", () => {
  it("uses the env override when set, else cwd-relative runs/", () => {
    const prev = process.env.COWORK_HARNESS_RUNS_DIR;
    try {
      process.env.COWORK_HARNESS_RUNS_DIR = "/tmp/custom-runs";
      expect(runsWriteRoot()).toBe("/tmp/custom-runs");
      delete process.env.COWORK_HARNESS_RUNS_DIR;
      expect(runsWriteRoot()).toBe(join(process.cwd(), "runs"));
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev;
    }
  });
});
