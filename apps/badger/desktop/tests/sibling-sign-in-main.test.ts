/**
 * Badger desktop's account for same-device sign-in: read from the window's stored session entries, published to
 * Parrot on this computer only when signed in with a library key.
 *
 * @req ACCT-PAIR-07
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() }, app: {} }));

const SUITE = "sibling-sign-in-main";

describe("siblingAccountOf", () => {
  it("signed in: token, user and the user's library key", async () => {
    const { siblingAccountOf } = await import("../src/main/siblingSignIn");
    const account = siblingAccountOf({
      sf_client_token: "tok",
      sf_client_user: JSON.stringify({ id: "u1", email: "lane@example.test" }),
      "sf_client_library_key:u1": "KEY ",
    });
    console.info(SUITE, "signed in", { user: account?.user });
    expect(account?.token).toBe("tok");
    expect(account?.user).toEqual({ id: "u1", email: "lane@example.test" });
    expect(await account?.libraryKey()).toBe("KEY");
  });

  it("an older bare library key is still found", async () => {
    const { siblingAccountOf } = await import("../src/main/siblingSignIn");
    const account = siblingAccountOf({
      sf_client_token: "tok",
      sf_client_user: JSON.stringify({ id: "u1", email: "lane@example.test" }),
      sf_client_library_key: "BARE",
    });
    expect(await account?.libraryKey()).toBe("BARE");
  });

  it("signed out or a broken user: nothing to offer", async () => {
    const { siblingAccountOf } = await import("../src/main/siblingSignIn");
    const cases: Record<string, string>[] = [
      {},
      { sf_client_token: "tok" },
      { sf_client_token: "tok", sf_client_user: "{broken" },
      { sf_client_token: " ", sf_client_user: JSON.stringify({ id: "u1", email: "a@b" }) },
      { sf_client_token: "tok", sf_client_user: JSON.stringify({ id: "u1" }) },
    ];
    for (const entries of cases) {
      const account = siblingAccountOf(entries);
      console.info(SUITE, "no account", { keys: Object.keys(entries), account });
      expect(account).toBeNull();
    }
  });
});
