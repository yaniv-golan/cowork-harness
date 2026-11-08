import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as transport from "../src/decide/llm-transport.js";
import {
  claudeCliComplete,
  claudeCliCompleteDecider,
  claudeCliCompleteEvaluator,
  claudeCliCompleteStructured,
  graderSpawnEnv,
  resetIsolationPreflight,
  transportIdentity,
} from "../src/decide/llm-transport.js";
import { makeSemanticJudge } from "../src/decide/semantic-judge.js";
import { makePairwiseJudge, PAIRWISE_JSON_SCHEMA } from "../src/decide/pairwise-judge.js";
import { evaluate, runSemanticJudges, type AssertContext } from "../src/assert.js";
import { candidateDocument, pairwiseComposeKey, runPairwiseJudges } from "../src/run/pairwise-prepass.js";
import { freezeRef } from "../src/refs/store.js";
import { createHash } from "node:crypto";
import type { Assertion } from "../src/types.js";
import { runJudgeCheck } from "../src/run/judge-check.js";
import { buildRunsLine } from "../src/eval/runs.js";
import { graderCredentialCheck } from "../src/run/doctor.js";

// A judge API failure (here a 401 from an invalid ANTHROPIC_API_KEY) must reach the result as a FAILED CALL, not
// as a malformed grade, and must not be retried. Every case below runs the real transport (spawnOnce →
// completeViaCli → the judge → the pre-pass) against a fake `claude` that prints a REAL captured envelope and
// exits with the real exit code (test/fixtures/judge-call-error/README.md). No test throws a fabricated error.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_401 = resolve(HERE, "fixtures", "judge-call-error", "claude-p-401-api-key.json");
const REAL_401 = JSON.parse(readFileSync(FIX_401, "utf8"));
const FIX_404 = resolve(HERE, "fixtures", "judge-call-error", "claude-p-404-unknown-model.json");
const REAL_404 = JSON.parse(readFileSync(FIX_404, "utf8"));
const FIX_OK = resolve(HERE, "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
const REAL_OK = JSON.parse(readFileSync(FIX_OK, "utf8"));

const FAKE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.319 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>" "--effort <level>" "--settings <s>"; do
    echo "  $f   x"
  done
  exit 0
fi
echo call >> "$FAKE_CALLS"
env > "$FAKE_ENV_DUMP"
cat > /dev/null
cat "$FAKE_ENVELOPE"
exit "\${FAKE_EXIT:-0}"
`;

let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = [
  "COWORK_HARNESS_FORBID_SPAWN",
  "CLAUDE_CONFIG_DIR",
  "COWORK_HARNESS_CLAUDE_BIN",
  "COWORK_HARNESS_LLM_RETRIES",
  "COWORK_HARNESS_GRADER_AUTH",
  "FAKE_CALLS",
  "FAKE_ENV_DUMP",
  "FAKE_ENVELOPE",
  "FAKE_EXIT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
];
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = realpathSync(mkdtempSync(join(tmpdir(), "judge-call-error-")));
  writeFileSync(join(dir, "fake-claude.sh"), FAKE, { mode: 0o755 });
  process.env.COWORK_HARNESS_FORBID_SPAWN = "0";
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.COWORK_HARNESS_CLAUDE_BIN = join(dir, "fake-claude.sh");
  process.env.FAKE_CALLS = join(dir, "calls");
  process.env.FAKE_ENV_DUMP = join(dir, "env");
  resetIsolationPreflight(join(dir, "no-managed-mcp.json"));
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetIsolationPreflight();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(dir, "calls"), { force: true });
  rmSync(join(dir, "env"), { force: true });
  delete process.env.COWORK_HARNESS_LLM_RETRIES; // the default (2), as a real run has it
  delete process.env.COWORK_HARNESS_GRADER_AUTH;
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"])
    delete process.env[k];
  serve(REAL_401, 1);
});

/** Serve `envelope` (with `over` merged in) from the fake CLI, exiting `code`. */
function serve(envelope: Record<string, unknown>, code: number, over: Record<string, unknown> = {}): void {
  const p = join(dir, `env-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ ...envelope, ...over }));
  process.env.FAKE_ENVELOPE = p;
  process.env.FAKE_EXIT = String(code);
}
const calls = (): number =>
  existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean).length : 0;
const spawnedEnv = (): string => readFileSync(join(dir, "env"), "utf8");

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "the answer",
    finalMessage: "the answer",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/x",
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    authoredFiles: [],
    authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [] } as never,
    ...over,
  };
}
const sem: Assertion = { semantic_matches: { rubric: ["the answer is given"] } };
const quiet = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

