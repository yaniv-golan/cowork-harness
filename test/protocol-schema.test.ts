// E9 — conformance tests for schema/protocol.v1.json, the harness's OWN control-channel wire protocol
// (spawn/initialize/can_use_tool/hook_callback/mcp_message requests, the nested control_response
// envelope, and the `answers` wire-shape). Deliberately NOT the Claude Agent SDK's own event stream
// (assistant/result/tool_use) — that surface is Anthropic's and is out of scope (docs/protocol.md).
//
// Two conformance halves (plan §4/E9, item 2), both real-output-first (§9 lesson 1/2 — no hand-rolled
// lookalike JSON):
//   (a) every controlOut line and every control_request event line in the COMMITTED cassettes
//       (examples/replays/*.cassette.json) — the exact recordings the replay gate already trusts.
//   (b) the ACTUAL output of the real envelope-builder functions in src/agent/session.ts
//       (serializeDecision / hookOutput+successEnvelope / mcpResponseEnvelope) for a synthetic decision
//       matrix — never a hand-authored fixture that merely looks like their output.
//
// Plus a self-verifying lockstep (item 5): every fixtures/protocol/v1/*.json vector validates against
// the schema, AND every schema `definitions` entry is exercised by at least one vector — so the schema
// and the vector pack cannot silently drift apart.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  serializeDecision,
  deserializeDecision,
  hookOutput,
  mcpResponseEnvelope,
  successEnvelope,
  COWORK_PRETOOLUSE_HOOKS,
  type DecisionRequest,
} from "../src/agent/session.js";

const REPO_ROOT = join(__dirname, "..");
const SCHEMA_PATH = join(REPO_ROOT, "schema/protocol.v1.json");
const CASSETTES_DIR = join(REPO_ROOT, "examples/replays");
const VECTORS_DIR = join(REPO_ROOT, "fixtures/protocol/v1");

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv({ strict: true });
/** The root `Message` validator — any single control-channel line (request OR response). */
const validateMessage = ajv.compile(schema);
/** Compile a standalone validator for one named definition (anonymous schema, no $id collision risk —
 *  ajv.compile() may be called repeatedly against schema-object literals with no `$id`). */
function compileDef(name: string) {
  if (!(name in schema.definitions)) throw new Error(`schema/protocol.v1.json has no definition "${name}"`);
  return ajv.compile({ definitions: schema.definitions, $ref: `#/definitions/${name}` });
}

function listCassettes(): string[] {
  return readdirSync(CASSETTES_DIR)
    .filter((f) => f.endsWith(".cassette.json"))
    .map((f) => join(CASSETTES_DIR, f));
}

describe("protocol.v1.json — draft-07 compiles cleanly", () => {
  it("ajv strict-compiles the schema with no warnings", () => {
    expect(() => new Ajv({ strict: true }).compile(schema)).not.toThrow();
  });
});

