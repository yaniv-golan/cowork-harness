// The minimal post-construction spawn-env scanner: DIRECT writes to the spawn options' env after Desktop's W1 literal is
// built, in the builder's tail and in the caller up to the spawn call. It covers what the observed spawn-env oracle
// cannot: a write whose condition never held on the maintainer's machine (CLAUDE_CODE_MAX_CONTEXT_TOKENS was unset in
// every observed session).
//
// Deliberately small. It does not follow calls, so a helper that writes the env (the host-loop setup, the memory keys,
// a proxy transform that returns a new env) is out of its reach: the oracle sees those writes' final effect, and the
// memory keys have their own anchors. A deeper value-flow scanner was measured over 38 saved Desktop builds and
// rejected: 49 hard-fails with 9 false, two rework events, and a nine-build window where an exempted helper hid real
// writes. This version went red on exactly 2 of those builds, both real (test/spawn-env-post-writes.test.ts replays it).
//
// What it reads, per alias of the options object (`<U>` in the builder, `<J>` in the caller, plus plain copies
// `let a=<U|J>`), skipping regions where a nested function, catch or let/const rebinds the name:
//   - `X.env={...X.env,…}`: literal keys, computed keys resolved to a string constant (any quote style, through a
//     required module's export map), and keys inside conditional / ternary / IIFE objects in that literal;
//   - `X.env.KEY=…` and `delete X.env.KEY`.
// Each key must be classified by the registry at the "post-write" site, else a hard-fail. A computed key it cannot
// resolve, or a spread inside a re-spread that it cannot enumerate, is a hard-fail too. Whole-env replacements
// (`X.env=f(X.env)`) are not scanned.

import { classifySpawnEnvKey, type SpawnEnvClass } from "./spawn-env-registry.js";

const ID = "[A-Za-z_$][\\w$]*";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NO_BYPASS = "do NOT bypass with --allow-empty";

type Classify = (name: string) => { class: SpawnEnvClass; reason: string } | null;

/** Index of the bracket closing the one at `i` (string- and template-aware), or -1. */
function matchClose(s: string, i: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack = [pairs[s[i]]];
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") {
      for (j++; j < s.length && s[j] !== c; j++) if (s[j] === "\\") j++;
    } else if (c === "`") {
      for (j++; j < s.length && s[j] !== "`"; j++) {
        if (s[j] === "\\") j++;
        else if (s.startsWith("${", j)) {
          const k = matchClose(s, j + 1);
          if (k < 0) return -1;
          j = k;
        }
      }
    } else if (c in pairs) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return j;
    }
  }
  return -1;
}

/** Split the INSIDE of a bracket pair at top-level `sep` characters. */
function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") {
      const close = c;
      for (j++; j < s.length && s[j] !== close; j++) {
        if (s[j] === "\\") j++;
        else if (close === "`" && s.startsWith("${", j)) {
          const k = matchClose(s, j + 1);
          j = k > 0 ? k : s.length;
        }
      }
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, j));
      start = j + 1;
    }
  }
  out.push(s.slice(start));
  return out.filter((x) => x.trim() !== "");
}

/** End of the expression starting at `j`: the next top-level `,` `;` or unmatched closer. */
function exprEnd(t: string, j: number): number {
  for (; j < t.length; j++) {
    const c = t[j];
    if (c === "(" || c === "[" || c === "{") {
      const k = matchClose(t, j);
      if (k < 0) return t.length;
      j = k;
    } else if (c === '"' || c === "'" || c === "`") {
      for (j++; j < t.length && t[j] !== c; j++) if (t[j] === "\\") j++;
    } else if (c === "," || c === ";" || c === ")" || c === "]" || c === "}") return j;
  }
  return t.length;
}

/** The innermost named function whose body contains `pos`: its name and body bounds. */
function functionAt(s: string, pos: number): { name: string; bodyOpen: number; bodyClose: number } | null {
  let best: { name: string; bodyOpen: number; bodyClose: number } | null = null;
  for (const m of s.slice(0, pos).matchAll(new RegExp(`function\\s+(${ID})\\s*\\(`, "g"))) {
    const po = m.index! + m[0].length - 1;
    const pc = matchClose(s, po);
    if (pc < 0) continue;
    const bo = s.indexOf("{", pc);
    if (bo < 0 || bo - pc > 3) continue;
    const bc = matchClose(s, bo);
    if (bo < pos && pos < bc) best = { name: m[1], bodyOpen: bo, bodyClose: bc };
  }
  return best;
}