describe("transport: an API error envelope (real 401 frame, exit 1)", () => {
  it("is one spawn, not three, and carries the status, origin and message", async () => {
    const q = quiet();
    let err: (Error & { status?: number; origin?: string; apiMessage?: string; retryable?: boolean }) | undefined;
    try {
      await claudeCliComplete("p", "claude-opus-4-8");
    } catch (e) {
      err = e as typeof err;
    } finally {
      q.mockRestore();
    }
    expect(err).toBeDefined();
    expect(calls()).toBe(1);
    expect(err!.status).toBe(401);
    expect(err!.origin).toBe("first_party");
    expect(err!.apiMessage).toContain("Invalid API key");
    expect(err!.retryable).toBe(false);
    expect(err!.name).toBe("ApiExitError");
  });

  it("the same frame at exit 0 is an API error, not an unparseable envelope", async () => {
    serve(REAL_401, 0);
    const q = quiet();
    const err = await claudeCliComplete("p", "claude-opus-4-8").catch((e: Error) => e);
    q.mockRestore();
    expect((err as { status?: number }).status).toBe(401);
    expect((err as Error).message).not.toContain("unparseable envelope");
  });

  it("a successful reply that also records an API status is a grade, not a failed call (exit 0 needs is_error)", async () => {
    // The real success envelope with a status edited in, as if the CLI had got past an error on its own.
    serve(REAL_OK, 0, { api_error_status: 529 });
    const q = quiet();
    try {
      const r = await claudeCliCompleteStructured({ system: "s", user: "u", schema: PAIRWISE_JSON_SCHEMA, model: "claude-haiku-4-5" });
      expect(r).toBeDefined();
    } finally {
      q.mockRestore();
    }
    expect(calls()).toBe(1);
  });

  it("a spent usage quota is an API error with its status, not retried, and its message names no CLI path", async () => {
    // The real 401 frame with the quota's status and text edited in.
    serve(REAL_401, 1, { api_error_status: 429, result: "You've hit your session limit · resets 4pm" });
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-opus-4-8" }));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([sem], c);
    expect(calls()).toBe(1);
    expect((r as { judgeError?: unknown }).judgeError).toMatchObject({ kind: "call", status: 429, retryable: false });
    expect(JSON.stringify(r)).not.toContain(dir); // the fake CLI's path
  });

  it("a failed call with no API status records the CLI by its basename, never its absolute path", async () => {
    // Not an envelope: the CLI died before it could write one.
    const p = join(dir, "not-json.txt");
    writeFileSync(p, "segfault\n");
    process.env.FAKE_ENVELOPE = p;
    process.env.FAKE_EXIT = "1";
    process.env.COWORK_HARNESS_LLM_RETRIES = "0";
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-opus-4-8" }));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([sem], c);
    const je = (r as { judgeError?: { status?: number; message: string } }).judgeError!;
    expect(je.status).toBeUndefined();
    expect(je.message).toContain("fake-claude.sh -p) exited 1");
    expect(JSON.stringify(r)).not.toContain(dir);
  });

  it("a transient status (529, the real frame with its status edited) is still retried", async () => {
    serve(REAL_401, 1, { api_error_status: 529, result: "Overloaded" });
    const q = quiet();
    const err = await claudeCliComplete("p", "claude-opus-4-8").catch((e: Error) => e);
    q.mockRestore();
    expect(calls()).toBe(3); // 1 + COWORK_HARNESS_LLM_RETRIES (default 2), at the transport level
    expect((err as { status?: number }).status).toBe(529);
    expect((err as { retryable?: boolean }).retryable).toBe(true);
  });
});

