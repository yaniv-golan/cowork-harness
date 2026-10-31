import { describe, expect, it } from "vitest";
import { checkScheduledSessionFacts } from "../src/sync/cowork-sync.js";

// The four sites, in the real bundle's shape with the minified names replaced. Each constant is exported the way
// the real bundle exports it, so the check has to resolve it to its value rather than trust the name.
const SITES = [
  "let b=e.userSelectedFolders??[];!e.sessionType&&e.scheduledTaskId&&(e.sessionType=NS.tZ);let x=Date.now();",
  'Rt=NS.ent({enabled:NS.ant([NS.b(),NS.c(NS.d())])}).safeParse(NS.f1("3045399524",void 0)).data??{enabled:!1},zt=!a.sessionType&&(Rt.enabled===!0||Array.isArray(Rt.enabled)&&!!F&&Rt.enabled.includes(F)),Bt=1;',
  "run({existingSession:X,hasSendUserMessage:zt,hasWritingDraft:Lt});",
  // The builders downstream RECEIVE the value (a parameter or a `let{…}=` read) and forward it — not extra sites.
  "async function Im(e,n,{sessionId:r,hasSendUserMessage:_,hasWritingDraft:v},O){await vo(e,n,{sessionId:r,hasSendUserMessage:_});}",
  "function wh(e,r){let{sessionId:i,hasSendUserMessage:me,hasWritingDraft:he}=r;Im(e,r,{sessionId:i,hasSendUserMessage:me},O);}",
  'o.scheduledTaskId&&(Y.disallowedTools=[...Y.disallowedTools??[],"AskUserQuestion",NS.fX]),!J&&1;',
  "e.scheduledTaskId&&!Dh()&&(e.frameArtifactsEnabled=void 0),m&&2;",
  'function Dh(){return NS.d1()&&NS.p1("1978029737","scheduledRunFrameArtifacts",!0,NS.q())}',
].join("");
const EXPORTS =
  'Object.defineProperty(exports,"tZ",{enumerable:!0,get:function(){return H0t}});var H0t="scheduled";' +
  'Object.defineProperty(exports,"fX",{enumerable:!0,get:function(){return F2t}});var F2t="mcp__cowork-onboarding__show_onboarding_role_picker";';
// The Code tab's own scheduled-task removal, in another chunk: pinned by shape, never mistaken for a Cowork one.
const CODE_TAB =
  'class R{async buildStartSdkOptions(e){let{sessionId:r,options:i}=e;i.scheduledTaskId&&($.disallowedTools=["AskUserQuestion"]),fe&&1;}}';
const MAIN = "index.chunk-sched.js";
const OTHER = "index.chunk-code.js";
// Desktop's own `cowork` SDK server module: the typed-artifact tool list, its read-only subset (exported as `m`), and
// the host loop that pre-approves that subset (Desktop 4.29.0+). Names resolve through MAIN's exports.
const FRAMEMOD_NAME = "index.chunk-frame.js";
const FRAMEMOD =
  'var NS=require("./index.chunk-sched.js");var W={},q=[NS.k1,NS.k2],mt=q.filter((e=>W[e].annotations?.readOnlyHint===!0)).map((e=>`mcp__${NS.u2}__${e}`)),ht=new Map(q.map((e=>[e,e])));' +
  'Object.defineProperty(exports,"m",{enumerable:!0,get:function(){return mt}});Object.defineProperty(exports,"n",{enumerable:!0,get:function(){return q}});';
const HOST_NAME = "index.chunk-host.js";
const HOST =
  'var NS=require("./index.chunk-sched.js"),G=require("./index.chunk-frame.js");function go(){let a=["WebSearch","AskUserQuestion","ToolSearch",...i([NS.k1]),...i(G.m),...Pt.readRules];return a}';
const FRAME_EXPORTS =
  'Object.defineProperty(exports,"k1",{enumerable:!0,get:function(){return K1}});var K1="list_types";' +
  'Object.defineProperty(exports,"k2",{enumerable:!0,get:function(){return K2}});var K2="db_write";' +
  'Object.defineProperty(exports,"u2",{enumerable:!0,get:function(){return U2}});var U2="cowork";' +
  'Object.defineProperty(exports,"r3",{enumerable:!0,get:function(){return R3}});var R3="chat";';
