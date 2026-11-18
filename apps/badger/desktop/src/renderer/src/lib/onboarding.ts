import { persistSessionToMain } from "./sessionMirror";
import { idbDel, idbGet, idbSet } from "./idb";
import { libraryKeyWordsText, readLibraryKeyInput } from "@space/shared/libraryKeyWords";

export const LIB_KEY_STORAGE = "sf_client_library_key";
export const LIB_KEY_ACK_STORAGE = "sf_client_library_key_ack";
/** The 12 words of the key, when this device made or was typed the key (UX-KEY-01). */
export const LIB_KEY_WORDS_STORAGE = "sf_client_library_key_words";
const USER_STORAGE_KEY = "sf_client_user";

const normalizeKey = (value: string) => value.trim().replace(/\s+/g, "");
const safeLocalStorageGet = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const safeLocalStorageSet = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors.
  }
};
const safeLocalStorageDel = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage delete errors.
  }
};

const getCurrentUserId = () => {
  const raw = safeLocalStorageGet(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed?.id === "string" && parsed.id.trim() ? parsed.id.trim() : null;
  } catch {
    return null;
  }
};

const scopedKey = (base: string, userId: string | null) => (userId ? `${base}:${userId}` : base);

/**
 * Bound on awaiting an IndexedDB mirror write. localStorage is written first and
 * read first, so callers never need the IDB write to finish; a stalled one
 * (LevelDB under userData on a saturated disk) stays queued and IDB applies it
 * before any later transaction on the store.
 */
export const IDB_MIRROR_WRITE_TIMEOUT_MS = 500;

const mirrorToIdb = (write: Promise<void>) =>
  Promise.race([
    write.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, IDB_MIRROR_WRITE_TIMEOUT_MS)),
  ]);

const getStorageKeys = () => {
  const userId = getCurrentUserId();
  return {
    userId,
    scopedLibraryKey: scopedKey(LIB_KEY_STORAGE, userId),
    scopedAckKey: scopedKey(LIB_KEY_ACK_STORAGE, userId),
    scopedWordsKey: scopedKey(LIB_KEY_WORDS_STORAGE, userId),
  };
};

export async function getStoredLibraryKey(): Promise<string | null> {
  const { userId, scopedLibraryKey } = getStorageKeys();
  const local = safeLocalStorageGet(scopedLibraryKey);
  if (local && local.trim()) return normalizeKey(local);
  const raw = await Promise.race([
    idbGet<string>(scopedLibraryKey).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, 500)),
  ]);
  if (raw && String(raw).trim()) return normalizeKey(String(raw));

  if (!userId && scopedLibraryKey !== LIB_KEY_STORAGE) {
    const legacyLocal = safeLocalStorageGet(LIB_KEY_STORAGE);
    if (legacyLocal && legacyLocal.trim()) {
      const normalized = normalizeKey(legacyLocal);
      await mirrorToIdb(idbSet(scopedLibraryKey, normalized));
      return normalized;
    }
    const legacyRaw = await Promise.race([
      idbGet<string>(LIB_KEY_STORAGE).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, 500)),
    ]);
    if (legacyRaw && String(legacyRaw).trim()) {
      const normalized = normalizeKey(String(legacyRaw));
      await mirrorToIdb(idbSet(scopedLibraryKey, normalized));
      return normalized;
    }
  }
  return null;
}

/**
 * UX-KEY-01: keeps the key, and the 12 words it was made from when this device knows them (made or typed here), so
 * Show key can show the words again. A key without words (from another device by pairing) drops any old words.
 */
export async function storeLibraryKey(key: string, words?: readonly string[] | null) {
  const { scopedLibraryKey, scopedWordsKey } = getStorageKeys();
  const normalized = normalizeKey(key);
  const wordsText = words && words.length > 0 ? libraryKeyWordsText(words) : null;
  safeLocalStorageSet(scopedLibraryKey, normalized);
  if (wordsText) safeLocalStorageSet(scopedWordsKey, wordsText);
  else safeLocalStorageDel(scopedWordsKey);
  void persistSessionToMain();
  await mirrorToIdb(
    Promise.all([
      idbSet(scopedLibraryKey, normalized),
      wordsText ? idbSet(scopedWordsKey, wordsText) : idbDel(scopedWordsKey),
    ]).then(() => undefined),
  );
}

/** The 12 words of the stored key, or null when this device got the key without them (or they do not make the key). */
export async function getStoredLibraryKeyWords(): Promise<string[] | null> {
  const { scopedWordsKey } = getStorageKeys();
  const key = await getStoredLibraryKey();
  if (!key) return null;
  const stored =
    safeLocalStorageGet(scopedWordsKey) ??
    (await Promise.race([
      idbGet<string>(scopedWordsKey).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, 500)),
    ]));
  if (!stored) return null;
  const read = readLibraryKeyInput(String(stored));
  return read.status === "ok" && read.words && read.keyBase64 === key ? read.words : null;
}

/** Bound on the IndexedDB fallback read; IDB is LevelDB under userData and stalls on a saturated disk. */
export const IDB_ACK_READ_TIMEOUT_MS = 500;

/**
 * localStorage is authoritative for "acknowledged": acknowledgeLibraryKey always
 * writes it. IndexedDB only backs installs that predate that write, so it is
 * read with a bound (it gates RequireClientReady's first render) and a late hit
 * is mirrored into localStorage for the next check.
 */
export async function isLibraryKeyAcknowledged() {
  const { scopedAckKey } = getStorageKeys();
  if (safeLocalStorageGet(scopedAckKey) === "true") return true;
  const idbAck = idbGet<boolean>(scopedAckKey).then(
    (stored) => {
      if (stored !== true) return false;
      safeLocalStorageSet(scopedAckKey, "true");
      return true;
    },
    () => false,
  );
  return Promise.race([
    idbAck,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), IDB_ACK_READ_TIMEOUT_MS)),
  ]);
}

const keyAcknowledgedListeners = new Set<() => void>();

/** Calls `listener` each time this device acknowledges the library key (the key step is done). Returns the unsubscribe. */
export function onLibraryKeyAcknowledged(listener: () => void): () => void {
  keyAcknowledgedListeners.add(listener);
  return () => {
    keyAcknowledgedListeners.delete(listener);
  };
}

export async function acknowledgeLibraryKey() {
  const { scopedAckKey } = getStorageKeys();
  safeLocalStorageSet(scopedAckKey, "true");
  for (const listener of [...keyAcknowledgedListeners]) listener();
  void persistSessionToMain();
  await mirrorToIdb(idbSet(scopedAckKey, true));
}

export async function clearLibraryKey() {
  const { scopedLibraryKey, scopedAckKey, scopedWordsKey } = getStorageKeys();
  safeLocalStorageDel(scopedWordsKey);
  safeLocalStorageDel(scopedLibraryKey);
  safeLocalStorageDel(scopedAckKey);
  safeLocalStorageDel(LIB_KEY_STORAGE);
  safeLocalStorageDel(LIB_KEY_ACK_STORAGE);
  void persistSessionToMain();
  await mirrorToIdb(
    Promise.all([
      idbDel(scopedLibraryKey),
      idbDel(scopedWordsKey),
      idbDel(scopedAckKey),
      idbDel(LIB_KEY_STORAGE),
      idbDel(LIB_KEY_ACK_STORAGE),
    ]).then(() => undefined),
  );
}
