/**
 * The library key on the phone (PRIV-KEY-01): one 32-byte AES key per account, the same for every suite app
 * (Badger, Parrot). The phone keeps it in the OS keychain and remembers that the user acknowledged writing it down.
 *
 * Shared by the Badger and Parrot phone apps. The keychain and storage are passed in, so this module carries no
 * native import and runs under plain unit tests.
 */

import { asksKeySavedBeforeSignOut } from "@space/shared/keptLibraryKey";

/** The `react-native-keychain` calls this module uses. */
export type LibraryKeyKeychain = {
  getGenericPassword: (options: { service: string }) => Promise<false | { password: string }>;
  setGenericPassword: (username: string, password: string, options: { service: string }) => Promise<unknown>;
  resetGenericPassword: (options: { service: string }) => Promise<unknown>;
};

type AsyncStorageApi = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type LibraryKeyStore = {
  get: () => Promise<string | null>;
  set: (value: string) => Promise<void>;
  clear: () => Promise<void>;
  isAcknowledged: () => Promise<boolean>;
  acknowledge: () => Promise<void>;
};

export const LIBRARY_KEY_SERVICE = "sf_client_library_key";
export const LIBRARY_KEY_ACK_STORAGE = "sf_client_library_key_ack";

/**
 * `onChange` runs after the keychain holds the new value (or none), so nothing derived from the old key outlives
 * the write (Badger drops its play-start cache there).
 */
export const createLibraryKeyStore = (input: {
  keychain: LibraryKeyKeychain;
  asyncStorage: AsyncStorageApi;
  service?: string;
  ackStorageKey?: string;
  onChange?: () => void;
}): LibraryKeyStore => {
  const service = input.service ?? LIBRARY_KEY_SERVICE;
  const ackKey = input.ackStorageKey ?? LIBRARY_KEY_ACK_STORAGE;
  return {
    get: async () => {
      const credentials = await input.keychain.getGenericPassword({ service });
      if (!credentials) return null;
      return credentials.password || null;
    },
    set: async (value) => {
      await input.keychain.setGenericPassword("library", value, { service });
      input.onChange?.();
    },
    clear: async () => {
      await input.keychain.resetGenericPassword({ service });
      input.onChange?.();
      await input.asyncStorage.removeItem(ackKey);
    },
    isAcknowledged: async () => (await input.asyncStorage.getItem(ackKey)) === "1",
    acknowledge: async () => {
      await input.asyncStorage.setItem(ackKey, "1");
    },
  };
};

/**
 * ACCT-DEV-03: whether the user's own Sign out must first ask if the library key was saved, i.e. this device holds it.
 * A store that cannot be read counts as holding one: asking once too often costs a tap, losing the key costs the
 * library.
 */
export const asksKeySavedBeforeSigningOut = (readStoredKey: () => Promise<string | null>): Promise<boolean> =>
  readStoredKey().then(asksKeySavedBeforeSignOut, () => true);

/** The question's words, in the app's own term for the key. */
export type SignOutKeyQuestionText = { title: string; body: string; cancel: string; confirm: string };

/** The `Alert.alert` shape (react-native's), passed in so this module stays free of native imports. */
export type SignOutKeyAlert = (
  title: string,
  body: string,
  buttons: { text: string; style: "cancel" | "destructive"; onPress?: () => void }[],
) => void;

/**
 * The phone's Sign out (ACCT-DEV-03), shared by Badger and Parrot: signing out forgets the library key, and without
 * it the only way back in is typing it (QR sign-in needs another device that still holds it). A phone that holds the
 * key asks first; Cancel is the first choice and changes nothing, only the destructive confirm signs out. A phone with
 * no key signs out at once. Phones cannot show the current key, so the question offers no "Show my key".
 */
export const signOutAskingForSavedKey = async (input: {
  readStoredKey: () => Promise<string | null>;
  text: SignOutKeyQuestionText;
  alert: SignOutKeyAlert;
  signOut: () => Promise<void>;
  log?: (event: "asked" | "signedOutAtOnce" | "cancelled" | "confirmed") => void;
}): Promise<"asked" | "signedOut"> => {
  if (!(await asksKeySavedBeforeSigningOut(input.readStoredKey))) {
    input.log?.("signedOutAtOnce");
    await input.signOut();
    return "signedOut";
  }
  input.log?.("asked");
  input.alert(input.text.title, input.text.body, [
    { text: input.text.cancel, style: "cancel", onPress: () => input.log?.("cancelled") },
    {
      text: input.text.confirm,
      style: "destructive",
      onPress: () => {
        input.log?.("confirmed");
        void input.signOut();
      },
    },
  ]);
  return "asked";
};

/** A pasted or typed key without its whitespace, line breaks and zero-width characters (password managers add them). */
export const normalizeLibraryKey = (value: string): string => value.replace(/[\s\u200b-\u200d\ufeff]+/g, "");

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Whether `value` (normalized) is base64 of exactly 32 bytes: 44 characters ending in one `=`. */
export const isLibraryKeyShape = (value: string): boolean => {
  const key = normalizeLibraryKey(value);
  return key.length === 44 && key.endsWith("=") && !key.endsWith("==") && BASE64.test(key);
};

export type LibraryKeyCheck = "ok" | "malformed" | "wrong" | "no_probe";

/**
 * Checks a key against the account's key probe (a random value the key encrypted, kept with the library meta):
 * `ok` when the probe decrypts with it, `wrong` when it does not, `no_probe` when the account has none yet,
 * `malformed` when the key is not a 32-byte base64 key. `decrypt` is the app's AES-GCM open (it throws on a bad tag).
 * A key typed as its 12 words is checked as the key they stand for: `readLibraryKeyInput(text).keyBase64`
 * (`@space/shared/libraryKeyWords`).
 */
export const checkLibraryKey = async (
  value: string,
  keyProbe: string | null | undefined,
  decrypt: (keyBase64: string, payloadBase64: string) => Promise<unknown>
): Promise<LibraryKeyCheck> => {
  if (!isLibraryKeyShape(value)) return "malformed";
  if (!keyProbe) return "no_probe";
  try {
    await decrypt(normalizeLibraryKey(value), keyProbe);
    return "ok";
  } catch {
    return "wrong";
  }
};
