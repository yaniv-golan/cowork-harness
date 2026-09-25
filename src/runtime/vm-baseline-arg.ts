import { loadBaseline, listBaselineNames } from "../baseline.js";
import type { PlatformBaseline } from "../types.js";
import { instanceName } from "./lima.js";

/** A VM instance name as `vm status` prints it (see lima.ts `instanceName`). */
const VM_NAME = /^cowork-vm-[0-9a-f]+$/;

export type VmBaselineArg = { ok: true; baseline: PlatformBaseline } | { ok: false; message: string; hint: string };

export interface VmBaselineArgDeps {
  load: (name: string) => PlatformBaseline;
  list: () => string[];
  instanceOf: (baseline: PlatformBaseline) => string;
}

const defaultDeps: VmBaselineArgDeps = { load: loadBaseline, list: listBaselineNames, instanceOf: instanceName };

/**
 * Resolve the optional `<baseline>` positional of `vm init|status|delete|prune` without ever throwing.
 * The positional names a BASELINE; the VM is derived from it. The natural mistake is passing the VM
 * name `vm status` prints, which used to reach loadBaseline's bare readFileSync and crash with a raw
 * ENOENT stack trace. Every failure here is a usage error with a hint listing the valid baselines.
 *
 * A VM name is deliberately NOT accepted as the argument. The mapping is not a function: one VM serves
 * several baselines (their guest config hashes equal), the hash depends on this machine's staged
 * install paths, and `COWORK_LIMA_INSTANCE` overrides it. So a VM name only earns a pointer to the
 * baseline(s) that derive it here.
 */
export function resolveVmBaselineArg(sub: string, name: string, deps: VmBaselineArgDeps = defaultDeps): VmBaselineArg {
  try {
    return { ok: true, baseline: deps.load(name) };
  } catch (e) {
    let names: string[] = [];
    try {
      names = deps.list();
    } catch {
      /* no baselines dir: the hint below says so */
    }
    const valid = names.length ? `valid baselines (newest first): ${names.join(", ")}` : "no committed baselines found";
    const bare = `run \`vm ${sub}\` with no argument for the latest baseline`;
    if (VM_NAME.test(name)) {
      const owners = names.filter((n) => {
        try {
          return deps.instanceOf(deps.load(n)) === name;
        } catch {
          return false;
        }
      });
      const owner = owners.length
        ? `On this machine ${name} is the VM for ${owners.join(", ")} — pass one of those, or ${bare}.`
        : `No committed baseline derives ${name} on this machine (an orphan — \`vm prune\` removes it); ${bare}.`;
      return {
        ok: false,
        message: `vm ${sub}: "${name}" is a VM name, not a baseline — the argument names the baseline the VM is derived from`,
        hint: `${owner} ${valid}`,
      };
    }
    const reason = e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT" ? "" : ` (${(e as Error).message})`;
    return {
      ok: false,
      message: `vm ${sub}: no baseline named "${name}"${reason} — the argument is a baseline (e.g. \`latest\` or desktop-<version>), not a VM name`,
      hint: `${bare}. ${valid}`,
    };
  }
}
