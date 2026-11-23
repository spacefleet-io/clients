/**
 * @test-id PARROT-DESKTOP-PAIRED-SIGN-IN-001
 * @level unit
 * @req ACCT-PAIR-01 ACCT-PAIR-05 PRIV-KEY-05
 * @why "Sign in with your phone" on Parrot desktop: a Badger or Parrot app approves and hands over the session and the
 *   library key. The key is checked before anything is stored; a wrong key stores nothing; another account replaces
 *   the previous one; a network failure is retried, not reported as a wrong key. "Get the key from another device" on
 *   the key step (already signed in) only checks and keeps the key, through the same path as a typed key.
 */
import { describe, expect, it, vi } from "vitest";
import { completeParrotKeyPairing, completeParrotPairedSignIn, type ParrotPairedSignInDeps } from "../src/main/pairedSignIn";

const handOver = { token: "tok-1", user: { id: "u1", email: "a@b.c", plan: "free" }, libraryKey: "KEY" };

const makeDeps = (patch: Partial<ParrotPairedSignInDeps> = {}) => {
  const calls: string[] = [];
  const deps: ParrotPairedSignInDeps = {
    previousUserId: () => null,
    forgetPreviousAccount: vi.fn(async () => void calls.push("forget")),
    verifyKey: vi.fn(async () => {
      calls.push("verify");
      return { ok: true as const };
    }),
    signIn: vi.fn(async () => void calls.push("signIn")),
    storeKey: vi.fn(async () => void calls.push("storeKey")),
    log: (line) => console.info(`[PARROT-DESKTOP-PAIRED-SIGN-IN-001] ${line}`),
    ...patch,
  };
  return { deps, calls };
};

describe("Parrot desktop paired sign-in (main)", () => {
  it("checks the key with the handed-over token, then keeps the session and the key", async () => {
    const { deps, calls } = makeDeps();
    expect(await completeParrotPairedSignIn(deps, handOver)).toBe("verified");
    expect(deps.verifyKey).toHaveBeenCalledWith("tok-1", "KEY");
    expect(deps.signIn).toHaveBeenCalledWith({ id: "u1", email: "a@b.c" }, "tok-1");
    expect(deps.storeKey).toHaveBeenCalledWith("KEY");
    expect(calls).toEqual(["verify", "signIn", "storeKey"]);
  });

  it.each(["wrongKey", "format"] as const)("stores nothing when the key is %s", async (error) => {
    const { deps, calls } = makeDeps({ previousUserId: () => "u0", verifyKey: vi.fn(async () => ({ ok: false as const, error })) });
    expect(await completeParrotPairedSignIn(deps, handOver)).toBe("mismatch");
    expect(calls).toEqual([]);
  });

  it("forgets the previous account when another one signs in", async () => {
    const { deps, calls } = makeDeps({ previousUserId: () => "u0" });
    await completeParrotPairedSignIn(deps, handOver);
    expect(calls).toEqual(["verify", "forget", "signIn", "storeKey"]);
  });

  // @req PAR-PL-05 the previous account's queued saves finish before the new account signs in
  it("waits for the previous account to be saved and forgotten before signing the new one in", async () => {
    const saved = Promise.withResolvers<void>();
    const { deps, calls } = makeDeps({
      previousUserId: () => "u0",
      forgetPreviousAccount: vi.fn(async () => {
        await saved.promise;
        calls.push("forget");
      }),
    });
    const done = completeParrotPairedSignIn(deps, handOver);
    await vi.waitFor(() => expect(deps.forgetPreviousAccount).toHaveBeenCalled());
    expect(deps.signIn).not.toHaveBeenCalled();
    expect(calls).toEqual(["verify"]);
    saved.resolve();
    await done;
    expect(calls).toEqual(["verify", "forget", "signIn", "storeKey"]);
  });

  it("keeps the same account's data when it signs in again", async () => {
    const { deps, calls } = makeDeps({ previousUserId: () => "u1" });
    await completeParrotPairedSignIn(deps, handOver);
    expect(calls).toEqual(["verify", "signIn", "storeKey"]);
  });

  it("throws on a network failure so the next poll retries, instead of calling the key wrong", async () => {
    const { deps } = makeDeps({ verifyKey: vi.fn(async () => ({ ok: false as const, error: "network" as const, message: "offline" })) });
    await expect(completeParrotPairedSignIn(deps, handOver)).rejects.toThrow(/offline/);
    expect(deps.signIn).not.toHaveBeenCalled();
  });
});

describe("Parrot desktop key from another device (main)", () => {
  const log = (line: string) => console.info(`[PARROT-DESKTOP-PAIRED-SIGN-IN-001] key-mode ${line}`);
  const ownSession = { ...handOver, token: "own-session" };

  it("keeps the key through the typed-key check and signs nobody in", async () => {
    const setLibraryKey = vi.fn(async () => ({ ok: true as const }));
    expect(await completeParrotKeyPairing(setLibraryKey, ownSession, log)).toBe("verified");
    console.info(`[PARROT-DESKTOP-PAIRED-SIGN-IN-001] key-mode calls=${JSON.stringify(setLibraryKey.mock.calls)}`);
    expect(setLibraryKey).toHaveBeenCalledWith("KEY");
  });

  it.each(["wrongKey", "format"] as const)("reports a mismatch when the key is %s", async (error) => {
    const setLibraryKey = vi.fn(async () => ({ ok: false as const, error }));
    expect(await completeParrotKeyPairing(setLibraryKey, ownSession, log)).toBe("mismatch");
  });

  it("throws on a network failure so the next poll retries", async () => {
    const setLibraryKey = vi.fn(async () => ({ ok: false as const, error: "network" as const, message: "offline" }));
    await expect(completeParrotKeyPairing(setLibraryKey, ownSession, log)).rejects.toThrow(/offline/);
  });
});
