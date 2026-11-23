import type { AccountDeletionMode } from "@space/shared/accountDeletion";

/** The word the user types to confirm; the API checks it again (`confirm_required`). Same as desktop. */
export const DELETE_CONFIRM_WORD = "DELETE";

/**
 * ACCT-DEL-03: the `mode` field to send with `DELETE /account`. Only a paid yearly plan past its guarantee offers the
 * choice (`periodEndDeleteAt` set); everywhere else no mode is sent and the API deletes at once.
 */
export const accountDeletionModeInput = (
  periodEndDeleteAt: string | null,
  mode: AccountDeletionMode
): { mode?: AccountDeletionMode } => (periodEndDeleteAt ? { mode } : {});

export type AccountDeletionError =
  | "invalidPassword"
  | "twoFactorRequired"
  | "twoFactorInvalid"
  | "confirmRequired"
  | "failed";

/** Maps a `DELETE /account` error code to the message to show, and whether the code field must appear. */
export const accountDeletionError = (apiCode: string | null | undefined): { key: AccountDeletionError; needsCode: boolean } => {
  switch (apiCode) {
    case "invalid_password":
      return { key: "invalidPassword", needsCode: false };
    case "two_factor_required":
      return { key: "twoFactorRequired", needsCode: true };
    case "two_factor_invalid":
      return { key: "twoFactorInvalid", needsCode: true };
    case "confirm_required":
      return { key: "confirmRequired", needsCode: false };
    default:
      return { key: "failed", needsCode: false };
  }
};

export type AccountDeletionCleanup = {
  downloadIds: string[];
  removeDownloads: (ids: string[]) => Promise<void>;
  clearLibraryKey: () => Promise<void>;
  logout: () => Promise<void>;
};

/**
 * Runs after the server accepted the deletion: removes the account's offline
 * files and its library key (the Keychain entry survives reinstall), then signs
 * out. Every step runs even if an earlier one fails, and nothing throws: the
 * account is already gone, so a local hiccup must not read as "deletion failed".
 */
export const finishAccountDeletion = async (cleanup: AccountDeletionCleanup): Promise<void> => {
  await cleanup.removeDownloads(cleanup.downloadIds).catch(() => undefined);
  await cleanup.clearLibraryKey().catch(() => undefined);
  await cleanup.logout().catch(() => undefined);
};