describe("semantic_matches: a judge call failure is reported as one", () => {
  it("one spawn; the check names the API status and message; judgeError is set; still judgeInvalid", async () => {
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-opus-4-8" }));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([sem], c);
    expect(calls()).toBe(1);
    expect(r!.pass).toBe(false);
    expect(r!.judgeInvalid).toBe(true);
    expect(r!.message).toContain("judge call FAILED (API 401");
    expect(r!.message).toContain("Invalid API key");
    expect(r!.message).not.toContain("malformed");
    // A 401 carries the credential hint; no credential variable is set here, so the judge used the claude login.
    expect(r!.message).toContain("The judge used your claude login");
    expect(r!.message).toContain("cowork-harness doctor");
    expect((r as { judgeError?: unknown }).judgeError).toMatchObject({
      kind: "call",
      status: 401,
      origin: "first_party",
      retryable: false,
    });
    expect(r!.judgeAttempts).toBe(1);
  });

  it("the 401 hint names the credential the judge was given and the one it was not, never a value", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-SECRET-value-1";
    process.env.ANTHROPIC_API_KEY = "key-SECRET-value-2";
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-opus-4-8" }));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([sem], c);
    expect(r!.message).toContain("The judge used CLAUDE_CODE_OAUTH_TOKEN; also set but not passed: ANTHROPIC_API_KEY");
    expect(r!.message).not.toContain("SECRET");
  });

  it("the eval's runs.jsonl line keeps the failed call (judgeError) and marks the cause as recorded", async () => {
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-opus-4-8" }));
    } finally {
      q.mockRestore();
    }
    const entries = evaluate([sem], c);
    const line = buildRunsLine({
      index: 0,
      arm: "before",
      scenario: "s",
      rep: 1,
      runId: "local_x",
      runDir: undefined,
      result: { scenario: "s", result: "success", assertions: entries } as never,
      thrown: undefined,
      evidence: undefined,
    });
    expect(line.grades[0]!.judgeErrorsRecorded).toBe(true);
    expect(line.grades[0]!.assertions[0]).toMatchObject({ judgeInvalid: true, judgeError: { kind: "call", status: 401 } });
  });

  it("a transient status is retried at both levels and still labelled a failed call", async () => {
    serve(REAL_401, 1, { api_error_status: 529, result: "Overloaded" });
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-opus-4-8" }));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([sem], c);
    expect(calls()).toBe(6); // 3 transport spawns x 2 pre-pass attempts
    expect(r!.message).toContain("judge call FAILED (API 529");
    expect(r!.message).not.toContain("The judge used"); // the credential hint is for a 401/403 only
  });

  it("(control) a well-formed reply that is not a grade stays a malformed grade, retried once", async () => {
    serve(REAL_OK, 0, { result: "I cannot grade this." });
    const q = quiet();
    const c = ctx();
    try {
      await runSemanticJudges([sem], c, makeSemanticJudge({ model: "claude-haiku-4-5" }));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([sem], c);
    expect(calls()).toBe(2);
    expect(r!.message).toContain("malformed/ambiguous after retry");
    expect((r as { judgeError?: unknown }).judgeError).toBeUndefined();
  });
});

