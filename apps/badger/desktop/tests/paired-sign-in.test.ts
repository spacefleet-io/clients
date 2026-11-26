/**
 * ACCT-PAIR-01 / PRIV-KEY-05: a paired sign-in stores the session and key only after the desktops' shared account key
 * check (PRIV-KEY-01) says the key is the account's: the key probe decides, else the library database opens with it.
 */
import { describe, expect, it, vi } from "vitest";
import type { User } from "@space/shared/api";
import { completePairedSignIn, verifyPairedKey, type ApprovedPairing, type PairedSignInDeps } from "../src/renderer/src/lib/pairedSignIn";

const SUITE = "[BADGER-DESKTOP-PAIRED-SIGN-IN]";
const KEY = Buffer.alloc(32, 1).toString("base64");

const approved: ApprovedPairing = {
  status: "approved",
  token: "tok",
  user: { id: "u1", email: "a@b.c" },
  libraryKey: KEY,
};

const makeDeps = (overrides: Partial<PairedSignInDeps> = {}) => {
  const calls: string[] = [];
  const deps: PairedSignInDeps = {
    getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: "probe" })),
    decryptProbe: vi.fn(async () => new Uint8Array()),
    openLibraryDb: vi.fn(async () => undefined),
    isDecryptFailure: (error) => String(error).includes("DECRYPT_FAILED"),
    setSession: vi.fn((_token: string, _user: User) => void calls.push("setSession")),
    storeLibraryKey: vi.fn(async () => void calls.push("storeLibraryKey")),
    setMediaKey: vi.fn(async () => void calls.push("setMediaKey")),
    forwardKeyToRuntime: vi.fn(async () => void calls.push("forwardKeyToRuntime")),
    acknowledgeLibraryKey: vi.fn(async () => void calls.push("acknowledgeLibraryKey")),
    log: (message) => console.info(`${SUITE} ${message}`),
    ...overrides,
  };
  return { deps, calls };
};

describe("paired sign-in", () => {
  it("@req ACCT-PAIR-01 @req PRIV-KEY-05 stores the session first, then the key, once the key matches the library probe", async () => {
    const { deps, calls } = makeDeps();
    expect(await completePairedSignIn(deps, approved)).toBe("verified");
    console.info(`${SUITE} probe ok, calls=${JSON.stringify(calls)}`);
    expect(deps.decryptProbe).toHaveBeenCalledWith(KEY, "probe");
    expect(deps.openLibraryDb).not.toHaveBeenCalled();
    expect(calls).toEqual(["setSession", "storeLibraryKey", "setMediaKey", "forwardKeyToRuntime", "acknowledgeLibraryKey"]);
    expect(deps.forwardKeyToRuntime).toHaveBeenCalledWith("u1", KEY);
  });

  it("@req PRIV-KEY-05 stores nothing when the key does not open the library probe", async () => {
    const { deps, calls } = makeDeps({
      decryptProbe: vi.fn(async () => {
        throw new Error("bad tag");
      }),
    });
    expect(await completePairedSignIn(deps, approved)).toBe("mismatch");
    console.info(`${SUITE} probe refused, calls=${JSON.stringify(calls)}`);
    expect(calls).toEqual([]);
  });

  it("@req PRIV-KEY-01 @bugfix @regression-proof refuses a key the account's probe refuses even when Badger has no library yet (key made in Parrot)", async () => {
    // Before the shared check, Badger took any paired key here (`if (!meta.exists) return "verified"`).
    const { deps, calls } = makeDeps({
      getLibraryMeta: vi.fn(async () => ({ exists: false, keyProbe: "probe" })),
      decryptProbe: vi.fn(async () => {
        throw new Error("bad tag");
      }),
    });
    expect(await completePairedSignIn(deps, approved)).toBe("mismatch");
    console.info(`${SUITE} no Badger library, probe refused, calls=${JSON.stringify(calls)}`);
    expect(deps.decryptProbe).toHaveBeenCalledWith(KEY, "probe");
    expect(calls).toEqual([]);
  });

  it("@req PRIV-KEY-05 falls back to opening the library database when there is no probe", async () => {
    const wrong = makeDeps({
      getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: null })),
      openLibraryDb: vi.fn(async () => {
        throw new Error("DECRYPT_FAILED");
      }),
    });
    const right = makeDeps({ getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: null })) });
    const results = [await verifyPairedKey(wrong.deps, "tok", KEY, "user-1"), await verifyPairedKey(right.deps, "tok", KEY, "user-1")];
    console.info(`${SUITE} no probe, library db: ${JSON.stringify(results)}`);
    expect(results).toEqual(["mismatch", "verified"]);
  });

  it("@req ACCT-PAIR-01 does not call a network failure a wrong key", async () => {
    const { deps, calls } = makeDeps({
      getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: null })),
      openLibraryDb: vi.fn(async () => {
        throw new Error("disk is busy");
      }),
    });
    await expect(completePairedSignIn(deps, approved)).rejects.toThrow("disk is busy");
    console.info(`${SUITE} disk busy, calls=${JSON.stringify(calls)}`);
    expect(calls).toEqual([]);
  });

  it("@req ACCT-PAIR-01 accepts the key for an account that has no library and no key probe yet", async () => {
    const { deps, calls } = makeDeps({ getLibraryMeta: vi.fn(async () => ({ exists: false, keyProbe: null })) });
    expect(await completePairedSignIn(deps, approved)).toBe("verified");
    console.info(`${SUITE} no library no probe, calls=${JSON.stringify(calls)}`);
    expect(calls[0]).toBe("setSession");
  });

  it("@req PRIV-KEY-01 refuses a handed-over key that is not 32 bytes of base64", async () => {
    const { deps, calls } = makeDeps();
    expect(await completePairedSignIn(deps, { ...approved, libraryKey: "KEY" })).toBe("mismatch");
    console.info(`${SUITE} malformed key, calls=${JSON.stringify(calls)}`);
    expect(calls).toEqual([]);
  });
});
