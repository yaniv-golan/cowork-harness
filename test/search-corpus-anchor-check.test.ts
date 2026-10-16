import { describe, it, expect } from "vitest";
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

// Local only: the real native agent against the anchors sync extracts from the VM agent of the same version.
const NATIVE = join(homedir(), "cowork-agent-backup/2.1.295/claude.app/Contents/MacOS/claude");
const ELF = join(homedir(), "cowork-agent-backup/vm-elf/2.1.295/claude");
const OLDER = join(homedir(), "cowork-agent-backup/vm-elf/2.1.293/claude");
describe.skipIf(!existsSync(NATIVE) || !existsSync(ELF))("agentAnchorsRefusal on the real agents (local only)", () => {
  it("the native 2.1.295 agent passes against 2.1.295's anchors, and against 2.1.293's (a version change alone never refuses)", () => {
    expect(agentAnchorsRefusal(NATIVE, anchorsOf(readFileSync(ELF)))).toBeNull();
    if (existsSync(OLDER)) expect(agentAnchorsRefusal(NATIVE, anchorsOf(readFileSync(OLDER)))).toBeNull();
  });
});

// The newest committed baseline's block, the object a real run passes, against the backed-up native agent of that
// baseline's own version. 2.1.299 rewords the search request's system sentence, so 2.1.295 against it must refuse.
const latest = loadBaseline("latest");
const LATEST_NATIVE = join(homedir(), `cowork-agent-backup/${latest.agentVersion}/claude.app/Contents/MacOS/claude`);
describe.skipIf(!existsSync(LATEST_NATIVE))("agentAnchorsRefusal against the newest baseline (local only)", () => {
  it("the newest baseline's own native agent passes against its block", () => {
    expect(agentAnchorsRefusal(LATEST_NATIVE, latest.agentBinary!.searchAnchors!)).toBeNull();
  });
  it.skipIf(!existsSync(NATIVE) || latest.agentVersion === "2.1.295")("the native 2.1.295 agent is refused against it", () => {
    expect(agentAnchorsRefusal(NATIVE, latest.agentBinary!.searchAnchors!)).toMatch(/different web-search anchors/);
  });
});
