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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runsWriteRoot } from "../run/trace-view.js";

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
  const digest = imageDigest(opts.runtime, opts.image);
  const key = `${opts.tier}:${digest ?? opts.image}`;
  const cache = readCache();
  if (cache[key]) return cache[key] as CapabilityFamily[];

  // --network none: the probe touches only build-time-installed tools, so it must not depend on the egress
  // sidecar; this also makes the result a pure function of the image.
  const r = spawnSync(opts.runtime, ["run", "--rm", "--network", "none", opts.image, "sh", "-c", probeScript()], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null; // unprobeable → caller decides (warn)
  const omitted = omittedFromPresent(r.stdout);
  if (omitted === null) return null;
  cache[key] = omitted;
  writeCache(cache);
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

function imageDigest(runtime: string, image: string): string | null {
  const r = spawnSync(runtime, ["image", "inspect", "-f", "{{.Id}}", image], { encoding: "utf8" });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.trim() || null;
}

/**
 * Scan a run's events.jsonl for USE of any OMITTED capability family. Returns the subset of `omitted` the
 * skill was observed using. Usage = a command-signature match in a Bash/python tool_use command, OR a
 * failure-signature match in an `isError` tool_result (the secondary corroborator). Mirrors scanEvents'
 * block parsing; covers subagent tool calls (no parentToolUseId filter).
 */
export function detectCapabilityUse(eventsFile: string, omitted: CapabilityFamily[]): CapabilityFamily[] {
  if (!omitted.length) return [];
  let lines: string[];
  try {
    lines = readFileSync(eventsFile, "utf8").trim().split("\n");
  } catch {
    return [];
  }
  const used = new Set<CapabilityFamily>();
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
        if (cmd) for (const f of omitted) if (CAPABILITY_FAMILIES[f].commandSignatures.some((re) => re.test(cmd))) used.add(f);
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
