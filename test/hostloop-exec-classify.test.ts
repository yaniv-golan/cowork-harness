import { describe, it, expect } from "vitest";
import { isExecInfraError, formatExecDuration } from "../src/hostloop/workspace-handler.js";

// Every shape here is the REAL object node:child_process rejects with — verified by executing each case,
// not hand-imagined. A fabricated shape would let these pass while production behavior stayed broken.
describe("isExecInfraError — the container's failure vs the command's own outcome", () => {
  it("does NOT classify a model-requested timeout as infrastructure", () => {
    // promisify(execFile) on a `timeout:` expiry: killed + a NULL code + a signal
    expect(isExecInfraError({ killed: true, code: null, stdout: "partial", stderr: "" })).toBe(false);
  });

  it("still classifies a maxBuffer kill as infrastructure", () => {
    // a maxBuffer error carries a STRING code and no `killed` key at all
    expect(isExecInfraError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: "", stderr: "" })).toBe(true);
  });

  it("still classifies a spawn failure as infrastructure", () => {
    expect(isExecInfraError({ code: "ENOENT" })).toBe(true);
  });

  it("still classifies a dead daemon as infrastructure", () => {
    expect(isExecInfraError({ code: 125, stderr: "Cannot connect to the Docker daemon" })).toBe(true);
  });

  it("still classifies a container-gone daemon error as infrastructure", () => {
    expect(isExecInfraError({ code: 1, stderr: "Error: No such container: abc" })).toBe(true);
  });

  it("leaves an ordinary non-zero exit alone", () => {
    expect(isExecInfraError({ code: 1, stdout: "", stderr: "grep: no match" })).toBe(false);
  });
});

describe("formatExecDuration — matches the agent binary's own formatter", () => {
  it("renders sub-minute budgets as whole seconds", () => {
    expect(formatExecDuration(30000)).toBe("30s");
    expect(formatExecDuration(59999)).toBe("59s");
  });

  it("renders a whole minute without a trailing zero-seconds part", () => {
    expect(formatExecDuration(120000)).toBe("2m");
  });

  it("renders a composite minute-and-second budget", () => {
    expect(formatExecDuration(90000)).toBe("1m 30s");
  });
});
