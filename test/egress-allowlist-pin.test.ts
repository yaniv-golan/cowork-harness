import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkEgressContractFacts,
  readPinnedAllowDomains,
  syncedNetworkBlock,
  NETWORK_ALLOWDOMAINS_COMMENT,
} from "../src/sync/cowork-sync.js";
import { loadBaseline } from "../src/baseline.js";
import { PlatformBaseline } from "../src/types.js";

/**
 * `network.allowDomains` is a PINNED list, not a derived one: on the first-party deployment the
 * harness models, the VM egress allowlist is server-delivered and absent from the asar. These tests
 * pin (a) the sentinels that make pinning safe and (b) the carry-forward reader.
 *
 * Regression origin: Desktop 1.34493.1 added a webview first-party-origin classifier naming
 * `www.claude.ai` / `staging.claude.ai`. The old bundle-wide domain regex swept those into the
 * ENFORCED allowlist — a false-green that would have let the harness permit egress Cowork denies.
 */

// A synthetic bundle carrying the three binary-verified egress facts, in the minified shape the real
// asar emits (1.34493.1): the 1p null policy, the 3p policy it is distinguished from, the resolver
// whose ternary falls through to its first argument, and the OTLP-only augmenter.
const ok =
  "sessionEnvVars(){return{}}vmEgressPolicy(){return null}async writeSessionSecrets(){return{env:{}}}" +
  'vmEgressPolicy(){let e=$l().workspace.allowedEgressHosts??[];return e.includes("*")?{kind:"unrestricted"}:' +
  '{kind:"allowlist",domains:[...this.provider.vmAllowedDomains(),...e]}}' +
  "async resolveVmAllowedDomains(e,n){let r=t.Qh().vmEgressPolicy(),i=r?t.$h(r):e;return t.Wc(i,n)}" +
  'async function Men(e,t){if(!t?.endpoint||!e||e.includes("*"))return e;try{let n=await Oen(t.endpoint),' +
  'r=new URL(n).hostname;if(r&&!e.includes(r))return D.info("Appending OTLP endpoint host to egress allowlist %o",' +
  "{otlpHost:r}),[...e,r]}catch(e){}return e}";

