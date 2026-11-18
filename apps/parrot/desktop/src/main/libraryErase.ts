import { libraryKeyEraseOutcomeOf, type LibraryKeyEraseOutcome } from "@space/desktop-shell/library-key-erase";

export type LibraryEraseDeps = {
  /** POST /library/recovery/reset: the whole vault of the account, every app and profile (PRIV-KEY-01). */
  reset: (password: string, twoFactorCode?: string) => Promise<unknown>;
  /** Forgets this computer's library key and everything kept under it (library, covers, kept songs, chunks). */
  clearLocal: () => Promise<void>;
  log: (message: string) => void;
  fail: (message: string) => void;
};

/**
 * The key step's erase (UX-KEY-01), as Badger desktop does it: the account-wide reset after the password (and the code
 * when the server asks), then the local key and cache go, so setup can make a fresh key. A refused reset changes nothing
 * here. Local cleanup failing after the server erased is logged, not returned: the vault is gone either way.
 */
export const eraseAccountLibrary = async (
  password: string,
  twoFactorCode: string | undefined,
  deps: LibraryEraseDeps,
): Promise<LibraryKeyEraseOutcome> => {
  if (!password) return { status: "failed", reason: "invalidPassword" };
  try {
    await deps.reset(password, twoFactorCode || undefined);
  } catch (error) {
    const outcome = libraryKeyEraseOutcomeOf(error);
    deps.log(`[key] erase refused: ${JSON.stringify(outcome)} (${error instanceof Error ? error.message : String(error)})`);
    return outcome;
  }
  deps.log("[key] the account's library was erased on the server (every app, every profile)");
  await deps.clearLocal().catch((error: unknown) => deps.fail(`[key] could not clear the local library after the erase: ${String(error)}`));
  return { status: "erased" };
};
