// A multi-leg scenario: `legs:` in place of `prompt:`. Each leg is a prompt (a fresh agent session) or a host action (a
// command run in the leg runtime, no agent, no tokens). The legs run strictly in order; a failing leg stops the scenario
// and every later leg is reported skipped, never run on bad state.
//
// Kept apart from `Scenario` on purpose: a single-prompt scenario's type keeps `prompt: string`, which ~30 readers rely
// on, and a loader that is not multi-leg aware (eval, hillclimb, verify-run, refs) refuses a `legs:` file outright
// instead of reading its first leg as the whole run.

import { z } from "zod";
import { Assertion, AnswerRule, FIDELITY_TIERS, ScenarioObject } from "../types.js";
import type { Assertion as AssertionT } from "../types.js";
import { LEG_ID_RE } from "./turn-layout.js";

/** The keys a leg's `session:` overlay may set. Anything that would change the plugin set, the mounts or the tier is
 *  not here: every leg runs the same plugins in the same runtime. `agent_env.artifacts_root` is left out too: a leg
 *  that moved the artifacts root would make a resuming skill start a fresh run instead. */
export const LegSessionOverlay = z.strictObject({
  answer_channel: z.enum(["none"]).optional(),
  permission_mode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  agent_env: z
    .strictObject({
      subagent_model: z.string().optional(),
      tool_search: z.enum(["auto", "off"]).optional(),
      disable_experimental_betas: z.boolean().optional(),
    })
    .optional(),
});
export type LegSessionOverlay = z.infer<typeof LegSessionOverlay>;

/** The assertion keys a host-action leg may use from the ordinary set: files only (an action has no transcript). */
export const HOST_ACTION_FILE_KEYS = ["file_exists", "file_absent", "artifact_json", "artifact_text"] as const;

/** The keys only a host-action leg has: its exit code and its (capped, scrubbed) stdout. */
const HostActionOwnAssert = z.strictObject({
  exit_code: z.number().int().min(0).max(255).optional().describe("the action's exit code (default expectation: 0)"),
  stdout_matches: z.string().optional().describe("a regex the action's stdout must match"),
  stdout_not_matches: z.string().optional().describe("a regex the action's stdout must not match"),
});

export const HOST_ACTION_OWN_KEYS = ["exit_code", "stdout_matches", "stdout_not_matches"] as const;
const OWN_KEYS = HOST_ACTION_OWN_KEYS;

/** One host-action assert item: either one of the action's own keys, or an ordinary assertion restricted to the file
 *  keys. Dispatched on the item's keys rather than a z.union, whose failure says only "invalid input". */
const HostActionAssert = z.unknown().transform((a, ctx): HostActionAssertion => {
  const keys = a && typeof a === "object" ? Object.keys(a as object) : [];
  if (keys.some((k) => (OWN_KEYS as readonly string[]).includes(k))) {
    const r = HostActionOwnAssert.safeParse(a);
    if (!r.success) {
      for (const iss of r.error.issues) ctx.addIssue({ ...iss } as z.core.$ZodRawIssue);
      return z.NEVER;
    }
    if (Object.keys(r.data).length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "each host_action assert item names exactly one of exit_code, stdout_matches, stdout_not_matches",
      });
      return z.NEVER;
    }
    return r.data;
  }
  const bad = keys.filter((k) => !(HOST_ACTION_FILE_KEYS as readonly string[]).includes(k));
  if (bad.length) {
    ctx.addIssue({
      code: "custom",
      message: `a host_action leg asserts files only (${HOST_ACTION_FILE_KEYS.join(", ")}) plus exit_code / stdout_matches / stdout_not_matches; ${bad.join(", ")} needs an agent transcript`,
    });
    return z.NEVER;
  }
  const r = Assertion.safeParse(a);
  if (!r.success) {
    for (const iss of r.error.issues) ctx.addIssue({ ...iss } as z.core.$ZodRawIssue);
    return z.NEVER;
  }
  return r.data;
});
export type HostActionAssertion = z.infer<typeof HostActionOwnAssert> | AssertionT;

export const HostAction = z.strictObject({
  status: z
    .strictObject({
      artifact: z
        .string()
        .min(1)
        .describe("a JSON status file to read before the action, relative to the work root as assertion paths are (`outputs/…`)"),
      expect: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("top-level fields the status file must have (`{field: {not_null: true}}` requires a non-null value)"),
    })
    .optional()
    .describe("a status file read before the action; its string fields fill `{status.<field>}` in `run`"),
  run: z
    .array(z.string())
    .min(1)
    .describe("argv, one element per argument; `{status.<field>}` is substituted per element. Never a shell string"),
  timeout: z.number().int().min(1).max(600).default(120).describe("seconds (default 120, max 600)"),
});
export type HostAction = z.infer<typeof HostAction>;

