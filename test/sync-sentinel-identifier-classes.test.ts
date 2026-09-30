import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { checkSpawnContractFacts, resolveSpawnValue } from "../src/sync/cowork-sync.js";

/**
 * Desktop 1.32885.1 blocked `sync` on a healthy build: the minifier named the empty-ANTHROPIC_* blank
 * helper `$s`, and the S14b sentinel spelled its callee `\w+` — and `\w` is [A-Za-z0-9_], which cannot
 * match a `$`. A `$` is a legal JS identifier character and terser uses it freely, so ANY sentinel that
 * pins a minifier-assigned name with `\w` is one build away from a false refusal.
 *
 * An audit found 11 such atoms across 7 regexes (all spawn-family); only S14b happened to be firing.
 * These sentinels fail CLOSED — a false BLOCK, never a silently-wrong spawn contract — which is exactly
 * why the other six sat latent for releases without anyone noticing.
 *
 * Two layers here:
 *   1. a structural invariant over the source, so the NEXT sentinel someone writes cannot re-arm it;
 *   2. behavioural `$`-named fixtures, so the invariant is grounded in the functions actually running.
 */

const SRC = "src/sync/cowork-sync.ts";

interface Atom {
  line: number;
  kind: "bare-\\w" | "class-without-$";
  text: string;
  context: string;
}

/** Every regex literal in the module, via the TS AST (never a text scrape — `/` is also division). */
function regexLiterals(): { line: number; pattern: string }[] {
  const text = readFileSync(SRC, "utf8");
  const sf = ts.createSourceFile(SRC, text, ts.ScriptTarget.Latest, true);
  const out: { line: number; pattern: string }[] = [];
  (function walk(n: ts.Node) {
    if (ts.isRegularExpressionLiteral(n)) {
      const raw = n.getText(sf);
      const last = raw.lastIndexOf("/");
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, pattern: raw.slice(1, last) });
    }
    ts.forEachChild(n, walk);
  })(sf);
  return out;
}

/**
 * Identifier-matching atoms that cannot match a `$`-initial minified name.
 *
 * A bare `\w` (outside a character class) is always suspect: in this module every one of them existed
 * to match a minified binding. A character class is only suspect when it contains `\w` — a hand-rolled
 * range like `[a-z]` (regex flags), `[A-Z][A-Z0-9_]{2,}` (env-var names) or `[a-z0-9.-]+` (hostnames)
 * matches something that is not a JS identifier and is deliberately left alone.
 */
function scanPattern(line: number, p: string): Atom[] {
  const out: Atom[] = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "[") {
      let j = i + 1;
      if (p[j] === "^") j++;
      for (; j < p.length; j++) {
        if (p[j] === "\\") {
          j++;
          continue;
        }
        if (p[j] === "]") break;
      }
      const cls = p.slice(i, j + 1);
      if (cls.includes("\\w") && !cls.includes("$")) {
        out.push({ line, kind: "class-without-$", text: cls, context: p.slice(Math.max(0, i - 24), i + 28) });
      }
      i = j;
      continue;
    }
    if (p[i] === "\\" && p[i + 1] === "w") {
      out.push({ line, kind: "bare-\\w", text: "\\w", context: p.slice(Math.max(0, i - 24), i + 24) });
      i++;
      continue;
    }
    if (p[i] === "\\") i++; // skip any other escape so `\[` never opens a class
  }
  return out;
}

function offendingAtoms(): Atom[] {
  return regexLiterals().flatMap(({ line, pattern }) => scanPattern(line, pattern));
}