describe("checkEgressContractFacts (guards the pinned allowDomains)", () => {
  it("returns no flags when every egress fact is present", () => {
    expect(checkEgressContractFacts(ok)).toEqual([]);
  });

  it("flags when the 1p policy stops returning null (1p egress may no longer be server-delivered)", () => {
    const drifted = ok.replace("vmEgressPolicy(){return null}", "vmEgressPolicy(){return this.p()}");
    expect(checkEgressContractFacts(drifted).some((f) => f.includes("1p"))).toBe(true);
  });

  it("flags when the resolver stops falling through to its first argument", () => {
    // The load-bearing fact: policy falsy (1p) => use the caller-supplied server list.
    const drifted = ok.replace("i=r?t.$h(r):e;", "i=r?t.$h(r):[];");
    expect(checkEgressContractFacts(drifted).some((f) => f.includes("resolveVmAllowedDomains"))).toBe(true);
  });

  describe("the three-parameter resolver (Desktop 2.37337.1)", () => {
    // A set policy plus a host-run CLI skips the OTLP host; a null policy still reaches the augmenter.
    const three = ok.replace(
      "async resolveVmAllowedDomains(e,n){let r=t.Qh().vmEgressPolicy(),i=r?t.$h(r):e;return t.Wc(i,n)}",
      "async resolveVmAllowedDomains(e,n,a){let r=t.Qh().vmEgressPolicy(),i=r?t.$h(r):e;return r&&a.cliRunsOnThisHost?i:t.Wc(i,n)}",
    );
    const flagged = (b: string) => checkEgressContractFacts(b).filter((f) => f.includes("resolveVmAllowedDomains"));

    it("admits the policy-only short-circuit", () => {
      expect(three).not.toBe(ok);
      expect(checkEgressContractFacts(three)).toEqual([]);
    });

    it("flags a short-circuit that no longer requires the policy (a null policy would skip the augmenter)", () => {
      expect(flagged(three.replace("return r&&a.cliRunsOnThisHost?", "return a.cliRunsOnThisHost?"))).not.toEqual([]);
    });

    it("flags a short-circuit keyed on another binding than the deployment policy", () => {
      expect(flagged(three.replace("return r&&a.cliRunsOnThisHost?", "return n&&a.cliRunsOnThisHost?"))).not.toEqual([]);
    });

    it("flags a short-circuit that returns a different list than the resolved one", () => {
      expect(flagged(three.replace("cliRunsOnThisHost?i:", "cliRunsOnThisHost?e:"))).not.toEqual([]);
    });

    it("still requires the null-policy fall-through to the first argument", () => {
      expect(flagged(three.replace("i=r?t.$h(r):e;", "i=r?t.$h(r):[];"))).not.toEqual([]);
    });
  });

  it("flags when the resolver returns a different binding than the ternary produced", () => {
    // Backreferences are what catch this: the shape still 'looks' right, but t.Wc gets `r`, not `i`.
    const drifted = ok.replace("return t.Wc(i,n)", "return t.Wc(r,n)");
    expect(checkEgressContractFacts(drifted).some((f) => f.includes("resolveVmAllowedDomains"))).toBe(true);
  });

  it("flags when the OTLP augmenter appends more than the endpoint host", () => {
    const drifted = ok.replace("[...e,r]", "[...e,r,q]");
    expect(checkEgressContractFacts(drifted).some((f) => f.includes("OTLP"))).toBe(true);
  });

  it("flags when the unrestricted short-circuit is removed", () => {
    const drifted = ok.replace('||!e||e.includes("*"))return e;', "||!e)return e;");
    expect(checkEgressContractFacts(drifted).some((f) => f.includes("OTLP"))).toBe(true);
  });

  it("tolerates `$`-initial minified callee names", () => {
    // 1.32885.1 S14b: the minifier assigns `$`-initial names; a `\w+` callee slot silently false-flags.
    const renamed = ok.replace("t.Qh()", "t.$q()").replace("t.$h(r)", "t.$z(r)").replace("t.Wc(i,n)", "t.$w(i,n)");
    expect(checkEgressContractFacts(renamed)).toEqual([]);
  });

  describe("the resolver's list wrapper (Desktop 2.9939.2's HIPAA all-domains filter)", () => {
    // The real wrapper's SHAPE, paraphrased hosts: identity unless the list holds `*` AND the org is
    // HIPAA-restricted; only then is `*` dropped and a fixed host list appended.
    const hipaa =
      'Object.defineProperty(exports,"TM",{enumerable:!0,get:function(){return Jan}});var qan="*";' +
      "function Jan(e){if(!e?.includes(qan)||!Jb())return e;let t=e.filter((e=>e!==qan));return[...new Set([...t,...jSe])]}" +
      'var jSe=["a.example.com"];function Jb(){return qb()==="restricted"}' +
      'function qb(){return Kb?"restricted":Vb("coworkHipaaRestricted")?(Kb=!0,"restricted"):"unrestricted"}';
    const wrapped = ok.replace("i=r?t.$h(r):e;", "i=t.TM(r?t.$h(r):e);") + hipaa;
    const flagged = (b: string) => checkEgressContractFacts(b).filter((f) => f.includes("resolveVmAllowedDomains"));

    it("admits the wrapper once it resolves to the identity-unless-HIPAA-and-* filter", () => {
      expect(checkEgressContractFacts(wrapped)).toEqual([]);
    });

    it("flags a wrapper that adds hosts unconditionally — the asar-side contribution the pin exists to catch", () => {
      const evil = wrapped.replace(
        "function Jan(e){if(!e?.includes(qan)||!Jb())return e;",
        'function Jan(e){return[...e,"evil.example.com"];',
      );
      expect(flagged(evil).join("\n")).toMatch(/not the HIPAA all-domains filter — its first statement/);
    });

    it("flags a guard that no longer requires BOTH the all-domains entry and the restriction", () => {
      const both = wrapped.replace("||!Jb())return e;", "&&!Jb())return e;");
      expect(flagged(both).join("\n")).toMatch(/its first statement/);
    });

    it("flags a guarded entry that is no longer `*`", () => {
      expect(flagged(wrapped.replace('var qan="*";', 'var qan="x";')).join("\n")).toMatch(/no longer the all-domains/);
    });

    it("flags a restriction reader that stops reading coworkHipaaRestricted", () => {
      const inert = wrapped.replace('Vb("coworkHipaaRestricted")?(Kb=!0,"restricted"):"unrestricted"', '"unrestricted"');
      expect(flagged(inert).join("\n")).toMatch(/no longer consults coworkHipaaRestricted/);
    });

    it("flags a wrapper it cannot resolve rather than admitting it", () => {
      expect(flagged(ok.replace("i=r?t.$h(r):e;", "i=t.ZZ(r?t.$h(r):e);")).join("\n")).toMatch(/could not be resolved/);
    });

    it("resolves `$`-initial wrapper, parameter and reader names", () => {
      const dollar = wrapped
        .replace("i=t.TM(", "i=t.$T(")
        .replace('"TM",{enumerable:!0,get:function(){return Jan}}', '"$T",{enumerable:!0,get:function(){return $an}}')
        .replace("function Jan(e){if(!e?.includes(qan)||!Jb())return e;", "function $an($e){if(!$e?.includes(qan)||!$b())return $e;")
        .replace("function Jb(){", "function $b(){");
      expect(checkEgressContractFacts(dollar)).toEqual([]);
    });
  });

  it("does NOT treat a bare claude.ai host literal as an egress fact", () => {
    // The whole point of the pin: a webview-trust host list must not influence the allowlist.
    const withClassifier =
      ok + 'var k6t=new Set(["claude.ai","www.claude.ai","preview.claude.ai"]);function N6t(e){return k6t.has(e)||e==="staging.claude.ai"}';
    expect(checkEgressContractFacts(withClassifier)).toEqual([]);
  });
});

