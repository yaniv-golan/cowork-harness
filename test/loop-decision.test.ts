import { describe, it, expect } from "vitest";
import { decideLoop, decideLoopFromBaseline } from "../src/loop-decision.js";

// Mirrors Cowork's f_() exactly (asar 1.12603.1).
describe("loop decision (f_ replica)", () => {
  it("requireFullVmSandbox forces VM-loop (HeA)", () => {
    expect(decideLoop({ requireFullVmSandbox: true, gateHostLoopOn: true })).toBe("vm");
  });
  it("forceDisableHostLoop forces VM-loop (iX)", () => {
    expect(decideLoop({ forceDisableHostLoop: true, gateHostLoopOn: true })).toBe("vm");
  });
  it("dev override forces host-loop", () => {
    expect(decideLoop({ devForceHostLoop: true, gateHostLoopOn: false })).toBe("host");
  });
  it("otherwise follows the gate", () => {
    expect(decideLoop({ gateHostLoopOn: true })).toBe("host");
    expect(decideLoop({ gateHostLoopOn: false })).toBe("vm");
  });
  it("policy beats the gate (precedence order)", () => {
    expect(decideLoop({ requireFullVmSandbox: true, devForceHostLoop: true, gateHostLoopOn: true })).toBe("vm");
  });
});

describe("decideLoopFromBaseline — reads requireFullVmSandbox from the baseline (bug fix)", () => {
  const withGate = (gate: string, extra: Record<string, unknown> = {}) =>
    ({ provenance: { gates: { "hostLoop:1143815894": gate } }, ...extra }) as any;
  it("host-loop when the gate is on(force) and no org lockdown", () => {
    expect(decideLoopFromBaseline(withGate("on(force)"))).toBe("host");
  });
  it("a locked-down org baseline (requireFullVmSandbox:true) forces VM-loop even with the gate on", () => {
    expect(decideLoopFromBaseline(withGate("on(force)", { requireFullVmSandbox: true }))).toBe("vm");
  });
  it("forceDisableHostLoop in the baseline forces VM-loop", () => {
    expect(decideLoopFromBaseline(withGate("on(force)", { forceDisableHostLoop: true }))).toBe("vm");
  });

  // #39: post-sync gates are STRUCTURED entries ({on,source,value}), not prose strings. Reading `.on`
  // (not a bare `!!obj`, which is truthy even for an off gate) is what makes an off gate force VM-loop.
  it("reads a synced structured gate entry: {on:true} → host, {on:false} → vm", () => {
    const structured = (on: boolean) => ({ provenance: { gates: { "hostLoop:1143815894": { on, source: "force", value: on } } } }) as any;
    expect(decideLoopFromBaseline(structured(true))).toBe("host");
    expect(decideLoopFromBaseline(structured(false))).toBe("vm"); // a bare !!obj would wrongly yield host here
  });
});
