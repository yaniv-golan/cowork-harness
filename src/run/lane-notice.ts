// One stderr line saying which Cowork lane a run models, printed only where it changes how a result reads.
//
// Every tier reproduces Cowork's LOCAL lane. From 2026-10-06 new Pro and Max tasks run in the cloud, where
// the environment differs: paths, mounts, how a file reaches the user, egress. A behaviour-shaped result
// (what the agent asked, which tool it called, what it wrote) still transfers; an environment-shaped one
// does not. So the notice prints only for a run whose assertions are environment-shaped, and never where
// it would be noise: under --compact/--demo, in CI, or with COWORK_HARNESS_NO_LANE_NOTICE set. It prints
// at most once per process, so a batch (`--repeat`, a directory, eval, hillclimb) gets one line.

import type { Assertion } from "../types.js";

/** Assertion keys whose result depends on the run's ENVIRONMENT (paths, mounts, delivery, egress, the host loop's
 *  path boundary) rather than on the agent's behaviour. The `lane: remote` code is CROSS-CHECKED against it, not
 *  derived from it: execute.ts types its load-time refusal list against this one (a key outside it fails to
 *  compile), and test/lane-notice.test.ts requires the key of every `lane === "remote"` branch in assert.ts to be
 *  in it. Not every key here has a remote branch (`file_exists` reads the local tree on every lane: it is the
 *  documented remote-lane proxy, with `transcript_matches`). */
export const ENVIRONMENT_SHAPED_ASSERT_KEYS = [
  "artifact_json",
  "artifact_text",
  "computer_links_resolve",
  "computer_links_resolve_if_present",
  "egress_allowed",
  "egress_denied",
  "file_absent",
  "file_exists",
  "input_unmodified",
  "no_path_denied",
  "no_delete_in_mounts",
  "no_delete_in_outputs",
  "no_lost_write_back",
  "no_scratchpad_leak",
  "no_unexpected_files",
  "no_vm_path_file_op",
  "path_denied",
  "present_files_called",
  "self_heal_ran",
  "transcript_no_host_path",
  "user_visible_artifact",
  "vm_path_denied",
] as const satisfies readonly (keyof Assertion)[];
export type EnvironmentShapedAssertKey = (typeof ENVIRONMENT_SHAPED_ASSERT_KEYS)[number];

export const LANE_NOTICE_ENV = "COWORK_HARNESS_NO_LANE_NOTICE";

export const LANE_NOTICE =
  "[lane] this run models Cowork's local lane, which new Pro and Max tasks do not use from 2026-10-06: " +
  "behaviour-shaped results carry over to the cloud lane; path, mount, delivery and egress results do not " +
  `(${LANE_NOTICE_ENV}=1 silences this)\n`;

interface NoticeOpts {
  compact?: boolean;
  env?: NodeJS.ProcessEnv;
}

const silenced = (env: NodeJS.ProcessEnv) => !!env.CI || !!env[LANE_NOTICE_ENV];

/** Whether a run of `scenario` gets the notice. Pure; the once-per-process latch is `maybePrintLaneNotice`. */
export function laneNoticeApplies(
  scenario: {
    lane?: "local" | "remote";
    assert: readonly Partial<Record<string, unknown>>[];
    expect_denied?: readonly unknown[];
  },
  opts: NoticeOpts = {},
): boolean {
  const env = opts.env ?? process.env;
  if ((scenario.lane ?? "local") !== "local" || opts.compact || silenced(env)) return false;
  // `expect_denied` is egress: execute.ts expands it into `egress_denied` asserts after this notice prints.
  if ((scenario.expect_denied?.length ?? 0) > 0) return true;
  return scenario.assert.some((a) => ENVIRONMENT_SHAPED_ASSERT_KEYS.some((k) => a[k] !== undefined));
}

let printed = false;

/** Print the notice for a live run of `scenario`, at most once per process. */
export function maybePrintLaneNotice(
  scenario: Parameters<typeof laneNoticeApplies>[0],
  opts: NoticeOpts & { write?: (s: string) => void } = {},
): void {
  if (printed || !laneNoticeApplies(scenario, opts)) return;
  printed = true;
  (opts.write ?? ((s: string) => process.stderr.write(s)))(LANE_NOTICE);
}

/** `chat`: one line at session start, whatever it asserts (a chat asserts nothing). Same silencers. */
export function maybePrintChatLaneNotice(opts: NoticeOpts & { write?: (s: string) => void } = {}): void {
  const env = opts.env ?? process.env;
  if (printed || opts.compact || silenced(env)) return;
  printed = true;
  (opts.write ?? ((s: string) => process.stderr.write(s)))(LANE_NOTICE);
}

/** Test seam only. */
export function resetLaneNoticeForTest(): void {
  printed = false;
}