describe("sync sentinels admit `$` in every minified-identifier position", () => {
  it("the AST scan actually finds regexes (guards against a silently empty invariant)", () => {
    // Without this, a broken parse would make the invariant below pass vacuously.
    expect(regexLiterals().length).toBeGreaterThan(100);
  });

  it("has zero identifier atoms that exclude `$`", () => {
    const bad = offendingAtoms();
    const detail = bad.map((a) => `  ${SRC}:${a.line}  ${a.kind}  «${a.text}»  …${a.context}…`).join("\n");
    expect(
      bad.length,
      bad.length === 0
        ? ""
        : `\n${bad.length} regex atom(s) cannot match a \`$\`-initial minified name.\n` +
            `Use [\\w$] instead of \\w wherever the pattern pins a minifier-assigned binding, callee or\n` +
            `member name. If the atom genuinely matches something that is NOT a JS identifier (a hostname,\n` +
            `an env-var name, a prompt-text tag), spell it as an explicit range rather than \\w.\n${detail}\n`,
    ).toBe(0);
  });

  // Mutation checks run the REAL scanner over synthetic patterns — a reimplemented probe would only
  // prove the copy agrees with itself.
  it("the scanner flags a reintroduced bare \\w", () => {
    const found = scanPattern(1, String.raw`CLAUDE_CODE_DISABLE_CRON:\w+\.disableCron`);
    expect(found.map((a) => a.kind)).toEqual(["bare-\\w"]);
  });

  it("the scanner accepts the widened [\\w$] form", () => {
    expect(scanPattern(1, String.raw`CLAUDE_CODE_DISABLE_CRON:[\w$]+\.disableCron`)).toEqual([]);
  });

  it("the scanner flags a \\w-bearing class that omits `$`", () => {
    const found = scanPattern(1, String.raw`"([\w.-]+)":\{`);
    expect(found.map((a) => a.kind)).toEqual(["class-without-$"]);
  });

  it("the scanner leaves non-identifier ranges alone", () => {
    // Regex flags, env-var names and hostnames are not JS identifiers and must not be forced to take `$`.
    expect(scanPattern(1, String.raw`[a-z]`)).toEqual([]);
    expect(scanPattern(1, String.raw`[{,](TZ|[A-Z][A-Z0-9_]{2,}):`)).toEqual([]);
    expect(scanPattern(1, String.raw`[a-z0-9.-]+\.(?:anthropic)`)).toEqual([]);
    expect(scanPattern(1, String.raw`[\s\S]{0,40}`)).toEqual([]);
  });

  it("an escaped bracket does not open a character class", () => {
    // `\[` followed by a bare \w must still be caught, not swallowed as class contents.
    const found = scanPattern(1, String.raw`\[?\w+ of`);
    expect(found.map((a) => a.kind)).toEqual(["bare-\\w"]);
  });
});

/**
 * The second half of the same bug class. Desktop 2.9939.2 named the sub-agent trailing-sentence binding
 * `$D`, and `extractSubagentComposition` interpolated that raw name into its lookup RegExp: unescaped, `$` is an
 * end-of-input anchor, so the lookup failed on a healthy build. The atom scan above cannot see this —
 * the offending character arrives at runtime, through an interpolation. An audit found eight such sites;
 * two could fail OPEN (an un-awaited async pre-pass or chain link passed in silence).
 *
 * Invariant: every `${…}` inside a `new RegExp(\`…\`)` is an escape call, the inline escape idiom, or a
 * name listed here with the reason it cannot carry a regex metacharacter.
 */