export const Leg = z
  .strictObject({
    id: z
      .string()
      .regex(LEG_ID_RE, { message: "a leg id is 1-64 of [a-z0-9_-], starting with a letter or digit" })
      .describe(
        "the leg's id, unique within the scenario: 1-64 of [a-z0-9_-], starting with a letter or digit. It names the leg's run dir (legs/<id>) and is what --leg <id> takes",
      ),
    prompt: z.string().optional().describe("the user turn of this leg's fresh agent session"),
    host_action: HostAction.optional().describe("a command run in the leg runtime; no agent, no tokens"),
    session: LegSessionOverlay.optional().describe("this leg's overlay on the scenario session"),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "this prompt leg's wall-clock budget for its agent run, in ms; on expiry the harness kills the agent and the leg ends result:error / errorSource:timeout. Omitted = no timeout. Refused on a host_action leg, whose limit is host_action.timeout (seconds)",
      ),
    assert: z.array(z.unknown()).default([]).describe("this leg's assertions"),
  })
  .superRefine((l, ctx) => {
    if ((l.prompt === undefined) === (l.host_action === undefined))
      ctx.addIssue({ code: "custom", message: `leg "${l.id}" must have exactly one of prompt or host_action` });
    if (l.host_action !== undefined && l.session !== undefined)
      ctx.addIssue({ code: "custom", message: `leg "${l.id}": a host_action leg runs no agent, so it takes no session overlay` });
    if (l.host_action !== undefined && l.timeout_ms !== undefined)
      ctx.addIssue({ code: "custom", message: `leg "${l.id}": a host_action leg's limit is host_action.timeout (seconds)` });
    const schema = l.host_action !== undefined ? HostActionAssert : Assertion;
    l.assert.forEach((a, i) => {
      const r = schema.safeParse(a);
      if (!r.success) for (const iss of r.error.issues) ctx.addIssue({ ...iss, path: ["assert", i, ...iss.path] } as z.core.$ZodRawIssue);
    });
  });
export type Leg = z.infer<typeof Leg>;

/** A prompt leg's assertions, typed. */
export function promptLegAsserts(l: Leg): Assertion[] {
  return l.assert.map((a) => Assertion.parse(a));
}
/** A host-action leg's assertions, typed. */
export function hostActionAsserts(l: Leg): HostActionAssertion[] {
  return l.assert.map((a) => HostActionAssert.parse(a));
}

/** The description a key shares with the single-prompt scenario, where it means the same thing here. */
const shared = (
  k: "name" | "baseline" | "session" | "fidelity" | "answers" | "on_unanswered" | "skills" | "requires_capabilities" | "allow_host_hooks",
) => ScenarioObject.shape[k].description ?? "";

export const MultiLegScenarioObject = z.strictObject({
  name: z.string().default("").describe(shared("name")),
  baseline: z.string().default("latest").describe(shared("baseline")),
  session: z.string().default("(inline)").describe(shared("session")),
  fidelity: z.enum(FIDELITY_TIERS).describe(shared("fidelity")),
  execution: z
    .enum(["local"], { message: "a multi-leg scenario runs locally (execution: local)" })
    .default("local")
    .describe("local only (the default): a multi-leg scenario runs locally"),
  lane: z
    .enum(["local"], { message: "a multi-leg scenario runs on the local lane (lane: remote is refused)" })
    .default("local")
    .describe("local only (the default): a multi-leg scenario runs on the local lane; lane: remote is refused"),
  workdir: z
    .enum(["persistent", "cowork-task"])
    .default("persistent")
    .describe(
      "persistent (default): every leg runs in the same session tree, so a leg sees earlier legs' files at the same paths — a persistent workspace, not Cowork. cowork-task: each prompt leg gets a new session root; connected folders carry over, outputs do not (a model of a new local Cowork task, unverified)",
    ),
  legs: z
    .array(Leg)
    .min(2)
    .describe(
      "the legs, run in order, each a fresh agent session (prompt) or a host command (host_action): the first is a prompt leg, at least two are, and a leg after one that failed is skipped",
    ),
  answers: z.array(AnswerRule).default([]).describe(shared("answers")),
  on_unanswered: z.enum(["fail", "prompt", "llm", "first"]).optional().describe(shared("on_unanswered")),
  expect_denied: z
    .array(z.string())
    .default([])
    .describe(
      "hosts whose egress must have been DENIED: graded once for the scenario, over every leg's egress and every host action's, when every leg ran",
    ),
  skills: z.array(z.string()).default([]).describe(shared("skills")),
  requires_capabilities: z.array(z.string()).default([]).describe(shared("requires_capabilities")),
  allow_host_hooks: z.boolean().optional().describe(shared("allow_host_hooks")),
  workspace_fixture: z
    .string()
    .min(1)
    .optional()
    .describe(
      "a directory (relative to the scenario file) whose contents are copied into the session's outputs/ before the first leg; a later leg starts from the previous leg's end state. The same rules as a single scenario's workspace_fixture",
    ),
});

export const MultiLegScenario = MultiLegScenarioObject.superRefine((s, ctx) => {
  if (s.legs[0]?.prompt === undefined) ctx.addIssue({ code: "custom", path: ["legs", 0], message: "the first leg must be a prompt leg" });
  const seen = new Set<string>();
  s.legs.forEach((l, i) => {
    if (seen.has(l.id)) ctx.addIssue({ code: "custom", path: ["legs", i, "id"], message: `duplicate leg id "${l.id}"` });
    seen.add(l.id);
  });
  if (!s.legs.some((l, i) => i > 0 && l.prompt !== undefined))
    ctx.addIssue({
      code: "custom",
      path: ["legs"],
      message: "a multi-leg scenario needs at least two prompt legs (one is a plain scenario)",
    });
});
export type MultiLegScenario = z.infer<typeof MultiLegScenarioObject> & { name: string };

/** Keys a single-prompt scenario has that a multi-leg one refuses, with why: named in the load error instead of
 *  Zod's bare "unrecognized key". */
export const REFUSED_TOP_LEVEL: Record<string, string> = {
  prompt: "each leg has its own prompt",
  assert: "assertions are per leg (legs[].assert)",
  timeout_ms: "the time limit is per leg (legs[].timeout_ms)",
  device_bridge: "the remote lane's device bridge is not modeled across legs",
  metrics: "whether a metric is per leg or summed is not decided; metrics are refused with legs",
  allow_host_writes: "multi-leg does not run on the host loop",
};
