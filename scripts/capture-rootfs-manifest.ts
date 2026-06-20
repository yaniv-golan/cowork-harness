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
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// NB: a SUBDIR of baselines/ — the baseline-validation test globs only top-level baselines/*.json as
// PlatformBaseline; this provisioning manifest is a different artifact and must not sit alongside them.
const MANIFEST = join(REPO_ROOT, "baselines", "provisioning", "rootfs-provisioning.json");
const BUNDLE = join(homedir(), "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle");
const ROOTFS = join(BUNDLE, "rootfs.img");

interface ProvisioningManifest {
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

/** Diff a built agent image's installed stack against the manifest; returns missing package names. */
function checkImage(image: string, manifest: ProvisioningManifest): { missingPip: string[]; node: { image: string; rootfs: string } } {
  const r = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", image, "bash", "-lc", "node --version; echo '###PIP###'; python3 -m pip freeze 2>/dev/null"],
    {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (r.status !== 0) throw new Error(`image probe failed for ${image}: ${r.stderr?.slice(0, 300)}`);
  const [nodeLine, pipText] = (r.stdout ?? "").split("###PIP###");
  const imagePip = parsePipFreeze(pipText ?? "");
  // Only flag the document/data stack we deliberately mirror (Layer A); Layer-B-only packages are expected
  // absent on the core image, so a check is most meaningful against cowork-agent-full.
  const missingPip = Object.keys(manifest.pip).filter((p) => !(p in imagePip) && CORE_PIP.has(p));
  return { missingPip, node: { image: (nodeLine ?? "").trim(), rootfs: manifest.node } };
}

// The Layer-A core stack (lowercased) — what the DEFAULT image must carry; used to scope --check.
const CORE_PIP = new Set([
  "numpy",
  "pandas",
  "openpyxl",
  "et-xmlfile",
  "et_xmlfile",
  "xlsxwriter",
  "python-docx",
  "python-pptx",
  "odfpy",
  "pdfplumber",
  "pypdf",
  "pdfminer.six",
  "pikepdf",
  "matplotlib",
  "pillow",
  "reportlab",
  "lxml",
  "beautifulsoup4",
  "tabulate",
  "jsonschema",
  "requests",
  "python-magic",
  "markdown",
  "jinja2",
]);

const checkIdx = process.argv.indexOf("--check");
if (checkIdx >= 0) {
  const image = process.argv[checkIdx + 1];
  if (!image) throw new Error("--check needs an image tag, e.g. --check cowork-agent-full:2");
  if (!existsSync(MANIFEST)) throw new Error(`no manifest at ${MANIFEST} — run without --check first to capture it`);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as ProvisioningManifest;
  const { missingPip, node } = checkImage(image, manifest);
  console.log(`node: image=${node.image} rootfs=${node.rootfs}`);
  if (missingPip.length) {
    console.error(`DRIFT: ${image} is MISSING core pip packages the rootfs ships: ${missingPip.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `OK: ${image} carries the full Layer-A core stack the rootfs ships (${Object.keys(manifest.pip).length} rootfs pip pkgs total).`,
  );
} else {
  const manifest = capture();
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${MANIFEST}`);
  console.log(
    `  node=${manifest.node}  pip=${Object.keys(manifest.pip).length} pkgs  apt-of-interest=${manifest.aptDocStack.length}  npm-globals=${manifest.npmGlobals.length}`,
  );
}
