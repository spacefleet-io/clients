/**
 * ACCT-KEYCHG-04: an app offers to change the media library key exactly when the change would work. The server refuses
 * a rotation while the account stores media sealed with the key (songs, covers, videos: 409
 * `rotation_needs_media_reseal`) unless the rotating device re-seals them (STOR-RESEAL-01); `GET /library/recovery/rotate`
 * tells which (`needsMediaReseal`). No app shows an entry that could only end in that refusal (Chris 2026-11-23: no
 * placeholder features in an update).
 */

/** What `GET /library/recovery/rotate` answers (`getKeyRotationReadiness`). */
export type KeyRotationReadiness = { needsMediaReseal: boolean };

/**
 * Whether this client release re-seals media during a key change. It becomes true in the release whose Badger and
 * Parrot re-seal media end to end, never before.
 */
export const KEY_CHANGE_RELEASED: boolean = false;

/**
 * A key change from a device that holds the current key (Badger desktop Settings, Badger phone Settings): offered when
 * the account stores no media, or once this release re-seals it. Readiness not known yet (loading, offline, failed):
 * not offered.
 */
export const keyChangeOffered = (readiness: KeyRotationReadiness | null): boolean =>
  readiness !== null && (KEY_CHANGE_RELEASED || !readiness.needsMediaReseal);

/**
 * Recovering with a new key after the current one is lost (Badger desktop onboarding, from the local library copy):
 * media sealed with the lost key can never be re-sealed, so it is offered only while the account stores none, whatever
 * the release. Otherwise erasing the library and starting over is what remains.
 */
export const keyRecoveryOffered = (readiness: KeyRotationReadiness | null): boolean =>
  readiness !== null && !readiness.needsMediaReseal;
