import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCliCompleteStructured, resetIsolationPreflight } from "../src/decide/llm-transport.js";
import { PAIRWISE_JSON_SCHEMA, candidateFirst, makePairwiseJudge } from "../src/decide/pairwise-judge.js";

// The pairwise judge's transport, driven through a FAKE `claude` that replays a REAL envelope captured once from
// `claude -p --json-schema` (test/fixtures/pairwise-judge/README.md). Never a fabricated envelope shape.
const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
const REAL = JSON.parse(readFileSync(FIXTURE, "utf8"));

const FAKE = `#!/bin/sh
# The isolation preflight probes --help / --version first: answer as a current CLI.
if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>" "--effort <level>" "--settings <s>"; do
    echo "  $f   x"
  done
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_ARGV_FILE"
cat > "$FAKE_STDIN_FILE"
cat "$FAKE_ENVELOPE"
exit 0
`;

let dir: string;
let prevForbid: string | undefined;
let prevConfigDir: string | undefined;
beforeAll(() => {
  prevForbid = process.env.COWORK_HARNESS_FORBID_SPAWN;
  process.env.COWORK_HARNESS_FORBID_SPAWN = "0"; // every spawn here is the fake bin
  dir = mkdtempSync(join(tmpdir(), "pairwise-transport-"));
  writeFileSync(join(dir, "fake-claude.sh"), FAKE, { mode: 0o755 });
  // The user-settings check reads CLAUDE_CONFIG_DIR: point it at the empty temp dir, never this machine's config.
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.COWORK_HARNESS_CLAUDE_BIN = join(dir, "fake-claude.sh");
  process.env.FAKE_ARGV_FILE = join(dir, "argv");
  process.env.FAKE_STDIN_FILE = join(dir, "stdin");
  process.env.FAKE_ENVELOPE = FIXTURE;
  // The enterprise-MCP check looks at a path that never exists, so the argv below does not depend on this machine.
  resetIsolationPreflight(join(dir, "no-managed-mcp.json"));
});
afterEach(() => {
  process.env.FAKE_ENVELOPE = FIXTURE;
});
afterAll(() => {
  if (prevForbid === undefined) delete process.env.COWORK_HARNESS_FORBID_SPAWN;
  else process.env.COWORK_HARNESS_FORBID_SPAWN = prevForbid;
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  for (const k of ["COWORK_HARNESS_CLAUDE_BIN", "FAKE_ARGV_FILE", "FAKE_STDIN_FILE", "FAKE_ENVELOPE"]) delete process.env[k];
  resetIsolationPreflight();
  rmSync(dir, { recursive: true, force: true });
});

const envelope = (over: Record<string, unknown>): string => {
  const p = join(dir, `env-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ ...REAL, ...over }));
  return p;
};

describe("claudeCliCompleteStructured (real envelope shape)", () => {
  it("returns the envelope's structured_output, subtype and resolved model — not the prose result", async () => {
    const r = await claudeCliCompleteStructured({
      system: "SYS",
      user: "USER PROMPT",
      schema: PAIRWISE_JSON_SCHEMA,
      model: "claude-haiku-4-5",
    });
    expect(r.structured).toEqual(REAL.structured_output);
    expect(r.subtype).toBe("success");
    expect(r.model).toBe("claude-haiku-4-5");
    expect((r.usage as Record<string, { costUSD: number }>)["claude-haiku-4-5"].costUSD).toBeCloseTo(REAL.total_cost_usd);
  });

  it("sends the schema and the system prompt, runs isolated with NO tools; the documents travel on stdin only", async () => {
    await claudeCliCompleteStructured({ system: "SYS PROMPT", user: "SECRET-ISH DOCUMENT", schema: PAIRWISE_JSON_SCHEMA, model: "m" });
    const argv = readFileSync(join(dir, "argv"), "utf8").split("\n").slice(0, -1);
    // The whole argv: the structured flags first, then the isolation flags, with the variadic --tools "" last.
    expect(argv).toEqual([
      "-p",
      "--model",
      "m",
      "--effort",
      "high",
      "--output-format",
      "json",
      "--settings",
      JSON.stringify({
        env: {
          CLAUDE_CODE_EFFORT_LEVEL: "",
          CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "",
          CLAUDE_CODE_DISABLE_THINKING: "",
          CLAUDE_CODE_SIMPLE: "",
        },
      }),
      "--json-schema",
      JSON.stringify(PAIRWISE_JSON_SCHEMA),
      "--system-prompt",
      "SYS PROMPT",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--setting-sources",
      "user",
      "--tools",
      "",
    ]);
    expect(argv.join("\n")).not.toContain("SECRET-ISH DOCUMENT");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("SECRET-ISH DOCUMENT");
  });

  it("an envelope with no structured_output yields structured: undefined (the judge then treats it as invalid)", async () => {
    process.env.FAKE_ENVELOPE = envelope({ structured_output: undefined });
    const r = await claudeCliCompleteStructured({ system: "s", user: "u", schema: PAIRWISE_JSON_SCHEMA, model: "m" });
    expect(r.structured).toBeUndefined();
  });

  it("a structured-output retry failure resolves with its subtype even without a result string", async () => {
    process.env.FAKE_ENVELOPE = envelope({
      subtype: "error_max_structured_output_retries",
      is_error: true,
      result: undefined,
      structured_output: undefined,
    });
    const r = await claudeCliCompleteStructured({ system: "s", user: "u", schema: PAIRWISE_JSON_SCHEMA, model: "m" });
    expect(r.subtype).toBe("error_max_structured_output_retries");
  });
});

describe("the judge over the real transport", () => {
  it("maps the captured verdict through the seeded order and records the real spend", async () => {
    const judge = makePairwiseJudge({ model: "claude-haiku-4-5", complete: claudeCliCompleteStructured });
    const r = await judge({ task: "t", candidate: "C", reference: "R", sessionId: "s1", assertIndex: 0, refName: "baseline" });
    // The fixture's verdict is "A": a win exactly when the candidate was put first.
    expect(r.outcome).toBe(candidateFirst("s1", 0, "baseline") ? "win" : "loss");
    expect(r.costUsd).toBeCloseTo(REAL.total_cost_usd);
    expect(r.usage?.cache_creation_input_tokens).toBe(REAL.usage.cache_creation_input_tokens);
  });
});
