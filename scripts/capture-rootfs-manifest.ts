// Drift gate (fix plan §8.8 / P6): capture the real Cowork rootfs's PROVISIONED toolchain into a committed
// manifest, and (--check) diff a built agent image against it so a future rootfs that adds packages surfaces
// as a TRACKED drift instead of a silent fidelity gap.
//
//   npx tsx scripts/capture-rootfs-manifest.ts          # mount the real rootfs.img, write baselines/rootfs-provisioning.json
//   npx tsx scripts/capture-rootfs-manifest.ts --check cowork-agent-full:2   # diff an image's stack vs the manifest
//
// LOCAL-ONLY / Docker lane: this privileged loop-mounts the user's OWN rootfs.img (their Claude Desktop
// install) — exactly like the harness bind-mounts their own agent binary; nothing Anthropic-owned is
// bundled or committed beyond a package NAME+VERSION list. It is NOT part of `cowork-harness sync` (which
// reads only app.asar and never the rootfs), and it can never run on the token-free replay gate.

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = join(REPO_ROOT, "docker", "Dockerfile.agent");
// NB: a SUBDIR of baselines/ — the baseline-validation test globs only top-level baselines/*.json as
// PlatformBaseline; this provisioning manifest is a different artifact and must not sit alongside them.
const MANIFEST = join(REPO_ROOT, "baselines", "provisioning", "rootfs-provisioning.json");
const BUNDLE = join(homedir(), "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle");
const ROOTFS = join(BUNDLE, "rootfs.img");

export interface ProvisioningManifest {
  capturedFrom: "rootfs.img";
  node: string;
  pip: Record<string, string>; // name -> version (from pip freeze)
  aptDocStack: string[]; // notable doc/OCR/office apt packages present (name list)
  npmGlobals: string[];
  generatedNote: string;
}

// The doc/OCR/office apt packages we care about mirroring (subset of the ~1177 — the rest is base cruft).
const APT_OF_INTEREST = [
  "tesseract-ocr",
  "poppler-utils",
  "ghostscript",
  "imagemagick",
  "libreoffice-core",
  "default-jre-headless",
  "openjdk-11-jre-headless",
  "pandoc",
  "graphviz",
  "ffmpeg",
  "qpdf",
  "ruby",
];

/** Run a shell snippet inside the loop-mounted rootfs (privileged container, chroot). Returns stdout. */
function inRootfs(snippet: string): string {
  if (!existsSync(ROOTFS)) {
    throw new Error(`rootfs not found at ${ROOTFS} — open Claude Desktop / Cowork once to stage the VM bundle`);
  }
  const script = [
    "set -e",
    "losetup -D 2>/dev/null || true",
    // GPT: partition 1 is the ext4 root; compute its byte offset from fdisk rather than hard-coding.
    'START=$(fdisk -l /bundle/rootfs.img 2>/dev/null | awk "/Linux filesystem/ {print \\$2; exit}")',
    '[ -z "$START" ] && START=206848',
    "LOOP=$(losetup -f --show -o $((START*512)) /bundle/rootfs.img)",
    "mkdir -p /mnt/root && mount -o ro,noload $LOOP /mnt/root",
    snippet,
  ].join("\n");
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--privileged",
      "-v",
      `${BUNDLE}:/bundle:ro`,
      "ubuntu:22.04",
      "bash",
      "-c",
      `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq fdisk >/dev/null 2>&1; ${script}`,
    ],
    { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`rootfs probe failed (exit ${r.status}): ${r.stderr?.slice(0, 500)}`);
  return r.stdout ?? "";
}

