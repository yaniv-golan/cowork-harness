import { loadBaseline, listBaselineNames } from "../baseline.js";
import { UsageError } from "../errors.js";
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
 * `loadBaseline` already turns an unknown name into a UsageError listing the valid baselines; this adds
 * the one mistake specific to `vm`: passing the VM name `vm status` prints. That gets its own message,
 * naming the baseline(s) that derive that VM here.
 *
 * A VM name is deliberately NOT accepted as the argument. The mapping is not a function: one VM serves
 * several baselines (their guest config hashes equal), the hash depends on this machine's staged
 * install paths, and `COWORK_LIMA_INSTANCE` overrides it.
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
    const detail = e instanceof UsageError ? e.message : `failed to load baseline "${name}" (${(e as Error).message})`;
    return { ok: false, message: `vm ${sub}: ${detail}`, hint: `${bare}. ${valid}` };
  }
}
