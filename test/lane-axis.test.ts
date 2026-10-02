import { describe, it, expect } from "vitest";
import { Scenario } from "../src/types.js";
import { locationDelivers } from "../src/run/verdict.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The `lane` axis — which Cowork product lane's DELIVERY CONTRACT a run is held to. Cowork has no
 *  per-session lane picker on 2.19675.0 and no setting reliably decides the lane, and the two lanes
 *  disagree about what "delivered" means: locally a file under a user-visible root is delivered by
 *  location; remotely nothing is delivered by location at all. */
describe("lane axis — schema", () => {
  it("defaults to local, so every existing scenario keeps its meaning", () => {
    expect(Scenario.parse({ prompt: "x", fidelity: "container" }).lane).toBe("local");
  });

  it("accepts remote", () => {
    expect(Scenario.parse({ prompt: "x", fidelity: "container", lane: "remote" }).lane).toBe("remote");
  });

  it("rejects anything else rather than silently coercing", () => {
    expect(() => Scenario.parse({ prompt: "x", fidelity: "container", lane: "cloud" })).toThrow();
  });

  // Three axes that are easy to conflate and must stay independent: the isolation tier, where the run
  // happens, and which contract it is held to.
  it("is independent of fidelity and execution", () => {
    const s = Scenario.parse({ prompt: "x", lane: "remote", fidelity: "hostloop", execution: "local" });
    expect([s.lane, s.fidelity, s.execution]).toEqual(["remote", "hostloop", "local"]);
  });
});

describe("lane axis — does location deliver?", () => {
  it("local: yes — outputs/ is durable and Cowork tells the agent to save deliverables there", () => {
    expect(locationDelivers("local")).toBe(true);
  });

  it("remote: NO — a remote container has no auto-delivering outputs dir and is reclaimed at session end", () => {
    expect(locationDelivers("remote")).toBe(false);
  });

  it("absent ⇒ local, so results written before the axis existed keep their meaning", () => {
    expect(locationDelivers(undefined)).toBe(true);
  });
});

describe("lane axis — present_files is withheld on the remote lane", () => {
  // Both runtimes decide whether to register the `cowork` MCP server AT SPAWN, which needs Docker/a real
  // host loop to exercise end-to-end. Guard the decision at the source instead — the same convention
  // `hostloop-cowork-wiring.test.ts` uses for its own spawn-gated seam.
  const container = readFileSync(resolve("src/runtime/container.ts"), "utf8");
  const hostloop = readFileSync(resolve("src/runtime/hostloop.ts"), "utf8");

  it("the container runtime skips the cowork bundle on the remote lane", () => {
    expect(container).toMatch(/plan\.lane === "remote"\s*\?\s*undefined/);
  });

  it("the hostloop runtime skips it too", () => {
    expect(hostloop).toMatch(/plan\.lane === "remote"\s*\?\s*undefined/);
  });

  // A remote Cowork session has no local MCP servers at all, so serving present_files there would hand
  // the model a tool production does not have — greening a skill that then fails on the real lane.
  it("both spread the bundle conditionally rather than passing undefined into combineSdkMcp", () => {
    expect(container).toContain("...(coworkBundle ? [coworkBundle] : [])");
    expect(hostloop).toContain("...(coworkBundle ? [coworkBundle] : [])");
  });
});
