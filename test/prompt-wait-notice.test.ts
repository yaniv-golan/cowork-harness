import { describe, it, expect, vi, afterEach } from "vitest";

// The FIRST blocking TTY wait under `prompt` policy emits one immediate `::notice:: [input]` —
// per PromptDecider instance (not module-level), and only for the real TTY asker (not chat's injected one).

// Mock the readline the default askRaw uses so `question()` resolves immediately instead of blocking.
vi.mock("node:readline", () => ({
  default: { createInterface: () => ({ question: (_p: string, cb: (a: string) => void) => cb("1"), close: () => {} }) },
}));

import { PromptDecider } from "../src/decide/decider.js";

const questionReq = () =>
  ({ kind: "question", questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] }) as any;

const spyStderr = () => {
  const calls: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
    calls.push(String(c));
    return true;
  });
  return calls;
};

const withTTY = async (isTTY: boolean, fn: () => Promise<void>) => {
  const prev = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });
  try {
    await fn();
  } finally {
    if (prev) Object.defineProperty(process.stdin, "isTTY", prev);
    else delete (process.stdin as any).isTTY;
  }
};

afterEach(() => vi.restoreAllMocks());

describe("prompt-wait notice", () => {
  it("emits the [input] waiting notice exactly ONCE across multiple gates (per instance)", async () => {
    await withTTY(true, async () => {
      const calls = spyStderr();
      const d = new PromptDecider(); // default askRaw → interactive path
      await d.decide(questionReq());
      await d.decide(questionReq());
      const notices = calls.filter((s) => /::notice:: \[input\] waiting for an answer/.test(s));
      expect(notices.length).toBe(1);
    });
  });

  it("does NOT emit the notice for a custom injected asker (chat REPL / tests)", async () => {
    await withTTY(true, async () => {
      const calls = spyStderr();
      const d = new PromptDecider(async () => "1"); // custom ask → not the interactive default
      await d.decide(questionReq());
      await d.decide(questionReq());
      expect(calls.some((s) => /::notice:: \[input\] waiting/.test(s))).toBe(false);
    });
  });
});
