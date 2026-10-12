import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractSearchAnchors, searchAnchorsForSync, SEARCH_ANCHOR_CALL_SITE } from "../src/sync/search-anchors.js";
import { AgentSearchGates, PlatformBaseline, SearchAnchors } from "../src/types.js";
import { buildNextAgentBinary, loadBaseline } from "../src/baseline.js";
import { readdirSync } from "node:fs";

// A synthetic agent bundle. The prose is invented here; only the code SHAPE mirrors the agent's nested-search call
// site (one user message built from a prefix literal plus the query, one system-prompt literal, the server tool
// type, and the querySource marker), and the CCR worker route.
const PREFIX = "Look this up on the web please: ";
const SENTENCE = "You are a pretend assistant that searches.";
const callSite = (prefix = PREFIX, sentence = SENTENCE) =>
  `let v=xe({content:"${prefix}"+h}),R={type:"web_search_20250305",name:"web_search",max_uses:8},` +
  `H=Qwt({messages:[v],systemPrompt:ki(["${sentence}"]),thinkingConfig:{type:"disabled"},tools:[],` +
  `options:{toolChoice:{type:"tool",name:"web_search"},extraToolSchemas:[R],${SEARCH_ANCHOR_CALL_SITE},enablePromptCaching:!1}})`;
const ccr =
  'he=Y?.replace(/\\/+$/,"")??`${q}/v1/code/sessions/${encodeURIComponent(INe(e))}`;be=await Rt.post(`${he}/worker/${n}`,y);' +
  'let Q=await ko(f.session,h,n),r="web-search"';
// The string table holds a second copy of literals, far from the call site.
const stringTable = `\0web_search_20250305\0${PREFIX}\0${SENTENCE}\0`;
const pad = (n: number) => "x".repeat(n);
const bundle = (site = callSite()) => Buffer.from(stringTable + pad(20000) + ccr + pad(9000) + site + pad(500));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("extractSearchAnchors", () => {
  it("extracts hashes and byte lengths, never the text", () => {
    const r = extractSearchAnchors(bundle());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anchors.systemSentence).toEqual({ sha256: sha(SENTENCE), bytes: Buffer.byteLength(SENTENCE) });
    expect(r.anchors.userPrefix).toEqual({ sha256: sha(PREFIX), bytes: Buffer.byteLength(PREFIX) });
    expect(r.anchors.toolType).toBe("web_search_20250305");
    expect(r.anchors.ccr).toEqual({ sessionsPath: "/v1/code/sessions/", workerPath: "/worker/", searchRoute: "web-search" });
    expect(SearchAnchors.safeParse(r.anchors).success).toBe(true);
    expect(JSON.stringify(r.anchors)).not.toContain(SENTENCE);
    expect(JSON.stringify(r.anchors)).not.toContain(PREFIX.trim());
  });

  it("ignores the string-table copies outside the call site", () => {
    const r = extractSearchAnchors(bundle());
    expect(r.ok).toBe(true);
  });

  it("fails when the call-site marker is missing or appears twice", () => {
    const none = extractSearchAnchors(Buffer.from(stringTable + ccr));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.defects.join("\n")).toMatch(/querySource/);
    const twice = extractSearchAnchors(Buffer.concat([bundle(), Buffer.from(callSite())]));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.defects.join("\n")).toMatch(/2 matches/);
  });

  it("fails when an anchor inside the call site vanishes or is ambiguous", () => {
    const noPrefix = callSite().replace(/xe\(\{content:"[^"]*"\+h\}\)/, "xe({content:h})");
    const r1 = extractSearchAnchors(bundle(noPrefix));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.defects.join("\n")).toMatch(/userPrefix/);
    const twoSystems = callSite().replace("systemPrompt:ki([", 'systemPrompt:ki(["another one"]),systemPrompt:ki([');
    const r2 = extractSearchAnchors(bundle(twoSystems));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.defects.join("\n")).toMatch(/systemSentence/);
    const noType = callSite().replace('type:"web_search_20250305"', 'type:"code_execution_1"');
    const r3 = extractSearchAnchors(bundle(noType));
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.defects.join("\n")).toMatch(/toolType/);
  });

  it("locates the sessions base only just before the worker route", () => {
    const many = Buffer.from("`${q}/v1/code/sessions/${a}/x`;".repeat(5) + bundle().toString());
    expect(extractSearchAnchors(many).ok).toBe(true);
    const moved = extractSearchAnchors(Buffer.from(bundle().toString().replace("/v1/code/sessions/${encode", "/v1/other/${encode")));
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.defects.join("\n")).toMatch(/ccr\.sessionsPath/);
  });

  it("fails when the search route vanishes or appears twice, in either quote", () => {
    const gone = extractSearchAnchors(Buffer.from(bundle().toString().replace('"web-search"', '"web-find"')));
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.defects.join("\n")).toMatch(/ccr\.searchRoute: 0/);
    const twice = extractSearchAnchors(Buffer.from(bundle().toString() + "`web-search`"));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.defects.join("\n")).toMatch(/ccr\.searchRoute: 2/);
  });

  it("fails when the tool type appears twice in the call site, even with the same value", () => {
    const r = extractSearchAnchors(bundle(callSite().replace("max_uses:8}", 'max_uses:8,x:{type:"web_search_20250305"}}')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defects.join("\n")).toMatch(/toolType: 2/);
  });

  it("never captures a template literal with a substitution", () => {
    const site = callSite().replace(`["${SENTENCE}"]`, "[`Search for ${x} now please`]");
    const r = extractSearchAnchors(bundle(site));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defects.join("\n")).toMatch(/systemSentence: 0/);
  });

  it("fails when a CCR anchor vanishes", () => {
    const r = extractSearchAnchors(Buffer.from(bundle().toString().replace("/worker/${n}", "/w/${n}")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defects.join("\n")).toMatch(/ccr\.workerPath/);
  });

  it("refuses a non-ASCII literal (byte length and code-unit length would differ)", () => {
    const r = extractSearchAnchors(bundle(callSite(PREFIX, "Vous êtes un assistant.")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.defects.join("\n")).toMatch(/ASCII/);
  });

  it("reads a backtick-quoted literal the same as a double-quoted one", () => {
    const site = callSite().replace(`"${PREFIX}"`, `\`${PREFIX}\``).replace(`["${SENTENCE}"]`, `[\`${SENTENCE}\`]`);
    const r = extractSearchAnchors(bundle(site));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.anchors.systemSentence.sha256).toBe(sha(SENTENCE));
  });
});

