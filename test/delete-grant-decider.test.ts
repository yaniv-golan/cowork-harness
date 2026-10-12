// The device bridge's delete card, `device_request_delete_permission`. A person must answer it, so the harness
// never answers it by itself: permission parity abstains, an unscripted card under the default `fail` ends the run
// as an unanswered gate, `first` declines, and every other answerer reads its two options through
// `coerceDeleteGrant`, never through web_fetch's grant scopes.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, credentialLeaks, exited, makeStubFixture, runDir, spawnCli } from "./helpers/stub-agent.js";
import { Run } from "../src/run/run.js";
import {
  buildDecider,
  coerceDeleteGrant,
  DELETE_GRANT_OPTIONS,
  DELETE_GRANT_TOOL,
  ExternalDecider,
  LlmDecider,
  PermissionDefaultDecider,
  PromptDecider,
  UnansweredError,
  ABSTAIN,
  type Decider,
} from "../src/decide/decider.js";
import { AnswerRule } from "../src/types.js";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse, DecisionDelivery } from "../src/agent/session.js";

class MockSession implements AgentSession {
  replies: Array<{ id: string; r: DecisionResponse }> = [];
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(id: string, r: DecisionResponse): DecisionDelivery {
    this.replies.push({ id, r });
    return { delivered: true };
  }
  close() {}
}

const grantReq = (): Extract<DecisionRequest, { kind: "permission" }> => ({
  id: "g1",
  kind: "permission",
  tool: DELETE_GRANT_TOOL,
  input: { paths: ["~/notes"], reason: "tidy up" },
});
const drive = (decider: Decider) => {
  const s = new MockSession([{ type: "decision", request: grantReq() } as AgentEvent, { type: "result", isError: false } as AgentEvent]);
  return { s, rec: new Run(s, decider).drive("go") };
};

describe("the delete card is never answered by permission parity", () => {
  it.each(["cowork", "strict"] as const)("PermissionDefaultDecider abstains under %s parity", async (parity) => {
    expect(await new PermissionDefaultDecider(parity).decide(grantReq())).toBe(ABSTAIN);
  });
});

describe("an unscripted delete card", () => {
  it("under on_unanswered fail, ends the run as an unanswered gate and sends no allow", async () => {
    const { s, rec } = drive(buildDecider({ rules: [], parity: "cowork", onUnanswered: "fail" }));
    await expect(rec).rejects.toBeInstanceOf(UnansweredError);
    expect(s.replies.some((x) => x.r.kind === "permission" && x.r.behavior === "allow")).toBe(false);
  });
  it("under on_unanswered first, is declined and recorded by `first`", async () => {
    const { s, rec } = drive(buildDecider({ rules: [], parity: "cowork", onUnanswered: "first" }));
    const r = await rec;
    expect(s.replies).toHaveLength(1);
    expect(s.replies[0]!.r).toMatchObject({ kind: "permission", behavior: "deny" });
    expect(r.decisions).toEqual([expect.objectContaining({ name: DELETE_GRANT_TOOL, decision: "deny", by: "first" })]);
  });
});

describe("a scripted delete card", () => {
  it("decide: allow sends a plain allow, with no grant field on the wire", async () => {
    const { s, rec } = drive(
      buildDecider({ rules: [{ when_tool: DELETE_GRANT_TOOL, decide: "allow" }], parity: "cowork", onUnanswered: "fail" }),
    );
    await rec;
    expect(s.replies[0]!.r).toMatchObject({ kind: "permission", behavior: "allow" });
    expect(s.replies[0]!.r).not.toHaveProperty("grant");
  });
  it("allow_if reads the requested folders", async () => {
    const rule = { when_tool: DELETE_GRANT_TOOL, allow_if: 'paths.every(p => p === "~/other")', else: "deny" as const };
    const { s, rec } = drive(buildDecider({ rules: [rule], parity: "cowork", onUnanswered: "fail" }));
    await rec;
    expect(s.replies[0]!.r).toMatchObject({ behavior: "deny" });
  });
  it("a grant: scope on the rule is refused at load (production offers only a session grant)", () => {
    expect(AnswerRule.safeParse({ when_tool: DELETE_GRANT_TOOL, decide: "allow", grant: "domain" }).success).toBe(false);
  });
});

describe("the run hands every decider the card's two options", () => {
  it("handleDecision attaches [Decline, Allow for this session]", async () => {
    let seen: DecisionRequest | undefined;
    const spy: Decider = {
      async decide(req) {
        seen = req;
        return { response: { kind: "permission", behavior: "deny", message: "x" }, by: "scripted" };
      },
    };
    await drive(spy).rec;
    expect(seen).toMatchObject({ kind: "permission", options: DELETE_GRANT_OPTIONS });
    expect(DELETE_GRANT_OPTIONS.map((o) => o.label)).toEqual(["Decline", "Allow for this session"]);
  });
});

