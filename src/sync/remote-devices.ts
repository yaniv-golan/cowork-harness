// The baseline's `cloud` block: what Desktop serves to a CLOUD Cowork session through its `remote-devices`
// MCP server (the tool list, and one fingerprint per conditional branch of each tool's description), plus
// the features a cloud session has that no local reproduction can reach (`cloud.unreachable`).
//
// It is DATA ONLY: nothing in the harness reads it. It exists so a per-release `sync --diff` shows when the
// cloud-facing tool surface moves.
//
// PUBLISHING RULE: the block carries names, hashes and counts, never description text. The descriptions are
// Anthropic's prose, so only `sha256` + `codePoints` of each rendered branch leave this module, and a branch
// is identified by a hash of its selector assignment, not by the selector expression. CloudBlock is strict,
// and test/remote-devices.test.ts holds every string in every committed block to a name/hash shape.
//
// HOW A DESCRIPTION IS RENDERED. Most descriptions are not one literal: they are `+` concatenations, template
// literals over chunk constants, (nested) ternaries, local `let`s that are themselves ternaries, and an
// object-table lookup. Each ternary reachable from the description is a SELECTOR; every assignment of the
// selectors is rendered, identical texts are merged, and each distinct text is one branch, keyed by the
// selectors it actually traversed. Selectors are labelled by a canonical form that survives minifier renames
// (gate ids by their digit-string argument, member names longer than 3 characters, `_` for anything else).
// A runtime value that cannot be resolved statically (device_bash's timeouts) renders as a fixed placeholder.
// Scoping follows the language: `var` and function declarations bind to the function, `let`/`const` to the
// enclosing block (the builder declares `let n` twice; function-only scoping bound a description to the
// wrong one and still produced hashes that were stable, i.e. wrong in both builds alike).

import { createHash } from "node:crypto";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { CloudBlock } from "../types.js";

/** Features of a cloud session that a local reproduction cannot reach by construction. Identifiers only. */
export const CLOUD_UNREACHABLE = [
  "ccr_session_riders", // anything delivered on the ccr-session host
  "ccr_web_fetch_proxy",
  "ccr_web_search_proxy",
  "memory_context",
  "plugin_skill_sync",
  "repl_bridge",
  // device_bash refusal codes that need Desktop's VM lifecycle or the server-asserted session id
  "session_id_unavailable",
  "workspace_failed",
  "workspace_starting",
] as const;

export interface RemoteDevicesFingerprint {
  name: string;
  branch: string;
  sha256: string;
  codePoints: number;
}

export interface CloudBlockReading {
  /** The `remote-devices` tool list in bundle order; null when its array was not found. */
  tools: string[] | null;
  descriptions: RemoteDevicesFingerprint[];
  /** The extraction could not be trusted, so no block is written (see cloudBlockFromReading). Never carries description text. */
  deltas: string[];
}

// acorn's ESTree nodes, typed loosely: this module walks arbitrary minified code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
interface Decl {
  kind: "var" | "fn" | "param";
  node?: N;
  init?: N;
  anc?: N[];
}
interface Chunk {
  src: string;
  ast: N;
  scopes: Map<N, Map<string, Decl>>;
  tools: { obj: N; nameNode: N; descNode: N; anc: N[] }[];
  requires: Map<string, string>;
}

const DYN = "⟨dyn⟩";
const MAX_SELECTORS = 12;
const isFn = (n: N) => /Function/.test(n.type);
const propKey = (p: N): string | null => (p.type === "Property" && !p.computed ? (p.key.name ?? p.key.value) : null);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `remote-devices` tool list: the one all-string array literal holding both `list_devices` and
 *  `device_bash`. Anchored on content, since every name around it is minified. */
