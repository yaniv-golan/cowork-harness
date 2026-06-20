// P8a — the rootfs `max` tier (fix plan §7a Route 2 / §8.4-P8): build a Docker image FROM the user's OWN
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
import { statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const BUNDLE = join(homedir(), "Library", "Application Support", "Claude", "vm_bundles", "claudevm.bundle");
const ROOTFS = join(BUNDLE, "rootfs.img");
const QUIET = process.argv.includes("--quiet");
const FORCE = process.argv.includes("--force");
const log = (m: string) => {
  if (!QUIET) console.error(m); // logs to stderr so --quiet stdout is JUST the tag (usable in $())
};

function tag(): string {
  const st = statSync(ROOTFS);
  const id = createHash("sha256").update(`${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 12);
  return `cowork-agent-rootfs:${id}`;
}

function imageExists(t: string): boolean {
  return spawnSync("docker", ["image", "inspect", t], { stdio: "ignore" }).status === 0;
}

/** Wait for a child process to exit; resolve its code. */
function wait(p: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((res) => p.on("close", (code) => res(code ?? 1)));
}

async function main(): Promise<void> {
  if (!existsSync(ROOTFS)) {
    throw new Error(`rootfs not found at ${ROOTFS} — open Claude Desktop / Cowork once to stage the VM bundle`);
  }
  const t = tag();
  if (imageExists(t) && !FORCE) {
    log(`cached: ${t} already built for this rootfs.img — reuse it (pass --force to rebuild)`);
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
  const [tarCode, importCode] = await Promise.all([wait(tarProc), wait(importProc)]);
  if (tarCode !== 0) throw new Error(`rootfs mount/tar failed (exit ${tarCode}) — see stderr above`);
  if (importCode !== 0) throw new Error(`docker import failed (exit ${importCode})`);
  log(`built ${t}. Use it: COWORK_AGENT_IMAGE=${t} cowork-harness run <scenario> --tier container`);
  console.log(t);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
