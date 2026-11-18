/**
 * What a new device (Badger TV, Parrot phone) does with an approved pairing: the same end state as a password
 * login followed by typing the library key (ACCT-PAIR-01: "signs the new device in to the account and hands it
 * the account key").
 *
 * Order matters. An app's library loader starts the moment the session token appears, and it routes to the key
 * screen when the key or its acknowledgement is missing, so the key and the acknowledgement are stored
 * BEFORE the session is set; the app's navigator then goes straight to its main screen.
 *
 * Pure with injected side effects so it runs under the logic test runner.
 */
import type { User } from "@space/shared/api";
import type { PairingPoll } from "@space/pairing-crypto";

export type KeyCheck = "ok" | "mismatch" | "unchecked";

export type PairingCompletionDeps = {
  /** Full user for the new token (`GET /auth/me`); null when it cannot be read right now. */
  fetchUser: (token: string) => Promise<User | null>;
  /** Tries the library key against the account's key probe. "unchecked" = no library yet / API unreachable. */
  verifyKey: (token: string, libraryKey: string) => Promise<KeyCheck>;
  setStoredLibraryKey: (libraryKey: string) => Promise<void>;
  setLibraryKeyAcknowledged: () => Promise<void>;
  setSession: (token: string, user: User) => Promise<void>;
  /** Best-effort sign-out of a token this device will not use. */
  discardSession: (token: string) => Promise<void>;
  /** Console log prefix, e.g. "tv.pairing"; defaults to "pairing". */
  logTag?: string;
};

export type PairingCompletion = { ok: true } | { ok: false; reason: "key_mismatch" | "failed" };

export const completePairing = async (
  deps: PairingCompletionDeps,
  approved: Extract<PairingPoll, { status: "approved" }>,
): Promise<PairingCompletion> => {
  const { token, user, libraryKey } = approved;
  const tag = `[${deps.logTag ?? "pairing"}]`;
  try {
    const check = await deps.verifyKey(token, libraryKey).catch((): KeyCheck => "unchecked");
    console.info(`${tag} complete.key_check`, { userId: user.id, check });
    if (check === "mismatch") {
      // The approver sealed a key this account's library does not open with: keep nothing, drop the session.
      await deps.discardSession(token).catch(() => undefined);
      return { ok: false, reason: "key_mismatch" };
    }
    // `/auth/me` carries the plan, storage and preferences the shell shows; the pairing answer has id + email only.
    const fullUser = (await deps.fetchUser(token).catch(() => null)) ?? (user as unknown as User);
    await deps.setStoredLibraryKey(libraryKey);
    await deps.setLibraryKeyAcknowledged();
    await deps.setSession(token, fullUser);
    console.info(`${tag} complete.signed_in`, { userId: fullUser.id });
    return { ok: true };
  } catch (error) {
    console.warn(`${tag} complete.failed`, { message: error instanceof Error ? error.message : String(error) });
    await deps.discardSession(token).catch(() => undefined);
    return { ok: false, reason: "failed" };
  }
};
