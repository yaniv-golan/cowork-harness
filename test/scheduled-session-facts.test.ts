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
const files = (edit: (s: string) => string = (s) => s, editOther: (s: string) => string = (s) => s) =>
  new Map([
    [MAIN, edit(SITES + EXPORTS)],
    [OTHER, editOther(CODE_TAB)],
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
});
