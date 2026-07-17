import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
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

describe("hostloop canUseTool gate — request_cowork_directory protected-path refusal (Desktop 1.22209.0)", () => {
  const FOLDER_GRANT_TOOL = "mcp__cowork__request_cowork_directory";
  const DENIAL_MESSAGE =
    "A requested folder can't be granted to this session. Ask the user to connect the folder they want using the folder picker on their device, or pick a different folder.";

  it("denies a grant request targeting a protected directory under home (~/.ssh)", async () => {
    const d = await gate.decide(perm({ tool: FOLDER_GRANT_TOOL, input: { path: "~/.ssh" } }), ctx);
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toBe(DENIAL_MESSAGE);
  });

  it("denies a grant request targeting a file inside a protected directory (~/.ssh/id_rsa)", async () => {
    const d = await gate.decide(perm({ tool: FOLDER_GRANT_TOOL, input: { path: "~/.ssh/id_rsa" } }), ctx);
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toBe(DENIAL_MESSAGE);
  });

  it("denies a grant request targeting a protected dotfile directly (~/.zshrc)", async () => {
    const d = await gate.decide(perm({ tool: FOLDER_GRANT_TOOL, input: { path: "~/.zshrc" } }), ctx);
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toBe(DENIAL_MESSAGE);
  });

  it("denies using an absolute (non-tilde) path form too", async () => {
    const d = await gate.decide(perm({ tool: FOLDER_GRANT_TOOL, input: { path: `${homedir()}/.netrc` } }), ctx);
    expect(permResp(d).behavior).toBe("deny");
    expect(permResp(d).message).toBe(DENIAL_MESSAGE);
  });

  it("abstains for an unprotected folder request (~/Projects/my-app), leaving it to the human-approval flow", async () => {
    const d = await gate.decide(perm({ tool: FOLDER_GRANT_TOOL, input: { path: "~/Projects/my-app" } }), ctx);
    expect(d).toBe(ABSTAIN);
  });

  it("abstains (does not crash) when path is missing — left to the policy chain", async () => {
    const d = await gate.decide(perm({ tool: FOLDER_GRANT_TOOL, input: {} }), ctx);
    expect(d).toBe(ABSTAIN);
  });

  it("does not affect unrelated tools (e.g. Write to an unrelated path is untouched by this check)", async () => {
    const d = await gate.decide(perm({ tool: "Write", input: { file_path: "/some/host/path.txt" } }), ctx);
    // Falls through to the existing Qt path-deny logic (no decisionReason, path present → protected-location wording),
    // NOT the folder-grant denial message — confirms the two checks don't cross-contaminate.
    expect(permResp(d).message).not.toBe(DENIAL_MESSAGE);
  });
});
