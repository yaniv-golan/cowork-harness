// The `[lane]` notice is for a person reading a live run; in the unit lane it is only noise in test output. Tests
// that assert it pass their own env (test/lane-notice.test.ts) or delete this variable for the child they spawn
// (test/lane-notice-cli.test.ts). Only set when the caller has not set it.
if (process.env.COWORK_HARNESS_NO_LANE_NOTICE === undefined) process.env.COWORK_HARNESS_NO_LANE_NOTICE = "1";