describe("searchAnchorsForSync — sync's decision (warnings, never write-blocking, while nothing reads the anchors)", () => {
  const good = bundle();
  const anchors = (extractSearchAnchors(good) as { ok: true; anchors: SearchAnchors }).anchors;
  const other = { ...anchors, userPrefix: { ...anchors.userPrefix, bytes: anchors.userPrefix.bytes + 1 } };
  const none = { sameVersionAsBase: false, base: undefined };

  it("records the ELF's anchors when the native agent agrees", () => {
    expect(searchAnchorsForSync({ elf: good, native: good, ...none })).toEqual({ anchors, warnings: [] });
  });
  it("records NO anchors and warns when the staged ELF's anchors cannot be extracted, even with a base to carry", () => {
    const r = searchAnchorsForSync({ elf: Buffer.from("no call site"), native: null, sameVersionAsBase: true, base: anchors });
    expect(r.anchors).toBeUndefined();
    expect(r.warnings.join("\n")).toMatch(/searchAnchors not recorded: querySource/);
  });
  it("records NO anchors when the native agent differs, cannot be extracted, or cannot be read", () => {
    const changed = bundle(callSite("Some other prefix text here: "));
    for (const [native, msg] of [
      [changed, /differ from the VM ELF/],
      [Buffer.from("nothing"), /could not be extracted/],
      [{ unreadable: "EACCES" }, /could not be read \(EACCES\)/],
    ] as const) {
      const r = searchAnchorsForSync({ elf: good, native, ...none });
      expect(r.anchors).toBeUndefined();
      expect(r.warnings.join("\n")).toMatch(msg);
    }
  });
  it("carries the base's anchors only for the same agent version when the ELF is not staged", () => {
    expect(searchAnchorsForSync({ elf: null, native: null, sameVersionAsBase: true, base: other })).toEqual({
      anchors: other,
      warnings: [],
    });
    expect(searchAnchorsForSync({ elf: null, native: null, sameVersionAsBase: false, base: other })).toEqual({
      anchors: undefined,
      warnings: [],
    });
  });
});