const files = (
  edit: (s: string) => string = (s) => s,
  editOther: (s: string) => string = (s) => s,
  editFrame: (s: string) => string = (s) => s,
  editHost: (s: string) => string = (s) => s,
) =>
  new Map([
    [MAIN, edit(SITES + EXPORTS + FRAME_EXPORTS)],
    [OTHER, editOther(CODE_TAB)],
    [FRAMEMOD_NAME, editFrame(FRAMEMOD)],
    [HOST_NAME, editHost(HOST)],
  ]);
const mutate = (from: string, to: string) => {
  const f = files((s) => s.replace(from, to));
  expect(f.get(MAIN), `mutation did not apply: ${from}`).not.toBe(files().get(MAIN));
  return checkScheduledSessionFacts(f).join("\n");
};
/** A refactor-shaped mutation: every pinned site stays, and one more is added. */
const add = (where: typeof MAIN | typeof OTHER, extra: string) =>
  checkScheduledSessionFacts(where === MAIN ? files((s) => s + extra) : files(undefined, (s) => s + extra)).join("\n");

describe("checkScheduledSessionFacts — what a scheduled observation cannot see", () => {
  it("the real shape has no flags", () => {
    expect(checkScheduledSessionFacts(files())).toEqual([]);
  });
  it("a scheduled-task session no longer typed at start flags", () => {
    expect(mutate("!e.sessionType&&e.scheduledTaskId&&(e.sessionType=NS.tZ);", "")).toMatch(/scheduled session type anchor missing/);
  });
  it("the type constant resolving to something other than scheduled flags", () => {
    expect(mutate('var H0t="scheduled"', 'var H0t="agent"')).toMatch(/no longer resolves to "scheduled"/);
  });
  it("send_user_message offered to typed sessions too (the !sessionType clause dropped) flags", () => {
    expect(mutate("zt=!a.sessionType&&(", "zt=(")).toMatch(/send_user_message predicate anchor missing/);
  });
  it("the predicate read from another gate flags", () => {
    expect(mutate('"3045399524"', '"3045399525"')).toMatch(/send_user_message predicate anchor missing/);
  });
  it("the predicate no longer feeding hasSendUserMessage flags", () => {
    expect(mutate("hasSendUserMessage:zt", "hasSendUserMessage:Lt")).toMatch(/no longer feeds `hasSendUserMessage`/);
  });
  it("AskUserQuestion no longer removed from a scheduled session flags", () => {
    expect(mutate('"AskUserQuestion",NS.fX', '"Other",NS.fX')).toMatch(/scheduled tool removals anchor missing/);
  });
  it("the second removed tool resolving to something other than the role picker flags", () => {
    expect(mutate('"mcp__cowork-onboarding__show_onboarding_role_picker"', '"mcp__cowork__present_files"')).toMatch(
      /no longer the onboarding role picker/,
    );
  });
  it("frame artifacts cleared unconditionally flags", () => {
    expect(mutate("e.scheduledTaskId&&!Dh()&&(", "e.scheduledTaskId&&(")).toMatch(/scheduled frame artifacts anchor missing/);
  });
  it("the frame-artifacts gate re-pointed flags", () => {
    expect(mutate('"1978029737","scheduledRunFrameArtifacts"', '"1978029737","otherFlag"')).toMatch(/no longer scheduledRunFrameArtifacts/);
  });
  it("the Code tab's removal list changing flags (it is pinned too, not waved through)", () => {
    const f = files(undefined, (s) => s.replace('["AskUserQuestion"]', '["AskUserQuestion","Bash"]'));
    expect(checkScheduledSessionFacts(f).join("\n")).toMatch(/match neither the Cowork removal nor the Code tab/);
  });
});

