import {
  acknowledgeLibraryKey,
  clearLibraryKey,
  getStoredLibraryKey,
  getStoredLibraryKeyWords,
  isLibraryKeyAcknowledged,
  storeLibraryKey,
} from "@/lib/onboarding";
import { LibraryDb } from "@/lib/libraryDb";
import { idbReset } from "@/lib/idb";
import { logoutStep } from "@/lib/logoutStep";
import { persistSessionToMain } from "@/lib/sessionMirror";

type ResetClientStorageOptions = {
  preserveLibraryKey?: boolean;
  preserveLocalStorageKeys?: string[];
};

const USER_STORAGE_KEY = "sf_client_user";

export const resetClientStorage = async (options?: ResetClientStorageOptions) => {
  const preserveLibraryKey = options?.preserveLibraryKey === true;
  const preserveLocalStorageKeys = (options?.preserveLocalStorageKeys ?? [])
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  const preservedKey = preserveLibraryKey ? await getStoredLibraryKey().catch(() => null) : null;
  const preservedWords = preserveLibraryKey ? await getStoredLibraryKeyWords().catch(() => null) : null;
  const preservedAck = preserveLibraryKey ? await isLibraryKeyAcknowledged().catch(() => false) : false;
  // Capture the current user blob BEFORE the clear. The library-key + ack are
  // stored under user-scoped storage keys (e.g., `sf_client_library_key_ack:<userId>`),
  // and `getStorageKeys()` reads the userId back from `sf_client_user`. If we
  // restore the key without the user context, the restored entry ends up under
  // the unscoped key and becomes invisible after the next login when the
  // scoped lookup is used again — causing the user to be bounced back through
  // onboarding unnecessarily.
  const preservedUserBlob = preserveLibraryKey
    ? (() => {
        try {
          return window.localStorage.getItem(USER_STORAGE_KEY);
        } catch {
          return null;
        }
      })()
    : null;
  const preservedLocalStorage = new Map<string, string>();
  for (const key of preserveLocalStorageKeys) {
    try {
      const value = window.localStorage.getItem(key);
      if (value !== null) {
        preservedLocalStorage.set(key, value);
      }
    } catch {
      // Ignore storage read errors.
    }
  }
  // Each step that waits on another process (the runtime, main, other IndexedDB connections) is bounded
  // (ACCT-DEV-01): run 38822's cache clear never answered, and nothing after it ran, the key clear included.
  await logoutStep("LibraryDb.clearLocalCache", () => LibraryDb.clearLocalCache());
  await logoutStep("clearExternalMpvSubtitleCache", async () => window.sf?.clearExternalMpvSubtitleCache?.());
  if (!preserveLibraryKey) {
    await logoutStep("clearLibraryKey", () => clearLibraryKey());
  }
  await logoutStep("idbReset", () => idbReset());
  try {
    window.localStorage.clear();
  } catch {
    // Ignore storage errors.
  }
  for (const [key, value] of preservedLocalStorage.entries()) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Ignore storage write errors.
    }
  }
  if (preserveLibraryKey && preservedKey) {
    // Temporarily restore the user blob so storeLibraryKey / acknowledgeLibraryKey
    // write under the correct user-scoped storage keys. The caller (auth.logout)
    // clears the user blob again immediately after this function returns.
    if (preservedUserBlob !== null) {
      try {
        window.localStorage.setItem(USER_STORAGE_KEY, preservedUserBlob);
      } catch {
        // Ignore storage write errors.
      }
    }
    await storeLibraryKey(preservedKey, preservedWords).catch(() => undefined);
    if (preservedAck) {
      await acknowledgeLibraryKey().catch(() => undefined);
    }
  }
  // localStorage.clear() above wiped the session keys; make main's durable copy match.
  await persistSessionToMain();
};
