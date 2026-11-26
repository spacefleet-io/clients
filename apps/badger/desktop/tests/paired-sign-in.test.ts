/**
 * ACCT-PAIR-01 / PRIV-KEY-05: a paired sign-in stores the session and key only after the key opens the
 * account's library (keyProbe, else the library database), like manual key entry.
 */
import { describe, expect, it, vi } from "vitest";
import type { User } from "@space/shared/api";
import { completePairedSignIn, verifyPairedKey, type ApprovedPairing, type PairedSignInDeps } from "../src/renderer/src/lib/pairedSignIn";

const approved: ApprovedPairing = {
  status: "approved",
  token: "tok",
  user: { id: "u1", email: "a@b.c" },
  libraryKey: "KEY",
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
    ...overrides,
  };
  return { deps, calls };
};

describe("paired sign-in", () => {
  it("@req ACCT-PAIR-01 @req PRIV-KEY-05 stores the session first, then the key, once the key matches the library probe", async () => {
    const { deps, calls } = makeDeps();
    expect(await completePairedSignIn(deps, approved)).toBe("verified");
    expect(deps.decryptProbe).toHaveBeenCalledWith("KEY", "probe");
    expect(calls).toEqual(["setSession", "storeLibraryKey", "setMediaKey", "forwardKeyToRuntime", "acknowledgeLibraryKey"]);
    expect(deps.forwardKeyToRuntime).toHaveBeenCalledWith("u1", "KEY");
  });

  it("@req PRIV-KEY-05 stores nothing when the key does not open the library probe", async () => {
    const { deps, calls } = makeDeps({
      decryptProbe: vi.fn(async () => {
        throw new Error("bad tag");
      }),
    });
    expect(await completePairedSignIn(deps, approved)).toBe("mismatch");
    expect(calls).toEqual([]);
  });

  it("@req PRIV-KEY-05 falls back to opening the library database when there is no probe", async () => {
    const wrong = makeDeps({
      getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: null })),
      openLibraryDb: vi.fn(async () => {
        throw new Error("DECRYPT_FAILED");
      }),
    });
    expect(await verifyPairedKey(wrong.deps, "tok", "KEY", "user-1")).toBe("mismatch");
    const right = makeDeps({ getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: null })) });
    expect(await verifyPairedKey(right.deps, "tok", "KEY", "user-1")).toBe("verified");
  });

  it("@req ACCT-PAIR-01 does not call a network failure a wrong key", async () => {
    const { deps, calls } = makeDeps({
      getLibraryMeta: vi.fn(async () => ({ exists: true, keyProbe: null })),
      openLibraryDb: vi.fn(async () => {
        throw new Error("disk is busy");
      }),
    });
    await expect(completePairedSignIn(deps, approved)).rejects.toThrow("disk is busy");
    expect(calls).toEqual([]);
  });

  it("@req ACCT-PAIR-01 accepts the key for an account that has no library yet", async () => {
    const { deps, calls } = makeDeps({ getLibraryMeta: vi.fn(async () => ({ exists: false, keyProbe: null })) });
    expect(await completePairedSignIn(deps, approved)).toBe("verified");
    expect(calls[0]).toBe("setSession");
  });
});
