import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractSearchAnchors, searchAnchorsForSync, searchAnchorsRefusal, SEARCH_ANCHOR_CALL_SITE } from "../src/sync/search-anchors.js";
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
// The no-request templates sit in the same tool definition, before the nested-search call site: two fixed
// validateInput messages and the budget-cap template (fixed P1, the turn|session variable, fixed P2, then variables).
// Constructed from the shape at the 2.1.295 offsets; the prose is invented.
const MISSING = "Error: nothing to look up";
const BOTH = "Error: pick one list of domains, not both";
const P1 = "Search skipped: this ";
const P2 = " has spent its search allowance (";
const noRequestSite = (o: { missing?: string; both?: string; p1?: string; p2?: string; scope?: string } = {}) =>
  `async validateInput(r){let{query:n,allowed_domains:s,blocked_domains:f}=r;if(!n.length)return{result:!1,message:"${o.missing ?? MISSING}",errorCode:1};` +
  `if(s?.length&&f?.length)return{result:!1,message:"${o.both ?? BOTH}",errorCode:2};return{result:!0}},` +
  `async call(r){let w=f.taskRegistry.getWebSearchBudget();if(!w.tryConsume()){let te=ve()${o.scope ?? '?"turn":"session"'},dn=1;` +
  "return{data:{query:h,results:[`" +
  (o.p1 ?? P1) +
  "${te}" +
  (o.p2 ?? P2) +
  "${dn}). more ${mn}`]}}}}";
