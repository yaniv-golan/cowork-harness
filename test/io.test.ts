import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/io.js";

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
