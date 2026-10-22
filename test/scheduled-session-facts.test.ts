import { describe, expect, it } from "vitest";
import { checkScheduledSessionFacts } from "../src/sync/cowork-sync.js";

// The four sites, in the real bundle's shape with the minified names replaced. Each constant is exported the way
// the real bundle exports it, so the check has to resolve it to its value rather than trust the name.
const SITES = [
  "let b=e.userSelectedFolders??[];!e.sessionType&&e.scheduledTaskId&&(e.sessionType=NS.tZ);let x=Date.now();",
  'Rt=NS.ent({enabled:NS.ant([NS.b(),NS.c(NS.d())])}).safeParse(NS.f1("3045399524",void 0)).data??{enabled:!1},zt=!a.sessionType&&(Rt.enabled===!0||Array.isArray(Rt.enabled)&&!!F&&Rt.enabled.includes(F)),Bt=1;',
  "run({existingSession:X,hasSendUserMessage:zt,hasWritingDraft:Lt});",
  'o.scheduledTaskId&&(Y.disallowedTools=[...Y.disallowedTools??[],"AskUserQuestion",NS.fX]),!J&&1;',
  "e.scheduledTaskId&&!Dh()&&(e.frameArtifactsEnabled=void 0),m&&2;",
  'function Dh(){return NS.d1()&&NS.p1("1978029737","scheduledRunFrameArtifacts",!0,NS.q())}',
].join("");
const EXPORTS =
  'Object.defineProperty(exports,"tZ",{enumerable:!0,get:function(){return H0t}});var H0t="scheduled";' +
  'Object.defineProperty(exports,"fX",{enumerable:!0,get:function(){return F2t}});var F2t="mcp__cowork-onboarding__show_onboarding_role_picker";';
const files = (edit: (s: string) => string = (s) => s) => new Map([["index.chunk-sched.js", edit(SITES + EXPORTS)]]);
const mutate = (from: string, to: string) => {
  const f = files((s) => s.replace(from, to));
  expect(f.get("index.chunk-sched.js"), `mutation did not apply: ${from}`).not.toBe(files().get("index.chunk-sched.js"));
  return checkScheduledSessionFacts(f).join("\n");
};

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
});
