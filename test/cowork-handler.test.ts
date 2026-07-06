import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCoworkHandler } from "../src/hostloop/cowork-handler.js";

// Token-free, filesystem-only coverage for the `cowork` sdk-MCP server: present_files scratchpad
// promotion, collision-safe naming, blocked-extension rejection, mnt/ passthrough, the whole-call
// pre-check for unmappable paths, and the C1 path-traversal/symlink containment guard.

const SESSION_ROOT_VM = "/sessions/abc";

function makeSessionTree() {
  const root = mkdtempSync(join(tmpdir(), "cowork-handler-"));
  const sessionHostDir = join(root, "session");
  const outputsHostDir = join(sessionHostDir, "mnt", "outputs");
  mkdirSync(outputsHostDir, { recursive: true });
  return { root, sessionHostDir, outputsHostDir };
}

type ToolsCallResult = {
  result?: { content: { type: string; text: string }[] };
  notify?: string;
  error?: { code: number; message: string };
};

async function callPresentFiles(h: ReturnType<typeof makeCoworkHandler>, filePaths: string[]): Promise<ToolsCallResult> {
  return (await h("cowork", {
    method: "tools/call",
    params: { name: "present_files", arguments: { files: filePaths.map((file_path) => ({ file_path })) } },
  })) as ToolsCallResult;
}

