/**
 * ACCT-KEYCHG-04: an app offers to change the media library key exactly when the change would work. The server refuses
 * a rotation while the account stores media sealed with the key (songs, covers, videos: 409
 * `rotation_needs_media_reseal`) unless the rotating device re-seals them (STOR-RESEAL-01); `GET /library/recovery/rotate`
 * tells which (`needsMediaReseal`). No app shows an entry that could only end in that refusal (Chris 2026-11-23: no
 * placeholder features in an update).
 */

/** What `GET /library/recovery/rotate` answers (`getKeyRotationReadiness`). */
export type KeyRotationReadiness = { needsMediaReseal: boolean };

/** The apps that can change the key, each on its own release track. */
export type KeyChangeSurface = "badger-desktop" | "badger-mobile" | "parrot-desktop" | "parrot-mobile";

/**
 * Whether this client release re-seals media during a key change, per surface. A surface turns true in the release
 * whose key change re-seals media end to end there, never before. Badger's phone re-seals with the mobile-data pause
 * (ACCT-KEYCHG-05, Main 2026-11-23, option A); Parrot's phone has no key change entry yet.
 */
export const KEY_CHANGE_RELEASED: Readonly<Record<KeyChangeSurface, boolean>> = {
  "badger-desktop": true,
  "parrot-desktop": true,
  "badger-mobile": true,
  "parrot-mobile": false,
};

/**
 * A key change from a device that holds the current key (Settings): offered when the account stores no media, or
 * once `surface`'s release re-seals it. Readiness not known yet (loading, offline, failed): not offered.
 */
export const keyChangeOffered = (surface: KeyChangeSurface, readiness: KeyRotationReadiness | null): boolean =>
  readiness !== null && (KEY_CHANGE_RELEASED[surface] || !readiness.needsMediaReseal);

/**
 * Recovering with a new key after the current one is lost (Badger desktop onboarding, from the local library copy):
 * media sealed with the lost key can never be re-sealed, so it is offered only while the account stores none, whatever
 * the release. Otherwise erasing the library and starting over is what remains.
 */
export const keyRecoveryOffered = (readiness: KeyRotationReadiness | null): boolean =>
  readiness !== null && !readiness.needsMediaReseal;
