import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/assert.js";

function ctx(workRoot: string, prefixes: string[], preRunPaths?: string[], preRunOrigin?: "local-walk" | "remote-unavailable") {
  return {
    transcript: "",
    toolsCalled: new Set<string>(),
    subagentTools: new Set<string>(),
    egress: [],
    result: "success" as const,
    workRoot,
    userVisiblePrefixes: prefixes,
    preRunPaths,
    preRunOrigin,
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
  };
}

describe("no_unexpected_files", () => {
  it("passes when a created file matches the allowlist", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "report.json"), "{}");
    const [r] = evaluate([{ no_unexpected_files: ["outputs/**"] }], ctx(root, ["outputs"], []));
    expect(r.pass).toBe(true);
  });

  it("fails naming a stray created file", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-stray-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "good.json"), "{}");
    writeFileSync(join(root, "outputs", "checklist.json"), "{}");
    const [r] = evaluate([{ no_unexpected_files: ["outputs/good.json"] }], ctx(root, ["outputs"], []));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/checklist\.json/);
  });

  it("ignores a pre-existing file that does not match the allowlist (new-files-only)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-pre-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "input.pdf"), "pdf");
    writeFileSync(join(root, "outputs", "report.json"), "{}");
    const [r] = evaluate([{ no_unexpected_files: ["outputs/report.json"] }], ctx(root, ["outputs"], ["outputs/input.pdf"]));
    expect(r.pass).toBe(true);
  });

  it("fails evidence-unavailable when preRunPaths is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-ev-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    const [r] = evaluate([{ no_unexpected_files: ["outputs/**"] }], ctx(root, ["outputs"], undefined));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/i);
  });

  it("[] allowlist rejects any created file", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-empty-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "x.json"), "{}");
    const [r] = evaluate([{ no_unexpected_files: [] }], ctx(root, ["outputs"], []));
    expect(r.pass).toBe(false);
  });

  it("[] allowlist passes when nothing was created", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-empty-none-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "input.pdf"), "pdf");
    const [r] = evaluate([{ no_unexpected_files: [] }], ctx(root, ["outputs"], ["outputs/input.pdf"]));
    expect(r.pass).toBe(true);
  });

  it("a 0-byte file still counts as created (replay truncated-placeholder shape)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-zerobyte-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "placeholder.bin"), "");
    const [r] = evaluate([{ no_unexpected_files: ["outputs/report.json"] }], ctx(root, ["outputs"], []));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/placeholder\.bin/);
  });

  it("fails evidence-unavailable (never a vacuous pass) when the manifest origin is remote-unavailable", () => {
    // Hand-constructed: no producer emits "remote-unavailable" today (RESERVED for a future cloud run
    // whose filesystem isn't locally observable). Even with an empty allowlist (which would otherwise
    // vacuously pass on an empty preRunPaths baseline), this must fail loud, not pass.
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-remote-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    const [r] = evaluate([{ no_unexpected_files: [] }], ctx(root, ["outputs"], [], "remote-unavailable"));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/i);
    expect(r.message).toMatch(/remote-unavailable/i);
  });
});
