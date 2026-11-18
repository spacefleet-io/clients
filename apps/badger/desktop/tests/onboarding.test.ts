// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords, libraryKeyWordsText } from "@space/shared/libraryKeyWords";

// Node 25+ exposes a broken localStorage global when --localstorage-file is invalid.
// Provide a functional in-memory shim so jsdom-style tests work reliably.
const localStorageShim = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
})();

if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.setItem !== "function") {
  Object.defineProperty(globalThis, "localStorage", { value: localStorageShim, writable: true });
}

const idbStore = vi.hoisted(() => new Map<string, unknown>());
// When set, idbGet / idbSet / idbDel never settle: IndexedDB (LevelDB under
// userData) stalled on a saturated disk, as in runs 7950 and 8013.
const idbControl = vi.hoisted(() => ({
  hangReads: false,
  hangWrites: false,
  pendingReads: [] as string[],
  pendingWrites: [] as string[],
}));

vi.mock("../src/renderer/src/lib/idb", () => ({
  idbGet: async (key: string) => {
    if (idbControl.hangReads) {
      idbControl.pendingReads.push(key);
      return new Promise<never>(() => {});
    }
    return idbStore.get(key);
  },
  idbSet: async (key: string, value: unknown) => {
    if (idbControl.hangWrites) {
      idbControl.pendingWrites.push(`set:${key}`);
      return new Promise<never>(() => {});
    }
    idbStore.set(key, value);
  },
  idbDel: async (key: string) => {
    if (idbControl.hangWrites) {
      idbControl.pendingWrites.push(`del:${key}`);
      return new Promise<never>(() => {});
    }
    idbStore.delete(key);
  },
}));

import {
  IDB_ACK_READ_TIMEOUT_MS,
  IDB_MIRROR_WRITE_TIMEOUT_MS,
  acknowledgeLibraryKey,
  clearLibraryKey,
  getStoredLibraryKey,
  getStoredLibraryKeyWords,
  isLibraryKeyAcknowledged,
  storeLibraryKey,
} from "../src/renderer/src/lib/onboarding";

