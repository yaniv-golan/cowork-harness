import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { cliCapabilitiesOfBuffer, cliCapabilitiesOfFile, loadBaseline } from "../src/baseline.js";
import { PlatformBaseline as PlatformBaselineSchema } from "../src/types.js";
import { hostCliSupportsPermissionPrompts, resetHostCliProbeCache } from "../src/runtime/host-cli-probe.js";

// The extractor's oracle is the Commander option DECLARATION (`--permission-prompts <target>`) plus the `none`
// handling text (`--permission-prompts none`), never a bare `--permission-prompts` substring: that also matches the
// argv pass-through tables and is a prefix of nothing useful, while `fewer-permission-prompts` (a skill name) sits
// beside it in the same binary.
describe("cliCapabilitiesOfBuffer — the permissionPrompts extractor", () => {
  const decl = "addOption(new rs(\"--permission-prompts <target>\",'Who answers permission prompts'))";
  const noneText = "t(`--permission-prompts none: permission prompts are answered with a local deny`)";

  it("is true when both the option declaration and the none-mode text are present", () => {
    expect(cliCapabilitiesOfBuffer(Buffer.from(`xx${decl}yy${noneText}zz`))).toEqual({ permissionPrompts: true });
  });

  // SYNTHETIC negatives: every backed-up agent carries the flag, so no real binary can show the false path.
  it("SYNTHETIC: is false when the binary has no such option", () => {
    expect(cliCapabilitiesOfBuffer(Buffer.from("nothing to see here"))).toEqual({ permissionPrompts: false });
  });

  it("SYNTHETIC: is false on a bare flag name with no declaration (an argv pass-through table)", () => {
    expect(cliCapabilitiesOfBuffer(Buffer.from('["--permission-prompt-tool","--permission-prompts","--tools"]'))).toEqual({
      permissionPrompts: false,
    });
  });

  it("SYNTHETIC: is false when the option is declared but has no `none` mode", () => {
    expect(cliCapabilitiesOfBuffer(Buffer.from(decl))).toEqual({ permissionPrompts: false });
  });

  it("SYNTHETIC: is false on the unrelated skill name alone", () => {
    expect(cliCapabilitiesOfBuffer(Buffer.from('name:"fewer-permission-prompts"'))).toEqual({ permissionPrompts: false });
  });
});

// The golden over REAL binaries. Local only: the backed-up ELFs and the staged agent live on the operator's machine,
// never in CI. Every one measured so far is positive (2.1.260–2.1.289), so this golden has no negative sample; the
// synthetic cases above carry the false path.
describe("cliCapabilitiesOfFile — golden over the backed-up agent ELFs (local only)", () => {
  const backupRoot = join(homedir(), "cowork-agent-backup", "vm-elf");
  const elfs = existsSync(backupRoot)
    ? readdirSync(backupRoot)
        .map((v) => join(backupRoot, v, "claude"))
        .filter((p) => existsSync(p))
    : [];
  it.skipIf(elfs.length === 0)("reports permissionPrompts: true for every backed-up ELF", () => {
    for (const p of elfs) expect(cliCapabilitiesOfFile(p), p).toEqual({ permissionPrompts: true });
  });

  it("the committed 2.26454.0 baseline records the capability", () => {
    expect(loadBaseline("desktop-2.26454.0").agentBinary?.cliCapabilities).toEqual({ permissionPrompts: true });
  });

  const b = loadBaseline("desktop-2.26454.0");
  const staged = (b.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
  it.skipIf(!staged || !existsSync(staged))("the committed 2.26454.0 value matches a re-measure of the staged ELF", () => {
    expect(cliCapabilitiesOfFile(staged)).toEqual(b.agentBinary?.cliCapabilities);
  });
});

describe("agentBinary.cliCapabilities schema", () => {
  it("round-trips through the schema (not stripped by the inner z.object)", () => {
    const base = loadBaseline("desktop-1.24012.1") as unknown as Record<string, unknown>;
    const reparsed = PlatformBaselineSchema.parse({
      ...base,
      agentBinary: { ...(base.agentBinary as object), cliCapabilities: { permissionPrompts: false } },
    });
    expect(reparsed.agentBinary?.cliCapabilities).toEqual({ permissionPrompts: false });
  });

  it("is absent on a baseline synced before the field existed (absent = unknown, never true)", () => {
    expect(loadBaseline("desktop-1.24012.1").agentBinary?.cliCapabilities).toBeUndefined();
  });
});

// Protocol spawns the HOST `claude` found on the run env's PATH, not the pinned ELF, so it is probed with `--help`.
describe("hostCliSupportsPermissionPrompts — the protocol-tier probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "host-cli-probe-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, help: string): string => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    const p = join(d, "claude");
    // `echo` is a shell builtin: the probe runs with PATH set to this dir alone, so no external `cat`.
    writeFileSync(p, `#!/bin/sh\n[ "$1" = "--help" ] && echo '${help}'\nexit 0\n`);
    chmodSync(p, 0o755);
    return d;
  };

  it.skipIf(process.platform === "win32")("is true when --help lists the option with its none mode", () => {
    resetHostCliProbeCache();
    const d = fake("yes", '  --permission-prompts <target>  Who answers permission prompts with --print: "host" or "none"');
    expect(hostCliSupportsPermissionPrompts({ PATH: d })).toEqual({ supported: true, path: join(d, "claude") });
  });

  it.skipIf(process.platform === "win32")("is false when --help does not list it", () => {
    resetHostCliProbeCache();
    const d = fake("no", "  --permission-prompt-tool <tool>  MCP tool to use for permission prompts");
    expect(hostCliSupportsPermissionPrompts({ PATH: d })).toEqual({ supported: false, path: join(d, "claude") });
  });

  it("is false with no path when `claude` is not on the run env's PATH", () => {
    resetHostCliProbeCache();
    expect(hostCliSupportsPermissionPrompts({ PATH: join(dir, "empty") })).toEqual({ supported: false, path: undefined });
  });
});