const ESCAPED_OR_CONSTANT_SPANS: Record<string, string> = {
  esc: "a local bound to `<name>.replace(/[.*+?^${}()|[\\]\\\\]/g, …)` in every function that uses it",
  idEsc: "bound to the escape idiom (extractPromptFingerprint)",
  escC: "bound to the escape idiom (S6c Artifact condition)",
  e: "bound to reEsc(local) (bindsGatedToolSet / bindsPathKeys)",
  p: "bound to reEsc(param) (egressWrapperDefect)",
  PATH_GATE_MAP_LITERAL: "a regex SOURCE constant, interpolated as pattern on purpose",
  ASSIGN_OP: "a regex SOURCE constant (assignment operators), interpolated as pattern on purpose",
  GRANT_KEY: "a string constant naming an env key",
  taskArray: "a regex source fragment built from constants",
  "arrayRe.source": "a regex literal's own source, interpolated as pattern on purpose",
  'forms.join("|")': "an alternation of regex source constants",
};
const ESCAPE_CALL = /^(?:reEsc|esc)\(/;
const ESCAPE_IDIOM = '.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")';

function regexTemplateSpans(): { line: number; expr: string }[] {
  const text = readFileSync(SRC, "utf8");
  const sf = ts.createSourceFile(SRC, text, ts.ScriptTarget.Latest, true);
  const out: { line: number; expr: string }[] = [];
  (function walk(n: ts.Node) {
    if (ts.isNewExpression(n) && n.expression.getText(sf) === "RegExp" && n.arguments?.[0] && ts.isTemplateExpression(n.arguments[0]))
      for (const sp of n.arguments[0].templateSpans)
        out.push({ line: sf.getLineAndCharacterOfPosition(sp.expression.getStart(sf)).line + 1, expr: sp.expression.getText(sf) });
    ts.forEachChild(n, walk);
  })(sf);
  return out;
}

const spanIsSafe = (expr: string) => ESCAPE_CALL.test(expr) || expr.endsWith(ESCAPE_IDIOM) || expr in ESCAPED_OR_CONSTANT_SPANS;

describe("sync sentinels escape every name interpolated into a dynamic RegExp", () => {
  it("the AST scan actually finds interpolations (guards against a silently empty invariant)", () => {
    expect(regexTemplateSpans().length).toBeGreaterThan(30);
  });

  it("every interpolation is escaped or a listed constant", () => {
    const bad = regexTemplateSpans().filter((s) => !spanIsSafe(s.expr));
    expect(
      bad.map((s) => `${SRC}:${s.line}  \${${s.expr}}`),
      "wrap a captured minified name in reEsc(…) — a `$` in it is an end-of-input anchor otherwise",
    ).toEqual([]);
  });

  it("the check rejects a raw captured name and a bare capture group", () => {
    expect(spanIsSafe("comp[1]")).toBe(false);
    expect(spanIsSafe("resultId")).toBe(false);
    expect(spanIsSafe("reEsc(comp[1])")).toBe(true);
    expect(spanIsSafe(`ref.local${ESCAPE_IDIOM}`)).toBe(true);
  });
});

/**
 * Behavioural fixtures. Each spawn sentinel is fed a bundle whose minified bindings all carry
 * `$`-initial names — the shape that broke S14b live — and must NOT flag.
 */
describe("spawn sentinels survive `$`-initial minified names", () => {
  // Minimal bundle carrying the three anchored constructs, every binding `$`-named.
  const dollarBundle = [
    `return{CLAUDE_CODE_ENTRYPOINT:"local-agent",`,
    `CLAUDE_CODE_DISABLE_CRON:$o.disableCron?"1":"",`,
    // Double-quoted, not a template literal: this element interpolates nothing, and writing `\${` in a
    // template literal trips CodeQL's useless-escape rule (the fixture flows into code that builds
    // RegExps from bundle text). In a double-quoted string both the backticks and `${` are literal.
    "CLAUDE_CODE_TAGS:`lam_session_type:${$k}`}",
    `,$x.sessionEnvVars()}`,
    `;function $blank($e){for(let $t of["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"])`,
    `if($e[$t]==="")delete $e[$t]}`,
    `;var $q={ANTHROPIC_CUSTOM_HEADERS:$ns.$Ms($F.env??{},D.app.getVersion())},$ns.$s($F.env),le.prime($F.env);`,
  ].join("");

  const flagsFor = (bundle: string) => checkSpawnContractFacts(bundle);
  const named = (flags: string[], id: string) => flags.filter((f) => f.includes(id));

  it("S13 DISABLE_CRON ternary matches a `$`-named session object", () => {
    expect(named(flagsFor(dollarBundle), "S13 DISABLE_CRON ternary")).toEqual([]);
  });

  it("S14a FnA definition matches a `$`-named loop binding", () => {
    expect(named(flagsFor(dollarBundle), "S14a FnA definition")).toEqual([]);
  });

  it("S14b FnA application matches `$`-named callees AND a `$`-named env binding", () => {
    // This is the exact 1.32885.1 failure: callee `$s`. The env binding is `$F` as well, which the
    // previous `(\w+\$?)` capture (trailing `$` only) would still have missed.
    expect(named(flagsFor(dollarBundle), "S14b FnA application")).toEqual([]);
  });

  it("S14b still FIRES when the blank helper runs on a DIFFERENT env object", () => {
    // The guard must keep its teeth: the backreference is the whole point of the sentinel.
    const wrong = dollarBundle.replace("$ns.$s($F.env)", "$ns.$s($OTHER.env)");
    expect(named(flagsFor(wrong), "S14b FnA application")).toHaveLength(1);
  });

  it("S14a still FIRES when the ANTHROPIC_* key list changes", () => {
    const wrong = dollarBundle.replace(`"ANTHROPIC_AUTH_TOKEN",`, "");
    expect(named(flagsFor(wrong), "S14a FnA definition")).toHaveLength(1);
  });
});

describe("resolveSpawnValue modeled-session ternaries accept `$`-initial bindings", () => {
  const gates = {};
  const resolve = (expr: string) => resolveSpawnValue("", expr, gates);

  it.each([
    [`$o.disableCron?"1":""`, "1"],
    [`$o.type!=="3p"&&$n==="staging"?"1":""`, ""],
    [`$o.type!=="3p"&&$n==="local"?"1":""`, ""],
  ])("resolves %s", (expr, value) => {
    expect(resolve(expr)).toEqual({ value });
  });

  it(`resolves the 3p-entrypoint ternary with a $-named object`, () => {
    expect(resolve(`$o.type==="3p"?"3p":"1p"`)).toEqual({ value: "1p" });
  });

  it("still reports unknown for a genuinely unrecognized expression", () => {
    // Fail-closed is the property that made this whole class survivable — keep proving it.
    expect(resolve(`$o.somethingNew?"1":""`)).toEqual({ unknown: true });
  });

  it("the non-`$` forms keep working (no regression for existing builds)", () => {
    expect(resolve(`o.disableCron?"1":""`)).toEqual({ value: "1" });
    expect(resolve(`o.type!=="3p"&&n==="staging"?"1":""`)).toEqual({ value: "" });
  });
});
