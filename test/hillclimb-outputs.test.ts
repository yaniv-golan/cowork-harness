// The files a run authored, copied into the flow so a reviewer can see them (eval-hillclimb.md l.200: output
// artifacts on the trace turn that produced them, written under the variant dir, referenced from the flow
// root). The source is the run's agent-writable work dir: a planted link or a `..` path must never pull a
// host file into the committable flow dir.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredOutputs, planOutputCopy, attachmentKind } from "../src/hillclimb/outputs.js";
import type { RunResult } from "../src/types.js";

let work: string;
const put = (rel: string, body: string | Buffer) => {
  mkdirSync(join(work, rel, ".."), { recursive: true });
  writeFileSync(join(work, rel), body);
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "hc-out-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("authoredOutputs", () => {
  it("new files and changed pre-run files are authored; an untouched pre-run file is not", () => {
    put("outputs/new.md", "new");
    put("outputs/changed.md", "after");
    put("outputs/same.md", "same");
    const r = {
      workDir: work,
      artifacts: [
        { path: "outputs/new.md", bytes: 3 },
        { path: "outputs/changed.md", bytes: 5 },
        { path: "outputs/same.md", bytes: 4 },
      ],
      preRunPaths: ["outputs/changed.md", "outputs/same.md"],
      preRunHashes: { "outputs/changed.md": sha("before"), "outputs/same.md": sha("same") },
    } as unknown as RunResult;
    expect(authoredOutputs(r)).toEqual(["outputs/changed.md", "outputs/new.md"]);
  });

  it("no artifacts recorded ⇒ nothing authored", () => {
    expect(authoredOutputs({ workDir: work } as unknown as RunResult)).toEqual([]);
  });
});

describe("planOutputCopy", () => {
  it("copies within the caps and names what it skipped", () => {
    put("outputs/a.md", "a");
    put("outputs/big.bin", Buffer.alloc(3 * 1024 * 1024));
    const plan = planOutputCopy(work, ["outputs/a.md", "outputs/big.bin"], { perFileBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });
    expect(plan.copy.map((c) => c.rel)).toEqual(["outputs/a.md"]);
    expect(plan.copy[0].data.toString()).toBe("a");
    expect(plan.skipped).toEqual([{ rel: "outputs/big.bin", reason: "over the per-file cap" }]);
  });

  it("stops at the total cap", () => {
    put("outputs/1.md", "x".repeat(600));
    put("outputs/2.md", "x".repeat(600));
    const plan = planOutputCopy(work, ["outputs/1.md", "outputs/2.md"], { perFileBytes: 1000, totalBytes: 1000 });
    expect(plan.copy.map((c) => c.rel)).toEqual(["outputs/1.md"]);
    expect(plan.skipped).toEqual([{ rel: "outputs/2.md", reason: "over the total cap" }]);
  });

  it("a planted symlink is never followed into a host file", () => {
    const host = mkdtempSync(join(tmpdir(), "hc-host-"));
    try {
      writeFileSync(join(host, "secret"), "HOST SECRET");
      mkdirSync(join(work, "outputs"), { recursive: true });
      symlinkSync(join(host, "secret"), join(work, "outputs", "x.md"));
      const plan = planOutputCopy(work, ["outputs/x.md"], { perFileBytes: 1e6, totalBytes: 1e7 });
      expect(plan.copy).toEqual([]);
      expect(plan.skipped).toEqual([{ rel: "outputs/x.md", reason: "not a plain file in the work dir" }]);
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it("an absolute, `..` or empty-segment path is refused before anything is read", () => {
    const plan = planOutputCopy(work, ["/etc/passwd", "outputs/../../x", "outputs//y"], { perFileBytes: 1e6, totalBytes: 1e7 });
    expect(plan.copy).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["not a safe relative path", "not a safe relative path", "not a safe relative path"]);
  });
});

describe("attachmentKind (SCHEMA.md Attachment.kind)", () => {
  it("maps by extension, with file as the fallback", () => {
    expect(["a.png", "a.svg", "a.html", "a.pdf", "a.json", "a.md", "a.py", "a.docx"].map(attachmentKind)).toEqual([
      "image",
      "svg",
      "html",
      "pdf",
      "json",
      "text",
      "code",
      "file",
    ]);
  });
});