describe("readPinnedAllowDomains (carry-forward of the hand-curated allowlist)", () => {
  const withBaselines = (files: Record<string, unknown>, fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "pin-allow-"));
    try {
      mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(files))
        writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const baseline = (domains: string[]) => ({ network: { mode: "gvisor", allowKind: "allowlist", allowDomains: domains } });

  it("carries the allowlist forward from the NEWEST baseline, numerically (not lexically)", () => {
    withBaselines(
      {
        "desktop-1.9.0.json": baseline(["old.example.com"]),
        "desktop-1.10.0.json": baseline(["new.example.com"]),
      },
      (dir) => {
        const unknown: string[] = [];
        // Lexical sort would pick 1.9.0; the version-aware sort must pick 1.10.0.
        expect(readPinnedAllowDomains(unknown, dir)).toEqual(["new.example.com"]);
        expect(unknown).toEqual([]);
      },
    );
  });

  it("fails closed (empty + unknown delta) when there is no baseline to carry forward", () => {
    withBaselines({}, (dir) => {
      const unknown: string[] = [];
      expect(readPinnedAllowDomains(unknown, dir)).toEqual([]);
      expect(unknown.some((f) => f.includes("no committed desktop-"))).toBe(true);
    });
  });

  it("fails closed on an unparseable baseline rather than silently emptying the allowlist", () => {
    withBaselines({ "desktop-1.0.0.json": "{not json" }, (dir) => {
      const unknown: string[] = [];
      expect(readPinnedAllowDomains(unknown, dir)).toEqual([]);
      expect(unknown.some((f) => f.includes("unreadable/unparseable"))).toBe(true);
    });
  });

  it("fails closed when the newest baseline carries no usable allowDomains[]", () => {
    withBaselines({ "desktop-1.0.0.json": { network: { allowDomains: [1, 2] } } }, (dir) => {
      const unknown: string[] = [];
      expect(readPinnedAllowDomains(unknown, dir)).toEqual([]);
      expect(unknown.some((f) => f.includes("no usable network.allowDomains"))).toBe(true);
    });
  });
});

describe("the pin documents itself, durably", () => {
  it("keeps network.$comment through the schema so the note survives the next sync", () => {
    // A strict z.object silently strips unknown keys. If `network` ever loses looseObject, the
    // explanation for why allowDomains is not derived evaporates on the next `sync` — and the next
    // maintainer sees an undocumented hand-edited list and 'fixes' it back into a bundle sweep.
    const parsed = PlatformBaseline.parse({
      baselineVersion: 1,
      appVersion: "1.0.0",
      agentVersion: "2.0.0",
      agentBinary: {},
      guest: { os: "linux", arch: "arm64" },
      mountLayout: { sessionRoot: "/s", cwd: "/s", mounts: [] },
      network: { $comment: "why this list is pinned", mode: "gvisor", allowKind: "allowlist", allowDomains: ["a.example.com"] },
    });
    expect((parsed.network as Record<string, unknown>).$comment).toBe("why this list is pinned");
  });

  it("a sync writes the generated note, not the previous baseline's", () => {
    const prior = { $comment: "a stale sentence from an older release", mode: "gvisor", allowKind: "allowlist", allowDomains: ["x"] };
    const net = syncedNetworkBlock(prior, null, ["a.example.com"]);
    expect(net.$comment).toBe(NETWORK_ALLOWDOMAINS_COMMENT);
    expect(net.allowDomains).toEqual(["a.example.com"]);
    expect(Object.keys(net)[0], "key order is carried from the prior block, so the diff stays a one-line change").toBe("$comment");
  });

  it("the generated note states the HIPAA wrapper instead of claiming OTLP is the only bundle-side host", () => {
    expect(NETWORK_ALLOWDOMAINS_COMMENT).toMatch(/PINNED/);
    expect(NETWORK_ALLOWDOMAINS_COMMENT).toMatch(/egressAllowedDomains/);
    expect(NETWORK_ALLOWDOMAINS_COMMENT).toMatch(/HIPAA/);
    expect(NETWORK_ALLOWDOMAINS_COMMENT).not.toMatch(/the only host the bundle contributes/);
  });

  it("the committed newest baseline actually carries the provenance note", () => {
    const net = loadBaseline("latest").network as unknown as Record<string, unknown>;
    const note = String(net.$comment ?? "");
    expect(note).toMatch(/PINNED/);
    // The note must say WHERE the real list comes from, not merely that it is hand-edited.
    expect(note).toMatch(/egressAllowedDomains/);
  });
});