// On an onboarding key-scoping assertion failure, dump every relevant key
// from BOTH backing stores (localStorage + the in-memory idb shim) so the
// scoping bug (legacy global leak, wrong user scope, unreadable fresh key)
// is visible in CI. Wrapped in try/catch so a dump failure can't mask the
// assertion.
const dumpOnboardingSnapshot = (label: string) => {
  try {
    const lsKeys: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("sf_client_library_key") || k === "sf_client_user")) {
        lsKeys[k] = localStorage.getItem(k);
      }
    }
    const idbKeys = Object.fromEntries(idbStore.entries());
    console.error(`=== [onboarding:${label}] snapshot ===`);
    console.error(`localStorage (sf_client_*): ${JSON.stringify(lsKeys, null, 2)}`);
    console.error(`idbStore: ${JSON.stringify(idbKeys, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("onboarding library key storage", () => {
  beforeEach(() => {
    console.info("[onboarding:setup] clearing localStorage + idbStore before test");
    localStorage.clear();
    idbStore.clear();
    idbControl.hangReads = false;
    idbControl.hangWrites = false;
    idbControl.pendingReads.length = 0;
    idbControl.pendingWrites.length = 0;
  });

  it("scopes the stored library key and acknowledgement to the current user", async () => {
    localStorage.setItem(
      "sf_client_user",
      JSON.stringify({ id: "user-a", email: "a@example.com" })
    );
    const {
      acknowledgeLibraryKey,
      getStoredLibraryKey,
      isLibraryKeyAcknowledged,
      storeLibraryKey,
    } = await import("../src/renderer/src/lib/onboarding");

    console.info("[onboarding:scope-key] storing+acking key for user-a, then switching to user-b");
    await storeLibraryKey(" key-a ");
    await acknowledgeLibraryKey();

    try {
      expect(await getStoredLibraryKey()).toBe("key-a");
      expect(await isLibraryKeyAcknowledged()).toBe(true);
      expect(localStorage.getItem("sf_client_library_key:user-a")).toBe("key-a");
      expect(localStorage.getItem("sf_client_library_key_ack:user-a")).toBe("true");
    } catch (err) {
      dumpOnboardingSnapshot("user-a-scoped-store-assert-failed");
      throw err;
    }

    localStorage.setItem(
      "sf_client_user",
      JSON.stringify({ id: "user-b", email: "b@example.com" })
    );

    console.info("[onboarding:scope-key] now signed in as user-b → expect no key visible");
    try {
      expect(await getStoredLibraryKey()).toBeNull();
      expect(await isLibraryKeyAcknowledged()).toBe(false);
    } catch (err) {
      dumpOnboardingSnapshot("user-b-isolation-assert-failed");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] does not leak legacy global key state into a signed-in user scope", async () => {
    localStorage.setItem("sf_client_library_key", "legacy-key");
    localStorage.setItem("sf_client_library_key_ack", "true");
    idbStore.set("sf_client_library_key", "legacy-key");
    idbStore.set("sf_client_library_key_ack", true);
    localStorage.setItem(
      "sf_client_user",
      JSON.stringify({ id: "fresh-user", email: "fresh@example.com" })
    );

    console.info("[onboarding:legacy-leak] seeded legacy global key+ack; signing in as fresh-user → expect no leak");
    const { getStoredLibraryKey, isLibraryKeyAcknowledged } = await import(
      "../src/renderer/src/lib/onboarding"
    );

    try {
      expect(await getStoredLibraryKey()).toBeNull();
      expect(await isLibraryKeyAcknowledged()).toBe(false);
    } catch (err) {
      dumpOnboardingSnapshot("legacy-leak-assert-failed");
      throw err;
    }
  });

  it("[@bugfix][@regression-proof] makes a freshly generated scoped key immediately readable on the next load", async () => {
    localStorage.setItem(
      "sf_client_user",
      JSON.stringify({ id: "bootstrap-user", email: "bootstrap@example.com" })
    );

    console.info("[onboarding:fresh-readable] storing+acking fresh-key for bootstrap-user → expect immediately readable");
    const onboarding = await import("../src/renderer/src/lib/onboarding");

    await onboarding.storeLibraryKey(" fresh-key ");
    await onboarding.acknowledgeLibraryKey();

    try {
      expect(localStorage.getItem("sf_client_library_key:bootstrap-user")).toBe("fresh-key");
      expect(localStorage.getItem("sf_client_library_key_ack:bootstrap-user")).toBe("true");
      expect(await onboarding.getStoredLibraryKey()).toBe("fresh-key");
      expect(await onboarding.isLibraryKeyAcknowledged()).toBe(true);
    } catch (err) {
      dumpOnboardingSnapshot("fresh-key-readable-assert-failed");
      throw err;
    }
  });

  // run 7950 playback-chapter-navigation: /home sat on "Loading..." for > 20 s.
  // RequireClientReady leaves "checking" only after isLibraryKeyAcknowledged(),
  // which awaited idbGet with no bound and read localStorage only if IDB REJECTED.
  describe("[@bugfix][@regression-proof] isLibraryKeyAcknowledged with a stalled IndexedDB read", () => {
    const settleWithin = async (promise: Promise<boolean>, boundMs: number) => {
      let outcome: { value: boolean } | "pending" = "pending";
      void promise.then((value) => {
        outcome = { value };
      });
      await vi.advanceTimersByTimeAsync(boundMs);
      return outcome as { value: boolean } | "pending";
    };

    it("resolves true from the localStorage ack without waiting on IDB", async () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem("sf_client_user", JSON.stringify({ id: "user-a" }));
        localStorage.setItem("sf_client_library_key_ack:user-a", "true");
        idbControl.hangReads = true;
        console.info("[onboarding:idb-stall-ack] localStorage ack present, IDB reads hang");
        const outcome = await settleWithin(isLibraryKeyAcknowledged(), 0);
        console.info(`[onboarding:idb-stall-ack] outcome=${JSON.stringify(outcome)} pendingIdbReads=${JSON.stringify(idbControl.pendingReads)}`);
        if (outcome === "pending") dumpOnboardingSnapshot("idb-stall-ack-pending");
        expect(outcome).toEqual({ value: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves false within a bounded wait when neither store answers", async () => {
      vi.useFakeTimers();
      try {
        localStorage.setItem("sf_client_user", JSON.stringify({ id: "user-a" }));
        idbControl.hangReads = true;
        console.info("[onboarding:idb-stall-no-ack] no ack anywhere, IDB reads hang");
        const outcome = await settleWithin(isLibraryKeyAcknowledged(), IDB_ACK_READ_TIMEOUT_MS);
        console.info(`[onboarding:idb-stall-no-ack] outcome=${JSON.stringify(outcome)} pendingIdbReads=${JSON.stringify(idbControl.pendingReads)}`);
        if (outcome === "pending") dumpOnboardingSnapshot("idb-stall-no-ack-pending");
        expect(outcome).toEqual({ value: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("an IDB-only (legacy) ack is still honoured and mirrored into localStorage", async () => {
      localStorage.setItem("sf_client_user", JSON.stringify({ id: "user-a" }));
      idbStore.set("sf_client_library_key_ack:user-a", true);
      console.info("[onboarding:idb-only-ack] ack only in IDB (legacy install)");
      try {
        expect(await isLibraryKeyAcknowledged()).toBe(true);
        expect(localStorage.getItem("sf_client_library_key_ack:user-a")).toBe("true");
      } catch (err) {
        dumpOnboardingSnapshot("idb-only-ack-assert-failed");
        throw err;
      }
    });
  });

  describe("UX-KEY-01: the key's 12 words next to the key", () => {
    const made = generateLibraryKeyWords("en", (bytes) => bytes.fill(7));

    beforeEach(() => {
      localStorage.setItem("sf_client_user", JSON.stringify({ id: "user-a" }));
    });

    it("keeps the words with a key made or typed here, scoped to the user, and clears them with the key", async () => {
      await storeLibraryKey(made.keyBase64, made.words);
      const words = await getStoredLibraryKeyWords();
      console.info(`[onboarding:words] stored=${localStorage.getItem("sf_client_library_key_words:user-a")} read=${JSON.stringify(words)}`);
      try {
        expect(localStorage.getItem("sf_client_library_key_words:user-a")).toBe(libraryKeyWordsText(made.words));
        expect(idbStore.get("sf_client_library_key_words:user-a")).toBe(libraryKeyWordsText(made.words));
        expect(words).toEqual(made.words);
        await clearLibraryKey();
        expect(localStorage.getItem("sf_client_library_key_words:user-a")).toBeNull();
        expect(idbStore.has("sf_client_library_key_words:user-a")).toBe(false);
        expect(await getStoredLibraryKeyWords()).toBeNull();
      } catch (err) {
        dumpOnboardingSnapshot("words-store-clear");
        throw err;
      }
    });

    it("drops the words when a key arrives without them (pairing), and never shows words that are not the key", async () => {
      await storeLibraryKey(made.keyBase64, made.words);
      await storeLibraryKey("UGFpcmVkS2V5RnJvbUFub3RoZXJEZXZpY2UwMDAwMDA=");
      const afterPairing = await getStoredLibraryKeyWords();
      localStorage.setItem("sf_client_library_key_words:user-a", libraryKeyWordsText(made.words));
      const mismatched = await getStoredLibraryKeyWords();
      console.info(`[onboarding:words-paired] afterPairing=${JSON.stringify(afterPairing)} mismatched=${JSON.stringify(mismatched)}`);
      expect(afterPairing).toBeNull();
      expect(mismatched).toBeNull();
    });
  });

  // run 8013 critical-path-smoke: a fresh user sat on /onboarding/key's loading
  // state for > 15 s. Both IDB reads hit their 500 ms bound (storedKey.done at
  // 502 ms), then the generate branch awaited storeLibraryKey → idbSet with no
  // bound, so setLoadingKey(false) never ran and no key UI rendered.
  describe("[@bugfix][@regression-proof] key writers with a stalled IndexedDB write", () => {
    const settleWithin = async (promise: Promise<unknown>, boundMs: number) => {
      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(boundMs);
      return settled;
    };

    const withStalledIdb = async (label: string, run: () => Promise<void>) => {
      vi.useFakeTimers();
      try {
        localStorage.setItem("sf_client_user", JSON.stringify({ id: "user-a" }));
        idbControl.hangReads = true;
        idbControl.hangWrites = true;
        console.info(`[onboarding:${label}] IDB reads and writes hang`);
        await run();
      } catch (err) {
        console.info(`[onboarding:${label}] pendingIdbWrites=${JSON.stringify(idbControl.pendingWrites)}`);
        dumpOnboardingSnapshot(`${label}-assert-failed`);
        throw err;
      } finally {
        vi.useRealTimers();
      }
    };

    it("storeLibraryKey settles within the bound and the key is readable from localStorage", async () => {
      await withStalledIdb("idb-stall-store", async () => {
        expect(await settleWithin(storeLibraryKey(" fresh-key "), IDB_MIRROR_WRITE_TIMEOUT_MS)).toBe(true);
        expect(idbControl.pendingWrites).toEqual(["set:sf_client_library_key:user-a", "del:sf_client_library_key_words:user-a"]);
        let stored: string | null | "pending" = "pending";
        void getStoredLibraryKey().then((value) => {
          stored = value;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stored).toBe("fresh-key");
      });
    });

    it("acknowledgeLibraryKey settles within the bound and the ack is readable from localStorage", async () => {
      await withStalledIdb("idb-stall-ack-write", async () => {
        expect(await settleWithin(acknowledgeLibraryKey(), IDB_MIRROR_WRITE_TIMEOUT_MS)).toBe(true);
        expect(idbControl.pendingWrites).toEqual(["set:sf_client_library_key_ack:user-a"]);
        expect(await settleWithin(isLibraryKeyAcknowledged(), 0)).toBe(true);
        expect(localStorage.getItem("sf_client_library_key_ack:user-a")).toBe("true");
      });
    });

    it("clearLibraryKey settles within the bound and clears localStorage", async () => {
      localStorage.setItem("sf_client_library_key:user-a", "old-key");
      localStorage.setItem("sf_client_library_key_ack:user-a", "true");
      await withStalledIdb("idb-stall-clear", async () => {
        expect(await settleWithin(clearLibraryKey(), IDB_MIRROR_WRITE_TIMEOUT_MS)).toBe(true);
        expect(idbControl.pendingWrites).toHaveLength(5);
        expect(idbControl.pendingWrites).toContain("del:sf_client_library_key_words:user-a");
        expect(localStorage.getItem("sf_client_library_key:user-a")).toBeNull();
        expect(localStorage.getItem("sf_client_library_key_ack:user-a")).toBeNull();
      });
    });
  });
});
