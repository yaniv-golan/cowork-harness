import { describe, it, expect } from "vitest";
import { makeSkillsHandler, SUGGEST_SKILLS_CAP } from "../src/hostloop/skills-handler.js";
import type { MountedSkill } from "../src/run/skill-metadata.js";

// Token-free, filesystem-free coverage for the `skills` sdk-MCP server (A2): tool-set gating across all
// three suggestSkillsEnabled/proactiveSkillSuggestEnabled states, alwaysLoad, output envelope shape, and
// the note-branch and cap fidelity bits Desktop's handler has.

const SKILL_A: MountedSkill = { name: "my-pdf-skill", description: "Extracts tables from PDFs", isUserCreated: true };
const SKILL_B: MountedSkill = { name: "founder-skills:deck-review", description: "Reviews pitch decks", isUserCreated: false };

async function listTools(h: ReturnType<typeof makeSkillsHandler>) {
  const out: any = await h("skills", { method: "tools/list" });
  return out.result.tools as Array<{ name: string; description: string; inputSchema: any; _meta?: any }>;
}

async function callTool(h: ReturnType<typeof makeSkillsHandler>, name: string, args: Record<string, unknown> = {}) {
  const out: any = await h("skills", { method: "tools/call", params: { name, arguments: args } });
  return out;
}

function parseText(out: any): any {
  return JSON.parse(out.result.content[0].text);
}

describe("makeSkillsHandler — tool-set gating", () => {
  it("suggestSkillsEnabled:true, proactive:false → list_skills + base suggest_skills, both alwaysLoad", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name).sort()).toEqual(["list_skills", "suggest_skills"]);
    for (const t of tools) expect(t._meta["anthropic/alwaysLoad"]).toBe(true);
    const suggest = tools.find((t) => t.name === "suggest_skills")!;
    expect(suggest.inputSchema.properties.trigger).toBeUndefined();
    const list = tools.find((t) => t.name === "list_skills")!;
    expect(list.description).toMatch(/fall back to suggest_skills/i);
  });

  it("suggestSkillsEnabled:false → suggest_skills omitted, list_skills description drops the fallback clause", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: false,
      proactiveSkillSuggestEnabled: false,
    });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name)).toEqual(["list_skills"]);
    expect(tools[0].description).not.toMatch(/suggest_skills/i);
  });

  it("suggestSkillsEnabled:true, proactive:true → suggest_skills gains a trigger enum param + proactive description", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: true,
    });
    const tools = await listTools(h);
    const suggest = tools.find((t) => t.name === "suggest_skills")!;
    expect(suggest.inputSchema.properties.trigger).toEqual({ type: "string", enum: ["user_asked", "proactive"] });
    expect(suggest.description).toMatch(/proactive/i);
  });

  // `toMatch(/proactive/i)` above passes against ANY proactive description, including one missing every
  // constraint production carries — a vacuous guard. Production's proactive variant is not just
  // "permission to suggest": it fences the permission with a do-not-call list, a once-per-conversation
  // dedup, a no-lead-in rule, and trigger-forwarding. Without these the emulated model over-suggests,
  // so each is pinned separately. Regex-per-rule (not a prose snapshot) so a legitimate rewording that
  // preserves the semantics does not red the suite.
  it("proactive description carries production's CONSTRAINTS, not just the permission", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: true,
    });
    const desc = (await listTools(h)).find((t) => t.name === "suggest_skills")!.description;
    expect(desc).toMatch(/do not call this when/i); // the negative list exists at all
    expect(desc).toMatch(/one-off/i); // …one-off task you can just answer
    expect(desc).toMatch(/not confident a skill would genuinely help/i); // …unsure it helps
    expect(desc).toMatch(/already rendered a suggestion.*did not engage/is); // once-per-conversation dedup
    expect(desc).toMatch(/same keywords and the same trigger/i); // forwarding, incl. the trigger
    expect(desc).toMatch(/do not write a lead-in/i); // no-lead-in rule
    expect(desc).toMatch(/context_label/i); // …use context_label instead
  });

  it("the BASE description stays free of proactive-only rules (no trigger to forward there)", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const desc = (await listTools(h)).find((t) => t.name === "suggest_skills")!.description;
    expect(desc).toMatch(/same keywords/i);
    expect(desc).not.toMatch(/and the same trigger/i); // the param does not exist on this branch
    expect(desc).not.toMatch(/do not call this when/i);
  });

  it("proactive:true is a no-op when suggestSkillsEnabled is false (gate #5 precedence)", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: false,
      proactiveSkillSuggestEnabled: true,
    });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name)).toEqual(["list_skills"]);
  });
});

