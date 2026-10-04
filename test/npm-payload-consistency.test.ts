// T-G2 — what the SHIPPED docs claim about the npm payload has to be true of the npm payload.
//
// Two promises, both measured against `npm pack --dry-run --json` (the exact published file list):
// every relative link in a shipped doc resolves inside it, and every shipped example scenario can
// actually resolve its session and skill sources from it — which is what the README's "What ships"
// table now asserts in prose.
//
// Nine links pointed at files that exist in a checkout and are not published: `./action.yml`,
// `.github/workflows/ci.yml`, three `src/**` implementation pointers, and two `examples/**` "runnable
// copy" pointers. In a git checkout all nine resolve, so nothing in the ordinary test suite could see
// them; from `npm i cowork-harness` they were dead. They are now GitHub `blob/main` links — the same
// convention the companion skill's references already use, for the same reason (the doc travels away
// from the repo).
//
// WHY THIS IS NOT `check-skill-doc-links.ts`. That script is a denylist regex over three plugin-cache
// roots matching `.md|.json|.ya?ml`; it never resolves a link, and it reports ZERO violations for the
// `src/**` targets above. This drives off `npm pack --dry-run --json` — the exact published file list —
// and resolves every extracted target against it.
//
// The scan is validated by its own second measurement: every relative target it extracts resolves on
// disk in a source checkout. A zero there means the extractor is not inventing links; the count floors
// below mean it is not silently extracting none.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

/** The exact file list npm would publish, package-root-relative. */
function packedPaths(): string[] {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (JSON.parse(raw) as { files: { path: string }[] }[])[0].files.map((f) => f.path);
}

/** Fenced blocks and inline code hold illustrative markup, not links the reader can follow. */
function stripCode(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const m = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fence !== null) {
      if (m && line.trim().startsWith(fence)) fence = null;
      out.push(""); // keep line numbers honest
      continue;
    }
    if (m) {
      fence = m[1];
      out.push("");
      continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, ""));
  }
  return out.join("\n");
}

/** Inline links/images, reference definitions, and raw HTML hrefs. `[^fn]:` is a FOOTNOTE definition,
 *  not a link target — matching it reported the prose after the colon as a broken path. */
function linkTargets(md: string): { target: string; line: number }[] {
  const src = stripCode(md);
  const found: { target: string; line: number }[] = [];
  const at = (i: number) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\s*\)/g))
    found.push({ target: m[1], line: at(m.index) });
  for (const m of src.matchAll(/^\s{0,3}\[(?!\^)[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)) found.push({ target: m[1], line: at(m.index) });
  for (const m of src.matchAll(/<(?:a[^>]*href|img[^>]*src)=["']([^"']+)["']/gi)) found.push({ target: m[1], line: at(m.index) });
  return found;
}

/** Package-root-relative path a target resolves to, or undefined if it is not a relative link. */
function resolveTarget(doc: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("#")) return undefined;
  const clean = decodeURI(target.split("#")[0].split("?")[0]);
  if (!clean) return undefined;
  const abs = clean.startsWith("/") ? clean.slice(1) : posix.normalize(posix.join(posix.dirname(doc), clean));
  return abs.replace(/\/$/, "");
}

/** `baselines/prompts/**` are captured prompt text, not documentation — their `[Title](URL)` is a
 *  literal instruction to the model, and "fixing" it would corrupt the baseline. */
const scannedDocs = (packed: string[]) => packed.filter((p) => p.endsWith(".md") && !p.startsWith("baselines/"));

