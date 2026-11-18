/**
 * @test-id DESKTOP-SHELL-KEPT-KEY-001
 * @level unit
 * @bugfix @regression-proof
 * @why After an account-wide erase from Parrot, a restarted Badger kept the erased key, went straight to Home and
 *   published a library under it, overwriting the new key's probe; a restarted Parrot opened an empty library with
 *   its erased key (erase e2e, 2026-11-12). Both apps now check the kept key on start with checkKeptLibraryKey:
 *   a probe it cannot open, or an account with no key at all, forgets the key; a server that does not answer keeps
 *   it so an offline start works (PRIV-KEY-01).
 */
import { describe, expect, it, vi } from "vitest";
import { checkKeptLibraryKey, type KeptLibraryKeyDeps } from "../src/libraryKeptKey";

const SUITE = "[DESKTOP-SHELL-KEPT-KEY-001]";

const deps = (over: Partial<KeptLibraryKeyDeps>): KeptLibraryKeyDeps => ({
  readKeyProbe: async () => null,
  decryptProbe: async () => new Uint8Array(),
  opensAccountLibrary: async () => null,
  log: () => undefined,
  ...over,
});

describe(`${SUITE} checkKeptLibraryKey`, () => {
  it("keeps a key that opens the account's probe, without reading a library", async () => {
    const opensAccountLibrary = vi.fn(async () => false);
    const verdict = await checkKeptLibraryKey("k", deps({ readKeyProbe: async () => "probe", opensAccountLibrary }));
    console.info(`${SUITE} probe opens → ${verdict}`);
    expect(verdict).toBe("account");
    expect(opensAccountLibrary).not.toHaveBeenCalled();
  });

  it("forgets a key the account's probe does not open (a new key was saved after an erase)", async () => {
    const verdict = await checkKeptLibraryKey(
      "old",
      deps({ readKeyProbe: async () => "new-probe", decryptProbe: async () => Promise.reject(new Error("OperationError")) }),
    );
    console.info(`${SUITE} probe fails → ${verdict}`);
    expect(verdict).toBe("stale");
  });

  it("forgets a key when the account has no probe and no library (erased)", async () => {
    expect(await checkKeptLibraryKey("old", deps({ opensAccountLibrary: async () => null }))).toBe("stale");
  });

  it("keeps a key that opens a library of an account from before probes", async () => {
    expect(await checkKeptLibraryKey("k", deps({ opensAccountLibrary: async () => true }))).toBe("account");
  });

  it("forgets a key that does not open the account's library", async () => {
    expect(await checkKeptLibraryKey("k", deps({ opensAccountLibrary: async () => false }))).toBe("stale");
  });

  it("keeps the key when the probe cannot be read (offline start)", async () => {
    const verdict = await checkKeptLibraryKey("k", deps({ readKeyProbe: async () => Promise.reject(new Error("fetch failed")) }));
    console.info(`${SUITE} probe read throws → ${verdict}`);
    expect(verdict).toBe("unknown");
  });

  it("keeps the key when the library cannot be read (offline start)", async () => {
    expect(
      await checkKeptLibraryKey("k", deps({ opensAccountLibrary: async () => Promise.reject(new Error("fetch failed")) })),
    ).toBe("unknown");
  });
});
