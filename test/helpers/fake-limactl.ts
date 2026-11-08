import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A scripted stand-in for `limactl`, for CLI tests that reach Lima (`vm status`). Point COWORK_HARNESS_LIMACTL at the
 * returned path so a test never lists, probes or otherwise touches a real VM on the machine running it.
 * `list` prints `status`; the provisioning-readiness `shell` probe prints `provisioning`; `--version`
 * succeeds; anything else fails.
 */
export function fakeLimactl(opts: { status: string; provisioning: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-limactl-"));
  const bin = join(dir, "limactl");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  --version) echo 'limactl version 0.0.0-fake' ;;",
      `  list) echo '${opts.status}' ;;`,
      `  shell) echo 'COWORK_PROVISIONING=${opts.provisioning}' ;;`,
      "  *) exit 1 ;;",
      "esac",
    ].join("\n") + "\n",
  );
  chmodSync(bin, 0o755);
  return bin;
}
