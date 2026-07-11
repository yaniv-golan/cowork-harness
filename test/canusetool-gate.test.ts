import { describe, it, expect } from "vitest";
import { makeHostLoopCanUseToolGate, SDK_WORKING_DIR_DENY } from "../src/hostloop/canusetool-gate.js";
import { ABSTAIN } from "../src/decide/decider.js";
import type { Decision, RunContext } from "../src/decide/decider.js";

const gate = makeHostLoopCanUseToolGate();
const ctx: RunContext = { task: "", transcript: () => "", toolLog: () => [], runId: "t" };
const perm = (over: Record<string, unknown>) => ({ id: "r1", kind: "permission", tool: "Write", input: {}, ...over }) as never;

// MODULE-SCOPE so the web_fetch describe (added by the toolAliases task) can reuse it. Every
// non-abstain gate return is a full Decision ({response, by, rationale?}, decider.ts:25-30); the
// permission payload lives INSIDE .response — never a bare {kind, behavior} object.
const permResp = (d: unknown) => {
  const r = (d as Decision).response;
  if (r.kind !== "permission") throw new Error("expected a permission response");
  return r;
};

describe("hostloop canUseTool gate (xe ?? Qt ?? original, composed BEFORE the policy chain)", () => {
  it("xe: /sessions path on a gated file tool → deny with the VM-path message (both keys scanned)", async () => {
    const d = await gate.decide(perm({ input: { path: "/sessions/vm_1/mnt/outputs/x" } }), ctx);
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toContain("is a VM path");
    expect((d as Decision).by).toBe("agent");
  });
  it("xe: exact '/sessions' matches (VM-path wording); '/sessionsfoo' does not match xe, but Qt still denies it (it's a path, per the unconditional Qt semantics below)", async () => {
    expect(permResp(await gate.decide(perm({ input: { file_path: "/sessions" } }), ctx)).behavior).toBe("deny");
    const notXe = permResp(await gate.decide(perm({ input: { file_path: "/sessionsfoo" } }), ctx));
    expect(notXe.behavior).toBe("deny");
    expect(notXe.message).not.toContain("is a VM path"); // xe abstained — this is Qt's generic path deny, not xe's
    expect(notXe.message).toContain("protected location");
  });
  it("Qt: a gated request WITH a path is denied even with NO reason (production keys on the path)", async () => {
    const d = await gate.decide(perm({ input: { file_path: "/etc/passwd" } }), ctx); // no decisionReason at all
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toContain("protected location"); // default wording (reason !== the workingDir constant)
  });
  it("Qt: the workingDir reason SELECTS the connected-folder wording (path still required)", async () => {
    const d = await gate.decide(perm({ input: { file_path: "/etc/passwd" }, decisionReason: SDK_WORKING_DIR_DENY }), ctx);
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toContain("connected folder");
  });
  it("Qt: a gated request with NO path abstains (nothing for Qt to deny — Se/policy runs)", async () => {
    expect(await gate.decide(perm({ input: { command: "noop" } }), ctx)).toBe(ABSTAIN);
  });
  it("abstains on: non-permission kinds, non-gated tools, and gated calls with no path", async () => {
    expect(await gate.decide({ id: "q", kind: "question", questions: [] } as never, ctx)).toBe(ABSTAIN);
    expect(await gate.decide(perm({ tool: "mcp__workspace__bash", input: { command: "ls" } }), ctx)).toBe(ABSTAIN);
    expect(await gate.decide(perm({ input: {} }), ctx)).toBe(ABSTAIN); // gated tool, no path key
  });
});
