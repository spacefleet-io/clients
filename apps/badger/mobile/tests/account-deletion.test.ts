import { describe, expect, it, vi } from "vitest";
import { accountDeletionError, accountDeletionModeInput, finishAccountDeletion } from "@space/mobile-shell/account-deletion";

describe("accountDeletionError", () => {
  it("asks for the verification code only when the API demands or rejects one", () => {
    expect(accountDeletionError("two_factor_required")).toEqual({ key: "twoFactorRequired", needsCode: true });
    expect(accountDeletionError("two_factor_invalid")).toEqual({ key: "twoFactorInvalid", needsCode: true });
    expect(accountDeletionError("invalid_password")).toEqual({ key: "invalidPassword", needsCode: false });
    expect(accountDeletionError("confirm_required")).toEqual({ key: "confirmRequired", needsCode: false });
  });

  it("falls back to a generic failure for unknown codes and network errors", () => {
    expect(accountDeletionError("rate_limited")).toEqual({ key: "failed", needsCode: false });
    expect(accountDeletionError(null)).toEqual({ key: "failed", needsCode: false });
  });
});

/**
 * @test-id MOBILE-ACCOUNT-DELETION-002
 * @level unit
 * @why After a successful deletion the screen only signed out: the deleted
 *   account's library key stayed in the Keychain (survives reinstall) and its
 *   offline files stayed on the device, while the warning promises everything
 *   is permanently deleted. A failing sign-out also surfaced as "deletion
 *   failed" although the server had already accepted it.
 * @bugfix @regression-proof Found in the PR #361 review, 2026-10-16.
 */
describe("finishAccountDeletion", () => {
  // @req ACCT-DEL-01[badger-mobile]
  it("removes every download and the library key, then signs out", async () => {
    const calls: string[] = [];
    await finishAccountDeletion({
      downloadIds: ["a", "b"],
      removeDownloads: async (ids) => void calls.push(`downloads:${ids.join(",")}`),
      clearLibraryKey: async () => void calls.push("key"),
      logout: async () => void calls.push("logout"),
    });
    expect(calls).toEqual(["downloads:a,b", "key", "logout"]);
  });

  it("still wipes the key and signs out when a step fails, without throwing", async () => {
    const clearLibraryKey = vi.fn(async () => undefined);
    const logout = vi.fn(async () => {
      throw new Error("storage");
    });
    await expect(
      finishAccountDeletion({
        downloadIds: ["a"],
        removeDownloads: async () => {
          throw new Error("native");
        },
        clearLibraryKey,
        logout,
      })
    ).resolves.toBeUndefined();
    expect(clearLibraryKey).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
  });
});

/**
 * @req ACCT-DEL-03
 * @level unit
 * @why Only a paid yearly plan past its guarantee offers "end of the paid year" or "now"; every other account must keep
 *   sending no mode so the API deletes at once, and the phone must send exactly the choice the user made.
 */
describe("accountDeletionModeInput (ACCT-DEL-03)", () => {
  it("sends the chosen mode only when the API offers an end-of-year booking", () => {
    const cases = [
      { periodEnd: "2027-03-01T00:00:00.000Z", mode: "end_of_period" as const, want: { mode: "end_of_period" } },
      { periodEnd: "2027-03-01T00:00:00.000Z", mode: "now" as const, want: { mode: "now" } },
      { periodEnd: null, mode: "end_of_period" as const, want: {} },
      { periodEnd: null, mode: "now" as const, want: {} },
    ];
    for (const c of cases) {
      const got = accountDeletionModeInput(c.periodEnd, c.mode);
      console.info(`[account-deletion:mode] periodEnd=${c.periodEnd} mode=${c.mode} -> ${JSON.stringify(got)}`);
      expect(got).toEqual(c.want);
    }
  });
});