function parsePipFreeze(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_.\-]+)==([^\s]+)$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function capture(): ProvisioningManifest {
  const out = inRootfs(
    [
      'echo "###NODE###"',
      "chroot /mnt/root /usr/bin/node --version 2>/dev/null || echo unknown",
      'echo "###PIP###"',
      "chroot /mnt/root /usr/bin/python3 -m pip freeze 2>/dev/null || true",
      'echo "###APT###"',
      `for p in ${APT_OF_INTEREST.join(" ")}; do chroot /mnt/root dpkg-query -W -f='\${Package} \${Status}\\n' "$p" 2>/dev/null | grep "install ok installed" | awk '{print $1}'; done`,
      'echo "###NPM###"',
      "ls /mnt/root/usr/local/lib/node_modules_global/lib/node_modules 2>/dev/null || true",
    ].join("\n"),
  );
  const section = (name: string) => {
    const re = new RegExp(`###${name}###\\n([\\s\\S]*?)(?:\\n###|$)`);
    return (out.match(re)?.[1] ?? "").trim();
  };
  return {
    capturedFrom: "rootfs.img",
    node: section("NODE").trim() || "unknown",
    pip: parsePipFreeze(section("PIP")),
    aptDocStack: section("APT")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort(),
    npmGlobals: section("NPM")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("."))
      .sort(),
    generatedNote:
      "Generated by scripts/capture-rootfs-manifest.ts from the local Claude Desktop rootfs.img. " +
      "Names+versions only (no Anthropic bytes). Re-run after a Desktop update to track provisioning drift.",
  };
}

/** Probe a built agent image's installed stack (node + pip + dpkg + npm globals). */
export interface ImageStack {
  node: string;
  pip: Record<string, string>;
  apt: Set<string>;
  npmGlobals: Set<string>;
}

export function probeImage(image: string, aptOfInterest: string[]): ImageStack {
  const aptProbe = aptOfInterest
    .map((p) => `dpkg-query -W -f='\${Package} \${Status}\\n' "${p}" 2>/dev/null | grep "install ok installed" | awk '{print $1}'`)
    .join("; ");
  const script = [
    "node --version",
    "echo '###PIP###'",
    "python3 -m pip freeze 2>/dev/null",
    "echo '###APT###'",
    aptProbe || "true",
    "echo '###NPM###'",
    "npm ls -g --depth=0 --parseable 2>/dev/null || true",
  ].join("; ");
  const r = spawnSync("docker", ["run", "--rm", "--network", "none", image, "bash", "-lc", script], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`image probe failed for ${image}: ${r.stderr?.slice(0, 300)}`);
  return parseImageStack(r.stdout ?? "");
}

/** Pure parser for the probeImage stdout layout — token-free unit-testable. */
export function parseImageStack(stdout: string): ImageStack {
  const sec = (name: string): string => {
    const re = new RegExp(`###${name}###\\n([\\s\\S]*?)(?:\\n###|$)`);
    return (stdout.match(re)?.[1] ?? "").trim();
  };
  const [nodePart] = stdout.split("###PIP###");
  // `npm ls -g --parseable` prints absolute module dirs; the last path segment is the package name.
  const npmGlobals = new Set(
    sec("NPM")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("/").filter(Boolean).pop() ?? "")
      .filter((n) => n && n !== "lib" && !n.startsWith(".")),
  );
  return {
    node: (nodePart ?? "").trim(),
    pip: parsePipFreeze(sec("PIP")),
    apt: new Set(
      sec("APT")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    npmGlobals,
  };
}

/**
 * Parse the Layer-A `pip3 install` pins out of docker/Dockerfile.agent so --check diffs the WHOLE
 * Layer-A contract, not a hand-maintained subset that silently omitted pdf2image/seaborn/etc.
 * Returns the lowercased pip package names (normalizing `_`/`.` the way pip freeze does).
 */