describe("makeSkillsHandler — list_skills envelope + note branches", () => {
  const h = makeSkillsHandler({
    mountedSkills: [SKILL_A, SKILL_B],
    mountedPluginNames: ["founder-skills"],
    suggestSkillsEnabled: true,
    proactiveSkillSuggestEnabled: false,
  });

  it("non-empty match: resolved_skills populated, installed_plugins present, widget-rendered note", async () => {
    const out = parseText(await callTool(h, "list_skills", {}));
    expect(out.resolved_skills).toEqual([
      { name: "my-pdf-skill", description: "Extracts tables from PDFs", skill_id: "my-pdf-skill", is_user_created: true },
      {
        name: "founder-skills:deck-review",
        description: "Reviews pitch decks",
        skill_id: "founder-skills:deck-review",
        is_user_created: false,
      },
    ]);
    expect(out.installed_plugins).toEqual(["founder-skills"]);
    expect(out.request_skill_names).toEqual([]);
    expect(out.request_keywords).toEqual([]);
    expect(out.note).toMatch(/widget rendered above/i);
  });

  it("skill_names filters to the named subset", async () => {
    const out = parseText(await callTool(h, "list_skills", { skill_names: ["my-pdf-skill"] }));
    expect(out.resolved_skills.map((s: any) => s.name)).toEqual(["my-pdf-skill"]);
    expect(out.request_skill_names).toEqual(["my-pdf-skill"]);
  });

  it("empty-but-plugins-exist: no skill matches, plugins are named in the note", async () => {
    const out = parseText(await callTool(h, "list_skills", { skill_names: ["nonexistent"] }));
    expect(out.resolved_skills).toEqual([]);
    expect(out.note).toMatch(/no slash-menu skills matched/i);
    expect(out.note).toContain("founder-skills");
  });

  it("fully-empty: no skills, no plugins", async () => {
    const empty = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const out = parseText(await callTool(empty, "list_skills", {}));
    expect(out.resolved_skills).toEqual([]);
    expect(out.installed_plugins).toEqual([]);
    expect(out.note).toMatch(/no installed skills matched/i);
  });
});

describe("makeSkillsHandler — suggest_skills envelope", () => {
  it("base (non-proactive): resolved_skills empty (out-of-band catalog), no trigger key, ≤15 cap held trivially", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [SKILL_A],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const out = parseText(await callTool(h, "suggest_skills", { keywords: ["pdf"] }));
    expect(out.resolved_skills).toEqual([]);
    // NOT `[].length <= 15` — that is a tautology while the addable catalog is always empty, and it
    // would keep passing if a later change populated the array and dropped the slice. Pin the exported
    // cap the handler actually applies instead.
    expect(SUGGEST_SKILLS_CAP).toBe(15);
    expect(out.trigger).toBeUndefined();
    expect(out.note).toMatch(/no addable standalone skills matched/i);
    expect(out.note).toMatch(/search_plugins/i);
  });

  // Production composes the empty note from three conditionals, so the note has THREE distinct shapes,
  // not two. A prior reconstruction branched proactive-vs-not and returned a bare "continue silently" on
  // `proactive` — suppressing the search_plugins chain production always emits. These pin the real shape.
  // `trigger` is optional, so trigger-omitted is a REAL third path, not a synthetic one.
  const proactiveHandler = () =>
    makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: true,
    });

  it("proactive: chains into search_plugins WITH trigger-forwarding, and the tail is silence", async () => {
    const out = parseText(await callTool(proactiveHandler(), "suggest_skills", { trigger: "proactive" }));
    expect(out.trigger).toBe("proactive");
    // The chain is emitted on the proactive path too — this is the assertion the old model failed.
    expect(out.note).toMatch(/search_plugins/i);
    expect(out.note).toMatch(/and the same trigger/i);
    expect(out.note).toMatch(/continue the task without mentioning that you searched/i);
    // Silence is the TAIL, not the whole note; the disclosure tail must not also appear.
    expect(out.note).not.toMatch(/in your follow-up/i);
  });

  it("proactive gate + user_asked: forwards the trigger but DISCLOSES the empty search", async () => {
    const out = parseText(await callTool(proactiveHandler(), "suggest_skills", { trigger: "user_asked" }));
    expect(out.trigger).toBe("user_asked");
    expect(out.note).toMatch(/search_plugins/i);
    expect(out.note).toMatch(/and the same trigger/i);
    expect(out.note).toMatch(/in your follow-up/i);
    expect(out.note).not.toMatch(/without mentioning that you searched/i);
  });

  it("proactive gate + trigger OMITTED: still chains, but forwards NO trigger (the third path)", async () => {
    const out = parseText(await callTool(proactiveHandler(), "suggest_skills", { keywords: ["pdf"] }));
    expect(out.trigger).toBeUndefined();
    expect(out.note).toMatch(/search_plugins/i);
    // The load-bearing pin: omitted must NOT tell the model to forward a trigger it never supplied.
    // On its own this negative would pass against the pre-fix note too (which had no forwarding clause
    // at all) — it is non-vacuous only as a PAIR with the two `and the same trigger` assertions above,
    // which prove the clause exists and is therefore genuinely conditional.
    expect(out.note).not.toMatch(/and the same trigger/i);
    expect(out.note).toMatch(/in your follow-up/i);
  });

  it("calling suggest_skills when the gate is off is rejected (tool truly doesn't exist)", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: false,
      proactiveSkillSuggestEnabled: false,
    });
    const out: any = await callTool(h, "suggest_skills", {});
    expect(out.error).toBeDefined();
  });
});

describe("makeSkillsHandler — protocol scaffolding", () => {
  it("initialize returns a well-formed capabilities envelope", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const out: any = await h("skills", { method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(out.result.serverInfo.name).toBe("skills");
    expect(out.result.protocolVersion).toBe("2025-06-18");
  });

  it("onCall observability hook fires for every tools/call", async () => {
    const calls: Array<[string, unknown]> = [];
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
      onCall: (name, args) => calls.push([name, args]),
    });
    await callTool(h, "list_skills", { context_label: "x" });
    expect(calls).toEqual([["list_skills", { context_label: "x" }]]);
  });
});
