/**
 * Offline-download job `stageCode` set by the runtime while the object's storage silo is saturated and holds the
 * download (STOR-BW-09). The desktop jobs sidebar keys its "downloads held" notice on it, so both sides share the literal.
 */
export const HELD_SATURATED_STAGE_CODE = "held_saturated";

/**
 * Offline-download job `stageCode` set by the runtime while the merged traffic state is `high` and the download is
 * slowed (never stopped, STOR-BW-01). The saturated hold takes precedence when both apply. The desktop jobs sidebar keys
 * its "downloads are slower" notice on it, so both sides share the literal.
 */
export const SLOWED_HIGH_TRAFFIC_STAGE_CODE = "slowed_high_traffic";