export function dockerfileCorePip(dockerfile = DOCKERFILE): Set<string> {
  const text = readFileSync(dockerfile, "utf8");
  // Grab the Layer-A pip block: the `pip3 install ... \` RUN that is NOT inside the Layer-B `if` guard.
  // Layer B installs are inside `if [ "$COWORK_FULL_PARITY" = "1" ]`; we stop at that marker.
  const layerB = text.indexOf('COWORK_FULL_PARITY" = "1"');
  const layerA = layerB >= 0 ? text.slice(0, layerB) : text;
  const m = layerA.match(/pip3 install[^\n]*--no-cache-dir\s*\\\n([\s\S]*?)(?:\n#|\nENV |\nRUN |\nUSER |$)/);
  if (!m) throw new Error(`could not locate the Layer-A pip3 install block in ${dockerfile}`);
  const out = new Set<string>();
  // tokens look like `numpy==2.2.6`, `et_xmlfile==2.0.0`, `Markdown==3.10.2`; strip the `==version`.
  for (const tok of m[1].split(/\s+/)) {
    const name = tok.split("==")[0].replace(/\\$/, "").trim();
    if (!name || name.startsWith("#")) continue;
    out.add(normalizePip(name));
  }
  if (out.size === 0) throw new Error(`parsed an EMPTY Layer-A pip set from ${dockerfile}`);
  return out;
}

const normalizePip = (n: string) => n.toLowerCase().replace(/_/g, "-");

/** Compare a major.minor-ish node version string; returns true if the major versions differ. */
export function nodeMajorDiffers(a: string, b: string): boolean {
  const major = (v: string) => v.match(/v?(\d+)\./)?.[1] ?? v.trim();
  return major(a) !== major(b);
}

/**
 * Diff a probed image stack against the manifest. Pure (no docker) so it is unit-testable.
 * Covers the full Layer-A pip contract (43), node drift (44), and the apt/npm layers (45).
 */
export interface DriftReport {
  missingPip: string[];
  missingApt: string[];
  missingNpm: string[];
  nodeMismatch: boolean;
  node: { image: string; rootfs: string };
}

export function diffStack(stack: ImageStack, manifest: ProvisioningManifest, corePip: Set<string>): DriftReport {
  const imagePip = new Set(Object.keys(stack.pip).map(normalizePip));
  // Flag every Layer-A package (from the Dockerfile) that the manifest's rootfs ships but the image lacks.
  const missingPip = [...corePip].filter((p) => manifestHasPip(manifest, p) && !imagePip.has(p)).sort();
  const missingApt = manifest.aptDocStack.filter((p) => !stack.apt.has(p)).sort();
  const missingNpm = manifest.npmGlobals.filter((p) => !stack.npmGlobals.has(p)).sort();
  const nodeMismatch = !!stack.node && !!manifest.node && manifest.node !== "unknown" && nodeMajorDiffers(stack.node, manifest.node);
  return { missingPip, missingApt, missingNpm, nodeMismatch, node: { image: stack.node, rootfs: manifest.node } };
}

const manifestHasPip = (m: ProvisioningManifest, name: string) => Object.keys(m.pip).some((k) => normalizePip(k) === name);

function runCheck(image: string, warnOnly: boolean): void {
  if (!existsSync(MANIFEST)) throw new Error(`no manifest at ${MANIFEST} — run without --check first to capture it`);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as ProvisioningManifest;
  const corePip = dockerfileCorePip();
  const stack = probeImage(image, manifest.aptDocStack);
  const report = diffStack(stack, manifest, corePip);
  console.log(`node: image=${report.node.image} rootfs=${report.node.rootfs}`);
  const drift: string[] = [];
  if (report.missingPip.length) drift.push(`MISSING Layer-A pip packages the rootfs ships: ${report.missingPip.join(", ")}`);
  if (report.nodeMismatch) drift.push(`Node major mismatch: image=${report.node.image} rootfs=${report.node.rootfs}`);
  if (report.missingApt.length) drift.push(`MISSING apt doc-stack packages: ${report.missingApt.join(", ")}`);
  if (report.missingNpm.length) drift.push(`MISSING npm globals: ${report.missingNpm.join(", ")}`);
  if (drift.length) {
    for (const d of drift) console.error(`DRIFT: ${image} — ${d}`);
    if (warnOnly) {
      console.error("(--warn-only: not failing)");
      return;
    }
    process.exit(1);
  }
  console.log(
    `OK: ${image} carries the full Layer-A core stack the rootfs ships ` +
      `(pip=${corePip.size} core, apt=${manifest.aptDocStack.length}, npm=${manifest.npmGlobals.length}, node ok).`,
  );
}

function main(): void {
  const checkIdx = process.argv.indexOf("--check");
  if (checkIdx >= 0) {
    const image = process.argv[checkIdx + 1];
    if (!image) throw new Error("--check needs an image tag, e.g. --check cowork-agent-full:2");
    runCheck(image, process.argv.includes("--warn-only"));
  } else {
    const manifest = capture();
    mkdirSync(dirname(MANIFEST), { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`wrote ${MANIFEST}`);
    console.log(
      `  node=${manifest.node}  pip=${Object.keys(manifest.pip).length} pkgs  apt-of-interest=${manifest.aptDocStack.length}  npm-globals=${manifest.npmGlobals.length}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
