// The rootfs `max` tier: build a Docker image FROM the user's OWN
// Cowork rootfs.img — true byte-for-byte parity, zero reconstruction/drift. This is the definitive
// full-parity path for anyone running locally against their own Claude Desktop install.
//
//   npx tsx scripts/build-rootfs-image.ts            # → prints the cached image tag to use
//   COWORK_AGENT_IMAGE=$(npx tsx scripts/build-rootfs-image.ts --quiet) cowork-harness run scenario.yaml
//
// Faithful to "nothing Anthropic-owned is bundled or DISTRIBUTED": this is the user's own local artifact,
// imported at run time exactly like the bind-mounted agent binary — never shipped in our package. The
// resulting image is LOCAL-only (a 10GB rootfs → a multi-GB image), cached by rootfs (mtime+size) so the
// expensive tar|import runs once per Desktop build. `docker import` strips ENV/CMD, so we re-apply the
// harness env contract via `-c` (the capability probe then reports omitted:[] → the banner self-suppresses).

import { spawnSync, spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const BUNDLE = join(homedir(), "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle");
const ROOTFS = join(BUNDLE, "rootfs.img");
const QUIET = process.argv.includes("--quiet");
const FORCE = process.argv.includes("--force");
const log = (m: string) => {
  if (!QUIET) console.error(m); // logs to stderr so --quiet stdout is JUST the tag (usable in $())
};

/**
 * Content-hash the rootfs.img bytes. size+mtime can be preserved across a content change
 * (e.g. an in-place patch), which would reuse a STALE image. A streaming sha256 of the file bytes is
 * content-addressed: any byte change yields a new tag. Runs once per Desktop build (then cached).
 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("error", reject);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function tag(): Promise<{ tag: string; hash: string }> {
  const hash = await hashFile(ROOTFS);
  return { tag: `cowork-agent-rootfs:${hash.slice(0, 12)}`, hash };
}

function imageExists(t: string): boolean {
  return spawnSync("docker", ["image", "inspect", t], { stdio: "ignore" }).status === 0;
}

/** Wait for a child process to exit; resolve its code. */
function wait(p: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((res) => p.on("close", (code) => res(code ?? 1)));
}

/**
 * Drive a `producer | consumer` pipeline to completion with explicit cross-kill on failure.
 * The OS pipe self-terminates the common case (producer dies → consumer sees EOF; consumer dies →
 * producer gets EPIPE), but an edge-case where one side errors WITHOUT closing the pipe (e.g. the
 * producer stuck before streaming) can hang the other. On any error/nonzero exit we kill the sibling,
 * await BOTH, then surface the failure. Pure over the two procs → testable with fakes.
 */
export async function runPipeline(
  producer: { proc: ReturnType<typeof spawn>; label: string },
  consumer: { proc: ReturnType<typeof spawn>; label: string },
): Promise<void> {
  const kill = (p: ReturnType<typeof spawn>) => {
    try {
      if (p.exitCode === null && !p.killed) p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  // If either side errors or exits non-zero, kill the sibling so the other can't hang.
  producer.proc.once("error", () => kill(consumer.proc));
  consumer.proc.once("error", () => kill(producer.proc));
  producer.proc.once("close", (code) => {
    if (code) kill(consumer.proc);
  });
  consumer.proc.once("close", (code) => {
    if (code) kill(producer.proc);
  });
  const [producerCode, consumerCode] = await Promise.all([wait(producer.proc), wait(consumer.proc)]);
  if (producerCode !== 0) throw new Error(`${producer.label} failed (exit ${producerCode}) — see stderr above`);
  if (consumerCode !== 0) throw new Error(`${consumer.label} failed (exit ${consumerCode})`);
}

async function main(): Promise<void> {
  if (!existsSync(ROOTFS)) {
    throw new Error(`rootfs not found at ${ROOTFS} — open Claude Desktop / Cowork once to stage the VM bundle`);
  }
  const { tag: t, hash } = await tag();
  log(`rootfs content hash: ${hash} → tag ${t}`);
  if (imageExists(t) && !FORCE) {
    log(`cached: ${t} already built for this rootfs.img content — reuse it (pass --force to rebuild)`);
    console.log(t);
    return;
  }

  // Re-apply the env contract docker import drops. The rootfs already carries the ubuntu uid-1000 user,
  // the full toolchain, /opt/cowork + /smol, and /etc/environment — we only restore the Docker-level ENV/
  // WORKDIR/USER the import strips, matching the reconstructed image so the harness behaves identically.
  const importOpts = [
    "-c",
    "ENV IS_SANDBOX=yes PYTHONUNBUFFERED=1 VM_IMAGE_BUILD=2 LANG=C.UTF-8",
    "-c",
    "ENV NODE_PATH=/usr/local/lib/node_modules_global/lib/node_modules NPM_CONFIG_PREFIX=/usr/local/lib/node_modules_global",
    "-c",
    "ENV PATH=/usr/local/lib/node_modules_global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
    "-c",
    "WORKDIR /sessions/local",
    "-c",
    "USER ubuntu",
  ];

  log(`building ${t} from ${ROOTFS} (tar | docker import — this takes a few minutes for a ~10GB rootfs)…`);
  // A privileged container loop-mounts the ext4 root and streams a tar of it; we pipe that (in Node, NOT a
  // fragile host shell string) straight into `docker import`. fdisk computes the ext4 partition offset;
  // diagnostics (mount, byte count) go to stderr so a silent-empty tar can't masquerade as success.
  const mountAndTar = [
    "set -e",
    "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq fdisk >/dev/null 2>&1 || true",
    "losetup -D 2>/dev/null || true",
    'START=$(fdisk -l /bundle/rootfs.img 2>/dev/null | awk "/Linux filesystem/ {print \\$2; exit}")',
    '[ -z "$START" ] && START=206848',
    "LOOP=$(losetup -f --show -o $((START*512)) /bundle/rootfs.img)",
    "mkdir -p /mnt/root && mount -o ro,noload $LOOP /mnt/root",
    // fail loudly if the mount produced an empty root (otherwise an empty tar imports as a 5kB image)
    '[ -e /mnt/root/usr/bin/python3 ] || { echo "ROOTFS MOUNT EMPTY — aborting" >&2; exit 3; }',
    'echo "mounted; streaming tar…" >&2',
    "tar -C /mnt/root --numeric-owner --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./mnt -cf - .",
  ].join("\n");

  const tarProc = spawn(
    "docker",
    ["run", "--rm", "--privileged", "-v", `${BUNDLE}:/bundle:ro`, "ubuntu:22.04", "bash", "-c", mountAndTar],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const importProc = spawn("docker", ["import", ...importOpts, "-", t], { stdio: [tarProc.stdout!, "inherit", "inherit"] });
  await runPipeline({ proc: tarProc, label: "rootfs mount/tar" }, { proc: importProc, label: "docker import" });
  log(`built ${t} (content ${hash.slice(0, 12)}). Use it: COWORK_AGENT_IMAGE=${t} cowork-harness run <scenario> --tier container`);
  console.log(t);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