describe("T-G2 · shipped docs link only to shipped files", () => {
  const packed = packedPaths();
  const packedSet = new Set(packed);
  const packedDirs = new Set<string>();
  for (const p of packed) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) packedDirs.add(parts.slice(0, i).join("/"));
  }
  const inPayload = (p: string) => packedSet.has(p) || packedDirs.has(p);

  const docs = scannedDocs(packed);
  const links = docs.flatMap((doc) =>
    linkTargets(readFileSync(doc, "utf8")).flatMap((l) => {
      const resolved = resolveTarget(doc, l.target);
      return resolved === undefined ? [] : [{ doc, ...l, resolved }];
    }),
  );

  it("scans a real corpus (never go green over an empty scan)", () => {
    expect(docs.length, "npm pack shipped almost no markdown").toBeGreaterThan(20);
    expect(links.length, "the extractor found almost no relative links — it is not matching").toBeGreaterThan(200);
  });

  it("can actually report a miss (the resolver is not stuck on true)", () => {
    // `src/**` is never published — dist is. If this resolved, every assertion below would be vacuous.
    expect(inPayload(resolveTarget("docs/x.md", "../src/cli.ts")!)).toBe(false);
    expect(inPayload(resolveTarget("docs/x.md", "./cassette.md")!)).toBe(true);
  });

  it("extracts only real links (every target resolves in a source checkout)", () => {
    // The counterweight to the floors above: a sloppy regex inflates `links.length` with prose, and
    // this is where that shows up. Prose does not exist on disk.
    const notOnDisk = links.filter((l) => !existsSync(l.resolved)).map((l) => `${l.doc}:${l.line} -> ${l.target}`);
    expect(notOnDisk, `these are not links, or they are dead in the checkout too:\n  ${notOnDisk.join("\n  ")}`).toEqual([]);
  });

  it("every relative link in a shipped doc resolves inside the tarball", () => {
    const dead = links.filter((l) => !inPayload(l.resolved)).map((l) => `${l.doc}:${l.line} -> ${l.target}`);
    expect(
      dead,
      `dead from an npm install — link to https://github.com/yaniv-golan/cowork-harness/blob/main/… instead, ` +
        `or add the target to package.json files[]:\n  ${dead.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The README used to say a global install "ships only `examples/replays/`" and that
// `run examples/scenarios/…` "errors with a missing file". Shipping the sibling trees made all five
// statements of that claim false at once, in five places, and nothing noticed — a `files[]` edit and the
// prose describing it have no mechanical link. This is that link: it fails when a scenario stops
// resolving from the payload, which is the fact the prose is about.

describe("T-G2 · shipped example scenarios resolve from the payload alone", () => {
  const packed = new Set(packedPaths());
  const scenarios = [...packed].filter((p) => /^examples\/(scenarios|hillclimb\/scenarios)\/.+\.ya?ml$/.test(p)).sort();

  /** `session:`, plus the skill/plugin roots and uploads that session stages — each resolved relative to its own file. */
  function referencesOf(scenario: string): string[] {
    const doc = parseYaml(readFileSync(scenario, "utf8")) as { session?: string };
    if (typeof doc?.session !== "string") return [];
    const sessionPath = posix.normalize(posix.join(posix.dirname(scenario), doc.session));
    if (!existsSync(sessionPath)) return [sessionPath];
    const sess = parseYaml(readFileSync(sessionPath, "utf8")) as {
      skills?: { local?: string[] };
      plugins?: { local_plugins?: string[] };
      uploads?: string[];
    };
    const roots = [...(sess?.skills?.local ?? []), ...(sess?.plugins?.local_plugins ?? []), ...(sess?.uploads ?? [])];
    return [sessionPath, ...roots.map((r) => posix.normalize(posix.join(posix.dirname(sessionPath), r)))];
  }

  it("finds the shipped scenarios (never go green over an empty list)", () => {
    expect(scenarios.length, "no example scenarios in the payload at all").toBeGreaterThan(4);
    expect(scenarios.flatMap(referencesOf).length, "no scenario declared a session — parsing is broken").toBeGreaterThan(4);
  });

  it("every scenario's session and skill sources are in the payload", () => {
    const missing = scenarios.flatMap((s) =>
      referencesOf(s)
        .filter((r) => !packed.has(r) && ![...packed].some((p) => p.startsWith(`${r}/`)))
        .map((r) => `${s} -> ${r}`),
    );
    expect(
      missing,
      `the README says a global install can \`run examples/scenarios/…\`; these do not resolve from the ` +
        `payload:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});
