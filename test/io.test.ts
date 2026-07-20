import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../src/io.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cwh-io-"));

describe("writeJsonAtomic", () => {
  it("writes valid JSON readable back at the target path", () => {
    const dir = tmp();
    const path = join(dir, "status.json");
    writeJsonAtomic(path, { a: 1, b: "two" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1, b: "two" });
  });

  it("leaves no stray temp file behind after a successful write", () => {
    const dir = tmp();
    writeJsonAtomic(join(dir, "status.json"), { ok: true });
    expect(readdirSync(dir)).toEqual(["status.json"]);
  });

  it("overwrites an existing file atomically (no partial-write window observable)", () => {
    const dir = tmp();
    const path = join(dir, "status.json");
    writeJsonAtomic(path, { n: 1 });
    writeJsonAtomic(path, { n: 2 });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ n: 2 });
  });
});

describe("writeTextAtomic", () => {
  it("writes the exact pre-serialized string readable back at the target path", () => {
    const dir = tmp();
    const path = join(dir, "result.json");
    const text = JSON.stringify({ a: 1, b: "two" }, null, 2);
    writeTextAtomic(path, text);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("leaves no stray temp file behind after a successful write", () => {
    const dir = tmp();
    writeTextAtomic(join(dir, "result.json"), "{}");
    expect(readdirSync(dir)).toEqual(["result.json"]);
  });

  it("overwrites an existing file atomically (no partial-write window observable)", () => {
    const dir = tmp();
    const path = join(dir, "result.json");
    writeTextAtomic(path, '{"n":1}');
    writeTextAtomic(path, '{"n":2}');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"n":2}');
  });

  it("does not require the input to be valid JSON (scrubbed strings are opaque text)", () => {
    const dir = tmp();
    const path = join(dir, "note.txt");
    writeTextAtomic(path, "not json at all");
    expect(readFileSync(path, "utf8")).toBe("not json at all");
  });
});
