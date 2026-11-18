/**
 * STOR-BW-11: every playback request names the profile it is for (the main profile's real id on a single-profile account; never
 * null). The API and the storage gateway refuse a playback tunnel session without one (400 `profile_required`) or with one that
 * is not the account's (403 `profile_not_owned`), whatever the app; at saturation all playbacks of one profile share that
 * profile's speed budget.
 */

export const PLAYBACK_PROFILE_REQUIRED_CODE = "profile_required";
export const PLAYBACK_PROFILE_NOT_OWNED_CODE = "profile_not_owned";

/** Body field of `POST /storage/tunnel/session` and query parameter of `GET /storage/traffic`. */
export const PLAYBACK_PROFILE_FIELD = "profileId";

/** Whether a tunnel session must name a profile: every playback does, from any app. */
export const sessionNeedsProfile = (purpose: string): boolean => purpose === "playback";

/** A profile id as sent on the wire: a non-empty trimmed string, else null. */
export const readProfileId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
};