// A refactor ADDS a site beside the pinned one more often than it edits it in place; a first-match check stays green.
describe("checkScheduledSessionFacts — a second site beside the pinned one", () => {
  it("(a) a second hasSendUserMessage feed in the same chunk flags", () => {
    expect(add(MAIN, "run2({hasSendUserMessage:Lt});")).toMatch(/also fed from `Lt`/);
  });
  it("(b) a second hasSendUserMessage feed in another chunk flags", () => {
    expect(add(OTHER, "run2({hasSendUserMessage:Qq});")).toMatch(/also fed from `Qq`/);
  });
  it("a constant fed to hasSendUserMessage flags", () => {
    expect(add(OTHER, "run2({hasSendUserMessage:!0});")).toMatch(/also fed from `!0`/);
  });
  it("(c) a second scheduled disallowedTools site with another list flags", () => {
    expect(add(OTHER, 's.scheduledTaskId&&(o.disallowedTools=[...o.disallowedTools??[],"WebFetch","Bash"]);')).toMatch(
      /1 scheduled-task disallowedTools site\(s\) match neither/,
    );
  });
  it("(d) a second typed-at-start site resolving to another type flags", () => {
    expect(add(OTHER, '!e.sessionType&&e.scheduledTaskId&&(e.sessionType="agent");')).toMatch(/no longer resolves to "scheduled"/);
  });
  it("a second typed-at-start site in another shape flags", () => {
    expect(add(OTHER, "e.scheduledTaskId&&(e.sessionType=NS.tZ);")).toMatch(/typed at 2 sites, only 1 in the pinned/);
  });
  it("a second read of gate 3045399524 flags", () => {
    expect(add(OTHER, 'q=NS.f1("3045399524",void 0);')).toMatch(/read at 2 sites/);
  });
  it("a second frame-artifacts assignment flags", () => {
    expect(add(OTHER, "e.frameArtifactsEnabled=!0;")).toMatch(/assigned at 2 sites, only 1 the gated scheduled clear/);
  });

  // Desktop 3.6556.1: typed-artifact tools (Desktop's own `cowork` server; a scheduled read never shows them) go only to an untyped,
  // unscheduled session. Required once the bundle builds a frame-tools section; absent before that release.
  const FRAME =
    "let ce=f&&a.sessionType===void 0&&(a.scheduledTaskId??r.getActiveSession(i)?.scheduledTaskId)===void 0,le=ce?NS.qo():[],ue=ce&&1;" +
    "build({frameToolsSection:le.length>0?Df(le):void 0,hasFrameTools:ue});" +
    'var HTr="claude-artifacts";';
  const ARM = "&&(a.scheduledTaskId??r.getActiveSession(i)?.scheduledTaskId)===void 0";
  it("3.6556.1: the frame-tools predicate in its pinned shape has no flags", () => {
    expect(checkScheduledSessionFacts(files((s) => s + FRAME))).toEqual([]);
  });
  it("3.6556.1: the predicate losing its scheduledTaskId arm flags (scheduled sessions would get the tools)", () => {
    const f = checkScheduledSessionFacts(files((s) => s + FRAME.replace(ARM, "")));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/scheduled frame tools anchor missing/);
  });
  it("3.6556.1: a second copy of the predicate flags", () => {
    const f = checkScheduledSessionFacts(files((s) => s + FRAME + FRAME));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/scheduled frame tools anchor missing/);
  });
  // Two dating signals, so a rename of the prompt key cannot switch the check off.
  it("3.6556.1: the prompt key renamed, predicate intact → no flags (the server literal keeps the check on)", () => {
    expect(checkScheduledSessionFacts(files((s) => s + FRAME.replace("frameToolsSection:", "frameToolSection:")))).toEqual([]);
  });
  it("3.6556.1: the prompt key renamed AND the scheduledTaskId arm dropped → 1 flag", () => {
    const f = checkScheduledSessionFacts(files((s) => s + FRAME.replace("frameToolsSection:", "frameToolSection:").replace(ARM, "")));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/scheduled frame tools anchor missing/);
  });
  it("3.6556.1: the server literal alone (no prompt key) still requires the predicate", () => {
    const noKey = FRAME.replace("frameToolsSection:", "frameToolSection:");
    expect(checkScheduledSessionFacts(files((s) => s + noKey.replace(ARM, "")))).toHaveLength(1);
    expect(checkScheduledSessionFacts(files((s) => s + noKey.replace('var HTr="claude-artifacts";', "").replace(ARM, "")))).toEqual([]);
  });
  it("before 3.6556.1 (no frame-tools section) the predicate is not required", () => {
    expect(checkScheduledSessionFacts(files())).toEqual([]);
  });
});