// The string table holds a second copy of literals, far from the call site.
const stringTable = `\0web_search_20250305\0${PREFIX}\0${SENTENCE}\0`;
const pad = (n: number) => "x".repeat(n);
const bundle = (site = callSite(), nr = noRequestSite()) =>
  Buffer.from(stringTable + pad(20000) + ccr + pad(9000) + nr + pad(1200) + site + pad(500));
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

  it("extracts the no-request templates as hashes, never the text", () => {
    const r = extractSearchAnchors(bundle());
    if (!r.ok) throw new Error(r.defects.join("; "));
    const h = (t: string) => ({ sha256: sha(t), bytes: Buffer.byteLength(t) });
    expect(r.anchors.noRequest).toEqual({ missingQuery: h(MISSING), bothDomainLists: h(BOTH), budgetPrefix: h(P1), budgetFragment: h(P2) });
    for (const t of [MISSING, BOTH, P1.trim(), P2.trim()]) expect(JSON.stringify(r.anchors)).not.toContain(t);
  });

  it("fails when a no-request template moves, vanishes or changes shape", () => {
    const fails = (nr: string) => {
      const r = extractSearchAnchors(bundle(callSite(), nr));
      return r.ok ? [] : r.defects;
    };
    expect(fails(noRequestSite().replace("errorCode:1", "errorCode:9"))).toEqual([
      expect.stringMatching(/^noRequest\.missingQuery: 0 matches/),
    ]);
    expect(fails(noRequestSite().replace("errorCode:2", "errorCode:9"))).toEqual([
      expect.stringMatching(/^noRequest\.bothDomainLists: 0 matches/),
    ]);
    expect(fails(noRequestSite().replace("results:[`", 'results:["'))).toEqual([expect.stringMatching(/^noRequest\.budget: 0 matches/)]);
    // the variable after P1 must be the turn|session choice
    expect(fails(noRequestSite({ scope: '?"a":"b"' }))).toEqual([expect.stringMatching(/^noRequest\.budget: .*turn.*session/)]);
    // the older, session-only template (2.1.260-2.1.289): a count where the turn|session word now is
    const older = fails(noRequestSite({ scope: "", p2: " of " }).replace("${te}", "${S}"));
    expect(older).toHaveLength(1);
    expect(older[0]).toContain("predates the supported template");
    expect(older[0]).toContain("update Claude Desktop, or pass --allow-missing-search-anchors");
    // an escape inside a fixed segment would make the wire bytes differ from the binary's
    expect(fails(noRequestSite({ p1: "Search \\n skipped: " }))).toEqual([expect.stringMatching(/^noRequest\.budget/)]);
    // too far before the call site to be the same tool
    const far = Buffer.from(stringTable + pad(20000) + ccr + pad(9000) + noRequestSite() + pad(9000) + callSite() + pad(500));
    expect(extractSearchAnchors(far).ok).toBe(false);
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

describe("searchAnchorsForSync — the decision table (refuse = sync's own refusal; the running binary is the native)", () => {
  const good = bundle();
  const anchors = (extractSearchAnchors(good) as { ok: true; anchors: SearchAnchors }).anchors;
  const changed = bundle(callSite("Some other prefix text here: "));
  const changedAnchors = (extractSearchAnchors(changed) as { ok: true; anchors: SearchAnchors }).anchors;
  const broken = Buffer.from("no call site");
  const unreadable = { unreadable: "EACCES" };
  const V = "2.1.300";
  const call = (o: Partial<Parameters<typeof searchAnchorsForSync>[0]>) =>
    searchAnchorsForSync({ elf: good, native: good, elfVersion: V, nativeVersion: V, baseAgentVersion: V, base: undefined, ...o });

  it("ELF ok + native ok, equal, same version: recorded, source both", () => {
    expect(call({})).toEqual({ anchors: { ...anchors, source: "both" }, notes: [], refuse: null });
  });
  it("ELF ok + native ok, equal, different versions: the native's, with a note naming the ELF version that agreed", () => {
    const r = call({ nativeVersion: "2.1.301" });
    expect(r.anchors).toEqual({ ...anchors, source: "native" });
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/VM agent 2\.1\.300 agreed/);
  });
  it("ELF ok + native ok, different anchors, same version: refuse", () => {
    const r = call({ native: changed });
    expect(r.anchors).toBeUndefined();
    expect(r.refuse).toMatch(/differ/);
  });
  it("ELF ok + native ok, different anchors, different versions: the native's, with a note", () => {
    const r = call({ native: changed, nativeVersion: "2.1.301" });
    expect(r.anchors).toEqual({ ...changedAnchors, source: "native" });
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/VM agent 2\.1\.300.*differ/);
  });
  it("ELF ok + native extract-fails or unreadable, either version relation: refuse (the running binary)", () => {
    for (const native of [broken, unreadable])
      for (const nativeVersion of [V, "2.1.301"]) {
        const r = call({ native, nativeVersion });
        expect(r.anchors).toBeUndefined();
        expect(r.refuse).toMatch(/native agent/);
      }
  });
  it("ELF ok + native absent: the ELF's, source elf, with a note that hostloop cannot run", () => {
    const r = call({ native: null, nativeVersion: null });
    expect(r.anchors).toEqual({ ...anchors, source: "elf" });
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/no native agent is staged/);
  });
  it("ELF extract-fails or unreadable + native ok: different versions → the native's with a note; same version → refuse", () => {
    for (const elf of [broken, unreadable]) {
      const skew = call({ elf, nativeVersion: "2.1.301" });
      expect(skew.anchors).toEqual({ ...anchors, source: "native" });
      expect(skew.refuse).toBeNull();
      expect(skew.notes.join("\n")).toMatch(/VM agent 2\.1\.300/);
      const same = call({ elf });
      expect(same.anchors).toBeUndefined();
      expect(same.refuse).toMatch(/VM agent/);
    }
  });
  it("ELF extract-fails or unreadable + native extract-fails, unreadable or absent: refuse", () => {
    for (const elf of [broken, unreadable])
      for (const native of [broken, unreadable, null]) {
        const r = call({ elf, native, nativeVersion: native === null ? null : V });
        expect(r.anchors).toBeUndefined();
        expect(r.refuse).not.toBeNull();
      }
  });
  it("no ELF + native ok: the native's, source native, with a note", () => {
    const r = call({ elf: null });
    expect(r.anchors).toEqual({ ...anchors, source: "native" });
    expect(r.refuse).toBeNull();
    expect(r.notes.join("\n")).toMatch(/no VM agent is staged/);
  });
  it("no ELF + native extract-fails: refuse", () => {
    const r = call({ elf: null, native: broken });
    expect(r.anchors).toBeUndefined();
    expect(r.refuse).toMatch(/native agent/);
  });
  it("no ELF + no readable native, same version, base has anchors: carried with the base's source, a note naming the VM version", () => {
    for (const native of [unreadable, null]) {
      const base = { ...anchors, source: "both" as const };
      const r = call({ elf: null, native, nativeVersion: null, base });
      expect(r.anchors).toEqual(base);
      expect(r.refuse).toBeNull();
      expect(r.notes.join("\n")).toMatch(/carried from the base for agent version 2\.1\.300/);
    }
  });
  it("no ELF + no readable native, same version, base WITHOUT anchors: refuse (never a silent anchorless write)", () => {
    const r = call({ elf: null, native: null, nativeVersion: null, base: undefined });
    expect(r.anchors).toBeUndefined();
    expect(r.refuse).toMatch(/no anchors to carry/);
  });
  it("no ELF + no readable native, changed version: refuse", () => {
    const r = call({ elf: null, native: null, nativeVersion: null, baseAgentVersion: "2.1.295", base: anchors });
    expect(r.anchors).toBeUndefined();
    expect(r.refuse).toMatch(/2\.1\.300/);
  });
  it("never puts a literal's text in a note or a refusal", () => {
    const all = [call({}), call({ native: changed }), call({ elf: null, native: null, nativeVersion: null })];
    for (const r of all) expect(JSON.stringify(r)).not.toContain(SENTENCE);
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

describe("searchAnchorsRefusal: sync's own refusal, its named override, and --diff", () => {
  const why = "agentBinary.searchAnchors: the native agent 2.1.300 its anchors could not be extracted (x)";
  it("nothing to refuse: nothing to print, nothing to fail", () => {
    expect(searchAnchorsRefusal(null, { diff: false, allow: false })).toEqual({ fail: null, log: null });
    expect(searchAnchorsRefusal(null, { diff: true, allow: true })).toEqual({ fail: null, log: null });
  });
  it("refuses with the reason, naming its own override and not --allow-empty as the remedy", () => {
    const r = searchAnchorsRefusal(why, { diff: false, allow: false });
    expect(r.log).toBeNull();
    expect(r.fail).toContain(why);
    expect(r.fail).toContain("--allow-missing-search-anchors");
    expect(r.fail).toMatch(/--allow-empty does not/);
  });
  it("--allow-missing-search-anchors writes, with a WARNING naming the defect", () => {
    const r = searchAnchorsRefusal(why, { diff: false, allow: true });
    expect(r.fail).toBeNull();
    expect(r.log).toMatch(/^WARNING: /);
    expect(r.log).toContain(why);
  });
  it("--diff reports it as 'would refuse' and does not fail, with or without the override", () => {
    for (const allow of [false, true]) {
      const r = searchAnchorsRefusal(why, { diff: true, allow });
      expect(r.fail).toBeNull();
      expect(r.log).toMatch(/would refuse/);
      expect(r.log).toContain(why);
    }
  });
});

describe("sync wiring (source text): every anchor path goes through searchAnchorsForSync, and its refusal is its own path", () => {
  const cli = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
  it("prints the helper's notes", () => {
    expect(cli).toContain("res.notes.push(...anchored.notes);");
  });
  it("passes both versions: the VM agent's and the native's own", () => {
    expect(cli).toMatch(
      /searchAnchorsForSync\(\{[\s\S]{0,600}elfVersion: res\.agentVersion,[\s\S]{0,200}nativeVersion: nativeDerived\.version,/,
    );
  });
  it("reads the ELF through the same unreadable wrap as the native (an EACCES ELF is never an uncaught throw)", () => {
    expect(cli).toMatch(/const elfStaged = stagedForAnchors\(resolvedDerived\);/);
    expect(cli).toMatch(/elf: elfStaged,/);
    // Every other reader of the ELF takes the one buffer, so an unreadable ELF cannot throw before the table sees it.
    expect(cli).not.toMatch(/sha256File\(resolvedDerived\)|countStringInFile\(resolvedDerived|cliCapabilitiesOfFile\(resolvedDerived\)/);
    expect(cli.indexOf("const elfStaged = stagedForAnchors(resolvedDerived);")).toBeLessThan(
      cli.indexOf('shaProvenance: "measured-local"'),
    );
    expect(cli).toMatch(/native: stagedForAnchors\(nativeResolved\),/);
  });
  it("never assigns the base's anchors outside the helper", () => {
    expect(cli).not.toMatch(/searchAnchors = baseSearchAnchors/);
    expect(cli.match(/searchAnchorsForSync\(/g)?.length).toBe(1);
  });
  it("writes the helper's anchors", () => {
    expect(cli).toMatch(/const searchAnchors = anchored\.anchors;/);
    expect(cli).toMatch(/buildNextAgentBinary\([\s\S]{0,800}searchAnchors,\n/);
  });
  it("routes the refusal through searchAnchorsRefusal after the --diff decision, never into unknownDeltas, and before the write", () => {
    expect(cli).not.toMatch(/unknownDeltas\.push\([^)]*anchored/);
    const at = cli.indexOf("searchAnchorsRefusal(anchored.refuse");
    expect(at).toBeGreaterThan(cli.indexOf('const diffFlag = !!syncParsed.flags["--diff"];'));
    expect(at).toBeLessThan(cli.indexOf("writeFileSync(baselinePath, JSON.stringify(next, null, 2));"));
    expect(cli).toMatch(/allow: !!syncParsed\.flags\["--allow-missing-search-anchors"\]/);
    // the refusal fails the command (exit 1) and the override's warning / the --diff line print
    const block = cli.slice(at, cli.indexOf("writeFileSync(baselinePath, JSON.stringify(next, null, 2));"));
    expect(block).toMatch(/if \(r\.fail\) return fail\("sync", "runtime", r\.fail, undefined, isJsonOutput\(normalizedArgs\), 1\);/);
    expect(block).toMatch(/if \(r\.log\) log\(/);
  });
  it("parses the flag as a sync boolean", () => {
    expect(cli).toMatch(/booleans: \[[^\]]*"--allow-missing-search-anchors"[^\]]*\]/);
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

// Local only: every backed-up agent ELF. Measured 2026-10-13: 2.1.293 and 2.1.295 give the same anchors. 2.1.260
// through 2.1.289 carry an older, session-only budget template with no turn|session choice, so they refuse with that
// one defect (their other anchors are unchanged); no shipped baseline pins one of them with anchors.
const VM_ELFS = join(homedir(), "cowork-agent-backup/vm-elf");
const atLeast = (v: string, min: string) => {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
};
describe.skipIf(!existsSync(VM_ELFS))("extractSearchAnchors over the backed-up agents (local only)", () => {
  it("extracts from every backed-up ELF from 2.1.293, and the anchors have not moved; older ones refuse on the budget template only", () => {
    const seen = new Set<string>();
    let older = 0;
    for (const v of readdirSync(VM_ELFS)) {
      const p = join(VM_ELFS, v, "claude");
      if (!existsSync(p) || !/^\d+\.\d+\.\d+$/.test(v)) continue;
      const r = extractSearchAnchors(readFileSync(p));
      if (atLeast(v, "2.1.293")) {
        expect(r.ok ? [] : r.defects, v).toEqual([]);
        if (r.ok) seen.add(JSON.stringify(r.anchors));
      } else {
        older++;
        expect(r.ok ? [] : r.defects, v).toEqual([expect.stringMatching(/^noRequest\.budget: .*turn\|session/)]);
      }
    }
    expect(seen.size).toBe(1);
    expect(older).toBeGreaterThan(0);
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