describe("makeCoworkHandler", () => {
  it("tools/list exposes present_files with anthropic/alwaysLoad", async () => {
    const { sessionHostDir, outputsHostDir } = makeSessionTree();
    const h = makeCoworkHandler({ sessionRootVm: SESSION_ROOT_VM, sessionHostDir, outputsHostDir });
    const out: any = await h("cowork", { method: "tools/list" });
    const tool = out.result.tools.find((t: any) => t.name === "present_files");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["files"]);
    expect(tool._meta["anthropic/alwaysLoad"]).toBe(true);
  });

  it("promotes a scratchpad file into outputs and reports promoted:true", async () => {
    const { sessionHostDir, outputsHostDir } = makeSessionTree();
    writeFileSync(join(sessionHostDir, "deliverable.md"), "hello");
    const events: any[] = [];
    const h = makeCoworkHandler({
      sessionRootVm: SESSION_ROOT_VM,
      sessionHostDir,
      outputsHostDir,
      onPresent: (p) => events.push(p),
    });
    const vmPath = `${SESSION_ROOT_VM}/deliverable.md`;
    const expectedVmOut = `${SESSION_ROOT_VM}/mnt/outputs/deliverable.md`;
    const out = await callPresentFiles(h, [vmPath]);

    expect(out.result?.content).toEqual([{ type: "text", text: expectedVmOut }]);
    expect(readFileSync(join(outputsHostDir, "deliverable.md"), "utf8")).toBe("hello");
    expect(events).toEqual([{ from: vmPath, to: expectedVmOut, promoted: true }]);
    expect(out.notify).toMatch(/was in the scratchpad.*copied to.*mnt\/outputs\/deliverable\.md/s);
  });

  it("collision-safe naming appends -1, -2 before the extension", async () => {
    const { sessionHostDir, outputsHostDir } = makeSessionTree();
    mkdirSync(join(sessionHostDir, "sub"));
    writeFileSync(join(sessionHostDir, "deliverable.md"), "AAA");
    writeFileSync(join(sessionHostDir, "sub", "deliverable.md"), "BBB");
    const h = makeCoworkHandler({ sessionRootVm: SESSION_ROOT_VM, sessionHostDir, outputsHostDir });

    const first = await callPresentFiles(h, [`${SESSION_ROOT_VM}/deliverable.md`]);
    expect(first.result?.content[0].text).toBe(`${SESSION_ROOT_VM}/mnt/outputs/deliverable.md`);

    const second = await callPresentFiles(h, [`${SESSION_ROOT_VM}/sub/deliverable.md`]);
    expect(second.result?.content[0].text).toBe(`${SESSION_ROOT_VM}/mnt/outputs/deliverable-1.md`);

    expect(readFileSync(join(outputsHostDir, "deliverable.md"), "utf8")).toBe("AAA");
    expect(readFileSync(join(outputsHostDir, "deliverable-1.md"), "utf8")).toBe("BBB");
  });

  it("blocked extension (.sh) is rejected: not copied, result text is the original path", async () => {
    const { sessionHostDir, outputsHostDir } = makeSessionTree();
    writeFileSync(join(sessionHostDir, "evil.sh"), "#!/bin/sh\necho pwned\n");
    const events: any[] = [];
    const h = makeCoworkHandler({
      sessionRootVm: SESSION_ROOT_VM,
      sessionHostDir,
      outputsHostDir,
      onPresent: (p) => events.push(p),
    });
    const vmPath = `${SESSION_ROOT_VM}/evil.sh`;
    const out = await callPresentFiles(h, [vmPath]);

    expect(out.result?.content).toEqual([{ type: "text", text: vmPath }]);
    expect(existsSync(join(outputsHostDir, "evil.sh"))).toBe(false);
    expect(events).toEqual([{ from: vmPath, to: vmPath, promoted: false, error: expect.any(String) }]);
    expect(out.notify).toMatch(/could not be copied.*remains in the scratchpad/s);
  });

  it("a path already under mnt/ is a passthrough: no copy, promoted:false, no notify", async () => {
    const { sessionHostDir, outputsHostDir } = makeSessionTree();
    const events: any[] = [];
    const h = makeCoworkHandler({
      sessionRootVm: SESSION_ROOT_VM,
      sessionHostDir,
      outputsHostDir,
      onPresent: (p) => events.push(p),
    });
    const vmPath = `${SESSION_ROOT_VM}/mnt/outputs/already-there.txt`;
    const out = await callPresentFiles(h, [vmPath]);

    expect(out.result?.content).toEqual([{ type: "text", text: vmPath }]);
    expect(readdirSync(outputsHostDir)).toEqual([]);
    expect(events).toEqual([{ from: vmPath, to: vmPath, promoted: false }]);
    expect(out.notify).toBeUndefined();
  });

  it("an unmappable path (outside session AND outside mnt/) aborts the whole call with an error", async () => {
    const { sessionHostDir, outputsHostDir } = makeSessionTree();
    const h = makeCoworkHandler({ sessionRootVm: SESSION_ROOT_VM, sessionHostDir, outputsHostDir });
    const out = await callPresentFiles(h, ["/etc/passwd"]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.error?.message).toContain("/etc/passwd");
    expect(readdirSync(outputsHostDir)).toEqual([]); // nothing copied
  });

  it("C1: a scratchpad path that escapes the session root via '..' is rejected, nothing copied", async () => {
    const { root, sessionHostDir, outputsHostDir } = makeSessionTree();
    // secret.txt sits OUTSIDE sessionHostDir (a sibling), reachable via a single ".." from the mapped
    // host path — the classic path-traversal target this guard must catch.
    writeFileSync(join(root, "secret.txt"), "TOP SECRET");
    const events: any[] = [];
    const h = makeCoworkHandler({
      sessionRootVm: SESSION_ROOT_VM,
      sessionHostDir,
      outputsHostDir,
      onPresent: (p) => events.push(p),
    });
    const vmPath = `${SESSION_ROOT_VM}/../secret.txt`;
    const out = await callPresentFiles(h, [vmPath]);

    // Rejected via the copy-failure branch (not a crash, not a silent skip).
    expect(out.result?.content).toEqual([{ type: "text", text: vmPath }]);
    expect(events).toEqual([{ from: vmPath, to: vmPath, promoted: false, error: expect.any(String) }]);
    // Nothing escaped into outputs, and the secret was never read into the outputs tree.
    expect(readdirSync(outputsHostDir)).toEqual([]);
  });

  it("C1: a symlinked scratchpad source pointing outside the tree is rejected, nothing copied", async () => {
    const { root, sessionHostDir, outputsHostDir } = makeSessionTree();
    writeFileSync(join(root, "outside-target.txt"), "OUTSIDE CONTENT");
    symlinkSync(join(root, "outside-target.txt"), join(sessionHostDir, "link-out.txt"));
    const events: any[] = [];
    const h = makeCoworkHandler({
      sessionRootVm: SESSION_ROOT_VM,
      sessionHostDir,
      outputsHostDir,
      onPresent: (p) => events.push(p),
    });
    const vmPath = `${SESSION_ROOT_VM}/link-out.txt`;
    const out = await callPresentFiles(h, [vmPath]);

    expect(out.result?.content).toEqual([{ type: "text", text: vmPath }]);
    expect(events).toEqual([{ from: vmPath, to: vmPath, promoted: false, error: expect.any(String) }]);
    expect(readdirSync(outputsHostDir)).toEqual([]);
  });
});
