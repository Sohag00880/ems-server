export const TRACKING = Object.freeze({

  OFFLINE_GRACE_MS: 6 * 60 * 60 * 1000, // 6 hours

  BOUNDARY_GRACE_MS: 5 * 60 * 1000, // 5 minutes (was 30 seconds)


  FUTURE_SLACK_MS: 10 * 60 * 1000, // 10 minutes (was 5 minutes)

  // Bounds for point uploads.
  MAX_POINTS_PER_BATCH: 500,
});