describe("coerceDeleteGrant and the interactive answerers", () => {
  it("maps the two labels, their shorthands and their 1-based indices; anything else throws", () => {
    expect(coerceDeleteGrant("Allow for this session")).toEqual({ behavior: "allow" });
    expect(coerceDeleteGrant("allow")).toEqual({ behavior: "allow" });
    expect(coerceDeleteGrant("2")).toEqual({ behavior: "allow" });
    expect(coerceDeleteGrant("Decline")).toEqual({ behavior: "deny" });
    expect(coerceDeleteGrant("1")).toEqual({ behavior: "deny" });
    expect(() => coerceDeleteGrant("Allow all for website")).toThrow(UnansweredError);
    expect(() => coerceDeleteGrant("once")).toThrow(UnansweredError);
  });
  const withOptions = () => ({ ...grantReq(), options: [...DELETE_GRANT_OPTIONS] });
  it("LlmDecider: the picked label goes through coerceDeleteGrant and the allow carries no grant", async () => {
    const llm = new LlmDecider(async () => ({ text: "Allow for this session", model: "m" }));
    const d = await llm.decide(withOptions());
    expect(d).not.toBe(ABSTAIN);
    if (d === ABSTAIN) return;
    expect(d.response).toMatchObject({ kind: "permission", behavior: "allow" });
    expect(d.response).not.toHaveProperty("grant");
  });
  it("LlmDecider asks about deleting in the requested folders, naming them and the reason, never a web fetch", async () => {
    const prompts: string[] = [];
    await new LlmDecider(async (p) => (prompts.push(p), { text: "Decline", model: "m" })).decide(withOptions());
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("~/notes");
    expect(prompts[0]).toContain("tidy up");
    expect(prompts[0]).toMatch(/delete/i);
    expect(prompts[0]).not.toMatch(/fetch|URL|domain/i);
  });
  it("PromptDecider shows the requested folders and the reason before the two options", async () => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const shown: string[] = [];
    try {
      await new PromptDecider(async (p) => (shown.push(p), "1")).decide(withOptions());
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
    expect(shown[0]).toContain("~/notes");
    expect(shown[0]).toContain("tidy up");
    expect(shown[0]).toContain("Allow for this session");
  });
  it("PromptDecider: a typed 1 declines", async () => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const d = await new PromptDecider(async () => "1").decide(withOptions());
      expect(d !== ABSTAIN && d.response).toMatchObject({ kind: "permission", behavior: "deny" });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });
  it("ExternalDecider: the request advertises a delete-shaped reply, and a grant in the reply is refused", async () => {
    const written: string[] = [];
    const reply = (line: string) => ({
      write: (l: string) => void written.push(l),
      readLine: async () => line,
    });
    const ok = await new ExternalDecider(reply(JSON.stringify({ id: "g1", behavior: "allow" }))).decide(withOptions());
    expect(ok !== ABSTAIN && ok.response).toMatchObject({ kind: "permission", behavior: "allow" });
    expect(ok !== ABSTAIN && ok.response).not.toHaveProperty("grant");
    const req = JSON.parse(written[0]!);
    expect(req.reply_with).toBe('{"id":"g1","behavior":"allow|deny"}');
    await expect(
      new ExternalDecider(reply(JSON.stringify({ id: "g1", behavior: "allow", grant: "domain" }))).decide(withOptions()),
    ).rejects.toBeInstanceOf(UnansweredError);
  });
});

// Through the real CLI: a stub agent raises the delete card and waits. With nothing scripted, the run must end as an
// unanswered gate — exit 2, a partial result whose verdict fails and names the gate — never a silent Decline.
const can = POSIX && existsSync(CLI);
const GRANT_FRAME = JSON.stringify({
  type: "control_request",
  request_id: "g-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "mcp__remote-devices__device_request_delete_permission",
    tool_use_id: "toolu_grant",
    input: { paths: ["~/notes"], reason: "remove the old draft" },
  },
});
describe.runIf(can)("an unscripted delete card through the CLI", () => {
  it("exits 2 with unansweredGate set and a failing verdict", async () => {
    const f = makeStubFixture(`printf '%s\\n' '${GRANT_FRAME}'\nexec sleep 300`);
    try {
      const cli = spawnCli(f, ["run", f.scenario, "--output-format", "json"]);
      const r = await exited(cli, 25_000);
      expect(credentialLeaks(f.envDump)).toEqual([]);
      expect(r.code, cli.stderrText()).toBe(2);
      const d = runDir(f)!;
      const res = JSON.parse(readFileSync(join(d, "turns", "1", "result.json"), "utf8"));
      expect(res.unansweredGate.message).toMatch(/delete permission/);
      expect(res.verdict.pass).toBe(false);
      expect((res.decisions ?? []).some((x: { decision: string }) => x.decision === "allow")).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it("allow_permissive_auto_allow cannot waive it: the run still exits 2 with nothing allowed", async () => {
    const f = makeStubFixture(`printf '%s\\n' '${GRANT_FRAME}'\nexec sleep 300`);
    try {
      writeFileSync(
        f.scenario,
        "baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n  - allow_permissive_auto_allow: true\n",
      );
      const cli = spawnCli(f, ["run", f.scenario, "--output-format", "json"]);
      const r = await exited(cli, 25_000);
      expect(r.code, cli.stderrText()).toBe(2);
      const res = JSON.parse(readFileSync(join(runDir(f)!, "turns", "1", "result.json"), "utf8"));
      expect(res.unansweredGate.message).toMatch(/delete permission/);
      expect(res.verdict.pass).toBe(false);
      expect(res.permissiveAutoAllow).toBeUndefined();
      expect((res.decisions ?? []).some((x: { decision: string }) => x.decision === "allow")).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