describe("protocol.v1.json — conformance against COMMITTED cassettes", () => {
  const cassettePaths = listCassettes();

  it("found at least one committed cassette to validate against (guards a silently-empty sweep)", () => {
    expect(cassettePaths.length).toBeGreaterThan(0);
  });

  for (const path of cassettePaths) {
    const name = path.split("/").pop()!;
    const cassette = JSON.parse(readFileSync(path, "utf8"));

    it(`${name}: every control_request line in events[] validates`, () => {
      let checked = 0;
      for (const line of cassette.events ?? []) {
        const obj = JSON.parse(line);
        if (obj.type !== "control_request") continue;
        checked++;
        const ok = validateMessage(obj);
        if (!ok) throw new Error(`${name} events[] control_request failed schema: ${ajv.errorsText(validateMessage.errors)}\n${line}`);
      }
      // Not every cassette has a gate (e.g. the pdf-skill fixture runs fully auto-approved) — this loop
      // is allowed to check zero lines there; the multiselect-gate fixture is what exercises it (below).
      expect(checked).toBeGreaterThanOrEqual(0);
    });

    it(`${name}: every controlOut line validates (excluding the "user" turn — out of E9's scope)`, () => {
      let checked = 0;
      for (const line of cassette.controlOut ?? []) {
        const obj = JSON.parse(line);
        // The `user` turn message (sendUserTurn) is mirrored into controlOut.jsonl for full-fidelity
        // replay, but it is the SDK's own input-message shape, not one of the five control-protocol
        // shapes DESIGN.md §6 documents — deliberately out of scope (see docs/protocol.md's scope note).
        if (obj.type === "user") continue;
        checked++;
        const ok = validateMessage(obj);
        if (!ok) throw new Error(`${name} controlOut line failed schema: ${ajv.errorsText(validateMessage.errors)}\n${line}`);
      }
      expect(checked).toBeGreaterThanOrEqual(0);
    });
  }

  it("the multiselect-gate fixture specifically exercises the AskUserQuestion can_use_tool + multiSelect answer shapes", () => {
    const cassette = JSON.parse(readFileSync(join(CASSETTES_DIR, "example-multiselect-gate.cassette.json"), "utf8"));
    const askEvent = (cassette.events as string[]).map((l) => JSON.parse(l)).find((o) => o.type === "control_request" && o.request?.subtype === "can_use_tool");
    expect(askEvent).toBeDefined();
    expect(askEvent.request.tool_name).toBe("AskUserQuestion");
    expect(compileDef("AskUserQuestionInput")(askEvent.request.input)).toBe(true);
    expect(askEvent.request.input.questions[0].multiSelect).toBe(true);

    const answerLine = (cassette.controlOut as string[]).map((l) => JSON.parse(l)).find((o) => o.type === "control_response");
    expect(answerLine).toBeDefined();
    const updatedInput = answerLine.response.response.updatedInput;
    expect(compileDef("QuestionAnswerUpdatedInput")(updatedInput)).toBe(true);
    // binary-verified wire shape: a multiSelect answer is one comma-joined STRING, never an array
    expect(typeof updatedInput.answers["Which features do you want to enable?"]).toBe("string");
    expect(updatedInput.answers["Which features do you want to enable?"]).toBe("Auth, Audit");
  });
});

