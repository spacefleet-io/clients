// The phone's persisted sign-in and library key. The key is the account's one library key, kept under the same
// keychain service Badger uses (PLAT-SUITE-02); on Android each app has its own keychain, so Parrot asks once.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Keychain from "react-native-keychain";
import { createAsyncStorageAuthSessionStore } from "@space/mobile-shell/services/auth";
import { createLibraryKeyStore } from "@space/mobile-shell/libraryKey";
import { createPhoneSetupStore } from "@space/mobile-shell/setup";

export const sessionStore = createAsyncStorageAuthSessionStore({ asyncStorage: AsyncStorage, key: "parrot.session" });

export const libraryKeyStore = createLibraryKeyStore({ keychain: Keychain, asyncStorage: AsyncStorage });

/** How far the first-setup walkthrough got on this phone (UX-SETUP-06/07). */
export const setupStore = createPhoneSetupStore({ asyncStorage: AsyncStorage, key: "parrot.setup" });

/**
 * Whose library key stayed on the phone after the server rejected their session: only that account gets it back at
 * the next sign-in. A key a pairing just brought belongs to the account signing in, so storing one forgets the owner.
 */
const KEY_OWNER_STORAGE = "parrot.libraryKeyOwner";
export const keptKeyOwnerStore = {
  read: () => AsyncStorage.getItem(KEY_OWNER_STORAGE),
  write: (userId: string) => AsyncStorage.setItem(KEY_OWNER_STORAGE, userId),
  forget: () => AsyncStorage.removeItem(KEY_OWNER_STORAGE),
};
