/**
 * The phone setup progress held in memory over its saved copy (`createPhoneSetupStore`), for screens outside the
 * walkthrough that read or move it too (Badger phone: the navigator, the sign-in and key screens' step bar, the
 * pairing sign-in). Every save shows at once and is then kept on the phone (UX-SETUP-07).
 */
import { useSyncExternalStore } from "react";
import { scopeLogger } from "../logger";
import { INITIAL_PHONE_SETUP, type PhoneSetupProgress, type PhoneSetupStore } from "./phoneSetup";

const log = scopeLogger("setup");

export type LivePhoneSetup = {
  /** Reads the saved progress once (later calls share the first read). */
  load: () => Promise<PhoneSetupProgress>;
  get: () => PhoneSetupProgress | null;
  /** Shows `next` at once and keeps it on this phone. */
  save: (next: PhoneSetupProgress) => Promise<void>;
  /** A pairing sign-in brought the key: the key screen leaves this phone's setup. */
  markPaired: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  /** The progress, or null until the first read is done (or while `enabled` is false). */
  useProgress: (enabled: boolean) => PhoneSetupProgress | null;
  /** Test hook: forget the in-memory state so the next `load` re-reads the store. */
  reset: () => void;
};

/**
 * `unsaved` is the progress of a phone that never saved any: the app decides (a phone set up before the walkthrough
 * existed has nothing left to set up).
 */
export const createLivePhoneSetup = (input: {
  store: PhoneSetupStore;
  unsaved?: () => Promise<PhoneSetupProgress>;
}): LivePhoneSetup => {
  let current: PhoneSetupProgress | null = null;
  let loading: Promise<PhoneSetupProgress> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const load = () => {
    if (loading) return loading;
    loading = (async () => {
      let saved: PhoneSetupProgress | null = null;
      try {
        saved = await input.store.readSaved();
      } catch (error) {
        log.warn("load.failed", { message: error instanceof Error ? error.message : String(error) });
      }
      const progress = saved ?? (input.unsaved ? await input.unsaved() : INITIAL_PHONE_SETUP);
      log.info("loaded", { ...progress, saved: saved !== null });
      // An answer saved while the read was in flight wins.
      if (!current) current = progress;
      notify();
      return current;
    })();
    return loading;
  };

  const get = () => current;

  const save = async (next: PhoneSetupProgress) => {
    log.info("save", { ...next });
    current = next;
    notify();
    try {
      await input.store.write(next);
    } catch (error) {
      log.warn("save.failed", { message: error instanceof Error ? error.message : String(error) });
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    load,
    get,
    save,
    markPaired: async () => {
      const progress = current ?? (await load());
      if (progress.done || progress.pairedKey) return;
      await save({ ...progress, pairedKey: true });
    },
    subscribe,
    useProgress: (enabled) => {
      const progress = useSyncExternalStore(subscribe, get, get);
      if (enabled && !progress) void load();
      return enabled ? progress : null;
    },
    reset: () => {
      current = null;
      loading = null;
      listeners.clear();
    },
  };
};
