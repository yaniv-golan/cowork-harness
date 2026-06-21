// Capability fidelity (fix plan §8.8 D6/D2/D3): the "core" agent image is a deliberate partial mirror of
// the real Cowork rootfs. To never SILENTLY false-negative a skill that uses a capability the core image
// omits (but real Cowork ships), we (a) PROBE the actual image for which capability families it has —
// cached by (tier, digest), the image is the source of truth, not a baked label — and (b) detect whether
// the skill USED an omitted family (from events.jsonl). The intersection becomes RunResult.missingCapabilityUse,
// which computeVerdict fails on (unless `allow_missing_capability`). See verdict.ts.
//
// SINGLE SOURCE OF TRUTH: CAPABILITY_FAMILIES backs BOTH the probe (what the image has) and the usage
// detector (what the skill did) — they cannot drift.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { runsWriteRoot } from "../run/trace-view.js";
import { warn } from "../io.js";

export type CapabilityFamily = "ocr" | "office_convert" | "ml_extract" | "cv" | "pdf_tables" | "magick";

interface FamilySpec {
  /** A `sh` test that exits 0 iff the image HAS this capability (run inside the image). */
  probe: string;
  /** USAGE signals in a Bash/python tool_use command (the skill invoking the capability). */
  commandSignatures: RegExp[];
  /** Corroborating FAILURE signals — only matched in an `isError` tool_result. */
  failureSignatures: RegExp[];
}