export function findRemoteDevicesToolList(files: Map<string, string>): string[] | null {
  for (const src of files.values()) {
    if (!src.includes("list_devices") || !src.includes("device_bash")) continue;
    for (const m of src.matchAll(/\[((?:\s*["'`][a-z][a-z0-9_]*["'`]\s*,)+\s*["'`][a-z][a-z0-9_]*["'`]\s*)\]/g)) {
      const names = [...m[1].matchAll(/["'`]([a-z][a-z0-9_]*)["'`]/g)].map((x) => x[1]);
      if (names.includes("list_devices") && names.includes("device_bash")) return names;
    }
  }
  return null;
}

/** The block `sync` writes from one reading, and the notes it prints. A reading with any delta, or no tool list,
 *  yields NO block (never a partial one) and a WARNING note per delta; the write is not blocked. */
export function cloudBlockFromReading(r: CloudBlockReading): { cloud: CloudBlock | null; notes: string[] } {
  const notes = r.deltas.map(
    (d) => `WARNING: ${d}. The baseline is written WITHOUT a cloud block (not carried forward); check:versions will warn.`,
  );
  if (!r.tools || r.deltas.length > 0) return { cloud: null, notes };
  return {
    cloud: { remoteDevicesTools: r.tools, remoteDevicesDescriptions: r.descriptions, unreachable: [...CLOUD_UNREACHABLE] },
    notes,
  };
}

/** Why `sync` must refuse to write this block, or null. Names only the failing PATHS: a zod issue message can echo
 *  the offending value, and in this block that value could be description text. */
export function cloudSchemaRefusal(cloud: unknown): string | null {
  const r = CloudBlock.safeParse(cloud);
  if (r.success) return null;
  return `ERROR: the cloud block failed its schema — refusing to write baseline (issue paths: ${r.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")})`;
}

/** The baseline `sync` writes, as far as the `cloud` block goes: this release's block when it was extracted, and
 *  otherwise none — never the previous release's, which would stamp its surface with this release's identity. */
export function withSyncedCloudBlock<T extends Record<string, unknown>>(
  next: T,
  cloud: object | null,
): Omit<T, "cloud"> & { cloud?: object } {
  const { cloud: _previous, ...rest } = next;
  return cloud ? { ...rest, cloud } : rest;
}

export function extractCloudBlock(files: Map<string, string>): CloudBlockReading {
  const deltas: string[] = [];
  const tools = findRemoteDevicesToolList(files);
  if (!tools) {
    deltas.push(
      "cloud: the remote-devices tool list (an array holding list_devices and device_bash) was not found — re-anchor findRemoteDevicesToolList (maintainer)",
    );
    return { tools: null, descriptions: [], deltas };
  }
  const wanted = new Set(tools);
  const chunks = new Map<string, Chunk | null>();

  function load(file: string): Chunk | null {
    if (chunks.has(file)) return chunks.get(file)!;
    const src = files.get(file);
    if (src === undefined) {
      chunks.set(file, null);
      return null;
    }
    let ast: N;
    try {
      ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: true });
    } catch {
      deltas.push(`cloud: ${file} did not parse, so its remote-devices descriptions could not be fingerprinted`);
      chunks.set(file, null);
      return null;
    }
    const scopes = new Map<N, Map<string, Decl>>();
    const add = (scope: N, name: string, rec: Decl) => {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      const m = scopes.get(scope)!;
      if (!m.has(name)) m.set(name, rec);
    };
    const found: Chunk["tools"] = [];
    walk.fullAncestor(ast, (n: N, _s: unknown, anc: N[]) => {
      const fnScope = () => {
        for (let i = anc.length - 2; i >= 0; i--) if (isFn(anc[i]) || anc[i].type === "Program") return anc[i];
        return ast;
      };
      if (n.type === "VariableDeclarator" && n.id.type === "Identifier") {
        const decl = anc[anc.length - 2];
        let sc = fnScope();
        if (decl && decl.kind !== "var")
          for (let i = anc.length - 3; i >= 0; i--) {
            const a = anc[i];
            if (a.type === "BlockStatement" || isFn(a) || a.type === "Program" || /^For/.test(a.type)) {
              sc = a;
              break;
            }
          }
        add(sc, n.id.name, { kind: "var", node: n, init: n.init, anc: anc.slice() });
      }
      if (n.type === "FunctionDeclaration" && n.id) add(fnScope(), n.id.name, { kind: "fn", node: n, anc: anc.slice() });
      if (isFn(n))
        for (const p of n.params) {
          if (p.type === "Identifier") add(n, p.name, { kind: "param" });
          else
            walk.full(p, (q: N) => {
              if (q.type === "Identifier") add(n, q.name, { kind: "param" });
            });
        }
      if (n.type === "ObjectExpression") {
        const nm = n.properties.find((p: N) => propKey(p) === "name");
        const ds = n.properties.find((p: N) => propKey(p) === "description");
        if (nm && ds) found.push({ obj: n, nameNode: nm.value, descNode: ds.value, anc: anc.slice() });
      }
    });
    const requires = new Map<string, string>();
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)=require\(["'`]\.\/([^"'`]+\.js)["'`]\)/g)) requires.set(m[1], m[2]);
    const c: Chunk = { src, ast, scopes, tools: found, requires };
    chunks.set(file, c);
    return c;
  }

  function lookup(c: Chunk, name: string, anc: N[]): Decl | undefined {
    for (let i = anc.length - 1; i >= 0; i--) {
      const s = c.scopes.get(anc[i]);
      if (s?.has(name)) return s.get(name);
    }
    return c.scopes.get(c.ast)?.get(name);
  }
  // `defineProperty(exports,"key",{…return X})` or `exports.key=X`
  function exportTarget(c: Chunk, key: string): string | null {
    const k = escapeRe(key);
    const m =
      c.src.match(new RegExp(`defineProperty\\(exports,["'\`]${k}["'\`],\\{[^}]*?return ([A-Za-z_$][\\w$]*)\\}`)) ??
      c.src.match(new RegExp(`exports\\.${k}=([A-Za-z_$][\\w$]*)`));
    return m ? m[1] : null;
  }
  function constOf(c: Chunk, node: N, anc: N[], depth = 0): string | number | undefined {
    if (!node || depth > 8) return undefined;
    if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === "Identifier") {
      const d = lookup(c, node.name, anc);
      return d?.kind === "var" && d.init ? constOf(c, d.init, d.anc!, depth + 1) : undefined;
    }
    if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier") {
      const d = lookup(c, node.object.name, anc);
      const target = c.requires.get(node.object.name);
      if (target && (!d || d.kind === "var")) {
        const c2 = load(target);
        const id = c2 && exportTarget(c2, node.property.name);
        const d2 = c2 && id ? lookup(c2, id, [c2.ast]) : undefined;
        if (c2 && d2?.kind === "var" && d2.init) return constOf(c2, d2.init, d2.anc!, depth + 1);
      }
    }
    return undefined;
  }
  function singleReturn(d: Decl | undefined | null): N | null {
    const body = d?.kind === "fn" ? d.node.body.body : null;
    return body && body.length === 1 && body[0].type === "ReturnStatement" ? body[0].argument : null;
  }
  /** Canonical, rename-independent label for a selector. Long string literals become `"<text>"`, so a label
   *  never carries description text (and labels are hashed before they leave this module anyway). */
  function label(c: Chunk, node: N, anc: N[], depth = 0): string {
    if (depth > 16) return "?";
    const L = (n: N, a: N[] = anc) => label(c, n, a, depth + 1);
    switch (node.type) {
      case "Literal":
        return typeof node.value === "string" && node.value.length > 40 ? '"<text>"' : JSON.stringify(node.value);
      case "UnaryExpression":
        return node.operator + L(node.argument);
      case "BinaryExpression":
      case "LogicalExpression":
        return `(${L(node.left)}${node.operator}${L(node.right)})`;
      case "Identifier": {
        const k = constOf(c, node, anc);
        if (k !== undefined) return typeof k === "string" && k.length > 40 ? '"<text>"' : JSON.stringify(k);
        const d = lookup(c, node.name, anc);
        if (d?.kind === "var" && d.init && !isFn(d.init)) return L(d.init, d.anc);
        return "_";
      }
      case "MemberExpression": {
        const k = constOf(c, node, anc);
        if (k !== undefined) return typeof k === "string" && k.length > 40 ? '"<text>"' : JSON.stringify(k);
        const prop = node.computed ? `[${L(node.property)}]` : node.property.name.length > 3 ? `.${node.property.name}` : "._";
        return (node.object.type === "Identifier" ? "_" : L(node.object)) + prop;
      }
      case "CallExpression": {
        if (node.arguments.length === 0 && node.callee.type === "Identifier") {
          const d = lookup(c, node.callee.name, anc);
          const ret = singleReturn(d);
          if (ret) return `[${L(ret, [...d!.anc!, d!.node])}]`;
        }
        if (
          node.arguments.length === 0 &&
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.object.type === "Identifier" &&
          c.requires.has(node.callee.object.name)
        ) {
          const c2 = load(c.requires.get(node.callee.object.name)!);
          const id = c2 && exportTarget(c2, node.callee.property.name);
          const d = c2 && id ? lookup(c2, id, [c2.ast]) : undefined;
          const ret = singleReturn(d);
          if (c2 && ret) return `[${label(c2, ret, [...d!.anc!, d!.node], depth + 1)}]`;
        }
        return `${L(node.callee)}(${node.arguments.map((a: N) => L(a)).join(",")})`;
      }
      case "ChainExpression":
        return L(node.expression);
      case "ConditionalExpression": {
        const isStr = (n: N) => n.type === "Literal" && typeof n.value === "string";
        // a ''-or-text value is a truthiness test of its own
        if (isStr(node.consequent) && isStr(node.alternate) && (node.consequent.value === "") !== (node.alternate.value === ""))
          return (node.alternate.value === "" ? "" : "!") + L(node.test);
        const sv = (n: N) => (isStr(n) && n.value.length > 24 ? '"<text>"' : L(n));
        return `(${L(node.test)}?${sv(node.consequent)}:${sv(node.alternate)})`;
      }
      default:
        return node.type;
    }
  }
  function evalObj(c: Chunk, node: N, anc: N[], asg: Map<string, boolean> | null, sels: string[], depth = 0): { node: N; anc: N[] } | null {
    if (!node || depth > 8) return null;
    if (node.type === "ObjectExpression") return { node, anc };
    if (node.type === "Identifier") {
      const d = lookup(c, node.name, anc);
      return d?.kind === "var" && d.init ? evalObj(c, d.init, d.anc!, asg, sels, depth + 1) : null;
    }
    if (node.type === "MemberExpression") {
      const o = evalObj(c, node.object, anc, asg, sels, depth + 1);
      if (!o) return null;
      const key = node.computed ? String(render(c, node.property, anc, asg, sels)) : node.property.name;
      const p = o.node.properties.find((q: N) => propKey(q) === key);
      return p ? evalObj(c, p.value, o.anc, asg, sels, depth + 1) : null;
    }
    return null;
  }
  /** Render a description under one selector assignment (`asg` null = take every consequent), recording each
   *  selector met in `sels`. */
  function render(c: Chunk, node: N, anc: N[], asg: Map<string, boolean> | null, sels: string[], depth = 0): string | number {
    if (depth > 40) return DYN;
    const R = (n: N, a: N[] = anc) => render(c, n, a, asg, sels, depth + 1);
    switch (node.type) {
      case "Literal":
        return typeof node.value === "string" || typeof node.value === "number" ? node.value : DYN;
      case "TemplateLiteral": {
        let s = "";
        node.quasis.forEach((q: N, i: number) => {
          s += q.value.cooked;
          if (i < node.expressions.length) s += String(R(node.expressions[i]));
        });
        return s;
      }
      case "BinaryExpression": {
        const a = R(node.left);
        const b = R(node.right);
        if (node.operator === "+") return typeof a === "number" && typeof b === "number" ? a + b : String(a) + String(b);
        if (typeof a === "number" && typeof b === "number") {
          if (node.operator === "/") return a / b;
          if (node.operator === "*") return a * b;
          if (node.operator === "-") return a - b;
        }
        return DYN;
      }
      case "ConditionalExpression": {
        const lb = label(c, node.test, anc);
        if (!sels.includes(lb)) sels.push(lb);
        return (asg ? asg.get(lb) : true) ? R(node.consequent) : R(node.alternate);
      }
      case "Identifier": {
        const d = lookup(c, node.name, anc);
        if (
          d?.kind === "var" &&
          d.init &&
          ["Literal", "TemplateLiteral", "BinaryExpression", "ConditionalExpression", "Identifier"].includes(d.init.type)
        )
          return R(d.init, d.anc);
        return DYN;
      }
      case "MemberExpression": {
        const k = constOf(c, node, anc);
        if (k !== undefined) return k;
        const o = evalObj(c, node.object, anc, asg, sels);
        if (o) {
          const key = node.computed ? String(render(c, node.property, anc, asg, sels, depth + 1)) : node.property.name;
          const p = o.node.properties.find((q: N) => propKey(q) === key);
          if (p) return render(c, p.value, o.anc, asg, sels, depth + 1);
        }
        return DYN;
      }
      default:
        return DYN;
    }
  }

  const seen = new Set<string>();
  const descriptions: RemoteDevicesFingerprint[] = [];
  for (const [file, src] of files) {
    if (![...wanted].some((t) => src.includes(t))) continue;
    const c = load(file);
    if (!c) continue;
    for (const t of c.tools) {
      const name = constOf(c, t.nameNode, t.anc);
      if (typeof name !== "string" || !wanted.has(name)) continue;
      const anc = [...t.anc, t.obj];
      // Discover selectors to a fixpoint: a nested selector appears only on some paths.
      const sels: string[] = [];
      render(c, t.descNode, anc, null, sels);
      let prev = -1;
      while (prev !== sels.length && sels.length <= MAX_SELECTORS) {
        prev = sels.length;
        const k = sels.length;
        for (let m = 0; m < 1 << k; m++)
          render(c, t.descNode, anc, new Map(sels.slice(0, k).map((l, i) => [l, Boolean((m >> i) & 1)])), sels);
      }
      if (sels.length > MAX_SELECTORS) {
        deltas.push(
          `cloud: ${name}'s description has more than ${MAX_SELECTORS} selectors — not fingerprinted; raise MAX_SELECTORS deliberately`,
        );
        continue;
      }
      const variants = new Map<string, Set<string>>();
      for (let m = 0; m < 1 << sels.length; m++) {
        const asg = new Map(sels.map((l, i) => [l, Boolean((m >> i) & 1)]));
        const used: string[] = [];
        const text = String(render(c, t.descNode, anc, asg, used));
        const key =
          used
            .map((l) => `${l}=${asg.get(l) ? "T" : "F"}`)
            .sort()
            .join(" & ") || "(unconditional)";
        if (!variants.has(text)) variants.set(text, new Set());
        variants.get(text)!.add(key);
      }
      for (const [text, keys] of variants) {
        const branch = sha([...keys].sort().join(" | ")).slice(0, 12);
        const rec = { name, branch, sha256: sha(text), codePoints: [...text].length };
        const id = `${rec.name}\u0000${rec.branch}\u0000${rec.sha256}`;
        if (seen.has(id)) continue;
        seen.add(id);
        descriptions.push(rec);
      }
    }
  }
  descriptions.sort((a, b) => (a.name === b.name ? (a.branch < b.branch ? -1 : 1) : a.name < b.name ? -1 : 1));
  if (descriptions.length === 0)
    deltas.push("cloud: no remote-devices tool description was found — the definitions moved; re-anchor extractCloudBlock (maintainer)");
  return { tools, descriptions, deltas };
}
