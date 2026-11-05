// Extractor admissions for Desktop 4.16336.0: the empty-sentinel helper's member set (S14a) and the hoisted readOnly
// tail in the path hook. Fixtures are synthetic minified shapes, never Desktop text.
import { describe, expect, it } from "vitest";
import { readOnlyTailHoistDefect, s14aEmptySentinelLists, s14aMemberDefect, S14A_EMPTY_SENTINEL_KEYS } from "../src/sync/cowork-sync.js";

describe("S14a empty-sentinel helper", () => {
  const loop = (keys: string[]) => `function q(e){for(let t of[${keys.map((k) => `"${k}"`).join(",")}])e[t]===""&&delete e[t]}`;

  it("reads the three-member form (older builds) and the four-member form", () => {
    expect(s14aEmptySentinelLists(loop(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"]))).toEqual([
      ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"],
    ]);
    expect(s14aEmptySentinelLists(loop([...S14A_EMPTY_SENTINEL_KEYS]))).toEqual([[...S14A_EMPTY_SENTINEL_KEYS]]);
  });

  it("does not take a loop with another body for the helper", () => {
    const scrub = `for(let t of["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN"])delete e[t]`;
    expect(s14aEmptySentinelLists(scrub)).toEqual([]);
  });

  it("reports a fifth member, so the caller can flag it by name", () => {
    const got = s14aEmptySentinelLists(loop([...S14A_EMPTY_SENTINEL_KEYS, "CLAUDE_CODE_NEW_SECRET"]));
    expect(got[0]!.filter((k) => !S14A_EMPTY_SENTINEL_KEYS.includes(k))).toEqual(["CLAUDE_CODE_NEW_SECRET"]);
  });
});

describe("S14a member set", () => {
  const three = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];
  const built = 'let e={CLAUDE_CODE_OAUTH_TOKEN:"",CLAUDE_CODE_SESSIONS_OAUTH_TOKEN:"",X:"1"};';

  it("an older build that neither constructs nor deletes the fourth reads clean", () => {
    expect(s14aMemberDefect(three, "let e={X:1};")).toBeNull();
  });
  it('a build that constructs it as "" and deletes it reads clean', () => {
    expect(s14aMemberDefect([...S14A_EMPTY_SENTINEL_KEYS], built)).toBeNull();
  });
  it('a build that constructs it as "" but no longer deletes it flags it by name', () => {
    expect(s14aMemberDefect(three, built)).toMatch(/-CLAUDE_CODE_SESSIONS_OAUTH_TOKEN/);
  });
  it("a lost ANTHROPIC_* member flags whatever the bundle builds", () => {
    expect(s14aMemberDefect(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], "")).toMatch(/-ANTHROPIC_CUSTOM_HEADERS/);
  });
  it("an unclassified member flags by name", () => {
    expect(s14aMemberDefect([...three, "NEW_KEY"], "")).toMatch(/\+NEW_KEY/);
  });
});

describe("readOnly tail, hoisted form", () => {
  const spawn = (hookBody: string, destructured = "getMidSessionReadOnlyPaths:de") =>
    `async function Q(e,r){let{readOnlyPluginPaths:le,resolveReadOnlyRoots:ue=!1,${destructured},skillsPluginPath:fe}=r;` +
    `let n=async e=>{let S=E();${hookBody};return w};return n}`;

  it("admits the binding, its use and the getter when all three connect", () => {
    expect(readOnlyTailHoistDefect(spawn("let C=de?.()??[],w=[...He,...S,...Ie||_?[]:C,..._?[]:x]"))).toBeNull();
  });

  it("admits the downleveled optional call", () => {
    expect(readOnlyTailHoistDefect(spawn("let C=(de==null?void 0:de())??[],w=[...He,...Ie||_?[]:C]"))).toBeNull();
  });

  it("refuses a same-named binding used in another function", () => {
    const src = spawn("let C=de?.()??[]") + "function other(){return[...A||B?[]:C]}";
    expect(readOnlyTailHoistDefect(src)).toMatch(/outside the closure/);
  });

  it("refuses a getter destructured from another property", () => {
    expect(readOnlyTailHoistDefect(spawn("let C=de?.()??[],w=[...A||B?[]:C]", "getReadOnlyPaths:de"))).toMatch(
      /not a destructured getMidSessionReadOnlyPaths/,
    );
  });

  it("refuses a getter re-bound between the destructuring and the closure", () => {
    const src =
      "async function Q(e,r){let{getMidSessionReadOnlyPaths:de}=r;de=()=>[];" +
      "let n=async e=>{let C=de?.()??[],w=[...A||B?[]:C];return w};return n}";
    expect(readOnlyTailHoistDefect(src)).toMatch(/re-bound/);
  });

  it("refuses a destructuring that does not enclose the closure", () => {
    const src =
      "function P(r){let{getMidSessionReadOnlyPaths:de}=r;return de}" +
      "async function Q(){let n=async e=>{let C=de?.()??[],w=[...A||B?[]:C];return w};return n}";
    expect(readOnlyTailHoistDefect(src)).toMatch(/does not enclose/);
  });

  it("names the missing shape when there is no hoisted binding at all", () => {
    expect(readOnlyTailHoistDefect(spawn("let w=[...A||B?[]:x]"))).toMatch(/no hoisted/);
  });
});