describe("semantic_pairwise: a judge call failure is reported as one", () => {
  let tmp: string;
  const TASK = "Summarise X";
  const META = {
    harnessVersion: "t",
    composerId: "c",
    scenario: "case_1",
    taskSha256: createHash("sha256").update(TASK, "utf8").digest("hex"),
  };
  const SRC = { command: "test", runDir: "~/r", resultSha256: "a".repeat(64), sessionId: "base" };
  const a = { semantic_pairwise: { rubric: ["cites a source"], order: "both" } } as Assertion;
  const freeze = (name: string) =>
    freezeRef(
      join(tmp, name),
      "case_1",
      SRC,
      { [pairwiseComposeKey(a, undefined)]: candidateDocument(ctx({ finalMessage: "REF" }), a).candidate },
      META,
    );
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(dir, "refs-")));
    freeze("baseline");
    freeze("v3");
  });
  const opts = (refs: string[]) => ({
    caseId: "case_1",
    sessionId: "s1",
    task: TASK,
    refsFor: () => refs.map((name) => ({ name, store: join(tmp, name) })),
    gateRefs: new Set(["baseline"]),
    judgeFor: (model: string) => makePairwiseJudge({ model, complete: claudeCliCompleteStructured }),
    modelFor: () => "claude-opus-4-8",
  });

  it("one gated reference, order both: one spawn, call-failure text, judgeError set", async () => {
    const q = quiet();
    const c = ctx({ finalMessage: "CANDIDATE" });
    try {
      await runPairwiseJudges([a], c, opts(["baseline"]));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([a], c);
    expect(calls()).toBe(1);
    expect(r!.judgeInvalid).toBe(true);
    expect(r!.message).toContain("judge call FAILED (API 401");
    expect((r as { judgeError?: unknown }).judgeError).toMatchObject({ kind: "call", status: 401 });
  });

  it("a metric-only reference before the gate records the cause in its why", async () => {
    const q = quiet();
    const c = ctx({ finalMessage: "CANDIDATE" });
    try {
      await runPairwiseJudges([a], c, opts(["v3", "baseline"]));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([a], c);
    // The 401 fails every later call the same way, so the gate reference is not judged: it is invalid with the same cause.
    expect(calls()).toBe(1);
    expect(r!.pairwise![0]).toMatchObject({ ref: "v3", gate: false, status: "invalid", callStatus: 401, callRetryable: false });
    expect(r!.pairwise![0]!.why).toContain("judge call failed (API 401, first_party: Invalid API key");
    expect(r!.judgeInvalid).toBe(true);
    expect((r as { judgeError?: unknown }).judgeError).toMatchObject({ kind: "call", status: 401, retryable: false });
  });

  it("after a credential failure, later metric-only references make no call and say why", async () => {
    freeze("v4");
    const q = quiet();
    const c = ctx({ finalMessage: "CANDIDATE" });
    try {
      await runPairwiseJudges([a], c, { ...opts(["v3", "v4"]), gateRefs: new Set<string>() });
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([a], c);
    expect(calls()).toBe(1);
    expect(r!.pairwise![1]).toMatchObject({ ref: "v4", status: "invalid", callStatus: 401, callRetryable: false });
    expect(r!.pairwise![1]!.why).toMatch(/^judge not called: an earlier comparison's call failed \(API 401/);
  });

  it("(control) a server error does not stop later comparisons: each reference is still judged", async () => {
    freeze("v4");
    serve(REAL_401, 1, { api_error_status: 500, result: "Internal server error" });
    const q = quiet();
    const c = ctx({ finalMessage: "CANDIDATE" });
    try {
      await runPairwiseJudges([a], c, { ...opts(["v3", "v4"]), gateRefs: new Set<string>() });
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([a], c);
    expect(r!.pairwise!.map((o) => o.why?.startsWith("judge call failed"))).toEqual([true, true]);
    expect(r!.pairwise![1]).toMatchObject({ callStatus: 500, callRetryable: true });
  });

  it("(control) error_max_structured_output_retries (is_error, no API status) stays malformed", async () => {
    serve(REAL_OK, 0, { subtype: "error_max_structured_output_retries", is_error: true, result: undefined, structured_output: undefined });
    const q = quiet();
    const c = ctx({ finalMessage: "CANDIDATE" });
    try {
      await runPairwiseJudges([a], c, opts(["baseline"]));
    } finally {
      q.mockRestore();
    }
    const [r] = evaluate([a], c);
    expect(calls()).toBe(2);
    expect(r!.message).toContain("malformed/ambiguous after retry");
    expect((r as { judgeError?: unknown }).judgeError).toBeUndefined();
  });
});

describe("grader credential: the graders follow the agent's credential when an OAuth token is set", () => {
  it("with a token, the API key and auth token are dropped; custom headers are kept", () => {
    const env = graderSpawnEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_AUTH_TOKEN: "auth",
      ANTHROPIC_CUSTOM_HEADERS: "X-A: 1",
      PATH: "/bin",
    });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_CUSTOM_HEADERS: "X-A: 1", PATH: "/bin" });
  });

  it("COWORK_HARNESS_GRADER_AUTH=inherit keeps every key (the 4.14.0 behaviour)", () => {
    const env = graderSpawnEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_AUTH_TOKEN: "auth",
      COWORK_HARNESS_GRADER_AUTH: "inherit",
      PATH: "/bin",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("auth");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("without a token nothing changes (the CI path keeps its key)", () => {
    expect(graderSpawnEnv({ ANTHROPIC_API_KEY: "key", ANTHROPIC_AUTH_TOKEN: "auth", PATH: "/bin" })).toEqual({
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_AUTH_TOKEN: "auth",
      PATH: "/bin",
    });
  });

  it("every grader entry point spawns without the API key when a token is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    process.env.ANTHROPIC_API_KEY = "fake-key-value";
    serve(REAL_OK, 0);
    const q = quiet();
    try {
      for (const call of [
        () => claudeCliComplete("p", "claude-haiku-4-5"),
        () => claudeCliCompleteDecider("p", "claude-haiku-4-5"),
        () => claudeCliCompleteEvaluator("p", "claude-haiku-4-5"),
        () => claudeCliCompleteStructured({ system: "s", user: "u", schema: PAIRWISE_JSON_SCHEMA, model: "claude-haiku-4-5" }),
      ]) {
        rmSync(join(dir, "env"), { force: true });
        await call();
        const env = spawnedEnv();
        expect(env).toMatch(/^CLAUDE_CODE_OAUTH_TOKEN=fake-token-value$/m);
        expect(env).not.toMatch(/^ANTHROPIC_API_KEY=/m);
      }
    } finally {
      q.mockRestore();
    }
  });

  it("a notice names the graders' credential once per process, by name only", async () => {
    transport.resetGraderAuthNotice?.();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    process.env.ANTHROPIC_API_KEY = "fake-key-value";
    serve(REAL_OK, 0);
    const out: string[] = [];
    const q = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    });
    try {
      await claudeCliComplete("p", "claude-haiku-4-5");
      await claudeCliComplete("p", "claude-haiku-4-5");
    } finally {
      q.mockRestore();
    }
    const notices = out.filter((l) => l.includes("[grader]"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(notices[0]).toContain("ANTHROPIC_API_KEY");
    expect(notices[0]).toContain("COWORK_HARNESS_GRADER_AUTH=inherit");
    expect(out.join("")).not.toContain("fake-token-value");
    expect(out.join("")).not.toContain("fake-key-value");
  });

  it("no notice when only one credential is set", async () => {
    transport.resetGraderAuthNotice?.();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    serve(REAL_OK, 0);
    const out: string[] = [];
    const q = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    });
    try {
      await claudeCliComplete("p", "claude-haiku-4-5");
    } finally {
      q.mockRestore();
    }
    expect(out.filter((l) => l.includes("[grader]"))).toHaveLength(0);
  });

  it("the transport identity records the credential by name, and the opt-in", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    process.env.ANTHROPIC_API_KEY = "fake-key-value";
    expect(transportIdentity("judge")).toMatchObject({ credential: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(transportIdentity("judge")).not.toHaveProperty("graderAuth");
    process.env.COWORK_HARNESS_GRADER_AUTH = "inherit";
    const t = transportIdentity("judge");
    expect(t).toMatchObject({ graderAuth: "inherit", credentialKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] });
    expect(t).not.toHaveProperty("credential");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.COWORK_HARNESS_GRADER_AUTH;
    expect(transportIdentity("judge")).toMatchObject({ credential: "host-login" });
  });
});

