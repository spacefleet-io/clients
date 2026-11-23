/**
 * Is the library key this phone or TV kept still the account's key? (UX-KEY-01, PRIV-KEY-01), shared by Badger phone,
 * Badger TV and Parrot phone. The library can be erased account-wide from any device (the erase behind "Lost your
 * key?"), and a new key made there; a device that kept the old key must not open an empty library under it, nor
 * publish anything with it. Main 2026-11-12: "On start (and on foreground if cheap), the app checks that its kept key
 * still matches the account's library/probe. A mismatch or a missing probe means: forget the key, clear the local
 * library cache, go to the shared key step (enter if there's a probe, create if none). A network failure keeps the
 * key. No publish/sync with a key that doesn't match the probe."
 *
 * The verdict comes from the account's key probe (a random value the key encrypted, returned with every app's library
 * meta), the same probe the key step and the desktop apps check a key against.
 */

/**
 * - `matches`: the probe opens with the kept key; keep it.
 * - `mismatch`: the account has another key now (erased and remade elsewhere); forget the kept one.
 * - `noKey`: the account has no probe and no library any more (erased elsewhere, nothing made since); forget it.
 * - `unchecked`: no verdict (no connection, the server failed, or an old library with no probe); keep the key.
 */
export type KeptLibraryKeyVerdict = "matches" | "mismatch" | "noKey" | "unchecked";

/** The part of the library meta the verdict reads (`LibraryMeta` from `@space/shared/api`). */
export type KeptKeyMeta = { exists: boolean; keyProbe: string | null | undefined };

/** Opens a base64 envelope with a base64 key; any throw means the key does not open it. */
export type KeptKeyDecrypt = (keyBase64: string, payloadBase64: string) => Promise<unknown>;

/** Whether the kept key must go: the account's key is another one, or the account has none any more. */
export const keptLibraryKeyIsStale = (verdict: KeptLibraryKeyVerdict): boolean =>
  verdict === "mismatch" || verdict === "noKey";

/** The verdict from library meta already fetched (null: the request failed, which never costs the key). */
export const keptLibraryKeyVerdict = async (
  key: string,
  meta: KeptKeyMeta | null,
  decrypt: KeptKeyDecrypt,
): Promise<KeptLibraryKeyVerdict> => {
  if (!meta) return "unchecked";
  // A library with no probe predates probes: its snapshot is the check (a wrong key fails to decrypt it).
  if (!meta.keyProbe) return meta.exists ? "unchecked" : "noKey";
  // The probe opens only with the account's key; a stored value that is not even a key cannot open it either.
  try {
    await decrypt(key, meta.keyProbe);
    return "matches";
  } catch {
    return "mismatch";
  }
};

export type KeptLibraryKeyCheckDeps = {
  /** The app's library meta (`getLibraryMeta(token, app)`); a throw is "no verdict", never a reason to forget. */
  fetchMeta: () => Promise<KeptKeyMeta>;
  decrypt: KeptKeyDecrypt;
  log?: (event: string, details: Record<string, unknown>) => void;
};

/** Fetches the account's meta and judges `key` against it. */
// tla: VaultKeys/Start
export const checkKeptLibraryKey = async (key: string, deps: KeptLibraryKeyCheckDeps): Promise<KeptLibraryKeyVerdict> => {
  let meta: KeptKeyMeta | null = null;
  try {
    meta = await deps.fetchMeta();
  } catch (error) {
    deps.log?.("kept_key.meta_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  const verdict = await keptLibraryKeyVerdict(key, meta, deps.decrypt);
  deps.log?.("kept_key.checked", { verdict, hasKeyProbe: Boolean(meta?.keyProbe), exists: meta?.exists ?? null });
  return verdict;
};

/** `AppState.addEventListener` (react-native's), passed in so this module stays free of native imports. */
export type ForegroundSource = {
  addEventListener: (event: "change", listener: (status: string) => void) => { remove: () => void };
};

/**
 * Runs `check` each time the app comes back to the front (and once now unless `atStart` is false) and calls `onStale`
 * when the kept key must go. One check at a time: a foreground while one is running is skipped. Returns the stop.
 */
export const watchKeptLibraryKey = (input: {
  check: () => Promise<KeptLibraryKeyVerdict>;
  onStale: (verdict: KeptLibraryKeyVerdict) => void | Promise<void>;
  appState: ForegroundSource;
  atStart?: boolean;
  log?: (event: string, details: Record<string, unknown>) => void;
}): (() => void) => {
  let stopped = false;
  let running = false;
  const run = async (reason: "start" | "foreground") => {
    if (stopped || running) return;
    running = true;
    try {
      const verdict = await input.check();
      if (stopped || !keptLibraryKeyIsStale(verdict)) return;
      input.log?.("kept_key.stale", { verdict, reason });
      await input.onStale(verdict);
    } catch (error) {
      input.log?.("kept_key.check_failed", { reason, message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };
  if (input.atStart !== false) void run("start");
  const subscription = input.appState.addEventListener("change", (status) => {
    if (status === "active") void run("foreground");
  });
  return () => {
    stopped = true;
    subscription.remove();
  };
};