/** Ranges of `t` where `name` is rebound: nested function/arrow params, catch, let/const/var. */
function shadowRanges(t: string, name: string, ownDecl = -1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const w = new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`);
  const bodyAfter = (j: number): [number, number] => {
    while (t[j] === " ") j++;
    if (t[j] === "{") {
      const k = matchClose(t, j);
      return [j, k > 0 ? k : t.length];
    }
    return [j, exprEnd(t, j)];
  };
  for (const m of t.matchAll(new RegExp(`(?<![\\w$.])${esc(name)}=>`, "g"))) out.push(bodyAfter(m.index! + m[0].length));
  for (const m of t.matchAll(/\(([^()]*)\)=>/g)) if (w.test(m[1])) out.push(bodyAfter(m.index! + m[0].length));
  for (const m of t.matchAll(new RegExp(`function\\s*(?:${ID})?\\s*\\(([^()]*)\\)\\s*\\{`, "g")))
    if (w.test(m[1])) {
      const o = m.index! + m[0].length - 1;
      out.push([o, matchClose(t, o)]);
    }
  for (const m of t.matchAll(new RegExp(`catch\\((${ID})\\)\\{`, "g")))
    if (m[1] === name) {
      const o = m.index! + m[0].length - 1;
      out.push([o, matchClose(t, o)]);
    }
  for (const m of t.matchAll(new RegExp(`(?:let|const|var)\\s+(?:[^;]*?[,\\s])?${esc(name)}(?=[=\\s,;])`, "g"))) {
    // The alias's own declaration (`let a=J`) introduces it; it is not a rebinding.
    if (m.index! <= ownDecl && ownDecl <= m.index! + m[0].length) continue;
    let d = 0;
    let end = t.length;
    for (let j = m.index! + m[0].length; j < t.length; j++) {
      const c = t[j];
      if (c === "{" || c === "(" || c === "[") d++;
      else if (c === "}" || c === ")" || c === "]") {
        if (d === 0) {
          end = j;
          break;
        }
        d--;
      }
    }
    out.push([m.index!, end]);
  }
  return out;
}
const visible = (ranges: Array<[number, number]>, i: number) => !ranges.some(([a, b]) => a <= i && i <= b);

class Scan {
  keys = new Set<string>();
  flags: string[] = [];
  constructor(
    private readonly files: Map<string, string>,
    private readonly classify: Classify,
  ) {}

  private requireTarget(chunk: string, ns: string): string | null {
    const m = chunk.match(new RegExp(`(?<![\\w$.])${esc(ns)}=require\\("\\./([^"]+)"\\)`));
    if (!m) return null;
    for (const [k, v] of this.files) if (k === m[1] || k.endsWith(`/${m[1]}`)) return v;
    return null;
  }

  private exportLocal(target: string, ex: string): string | null {
    const m =
      target.match(new RegExp(`"${esc(ex)}",\\{enumerable:!0,get:function\\(\\)\\{return (${ID})\\}`)) ??
      target.match(new RegExp(`(?<![\\w$])${esc(ex)}:\\(\\)=>(${ID})`));
    return m ? m[1] : null;
  }

  private constValue(text: string, local: string): string | null {
    const vals = new Set([...text.matchAll(new RegExp(`(?<![\\w$.])${esc(local)}=["'\`]([A-Z][A-Z0-9_]*)["'\`]`, "g"))].map((m) => m[1]));
    return vals.size === 1 ? [...vals][0] : null;
  }

  resolveKey(expr: string, chunk: string): string | null {
    const e = expr.trim();
    const lit = e.match(/^["'`]([A-Z][A-Z0-9_]*)["'`]$/);
    if (lit) return lit[1];
    if (new RegExp(`^${ID}$`).test(e)) return this.constValue(chunk, e);
    const ns = e.match(new RegExp(`^(${ID})\\.(${ID})$`));
    if (!ns) return null;
    const tgt = this.requireTarget(chunk, ns[1]);
    const local = tgt ? this.exportLocal(tgt, ns[2]) : null;
    return tgt && local ? this.constValue(tgt, local) : null;
  }

  private add(key: string, where: string) {
    this.keys.add(key);
    if (!this.classify(key))
      this.flags.push(
        `spawn.env post-construction: ${where} writes ${key}, which src/sync/spawn-env-registry.ts does not classify at the "post-write" site — classify it; ${NO_BYPASS}`,
      );
  }

  /** Keys of an object literal spread into the env, recursing into conditional, ternary and IIFE objects. */
  private enumObject(obj: string, chunk: string, where: string, selfAlias: string | null): void {
    for (const ent of splitTop(obj.slice(1, -1))) {
      const e = ent.trim();
      if (e.startsWith("...")) {
        const sp = e.slice(3).trim();
        if (selfAlias && (sp === selfAlias || sp === `${selfAlias}??{}`)) continue;
        this.enumValue(sp, chunk, where);
        continue;
      }
      const k = e.match(/^["']?([A-Za-z_$][\w$]*)["']?\s*:/);
      if (k) {
        this.add(k[1], where);
        continue;
      }
      if (e.startsWith("[")) {
        const close = matchClose(e, 0);
        const key = close > 0 ? this.resolveKey(e.slice(1, close), chunk) : null;
        if (key) this.add(key, where);
        else
          this.flags.push(
            `spawn.env post-construction: ${where} writes a computed key \`${e.slice(1, Math.max(1, close)).slice(0, 60)}\` this scanner cannot resolve to a string constant — re-derive; ${NO_BYPASS}`,
          );
        continue;
      }
      this.flags.push(
        `spawn.env post-construction: ${where} has an env entry this scanner cannot read (\`${e.slice(0, 60)}\`) — re-derive; ${NO_BYPASS}`,
      );
    }
  }

  private enumValue(v0: string, chunk: string, where: string): void {
    let v = v0.trim();
    while (v.startsWith("(") && matchClose(v, 0) === v.length - 1) v = v.slice(1, -1).trim();
    if (v.startsWith("{") && matchClose(v, 0) === v.length - 1) return this.enumObject(v, chunk, where, null);
    const q = splitTop(v, "?");
    if (q.length === 2) {
      const alts = splitTop(q[1], ":");
      if (alts.length === 2) {
        this.enumValue(alts[0], chunk, where);
        this.enumValue(alts[1], chunk, where);
        return;
      }
    }
    let i = v.lastIndexOf("&&");
    while (i > 0) {
      let d = 0;
      for (const c of v.slice(0, i)) d += c === "(" || c === "[" || c === "{" ? 1 : c === ")" || c === "]" || c === "}" ? -1 : 0;
      if (d === 0) return this.enumValue(v.slice(i + 2), chunk, where);
      i = v.lastIndexOf("&&", i - 1);
    }
    const iife = v.match(/^\(\(\)=>\{([\s\S]*)\}\)\(\)$/);
    if (iife) {
      for (const r of iife[1].matchAll(/(?<![\w$])return(?=[\s{(])/g)) {
        const st = r.index! + r[0].length;
        const expr = iife[1].slice(st, exprEnd(iife[1], st)).trim();
        if (expr) this.enumValue(expr, chunk, where);
      }
      return;
    }
    this.flags.push(
      `spawn.env post-construction: ${where} spreads \`${v.slice(0, 60)}\` into the env, which this scanner does not follow — re-derive; ${NO_BYPASS}`,
    );
  }

  /** Scan `text` (a slice of `chunk`) for direct env writes through any alias in `aliases`. */
  scan(text: string, chunk: string, aliases: string[], where: string) {
    // plain copies `let a=X` / `,a=X` of an alias: scan them as the same object
    const declAt = new Map<string, number>(aliases.map((a) => [a, -1]));
    for (const a of aliases)
      for (const m of text.matchAll(new RegExp(`(?:let|const|var|[,;{(])\\s*(${ID})=${esc(a)}(?=[,;)])`, "g")))
        if (!declAt.has(m[1])) declAt.set(m[1], m.index! + m[0].length - a.length - 1 - m[1].length);
    for (const [opt, own] of declAt) {
      const sh = shadowRanges(text, opt, own);
      const E = `${opt}.env`;
      for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${esc(E)}(?![\\w$])`, "g"))) {
        const i = m.index!;
        if (!visible(sh, i)) continue;
        const k = i + E.length;
        const before = text.slice(Math.max(0, i - 7), i);
        const rest = text.slice(k, k + 200);
        const assign = rest.match(/^\s*=(?![=>])/);
        if (assign) {
          const st = k + assign[0].length;
          const rhs = text.slice(st, exprEnd(text, st)).trim();
          if (new RegExp(`^\\{\\s*\\.\\.\\.${esc(E)}(?:\\?\\?\\{\\})?\\s*[,}]`).test(rhs)) this.enumObject(rhs, chunk, where, E);
          continue; // a whole-env replacement is not scanned (see the header)
        }
        const member = rest.match(new RegExp(`^\\.(${ID})\\s*=(?![=>])`));
        if (member) {
          this.add(member[1], where);
          continue;
        }
        if (before.endsWith("delete ")) {
          const del = rest.match(new RegExp(`^\\.(${ID})`));
          if (del) this.add(del[1], where);
        }
      }
    }
  }
}

/**
 * Scan Desktop's spawn path for direct post-construction env writes. `files` is the bundle's chunk map (quote-normalized,
 * as sync reads it). `classify` is the registry at the post-write site; the test seam replays history with a growing set.
 */
export function scanSpawnEnvPostWrites(
  files: Map<string, string>,
  classify: Classify = (n) => classifySpawnEnvKey(n, "post-write"),
): { keys: string[]; flags: string[] } {
  const s = new Scan(files, classify);
  const fail = (why: string) => ({
    keys: [],
    flags: [`spawn.env post-construction: ${why} — the spawn path moved; re-derive src/sync/spawn-env-post-writes.ts; ${NO_BYPASS}`],
  });
  const w1 = [...files.values()].filter((c) => c.includes("env:{CLAUDE_CONFIG_DIR"));
  if (w1.length !== 1 || w1[0].split("env:{CLAUDE_CONFIG_DIR").length !== 2)
    return fail("the W1 anchor `env:{CLAUDE_CONFIG_DIR` is not unique");
  const ch = w1[0];
  const p = ch.indexOf("env:{CLAUDE_CONFIG_DIR");
  const fn = functionAt(ch, p);
  if (!fn) return fail("no named function encloses W1");
  let U: string | null = null;
  let uClose = -1;
  for (const m of ch.slice(fn.bodyOpen, p).matchAll(new RegExp(`(?<![\\w$.])(${ID})=\\{`, "g"))) {
    const o = fn.bodyOpen + m.index! + m[0].length - 1;
    const c = matchClose(ch, o);
    if (c > p && splitTop(ch.slice(o + 1, c)).some((e) => e.trim().startsWith("env:{CLAUDE_CONFIG_DIR"))) {
      U = m[1];
      uClose = c;
    }
  }
  if (!U) return fail("the options literal holding `env:{CLAUDE_CONFIG_DIR` was not found");
  const tail = ch.slice(uClose + 1, fn.bodyClose);
  const ret = tail.split(`{sdkOptions:${U},`).length - 1 + (tail.split(`{sdkOptions:${U}}`).length - 1);
  if (ret !== 1) return fail(`the builder returns \`{sdkOptions:${U}\` ${ret} times, expected 1`);
  const dm = [...ch.matchAll(new RegExp(`\\{sdkOptions:(${ID})(?:,[^;{}]{0,400})?\\}=await\\s+${esc(fn.name)}\\(`, "g"))];
  if (dm.length !== 1) return fail(`the caller destructure \`{sdkOptions:…}=await ${fn.name}(\` appears ${dm.length} times, expected 1`);
  const J = dm[0][1];
  const from = dm[0].index! + dm[0][0].length;
  const spawn = ch.slice(from).search(new RegExp(`\\(\\{prompt:${ID},options:${esc(J)}\\}\\)`));
  if (spawn < 0) return fail(`the spawn call \`({prompt:…,options:${J}})\` was not found after the caller destructure`);
  s.scan(tail, ch, [U], `the builder ${fn.name}`);
  s.scan(ch.slice(from, from + spawn), ch, [J], "its caller");
  return { keys: [...s.keys].sort(), flags: s.flags };
}
