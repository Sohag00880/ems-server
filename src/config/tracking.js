export const TRACKING = Object.freeze({
  // Points captured after a session ends may still be uploaded within this window.
  OFFLINE_GRACE_MS: 6 * 60 * 60 * 1000, // 6 hours

  // Small grace at the session boundary to tolerate client clock skew.
  BOUNDARY_GRACE_MS: 30 * 1000, // 30s

  // Reject capturedAt more than this far in the future.
  FUTURE_SLACK_MS: 5 * 60 * 1000, // 5 minutes

  // Bounds for point uploads.
  MAX_POINTS_PER_BATCH: 500,
});