export const CAPABILITY_FAMILIES: Record<CapabilityFamily, FamilySpec> = {
  ocr: {
    probe: "command -v tesseract >/dev/null 2>&1",
    commandSignatures: [/\btesseract\b/, /\bpytesseract\b/, /import\s+pytesseract/],
    failureSignatures: [/tesseract[^\n]*not found/i, /TesseractNotFound/i, /tesseract is not installed/i],
  },
  office_convert: {
    probe: "command -v soffice >/dev/null 2>&1",
    commandSignatures: [/\bsoffice\b/, /\blibreoffice\b/i, /\bunoserver\b/, /import\s+(pyoo|unoserver)/],
    failureSignatures: [/soffice[^\n]*not found/i, /libreoffice[^\n]*not found/i],
  },
  ml_extract: {
    probe: 'python3 -c "import markitdown, magika, onnxruntime" >/dev/null 2>&1',
    commandSignatures: [/import\s+(markitdown|magika|onnxruntime)/, /\bmarkitdown\b/],
    failureSignatures: [/No module named ['"](markitdown|magika|onnxruntime)['"]/],
  },
  cv: {
    probe: 'python3 -c "import cv2" >/dev/null 2>&1',
    commandSignatures: [/import\s+cv2\b/, /\bcv2\./],
    failureSignatures: [/No module named ['"]cv2['"]/, /libGL\.so/],
  },
  pdf_tables: {
    probe: 'python3 -c "import camelot" >/dev/null 2>&1 || python3 -c "import tabula" >/dev/null 2>&1',
    commandSignatures: [/import\s+(camelot|tabula)\b/, /\bcamelot\b/, /\btabula\b/],
    failureSignatures: [/No module named ['"](camelot|tabula)['"]/],
  },
  magick: {
    probe: 'python3 -c "import wand" >/dev/null 2>&1',
    commandSignatures: [/import\s+wand\b/, /from\s+wand\b/],
    failureSignatures: [/No module named ['"]wand['"]/, /MagickWand[^\n]*not (found|present)/i],
  },
};

const FAMILIES = Object.keys(CAPABILITY_FAMILIES) as CapabilityFamily[];

/** The probe script: prints `COWORK_PRESENT:<space-separated families the image HAS>`. */
function probeScript(): string {
  const lines = FAMILIES.map((f) => `${CAPABILITY_FAMILIES[f].probe} && p="$p ${f}"`);
  return ['p=""', ...lines, 'echo "COWORK_PRESENT:$p"'].join("\n");
}

function cacheFile(): string {
  return join(runsWriteRoot(), "capability-cache.json");
}
function readCache(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeCache(c: Record<string, string[]>): void {
  try {
    mkdirSync(runsWriteRoot(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(c, null, 2));
  } catch {
    /* cache is an optimization; never fatal */
  }
}

export interface ProbeOpts {
  runtime: string; // "docker" | "podman"
  image: string;
  tier: string; // "container" | "hostloop" — the cache key includes it (a digest can mean different things per tier)
}

/**
 * Returns the capability families the image OMITS (does not have), or null if the image could not be probed
 * (daemon down / image absent). Cached by `(tier, image-digest)` at runsWriteRoot — one probe per build.
 * Container/hostloop only (both use a Docker image); lima/rootfs probing is handled by their own tiers.
 */
export function probeImageOmitted(opts: ProbeOpts): CapabilityFamily[] | null {
  // The cache key must be CONTENT-addressed so a tag rebuilt in place can't reuse a stale `omitted` set.
  // imageIdentity returns the content-addressed image id (+Created) when `image inspect` succeeds; when it
  // can't (daemon down, never-pulled tag), we have only the MUTABLE tag — which a rebuild reuses — so we
  // must NOT persist that result to the on-disk cache (it would survive a rebuild and go stale).
  const ident = imageIdentity(opts.runtime, opts.image);
  const key = `${opts.tier}:${ident.key}`;
  const cache = readCache();
  if (ident.cacheable && cache[key]) return cache[key] as CapabilityFamily[];

  // --network none: the probe touches only build-time-installed tools, so it must not depend on the egress
  // sidecar; this also makes the result a pure function of the image.
  const r = spawnSync(opts.runtime, ["run", "--rm", "--network", "none", opts.image, "sh", "-c", probeScript()], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null; // unprobeable → caller decides (warn)
  const omitted = omittedFromPresent(r.stdout);
  if (omitted === null) return null;
  if (ident.cacheable) {
    cache[key] = omitted;
    writeCache(cache);
  } else {
    // No content digest → the key is the mutable tag; persisting would let a rebuilt-in-place tag reuse this
    // result. Probe fresh every run instead, and tell the user why caching is off.
    warn(
      `::warning:: [capability] could not read a content digest for image ${opts.image} ` +
        `(\`${opts.runtime} image inspect\` failed) — capability probe is NOT cached this run; a rebuilt-in-place ` +
        `tag would otherwise reuse stale capability data.\n`,
    );
  }
  return omitted;
}

/** Parse a `COWORK_PRESENT:<families>` line into the OMITTED set (families NOT present), or null if absent. */
function omittedFromPresent(stdout: string): CapabilityFamily[] | null {
  const line = stdout.split("\n").find((l) => l.startsWith("COWORK_PRESENT:"));
  if (line === undefined) return null;
  const present = new Set(line.slice("COWORK_PRESENT:".length).trim().split(/\s+/).filter(Boolean));
  return FAMILIES.filter((f) => !present.has(f));
}

/**
 * Probe a RUNNING Lima microvm guest (L2) for omitted capabilities via `limactl shell` — the L2 analogue of
 * the Docker probe (L2 has no image, so the cache key is the instance name, not a digest). The instance is
 * deterministic from the baseline (`instanceName`), so it's stable across a run. Container/hostloop use
 * probeImageOmitted; this closes the L2 capability-probe gap.
 */
export function probeMicrovmOmitted(instance: string): CapabilityFamily[] | null {
  const key = `microvm:${instance}`;
  const cache = readCache();
  if (cache[key]) return cache[key] as CapabilityFamily[];
  const r = spawnSync("limactl", ["shell", "--workdir", "/", instance, "sh", "-c", probeScript()], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const omitted = omittedFromPresent(r.stdout);
  if (omitted === null) return null;
  cache[key] = omitted;
  writeCache(cache);
  return omitted;
}

interface ImageIdentity {
  /** The cache-key payload: a content-addressed `id:created` when available, else the mutable tag. */
  key: string;
  /** True iff `key` is content-addressed (safe to persist); false when it's only the mutable tag. */
  cacheable: boolean;
}

/**
 * Resolve a STABLE identity for an image. `image inspect` yields the content-addressed config id (`{{.Id}}`),
 * which already changes whenever the built image content changes; we fold in `{{.Created}}` so even an id
 * collision (or a runtime that reuses ids) can't reuse a stale entry. When inspect fails (daemon down, tag
 * never built locally) we fall back to the MUTABLE tag and mark the identity un-cacheable so the caller
 * skips persistent caching — a tag rebuilt in place must never reuse a prior `omitted` set.
 */
function imageIdentity(runtime: string, image: string): ImageIdentity {
  const r = spawnSync(runtime, ["image", "inspect", "-f", "{{.Id}} {{.Created}}", image], { encoding: "utf8" });
  if (r.status === 0 && typeof r.stdout === "string") {
    const fields = r.stdout.trim().split(/\s+/).filter(Boolean);
    // Require at least the content-addressed id; Created is best-effort corroboration.
    if (fields.length && fields[0]) return { key: fields.join(":"), cacheable: true };
  }
  return { key: image, cacheable: false };
}

/** Interpreters whose first script-file argument we follow into the workspace for a deeper signature scan. */
const SCRIPT_INTERPRETERS = /(?:^|[;&|]|\s)(?:python3?|node|ruby|bash|sh)\s+/;
/** A bare script-file token: `foo.py`, `./pkg/run.py`, `scripts/x.js` — NOT a flag and NOT inline `-c "…"`. */
const SCRIPT_FILE_RE = /(?:^|\s)((?:\.{0,2}\/)?[\w./-]+\.(?:py|js|mjs|cjs|rb|sh))\b/g;
/** Cap how many distinct workspace files we read per run — best-effort, never an unbounded fan-out. */
const MAX_SCRIPT_SCANS = 64;
/** Cap per-file read size so a pathological artifact can't blow up the scan. */
const MAX_SCRIPT_BYTES = 1_000_000;

/** Extract candidate script paths a shell command executes (`python script.py …` → `script.py`). */
function scriptPathsInCommand(cmd: string): string[] {
  if (!SCRIPT_INTERPRETERS.test(cmd)) return [];
  const out: string[] = [];
  for (const m of cmd.matchAll(SCRIPT_FILE_RE)) out.push(m[1]);
  return out;
}

/**
 * Best-effort, side-effect-free read of a workspace script for capability signatures. Resolves `rel` under
 * `workRoot`, refuses to escape it (a `../` path or absolute path is ignored), and silently skips anything
 * missing/oversized. Returns the file text or "".
 */
function readWorkspaceScript(workRoot: string, rel: string): string {
  if (isAbsolute(rel)) return ""; // only follow paths relative to the agent's workspace
  const full = resolve(workRoot, rel);
  const root = resolve(workRoot);
  if (full !== root && !full.startsWith(root + "/")) return ""; // containment: no escape via `../`
  try {
    if (!existsSync(full)) return "";
    if (statSync(full).size > MAX_SCRIPT_BYTES) return "";
    return readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

/**
 * Scan a run's events.jsonl for USE of any OMITTED capability family. Returns the subset of `omitted` the
 * skill was observed using. Usage = a command-signature match in a Bash/python tool_use command, OR a
 * failure-signature match in an `isError` tool_result (the secondary corroborator). Mirrors scanEvents'
 * block parsing; covers subagent tool calls (no parentToolUseId filter).
 *
 * When `workRoot` is given, a command that EXECUTES a workspace script (`python script.py`) also has that
 * script's contents scanned for command signatures — so a missing-module import hidden inside a script file
 * (e.g. `import cv2`) is still attributed, even when the import never surfaces in the command text or an
 * error (the module may simply be present, or the script may swallow the failure). Script reads are
 * read-only, containment-checked, and bounded; missing files are skipped.
 */
export function detectCapabilityUse(eventsFile: string, omitted: CapabilityFamily[], workRoot?: string): CapabilityFamily[] {
  if (!omitted.length) return [];
  let lines: string[];
  try {
    lines = readFileSync(eventsFile, "utf8").trim().split("\n");
  } catch {
    return [];
  }
  const used = new Set<CapabilityFamily>();
  const scannedScripts = new Set<string>(); // de-dupe + bound disk reads across the whole run
  const matchText = (text: string) => {
    for (const f of omitted) if (CAPABILITY_FAMILIES[f].commandSignatures.some((re) => re.test(text))) used.add(f);
  };
  for (const l of lines) {
    let msg: any;
    try {
      msg = JSON.parse(l);
    } catch {
      continue;
    }
    if (msg.type !== "assistant" && msg.type !== "user") continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_use") {
        const cmd = String(block.input?.command ?? block.input?.code ?? "");
        if (cmd) {
          matchText(cmd);
          // Follow a `python script.py` style command into the workspace file when we know where it lives.
          if (workRoot && used.size < omitted.length) {
            for (const rel of scriptPathsInCommand(cmd)) {
              if (scannedScripts.size >= MAX_SCRIPT_SCANS) break;
              if (scannedScripts.has(rel)) continue;
              scannedScripts.add(rel);
              const src = readWorkspaceScript(workRoot, rel);
              if (src) matchText(src);
            }
          }
        }
      }
      if (block.type === "tool_result" && block.is_error) {
        const c = block.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((s: any) => s?.text ?? "").join("\n") : "";
        if (text) for (const f of omitted) if (CAPABILITY_FAMILIES[f].failureSignatures.some((re) => re.test(text))) used.add(f);
      }
    }
  }
  return omitted.filter((f) => used.has(f));
}