describe("committed baselines: the search blocks parse strictly (non-vacuous on the newest)", () => {
  const dir = join(process.cwd(), "baselines");
  const files = readdirSync(dir).filter((f) => /^desktop-.*\.json$/.test(f));
  it.each(files)("%s", (f) => {
    const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
      agentBinary?: { searchAnchors?: unknown };
      provenance?: { agentSearchGates?: unknown };
    };
    if (b.agentBinary?.searchAnchors !== undefined) expect(SearchAnchors.safeParse(b.agentBinary.searchAnchors).success).toBe(true);
    if (b.provenance?.agentSearchGates !== undefined) expect(AgentSearchGates.safeParse(b.provenance.agentSearchGates).success).toBe(true);
  });
  it("the newest baseline carries both blocks", () => {
    const newest = loadBaseline("latest") as unknown as {
      agentBinary?: { searchAnchors?: unknown };
      provenance?: { agentSearchGates?: unknown };
    };
    expect(newest.agentBinary?.searchAnchors).toBeDefined();
    expect(newest.provenance?.agentSearchGates).toBeDefined();
  });
});

describe("sync wiring (source text): every anchor path goes through searchAnchorsForSync, and its warnings print", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
  it("prints the helper's warnings as notes", () => {
    expect(cli).toContain("res.notes.push(...anchored.warnings.map((w) => `WARNING: ${w}`));");
  });
  it("never assigns the base's anchors outside the helper", () => {
    expect(cli).not.toMatch(/searchAnchors = baseSearchAnchors/);
    expect(cli.match(/searchAnchorsForSync\(/g)?.length).toBe(1);
  });
  it("writes the helper's anchors", () => {
    expect(cli).toMatch(/const searchAnchors = anchored\.anchors;/);
    expect(cli).toMatch(/buildNextAgentBinary\([\s\S]{0,800}searchAnchors,\n/);
  });
});

describe("agentBinary.searchAnchors schema", () => {
  const anchors = (extractSearchAnchors(bundle()) as { ok: true; anchors: SearchAnchors }).anchors;
  it("round-trips through PlatformBaseline (not stripped by the inner z.object)", () => {
    const base = loadBaseline("latest") as unknown as Record<string, unknown>;
    const reparsed = PlatformBaseline.parse({ ...base, agentBinary: { ...(base.agentBinary as object), searchAnchors: anchors } });
    expect(reparsed.agentBinary?.searchAnchors).toEqual(anchors);
  });
  it("rejects any extra field, so no literal text can be published through it", () => {
    expect(SearchAnchors.safeParse({ ...anchors, systemSentence: { ...anchors.systemSentence, text: "x" } }).success).toBe(false);
    expect(SearchAnchors.safeParse({ ...anchors, note: "x" }).success).toBe(false);
  });
  it("buildNextAgentBinary writes the measured anchors and never the base's", () => {
    const next = buildNextAgentBinary(
      { searchAnchors: { stale: true } },
      { stagedPath: "s", nativeStagedPath: "n", channel: null, releaseBaseUrl: null, searchAnchors: anchors },
    );
    expect(next.searchAnchors).toEqual(anchors);
    const dropped = buildNextAgentBinary(
      { searchAnchors: anchors },
      { stagedPath: "s", nativeStagedPath: "n", channel: null, releaseBaseUrl: null },
    );
    expect(dropped.searchAnchors).toBeUndefined();
  });
});

// Local only: every backed-up agent ELF. Measured 2026-10-12: 2.1.260 through 2.1.295 all give the same anchors.
const VM_ELFS = join(homedir(), "cowork-agent-backup/vm-elf");
describe.skipIf(!existsSync(VM_ELFS))("extractSearchAnchors over the backed-up agents (local only)", () => {
  it("extracts from every backed-up ELF, and the anchors have not moved", () => {
    const seen = new Set<string>();
    for (const v of readdirSync(VM_ELFS)) {
      const p = join(VM_ELFS, v, "claude");
      if (!existsSync(p)) continue;
      const r = extractSearchAnchors(readFileSync(p));
      expect(r.ok ? [] : r.defects, v).toEqual([]);
      if (r.ok) seen.add(JSON.stringify(r.anchors));
    }
    expect(seen.size).toBe(1);
  });
});

// Local only: the real staged agent. Skips when the binary is absent (CI). Prints nothing from the binary.
const ELF = process.env.COWORK_SEARCH_ANCHOR_ELF ?? join(homedir(), "cowork-agent-backup/vm-elf/2.1.295/claude");
describe.skipIf(!existsSync(ELF))("extractSearchAnchors on the real agent", () => {
  it("finds every anchor exactly once", () => {
    const r = extractSearchAnchors(readFileSync(ELF));
    expect(r.ok ? [] : r.defects).toEqual([]);
    if (!r.ok) return;
    expect(r.anchors.toolType).toMatch(/^web_search_/);
    expect(r.anchors.userPrefix.bytes).toBeGreaterThan(10);
    expect(r.anchors.systemSentence.bytes).toBeGreaterThan(20);
  });
});