describe("the pre-spend judge check: one real call through the grader path, never retried", () => {
  it("the real 401 envelope refuses at one call, naming the status, model and credential", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key-value";
    const q = quiet();
    try {
      const o = await runJudgeCheck([{ role: "judge", model: "claude-opus-4-8" }]);
      expect(calls()).toBe(1);
      expect(o.refusal).toMatch(/API 401|401/);
      expect(o.refusal).toContain("claude-opus-4-8");
      expect(o.refusal).toContain("ANTHROPIC_API_KEY");
      expect(o.refusal).not.toContain("fake-key-value");
    } finally {
      q.mockRestore();
    }
  });

  it("a working credential prints one line per distinct grader, with the credential name and the cost", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    serve(REAL_OK, 0);
    const q = quiet();
    try {
      const o = await runJudgeCheck([
        { role: "judge", model: "claude-opus-4-8" },
        { role: "judge", model: "claude-opus-4-8" },
        { role: "decider", model: "sonnet" },
      ]);
      expect(o.refusal).toBeUndefined();
      expect(calls()).toBe(2); // the duplicate judge model is probed once
      expect(o.lines).toHaveLength(2);
      expect(o.lines[0]).toMatch(/^judge credential: CLAUDE_CODE_OAUTH_TOKEN works for .* \(probe cost/);
      expect(o.lines[1]).toMatch(/^LLM decider credential: CLAUDE_CODE_OAUTH_TOKEN works for /);
    } finally {
      q.mockRestore();
    }
  });

  it("an unknown model is a real API 404 (measured, $0): the probe refuses and names the model as the fix", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    serve(REAL_404, 1);
    const q = quiet();
    try {
      const o = await runJudgeCheck([{ role: "judge", model: "claude-no-such-model-1" }]);
      expect(calls()).toBe(1);
      expect(o.refusal).toContain("API 404");
      expect(o.refusal).toContain("pass --judge-model");
      expect(o.refusal).not.toContain("doctor");
    } finally {
      q.mockRestore();
    }
  });

  it("a spent quota refuses; a plain rate limit (429, retryable) only warns", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token-value";
    const q = quiet();
    try {
      serve(REAL_401, 1, { api_error_status: 429, result: "You've hit your weekly limit · resets Jul 13" });
      expect((await runJudgeCheck([{ role: "judge", model: "claude-opus-4-8" }])).refusal).toContain("usage quota is spent");
      serve(REAL_401, 1, { api_error_status: 429, result: "You've hit your rate limit, please try again shortly" });
      const o = await runJudgeCheck([{ role: "judge", model: "claude-opus-4-8" }]);
      expect(o.refusal).toBeUndefined();
      expect(o.lines[0]).toMatch(/could not check/);
    } finally {
      q.mockRestore();
    }
  });

  it("a 529 warns and proceeds, at one call (no retry)", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key-value";
    serve(REAL_401, 1, { api_error_status: 529, result: "Overloaded" });
    const q = quiet();
    try {
      const o = await runJudgeCheck([{ role: "judge", model: "claude-opus-4-8" }]);
      expect(o.refusal).toBeUndefined();
      expect(o.lines[0]).toMatch(/could not check claude-opus-4-8/);
      expect(calls()).toBe(1);
    } finally {
      q.mockRestore();
    }
  });

  it("every command that runs an agent with graders wires the check; regrade and dry run never probe", () => {
    const src = (p: string) => readFileSync(resolve(HERE, "..", p), "utf8");
    const cli = src("src/cli.ts");
    expect(cli.match(/judgeCheck: \(targets\) => runJudgeCheck\(targets\)/g)).toHaveLength(1); // eval
    expect(cli).toMatch(/judgeCheck: async \(\) => \{\s*throw new Error\("eval --dry-run must never probe/); // eval --dry-run
    const hc = src("src/hillclimb/cli.ts");
    expect(hc.match(/judgeCheck: \(targets\) => runJudgeCheck\(targets\)/g)).toHaveLength(1); // hillclimb run only
  });
});

describe("doctor: the Grader credential row (names only, $0)", () => {
  const base = { CLAUDE_CODE_OAUTH_TOKEN: "tok-value", ANTHROPIC_API_KEY: "key-value" };
  it("container with both keys: graders and agent both use the token (ok), the key named as not passed", () => {
    const c = graderCredentialCheck("container", base);
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("graders use CLAUDE_CODE_OAUTH_TOKEN; the agent at container uses CLAUDE_CODE_OAUTH_TOKEN");
    expect(c.detail).toContain("set but not passed to the graders: ANTHROPIC_API_KEY");
    expect(JSON.stringify(c)).not.toMatch(/tok-value|key-value/);
  });
  it("the API key and the auth token with no OAuth token: graders and agent both get the key (ok, no inherit advice)", () => {
    const env = { ANTHROPIC_API_KEY: "key-value", ANTHROPIC_AUTH_TOKEN: "auth-value" };
    for (const tier of ["container", "hostloop", "protocol"] as const) {
      const c = graderCredentialCheck(tier, env);
      expect(c.status).toBe("ok");
      expect(c.detail).toContain("graders use ANTHROPIC_API_KEY (the host claude's pick of ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN)");
      expect(c.detail).toContain(`the agent at ${tier} uses ANTHROPIC_API_KEY`);
      expect(JSON.stringify(c)).not.toMatch(/key-value|auth-value|inherit/);
    }
  });
  it("an auth token alone: the isolated tiers' agent gets no credential from it, so the row warns; protocol reads it (ok)", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "auth-value" };
    for (const tier of ["container", "hostloop", "microvm"] as const) {
      const c = graderCredentialCheck(tier, env);
      expect(c.status).toBe("warn");
      expect(c.detail).toContain(`graders use ANTHROPIC_AUTH_TOKEN; the agent at ${tier} uses no credential variable`);
      expect(c.remedy).toContain("it reads CLAUDE_CODE_OAUTH_TOKEN, else ANTHROPIC_API_KEY");
      expect(JSON.stringify(c)).not.toContain("auth-value");
    }
    expect(graderCredentialCheck("protocol", env).status).toBe("ok");
  });
  it("protocol with both keys: the agent uses the API key, so the row warns", () => {
    const c = graderCredentialCheck("protocol", base);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("the agent at protocol uses ANTHROPIC_API_KEY");
  });
  it("inherit with both keys warns on every tier; one key alone is ok", () => {
    expect(graderCredentialCheck("hostloop", { ...base, COWORK_HARNESS_GRADER_AUTH: "inherit" }).status).toBe("warn");
    expect(graderCredentialCheck("protocol", { ANTHROPIC_API_KEY: "k" }).status).toBe("ok");
  });
});