// Desktop 4.29.0: the predicate also admits a session typed "chat", through a flag declared in the same let-list. The
// minifier reuses binding names (4.29.0's chat flag is `I`, its artifacts gate `F`; 4.4212.0 swaps them), so the flag
// is read only from the let-list beside the predicate.
describe("checkScheduledSessionFacts — 4.29.0 chat arm and the cowork frame-tool list", () => {
  const CHAT =
    "let F=a.sessionType===NS.r3,ae=f&&(a.sessionType===void 0||F)&&(a.scheduledTaskId??r.getActiveSession(i)?.scheduledTaskId)===void 0,oe=ae?NS.qo():[],ue=ae&&1;" +
    "build({frameToolsSection:oe.length>0?Df(oe):void 0,hasFrameTools:ue});" +
    'var HTr="claude-artifacts";';
  const ARM = "&&(a.scheduledTaskId??r.getActiveSession(i)?.scheduledTaskId)===void 0";
  const run = (main = CHAT, frame?: (s: string) => string, host?: (s: string) => string, exp?: (s: string) => string) =>
    checkScheduledSessionFacts(files((s) => (exp ? exp(s) : s) + main, undefined, frame, host)).join("\n");
  it("the chat form, the frame-tool list and the pre-approval in their pinned shape have no flags", () => {
    expect(run()).toBe("");
  });
  it("an earlier binding of the same name (the artifacts gate) does not stand in for the chat flag", () => {
    expect(run("let F=NS.gate();" + CHAT)).toBe("");
  });
  it("the adjacent flag resolving to another session type flags", () => {
    expect(run(CHAT, undefined, undefined, (s) => s.replace('R3="chat"', 'R3="scheduled"'))).toMatch(/resolves to "scheduled", not "chat"/);
  });
  it("the adjacent flag reading an inline literal other than chat flags", () => {
    expect(run(CHAT.replace("===NS.r3", '==="agent"'))).toMatch(/resolves to "agent", not "chat"/);
  });
  it("the chat form losing its scheduledTaskId arm flags", () => {
    expect(run(CHAT.replace(ARM, ""))).toMatch(/scheduled frame tools anchor missing — the typed-artifact tools are gated by 0/);
  });
  it("the chat form beside the old form (two predicates) flags", () => {
    const OLD = "let ce=f&&a.sessionType===void 0&&(a.scheduledTaskId??r.getActiveSession(i)?.scheduledTaskId)===void 0,le=ce?NS.qo():[];";
    expect(run(CHAT + OLD)).toMatch(/gated by 2 pinned/);
  });
  it("the predicate dated but no frame-tool list flags", () => {
    expect(run(CHAT, () => "")).toMatch(/cowork frame-tool list anchor missing — 0 typed-artifact tool list/);
  });
  it("a frame-tool name this sync has not read flags", () => {
    expect(run(CHAT, undefined, undefined, (s) => s.replace('K2="db_write"', 'K2="db_drop"'))).toMatch(/not read \(`db_drop`\)/);
  });
  it("the tools served under another server name flags", () => {
    expect(run(CHAT, undefined, undefined, (s) => s.replace('U2="cowork"', 'U2="claude-artifacts"'))).toMatch(
      /served under "claude-artifacts", not "cowork"/,
    );
  });
  it("the host loop pre-approving the whole tool list (not its read-only subset) flags", () => {
    expect(run(CHAT, undefined, (s) => s.replace("...i(G.m)", "...i(G.n)"))).toMatch(/spreads `G.n` from the cowork frame-tool module/);
  });
  it("the read-only subset dropping its readOnlyHint filter is no longer the pinned list, and flags", () => {
    expect(run(CHAT, (s) => s.replace(".filter((e=>W[e].annotations?.readOnlyHint===!0))", ""))).toMatch(
      /cowork frame-tool list anchor missing/,
    );
  });
  it("a second allowed-tools list flags", () => {
    expect(run(CHAT, undefined, (s) => s + 'let b=["WebSearch","AskUserQuestion","ToolSearch",...i(G.m)];')).toMatch(
      /allowed-tools list appears 2 times/,
    );
  });
  it("no pre-approval spread (3.6556.x) is not a flag", () => {
    expect(run(CHAT, undefined, (s) => s.replace("...i(G.m),", ""))).toBe("");
  });
});
