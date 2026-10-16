import { beforeAll, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentAnchorsRefusal } from "../src/search-corpus/run.js";
import { loadBaseline } from "../src/baseline.js";
import { extractSearchAnchors } from "../src/sync/search-anchors.js";
import type { SearchAnchors } from "../src/types.js";
import { bundle, callSite, noRequestSite } from "./helpers/search-anchor-bundle.js";

// The pre-spend check: the agent binary the run will actually launch must give the baseline's web-search anchors.
const write = (buf: Buffer) => {
  const p = join(mkdtempSync(join(tmpdir(), "cwh-anchor-check-")), "claude");
  writeFileSync(p, buf);
  return p;
};
const anchorsOf = (buf: Buffer) => (extractSearchAnchors(buf) as { ok: true; anchors: SearchAnchors }).anchors;
const base = anchorsOf(bundle());

describe("agentAnchorsRefusal: the binary hostloop will spawn against the baseline's anchors", () => {
  it("a matching agent passes, whatever the baseline's recorded source", () => {
    expect(agentAnchorsRefusal(write(bundle()), base)).toBeNull();
    expect(agentAnchorsRefusal(write(bundle()), { ...base, source: "both" })).toBeNull();
  });

  it("a version change alone passes: other bytes differ, the anchors do not", () => {
    const bumped = Buffer.concat([Buffer.from('VERSION="2.1.999";BUILD="ffff";'), bundle(), Buffer.from("x".repeat(4096))]);
    expect(agentAnchorsRefusal(write(bumped), base)).toBeNull();
  });

  it("an anchor that differs refuses, naming the remedy", () => {
    const moved = bundle(callSite("A different prefix entirely: "));
    expect(agentAnchorsRefusal(write(moved), base)).toMatch(
      /different web-search anchors from the baseline's.*re-run `cowork-harness sync` with it staged/,
    );
  });

  it("a no-request template that differs refuses too (the whole block is compared)", () => {
    const nr = bundle(callSite(), noRequestSite({ both: "Error: some other both-lists message" }));
    expect(agentAnchorsRefusal(write(nr), base)).toMatch(/different web-search anchors/);
  });

  it("a binary whose anchors cannot be extracted refuses, and so does one that cannot be read", () => {
    expect(agentAnchorsRefusal(write(Buffer.from("not an agent")), base)).toMatch(/web-search anchors could not be read from it/);
    expect(agentAnchorsRefusal(join(tmpdir(), "no-such-agent-binary"), base)).toMatch(/could not be read/);
  });

  it("never quotes agent text in the refusal", () => {
    const moved = bundle(callSite("A different prefix entirely: "));
    const why = agentAnchorsRefusal(write(moved), base);
    expect(why).toMatch(/different web-search anchors/);
    expect(why).not.toContain("A different prefix");
  });
});

// Local only: the backed-up agents. The newest baseline is loaded inside these suites, so a failure to load it fails
// them and not the synthetic suite above.
const backup = (v: string) => ({
  native: join(homedir(), `cowork-agent-backup/${v}/claude.app/Contents/MacOS/claude`),
  elf: join(homedir(), `cowork-agent-backup/vm-elf/${v}/claude`),
});

describe("agentAnchorsRefusal against the newest baseline's agent (local only)", () => {
  let latest: ReturnType<typeof loadBaseline>;
  let at: ReturnType<typeof backup>;
  beforeAll(() => {
    latest = loadBaseline("latest");
    at = backup(latest.agentVersion);
  });
  it("its native agent passes against the anchors sync extracts from its VM agent, and against the baseline's block", (ctx) => {
    if (!existsSync(at.native) || !existsSync(at.elf)) ctx.skip();
    expect(agentAnchorsRefusal(at.native, anchorsOf(readFileSync(at.elf)))).toBeNull();
    expect(agentAnchorsRefusal(at.native, latest.agentBinary!.searchAnchors!)).toBeNull();
  });
  it("the native 2.1.295 agent is refused against the baseline's block (2.1.299 reworded the system sentence)", (ctx) => {
    const old = backup("2.1.295").native;
    if (!existsSync(old) || latest.agentVersion === "2.1.295") ctx.skip();
    expect(agentAnchorsRefusal(old, latest.agentBinary!.searchAnchors!)).toMatch(/different web-search anchors/);
  });
});

// Pinned on purpose: 2.1.293 and 2.1.295 are two versions measured to give the same anchors.
describe.skipIf(!existsSync(backup("2.1.295").native) || !existsSync(backup("2.1.293").elf))(
  "agentAnchorsRefusal across a version change (local only)",
  () => {
    it("the native 2.1.295 agent passes against 2.1.293's anchors: a version change alone never refuses", () => {
      expect(agentAnchorsRefusal(backup("2.1.295").native, anchorsOf(readFileSync(backup("2.1.293").elf)))).toBeNull();
    });
  },
);