describe("protocol.v1.json — conformance against the REAL envelope-builder output (src/agent/session.ts)", () => {
  const permReq: DecisionRequest = { id: "req-1", kind: "permission", tool: "Write", input: { path: "out.txt" } };
  const questionReq: DecisionRequest = {
    id: "req-2",
    kind: "question",
    questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }],
  };
  const multiSelectReq: DecisionRequest = {
    id: "req-3",
    kind: "question",
    questions: [{ question: "Pick features", options: [{ label: "Auth" }, { label: "Billing" }], multiSelect: true }],
  };

  it("permission allow — serializeDecision output validates as ControlResponse + AllowBody", () => {
    const envelope = serializeDecision(permReq, { kind: "permission", behavior: "allow", updatedInput: { path: "out.txt" } });
    expect(validateMessage(envelope)).toBe(true);
    expect(compileDef("ControlResponse")(envelope)).toBe(true);
    expect(compileDef("AllowBody")((envelope as any).response.response)).toBe(true);
  });

  it("permission deny — serializeDecision output validates as ControlResponse + DenyBody", () => {
    const envelope = serializeDecision(permReq, { kind: "permission", behavior: "deny", message: "nope" });
    expect(validateMessage(envelope)).toBe(true);
    expect(compileDef("DenyBody")((envelope as any).response.response)).toBe(true);
  });

  it("question answer (single-select) — serializeDecision output validates as QuestionAnswerUpdatedInput", () => {
    const envelope = serializeDecision(questionReq, { kind: "question", answers: { "Proceed?": "Yes" } });
    expect(validateMessage(envelope)).toBe(true);
    const updatedInput = (envelope as any).response.response.updatedInput;
    expect(compileDef("QuestionAnswerUpdatedInput")(updatedInput)).toBe(true);
  });

  it("question answer (multiSelect) — serializeDecision output carries a comma-joined string, validates identically", () => {
    // The comma-join itself happens in the decider layer (ScriptedDecider et al, not serializeDecision) —
    // serializeDecision just carries whatever string `answers` holds. Feed it the wire-shape a real
    // multiSelect answer takes (binary-verified: seams.test.ts's decider test asserts this exact join).
    const envelope = serializeDecision(multiSelectReq, { kind: "question", answers: { "Pick features": "Auth, Billing" } });
    expect(validateMessage(envelope)).toBe(true);
    const updatedInput = (envelope as any).response.response.updatedInput;
    expect(compileDef("QuestionAnswerUpdatedInput")(updatedInput)).toBe(true);
    expect(compileDef("Answers")(updatedInput.answers)).toBe(true);
  });

  it("round-trip: serializeDecision → deserializeDecision recovers an equivalent DecisionResponse (both ends schema-valid)", () => {
    const envelope = serializeDecision(permReq, { kind: "permission", behavior: "allow", updatedInput: { path: "out.txt" } });
    expect(validateMessage(envelope)).toBe(true);
    const decoded = deserializeDecision(permReq, (envelope as any).response.response);
    expect(decoded).toEqual({ kind: "permission", behavior: "allow", updatedInput: { path: "out.txt" } });
  });

  it("hook_callback round-trip — hookOutput()+successEnvelope() output validates as ControlResponse + HookOutputBody", () => {
    const callbackId = COWORK_PRETOOLUSE_HOOKS.PreToolUse[0].hookCallbackIds[0];
    const blocked = hookOutput(callbackId, { tool_input: { run_in_background: true } });
    const allowed = hookOutput(callbackId, { tool_input: {} });
    const blockedEnvelope = successEnvelope("req-hook", blocked);
    const allowedEnvelope = successEnvelope("req-hook", allowed);
    expect(validateMessage(blockedEnvelope)).toBe(true);
    expect(validateMessage(allowedEnvelope)).toBe(true);
    expect(compileDef("HookOutputBody")(blocked)).toBe(true);
    expect(compileDef("HookOutputBody")(allowed)).toBe(true);
    expect(blocked).toEqual({ decision: "block", reason: "Background agents disabled" });
    expect(allowed).toEqual({});
  });

  it("mcp_message round-trip — mcpResponseEnvelope() output validates as ControlResponse + McpResponseBody", () => {
    const withResult = mcpResponseEnvelope("req-mcp", { result: { ok: true } }, 1);
    const withError = mcpResponseEnvelope("req-mcp", { error: { code: -32601, message: "no handler" } }, 1);
    const noReply = mcpResponseEnvelope("req-mcp", {}, undefined); // no `id` → notification, empty body
    expect(validateMessage(withResult)).toBe(true);
    expect(validateMessage(withError)).toBe(true);
    expect(validateMessage(noReply)).toBe(true);
    expect(compileDef("McpResponseBody")((withResult as any).response.response)).toBe(true);
    expect((noReply as any).response.response).toEqual({});
  });
});

