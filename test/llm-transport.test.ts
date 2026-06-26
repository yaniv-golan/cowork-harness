import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { claudeCliComplete } from "../src/decide/llm-transport.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the transport through a FAKE `claude` bin (via COWORK_HARNESS_CLAUDE_BIN) so the retry loop is
// exercised without a real model call. The fake's behavior is steered by env vars it reads at runtime; it
// records its invocation count to a counter file so a test can assert exactly how many times it was spawned.
let dir: string;
let binPath: string;
let counterPath: string;

const FAKE = `#!/bin/sh
n=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_COUNTER"
case "$FAKE_MODE" in
  always-fail)
    echo "fake operational error (on stdout, like claude -p)"
    exit 1 ;;
  succeed-after-1)
    if [ "$n" -le 1 ]; then echo "transient blip"; exit 1; fi
    echo "OK-ANSWER"; exit 0 ;;
  timeout)
    sleep 30
    echo "late"; exit 0 ;;
  *)
    echo "OK-ANSWER"; exit 0 ;;
esac
`;

function invocations(): number {
  return existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) || 0 : 0;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cowork-llm-transport-"));
  binPath = join(dir, "fake-claude.sh");
  counterPath = join(dir, "counter");
  writeFileSync(binPath, FAKE, { mode: 0o755 });
  process.env.COWORK_HARNESS_CLAUDE_BIN = binPath;
});

afterEach(() => {
  if (existsSync(counterPath)) rmSync(counterPath);
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_COUNTER;
  delete process.env.COWORK_HARNESS_LLM_RETRIES;
  delete process.env.COWORK_HARNESS_LLM_TIMEOUT_MS;
});

afterAll(() => {
  delete process.env.COWORK_HARNESS_CLAUDE_BIN;
  rmSync(dir, { recursive: true, force: true });
});

describe("claudeCliComplete — retry transport", () => {
  it("retries a non-zero exit and resolves once the spawn succeeds", async () => {
    process.env.FAKE_MODE = "succeed-after-1";
    process.env.FAKE_COUNTER = counterPath;
    const out = await claudeCliComplete("q", "m");
    expect(out.trim()).toBe("OK-ANSWER");
    expect(invocations()).toBe(2); // 1 transient failure + 1 success
  });

  it("exhausts the bounded retries then fails loud, with the child's STDOUT folded into the message", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "2";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1.*stdout: fake operational error/s);
    expect(invocations()).toBe(3); // 1 initial + 2 retries
  });

  it("COWORK_HARNESS_LLM_RETRIES=0 disables retry (single attempt)", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "0";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1/);
    expect(invocations()).toBe(1);
  });

  it("an unparseable retry count falls back to the default (does NOT silently disable)", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "not-a-number";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1/);
    expect(invocations()).toBe(3); // default 2 retries, not 0
  });

  it("does NOT retry a timeout (a hung child that ate the budget is not a quick transient)", async () => {
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "2";
    // The fake sleeps 30s; the timeout trips at 1s (wide margin so a slow/loaded CI box still records the
    // counter write — the fake's first action — before SIGKILL). The kill ends the test in ~1s, not 30s.
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/timed out/);
    expect(invocations()).toBe(1); // spawned once, NOT retried
  });
});
