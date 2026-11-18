/**
 * @test-id PARROT-DESKTOP-LIBRARY-ERASE-001
 * @level unit
 * @req PRIV-KEY-01[parrot]
 * @why Chris (2026-11-12): the vault and its key are shared by Badger and Parrot; the erase on the key step is the last
 *   resort and wipes the whole account's vault. Parrot runs the same account-wide reset as Badger (password, then the
 *   two-factor code when asked), and only an accepted reset forgets this computer's key and cache; a refused one
 *   changes nothing here.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { eraseAccountLibrary } from "../src/main/libraryErase";

const SUITE = "[PARROT-DESKTOP-LIBRARY-ERASE-001]";

const setup = (reset: (password: string, code?: string) => Promise<unknown>) => {
  const deps = {
    reset: vi.fn(reset),
    clearLocal: vi.fn(async () => undefined),
    log: (m: string) => console.info(`${SUITE} ${m}`),
    fail: (m: string) => console.warn(`${SUITE} ${m}`),
  };
  return deps;
};

describe("@req PRIV-KEY-01 eraseAccountLibrary", () => {
  it("resets the account with the password and code, then clears this computer's key and cache", async () => {
    const deps = setup(async () => ({ ok: true }));
    const outcome = await eraseAccountLibrary("pw", "123456", deps);
    console.info(`${SUITE} erased: ${JSON.stringify(outcome)} resets=${JSON.stringify(deps.reset.mock.calls)} clears=${deps.clearLocal.mock.calls.length}`);
    expect(outcome).toEqual({ status: "erased" });
    expect(deps.reset).toHaveBeenCalledWith("pw", "123456");
    expect(deps.clearLocal).toHaveBeenCalledTimes(1);
  });

  it("still reports erased when the local cleanup fails after the server erased", async () => {
    const deps = setup(async () => ({ ok: true }));
    deps.clearLocal.mockRejectedValueOnce(new Error("disk busy"));
    const outcome = await eraseAccountLibrary("pw", undefined, deps);
    console.info(`${SUITE} cleanup failed: ${JSON.stringify(outcome)}`);
    expect(outcome).toEqual({ status: "erased" });
  });

  it("refuses an empty password without calling the server", async () => {
    const deps = setup(async () => ({ ok: true }));
    const outcome = await eraseAccountLibrary("", undefined, deps);
    console.info(`${SUITE} empty password: ${JSON.stringify(outcome)}`);
    expect(outcome).toEqual({ status: "failed", reason: "invalidPassword" });
    expect(deps.reset).not.toHaveBeenCalled();
    expect(deps.clearLocal).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong password", new ApiError(401, { error: "invalid_password" }), { status: "failed", reason: "invalidPassword" }],
    ["code needed", new ApiError(401, { error: "two_factor_required", method: "totp" } as never), { status: "codeNeeded", method: "totp" }],
    ["wrong code", new ApiError(401, { error: "two_factor_invalid" }), { status: "failed", reason: "invalidCode" }],
    ["offline", new Error("fetch failed"), { status: "failed", reason: "other" }],
  ])("a refused reset (%s) clears nothing and maps like Badger's", async (label, error, expected) => {
    const deps = setup(async () => {
      throw error;
    });
    const outcome = await eraseAccountLibrary("pw", undefined, deps);
    console.info(`${SUITE} ${label}: ${JSON.stringify(outcome)}`);
    expect(outcome).toEqual(expected);
    expect(deps.clearLocal).not.toHaveBeenCalled();
  });
});
