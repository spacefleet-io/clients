import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import { asksKeySavedBeforeSigningOut as asksWithStore, createKeptKeyOwnerStore, createLibraryKeyStore } from "@space/mobile-shell/libraryKey";
import { clearPlayStartWarm } from "./playback/playStartCache";

// The play-start cache is cleared once the Keychain holds the new value, so no read of the old key outlives the write.
const libraryKey = createLibraryKeyStore({ keychain: Keychain, asyncStorage: AsyncStorage, onChange: clearPlayStartWarm });

export const getStoredLibraryKey = libraryKey.get;
/**
 * Whose library key stayed on the phone or TV after the server refused their session: only that account gets it back
 * at the next sign-in (`keepsKeyOnSignIn`, `store/auth.tsx`).
 */
export const keptKeyOwnerStore = createKeptKeyOwnerStore({ asyncStorage: AsyncStorage, key: "sf_library_key_owner" });

/** A key stored here (pairing, the key step) belongs to the account signing in, so no kept owner competes with it. */
export const setStoredLibraryKey = async (value: string): Promise<void> => {
  await libraryKey.set(value);
  await keptKeyOwnerStore.forget();
};
export const clearLibraryKey = libraryKey.clear;
export const isLibraryKeyAcknowledged = libraryKey.isAcknowledged;
export const setLibraryKeyAcknowledged = libraryKey.acknowledge;

/** ACCT-DEV-03: whether Sign out must first ask if the library key was saved (this phone or TV holds it). */
export const asksKeySavedBeforeSigningOut = (): Promise<boolean> => asksWithStore(getStoredLibraryKey);
