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
 *  derived from it: `LANE_REMOTE_INCOMPATIBLE` below, the load-time refusal list, is typed against this one (a key
 *  outside it fails to compile), and test/lane-notice.test.ts requires the key of every `lane === "remote"` branch in assert.ts to be
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

// One remedy per reason, so the load error, the assertion-time refusal and lint can say the same thing.
const DELIVERY =
  'that lane serves no present_files and delivers nothing by location, so the key can only report "cannot verify". Tool-level delivery is NOT YET ASSERTABLE on this lane (the harness models no remote delivery tool; production uses the agent-native SendUserFile). Either assert the written path plus the agent\'s own statement of it (`file_exists` + `transcript_matches` — a weaker proxy, since the semantic judge cannot see tool calls), or set `lane: local` if this scenario models the desktop lane.';
const BODY =
  "it reads the body of a file the run wrote, which lives in a remote container whose filesystem is not locally observable. Assert the written path with `file_exists` and the agent's own statement of the content with `transcript_matches`, or set `lane: local`.";
const ABSENCE =
  "it proves an absence over a tree a remote container holds, whose filesystem is not locally observable — a clean local read is not evidence. Assert the agent's own statement with `transcript_not_matches`, or set `lane: local`.";
const LINKS_WHY =
  "a `computer://` link is the local lane's delivery convention, and a remote container's filesystem is not locally observable, so there is nothing to resolve a link against.";
const LINKS = `${LINKS_WHY} Assert the written path plus the agent's own statement of it (\`file_exists\` + \`transcript_matches\`), or set \`lane: local\`.`;
const LINKS_IF_PRESENT = `${LINKS_WHY} Assert that no link was given (\`transcript_not_matches: "computer://"\`), or set \`lane: local\`.`;
const AUTHORED =
  "it analyses the files the run authored, which live in a remote container whose filesystem is not locally observable. Set `lane: local` to check it.";

/** Every key that can NEVER pass on `lane: remote`, with why. A config error at load, not a paid run that fails at
 *  assertion time; the assertion-time branches in assert.ts stay for what bypasses this (a replayed older cassette,
 *  verify-run of a kept run, a hand-built context). Typed against ENVIRONMENT_SHAPED_ASSERT_KEYS: a key here that is
 *  not environment-shaped fails to compile. `semantic_*` with `evidence_files` is refused by value, below. */
export const LANE_REMOTE_INCOMPATIBLE = {
  present_files_called: DELIVERY,
  no_scratchpad_leak: DELIVERY,
  user_visible_artifact: DELIVERY,
  artifact_text: BODY,
  artifact_json: BODY,
  file_absent: ABSENCE,
  no_unexpected_files: ABSENCE,
  computer_links_resolve: LINKS,
  computer_links_resolve_if_present: LINKS_IF_PRESENT,
  no_lost_write_back: AUTHORED,
} as const satisfies Partial<Record<EnvironmentShapedAssertKey, string>>;

const AUTHORSHIP =
  "with `authored: true` it compares the container's file with the pre-run manifest, and a remote container's filesystem is not locally observable. Drop `authored` (a written path is the documented proxy on this lane), or set `lane: local`.";
const SEMANTIC_FILES =
  "its `evidence_files` names files to grade, and on this lane the files the run wrote live in a remote container whose filesystem is not locally observable, so the judge sees the transcript only. Drop `evidence_files` and write the rubric about what the agent said, or set `lane: local`.";

/** The load-time refusal for a `lane: remote` scenario, or undefined. Shared by the scenario loader and the pre-spend
 *  list `record` runs (which `record --from-embedded` reaches without the loader). */
export function laneRemoteLoadRefusal(scenario: {
  lane?: "local" | "remote";
  assert: readonly Partial<Record<string, unknown>>[];
}): string | undefined {
  if (scenario.lane !== "remote") return undefined;
  for (const a of scenario.assert) {
    for (const [key, why] of Object.entries(LANE_REMOTE_INCOMPATIBLE))
      if (a[key] !== undefined) return `\`${key}\` cannot pass on \`lane: remote\` — ${why}`;
    const fe = a.file_exists as { authored?: unknown } | string | undefined;
    if (typeof fe === "object" && fe !== null && fe.authored === true)
      return `\`file_exists\` cannot pass on \`lane: remote\` — ${AUTHORSHIP}`;
    for (const key of ["semantic_matches", "semantic_pairwise"] as const) {
      const files = (a[key] as { evidence_files?: unknown[] } | undefined)?.evidence_files;
      if (Array.isArray(files) && files.length > 0) return `\`${key}\` cannot pass on \`lane: remote\` — ${SEMANTIC_FILES}`;
    }
  }
  return undefined;
}
