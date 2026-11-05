// The guard behind leaving CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP unset (Desktop 4.16336.0). Synthetic minified shapes,
// never Desktop text.
import { describe, expect, it } from "vitest";
import { checkArtifactsMcpGuardFacts } from "../src/sync/cowork-sync.js";

const K = "CLAUDE_CODE_HOST_GUARDS_ARTIFACTS_MCP";
const EXPORTS = `var X={CLAUDE_CODE_HIDE_CWD:()=>a,${K}:()=>b};`;
const W2 = `function B(){let n=K();return{CLAUDE_CODE_ENTRYPOINT:E(n.type),CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS:"",${K}:"1",ANTHROPIC_BASE_URL:u}}`;
const W1 = `env:{...pe&&{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:"1"},...pe&&he!==void 0&&{CLAUDE_ARTIFACT_HOST_GRANT:he,${K}:"0"}}`;
const CODE = `!c.supportsLaunchTools()||V?$.env&&($.env.${K}="0"):x;`;
const files = (o: { w2?: string; w1?: string; code?: string; extra?: string } = {}) =>
  new Map([
    ["index.chunk-EXP.js", EXPORTS],
    ["index.chunk-BASE.js", o.w2 ?? W2],
    ["index.chunk-SPAWN.js", (o.w1 ?? W1) + (o.extra ?? "")],
    ["index.chunk-CODE.js", o.code ?? CODE],
  ]);

describe("checkArtifactsMcpGuardFacts", () => {
  it("the three pinned constructions are clean", () => {
    expect(checkArtifactsMcpGuardFacts(files())).toEqual([]);
  });
  it("a bundle that only declares the key in its export tables has nothing to guard", () => {
    expect(checkArtifactsMcpGuardFacts(new Map([["a.js", EXPORTS]]))).toEqual([]);
  });
  it.each([
    ["a fourth construction", { extra: `,env2:{${K}:"0"}` }, /4 construction\(s\) in the bundle but 3/],
    [
      "an unconditional override on the Cowork spawn",
      { w1: `env:{...pe&&{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:"1"},${K}:"0"}` },
      /0 Cowork-spawn "0" override/,
    ],
    [
      "the override under another predicate",
      { w1: W1.replace("...pe&&he", "...qe&&he") },
      /spread under qe, not the chunk's one frame-artifacts predicate \(pe\)/,
    ],
    ["the base builder's value changed", { w2: W2.replace(`${K}:"1"`, `${K}:"0"`) }, /0 base-builder "1" site/],
    ["the Code tab's guard dropped", { code: `$.env&&($.env.${K}="0");` }, /0 Code-tab "0" site/],
  ])("flags: %s", (_n, o, why) => {
    const f = files(o);
    expect([...f.values()].join("")).not.toBe([...files().values()].join("")); // the mutation applied
    const flags = checkArtifactsMcpGuardFacts(f);
    expect(flags.join("\n")).toMatch(why);
    expect(flags[0]).toMatch(/^artifacts-mcp: /);
  });
});