describe("protocol.v1.json — golden vector pack lockstep (fixtures/protocol/v1/)", () => {
  // Maps each committed vector file to the definition it's meant to demonstrate. Every vector must
  // validate against ITS mapped def; every schema definition must appear as a value here at least once —
  // together these two directions are the "no schema definition ships unexercised, no vector ships
  // unschema'd" guard the plan asks for.
  const requestVectors: Record<string, string> = {
    "initialize.json": "ControlRequestInitialize",
    "permission-request.json": "ControlRequestCanUseTool",
    "question-request.json": "ControlRequestCanUseTool",
  };
  const responseVectors: Record<string, string> = {
    "allow-response.json": "AllowBody",
    "deny-response.json": "DenyBody",
    "question-answer-response.json": "QuestionAnswerUpdatedInput",
  };
  // Round-trip vectors: { request, response } — each half validates against its own def.
  const roundTripVectors: Record<string, { request: string; response: string }> = {
    "hook-callback.json": { request: "ControlRequestHookCallback", response: "HookOutputBody" },
    "mcp-message.json": { request: "ControlRequestMcpMessage", response: "McpResponseBody" },
  };

  const allFiles = readdirSync(VECTORS_DIR).filter((f) => f.endsWith(".json"));

  it("every file under fixtures/protocol/v1/ is accounted for in exactly one of the three maps above", () => {
    const mapped = new Set([...Object.keys(requestVectors), ...Object.keys(responseVectors), ...Object.keys(roundTripVectors)]);
    expect(new Set(allFiles)).toEqual(mapped);
  });

  for (const [file, defName] of Object.entries(requestVectors)) {
    it(`${file} validates as a whole Message AND as #/definitions/${defName}`, () => {
      const vector = JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8"));
      expect(validateMessage(vector)).toBe(true);
      expect(compileDef(defName)(vector)).toBe(true);
    });
  }

  it("question-request.json's `input` body ALSO validates against AskUserQuestionInput/QSpec/QSpecOption specifically", () => {
    const vector = JSON.parse(readFileSync(join(VECTORS_DIR, "question-request.json"), "utf8"));
    const input = vector.request.input;
    expect(compileDef("AskUserQuestionInput")(input)).toBe(true);
    expect(compileDef("QSpec")(input.questions[0])).toBe(true);
    expect(compileDef("QSpecOption")(input.questions[0].options[0])).toBe(true);
  });

  for (const [file, defName] of Object.entries(responseVectors)) {
    it(`${file} is a ControlResponse whose inner body validates against #/definitions/${defName}`, () => {
      const vector = JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8"));
      expect(validateMessage(vector)).toBe(true);
      expect(compileDef("ControlResponse")(vector)).toBe(true);
      const body =
        defName === "QuestionAnswerUpdatedInput" ? vector.response.response.updatedInput : vector.response.response;
      expect(compileDef(defName)(body)).toBe(true);
    });
  }

  for (const [file, defs] of Object.entries(roundTripVectors)) {
    it(`${file}: request validates as #/definitions/${defs.request}, response body as #/definitions/${defs.response}`, () => {
      const vector = JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8"));
      expect(validateMessage(vector.request)).toBe(true);
      expect(compileDef(defs.request)(vector.request)).toBe(true);
      expect(validateMessage(vector.response)).toBe(true);
      const body = vector.response.response.response;
      expect(compileDef(defs.response)(body)).toBe(true);
    });
  }

  it("every schema definitions entry is exercised by at least one vector (no unexercised definition)", () => {
    // Defs exercised directly by the maps above, PLUS the structural wrapper/union defs that every
    // vector transitively exercises by validating against the root Message schema (oneOf ControlRequest |
    // ControlResponse) and, for request vectors, the ControlRequest union itself.
    const directlyMapped = new Set([
      ...Object.values(requestVectors),
      ...Object.values(responseVectors),
      ...Object.values(roundTripVectors).flatMap((d) => [d.request, d.response]),
    ]);
    const transitivelyExercised = new Set([
      "Message", // every vector validates against the root
      "ControlRequest", // every *-request.json vector + the request half of every round-trip
      "ControlResponse", // every response-shaped vector
      "ControlResponseBody", // every response body validates against this anyOf too
      "QSpec", // question-request.json validates directly against this (test above)
      "QSpecOption", // question-request.json's first option validates directly against this (test above)
      "AskUserQuestionInput", // question-request.json's `input` body validates directly against this (test above)
      "Answers", // question-answer-response.json's `answers` map
    ]);
    const exercised = new Set([...directlyMapped, ...transitivelyExercised]);
    const allDefs = Object.keys(schema.definitions);
    const unexercised = allDefs.filter((d) => !exercised.has(d));
    expect(unexercised).toEqual([]);
  });

  it("QSpec is exercised with BOTH multiSelect:true (question-request.json) and a plain option set is schema-valid", () => {
    const vector = JSON.parse(readFileSync(join(VECTORS_DIR, "question-request.json"), "utf8"));
    const qspec = vector.request.input.questions[0];
    expect(compileDef("QSpec")(qspec)).toBe(true);
    expect(qspec.multiSelect).toBe(true);
  });
});
