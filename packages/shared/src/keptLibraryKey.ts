/**
 * What happens to the library key on a device when its user is signed out. Shared by Parrot's phone and desktop apps
 * and Badger's phone and TV, so they all keep (or forget) the key the same way.
 */

/** Why the device is signed out: the user's own Sign out, or a saved session the server refused. */
export type SignedOutReason = "signOut" | "sessionRejected";

/** A rejected session is not a sign-out: the library key stays on the device so signing in again opens the library. */
// tla: VaultKeys/SpinRefused
export const keyAfterSignedOut = (reason: SignedOutReason): "keep" | "clear" =>
  reason === "sessionRejected" ? "keep" : "clear";

/** A key kept from a rejected session goes back only to the account it belongs to. */
export const keepsKeyOnSignIn = (input: { keyOwnerId: string | null; signedInUserId: string }): boolean =>
  input.keyOwnerId === null || input.keyOwnerId === input.signedInUserId;

/**
 * ACCT-DEV-03: the user's own Sign out forgets the key, and without it the only way back in is typing it, since
 * pairing by QR code needs another device that still holds it. So a device that holds the key asks the user to
 * confirm they saved it before signing out; a device with no key signs out at once. No device can tell whether it is
 * the last holder (the device list says nothing about keys, a device signed in with a password may never have been
 * given the key, and a device whose session was refused keeps its key but leaves the list), so every holder asks.
 */
export const asksKeySavedBeforeSignOut = (storedKey: string | null | undefined): boolean =>
  typeof storedKey === "string" && storedKey.length > 0;
