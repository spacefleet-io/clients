/**
 * @test-id MOBILE-ONBOARD-001
 * @level unit
 * @why The encryption key lifecycle gates library access. If key acknowledgement
 *   or storage fails, users get stuck in onboarding or can't decrypt their
 *   library. Tests use fake AsyncStorage + Keychain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage, createFakeKeychain } from "./harness";

const fakeStorage = createFakeAsyncStorage();
const fakeKeychain = createFakeKeychain();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

vi.mock("react-native-keychain", () => ({
  getGenericPassword: (opts?: { service?: string }) => fakeKeychain.getGenericPassword(opts),
  setGenericPassword: (u: string, p: string, opts?: { service?: string }) => fakeKeychain.setGenericPassword(u, p, opts),
  resetGenericPassword: (opts?: { service?: string }) => fakeKeychain.resetGenericPassword(opts),
}));

beforeEach(() => {
  console.info(`[onboarding-key-lifecycle:reset] clearing fake AsyncStorage + Keychain backing stores`);
  fakeStorage._backing.clear();
  fakeKeychain._store.clear();
});

afterEach(() => {
  vi.resetModules();
});

// Dump-on-failure: print the fake AsyncStorage + Keychain backing rows so a
// failing key-lifecycle assertion shows the persisted state, not just the bad
// return value. try/catch so a dump failure can't mask the real assertion.
const dumpKeyStoreSnapshot = (label: string) => {
  try {
    const storageRows = Array.from(fakeStorage._backing.entries());
    const keychainRows = Array.from(fakeKeychain._store.entries());
    console.error(`=== [onboarding-key-lifecycle:${label}] snapshot ===`);
    console.error(`AsyncStorage backing (${storageRows.length}): ${JSON.stringify(storageRows)}`);
    console.error(`Keychain store (${keychainRows.length}): ${JSON.stringify(keychainRows)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// @req PRIV-KEY-03
describe("onboarding key lifecycle", () => {
  it("isLibraryKeyAcknowledged returns false initially", async () => {
    console.info(`[onboarding-key-lifecycle:ack-initial] checking acknowledgement on fresh stores`);
    const { isLibraryKeyAcknowledged } = await import("../src/lib/onboarding");
    const acked = await isLibraryKeyAcknowledged();
    console.info(`[onboarding-key-lifecycle:ack-initial] acknowledged=${acked} (expected false)`);
    if (acked !== false) dumpKeyStoreSnapshot("ack-initial");
    expect(acked).toBe(false);
  });

  it("setLibraryKeyAcknowledged persists and subsequent check returns true", async () => {
    console.info(`[onboarding-key-lifecycle:ack-persist] setting acknowledgement then re-reading`);
    const { setLibraryKeyAcknowledged, isLibraryKeyAcknowledged } = await import("../src/lib/onboarding");
    await setLibraryKeyAcknowledged();
    const acked = await isLibraryKeyAcknowledged();
    console.info(`[onboarding-key-lifecycle:ack-persist] acknowledged=${acked} (expected true)`);
    if (acked !== true) dumpKeyStoreSnapshot("ack-persist");
    expect(acked).toBe(true);
  });

  it("getStoredLibraryKey returns null when no key stored", async () => {
    console.info(`[onboarding-key-lifecycle:key-absent] reading key from fresh keychain`);
    const { getStoredLibraryKey } = await import("../src/lib/onboarding");
    const key = await getStoredLibraryKey();
    console.info(`[onboarding-key-lifecycle:key-absent] storedKey=${JSON.stringify(key)} (expected null)`);
    if (key !== null) dumpKeyStoreSnapshot("key-absent");
    expect(key).toBeNull();
  });

  it("setStoredLibraryKey + getStoredLibraryKey round-trips", async () => {
    console.info(`[onboarding-key-lifecycle:key-roundtrip] storing then reading key`);
    const { setStoredLibraryKey, getStoredLibraryKey } = await import("../src/lib/onboarding");
    const testKey = "dGVzdC1rZXktYmFzZTY0";
    await setStoredLibraryKey(testKey);
    const readBack = await getStoredLibraryKey();
    console.info(`[onboarding-key-lifecycle:key-roundtrip] wrote=${testKey} readBack=${JSON.stringify(readBack)}`);
    if (readBack !== testKey) dumpKeyStoreSnapshot("key-roundtrip");
    expect(readBack).toBe(testKey);
  });

  it("clearLibraryKey removes key from keychain and clears acknowledgement", async () => {
    console.info(`[onboarding-key-lifecycle:clear] seeding key + acknowledgement, then clearing`);
    const { setStoredLibraryKey, setLibraryKeyAcknowledged, clearLibraryKey, getStoredLibraryKey, isLibraryKeyAcknowledged } = await import("../src/lib/onboarding");

    await setStoredLibraryKey("some-key");
    await setLibraryKeyAcknowledged();

    // Verify setup
    const seededKey = await getStoredLibraryKey();
    const seededAck = await isLibraryKeyAcknowledged();
    console.info(`[onboarding-key-lifecycle:clear] post-seed key=${JSON.stringify(seededKey)} ack=${seededAck}`);
    if (seededKey !== "some-key" || seededAck !== true) dumpKeyStoreSnapshot("clear-seed");
    expect(seededKey).toBe("some-key");
    expect(seededAck).toBe(true);

    // Clear
    await clearLibraryKey();

    const clearedKey = await getStoredLibraryKey();
    const clearedAck = await isLibraryKeyAcknowledged();
    console.info(`[onboarding-key-lifecycle:clear] post-clear key=${JSON.stringify(clearedKey)} ack=${clearedAck} (expected null/false)`);
    if (clearedKey !== null || clearedAck !== false) dumpKeyStoreSnapshot("clear-post");
    expect(clearedKey).toBeNull();
    expect(clearedAck).toBe(false);
  });
});
