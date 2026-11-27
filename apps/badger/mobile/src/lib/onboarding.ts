import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import { asksKeySavedBeforeSigningOut as asksWithStore, createLibraryKeyStore } from "@space/mobile-shell/libraryKey";
import { clearPlayStartWarm } from "./playback/playStartCache";

// The play-start cache is cleared once the Keychain holds the new value, so no read of the old key outlives the write.
const libraryKey = createLibraryKeyStore({ keychain: Keychain, asyncStorage: AsyncStorage, onChange: clearPlayStartWarm });

export const getStoredLibraryKey = libraryKey.get;
export const setStoredLibraryKey = libraryKey.set;
export const clearLibraryKey = libraryKey.clear;
export const isLibraryKeyAcknowledged = libraryKey.isAcknowledged;
export const setLibraryKeyAcknowledged = libraryKey.acknowledge;

/** ACCT-DEV-03: whether Sign out must first ask if the library key was saved (this phone or TV holds it). */
export const asksKeySavedBeforeSigningOut = (): Promise<boolean> => asksWithStore(getStoredLibraryKey);
