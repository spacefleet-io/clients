/**
 * @test-id PARROT-DESKTOP-KEY-KEPT-001
 * @level unit
 * @bugfix @regression-proof
 * @why Parrot desktop wiped the library key when the server refused the saved session (`resetToSignIn` called
 *   `store.signOut()`, which removed `library-key.secret`), so the key step came back after signing in again. Same bug
 *   as on Parrot's phone (PARROT-KEY-KEPT-001); both now follow `@space/shared/keptLibraryKey`. The store and its secret
 *   files are the real code; only Electron's `safeStorage` is replaced, so the secrets are written unsealed.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotSetupState } from "../src/shared/ipc";

vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => {
      throw new Error("no protected storage in tests");
    },
    decryptStringAsync: async () => {
      throw new Error("no protected storage in tests");
    },
  },
}));

const { openParrotStore } = await import("../src/main/store");

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const USER_A = { id: "user-a", email: "a@example.test" };
const USER_B = { id: "user-b", email: "b@example.test" };
const defaultSetup = (): ParrotSetupState =>
  ({ done: false, step: "language" }) as unknown as ParrotSetupState;

let dir = "";
const lines: string[] = [];
const open = () => openParrotStore({ dir, defaultSetup, log: (line) => lines.push(line) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "parrot-kept-key-"));
  lines.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signedInWithKey = async () => {
  const store = await open();
  await store.signIn(USER_A, "token-a");
  await store.setLibraryKey(KEY);
  return store;
};

describe("Parrot desktop library key after a sign-out", () => {
  it("keeps the key when the server refused the session, and gives it back to the same account", async () => {
    const store = await signedInWithKey();
    await store.signOut("sessionRejected");
    console.info("after refused session", { token: store.token(), key: Boolean(store.libraryKey()), lines });
    expect(store.token()).toBeNull();
    expect(store.libraryKey()).toBe(KEY);
    expect(existsSync(join(dir, "library-key.secret"))).toBe(true);

    const reopened = await open();
    await reopened.signIn(USER_A, "token-a2");
    expect(reopened.libraryKey()).toBe(KEY);
  });

  it("drops the kept key when another account signs in", async () => {
    const store = await signedInWithKey();
    await store.signOut("sessionRejected");
    const reopened = await open();
    await reopened.signIn(USER_B, "token-b");
    console.info("other account signed in", { key: reopened.libraryKey(), lines });
    expect(reopened.libraryKey()).toBeNull();
    expect(existsSync(join(dir, "library-key.secret"))).toBe(false);
  });

  it("forgets the key on an explicit Sign out", async () => {
    const store = await signedInWithKey();
    await store.signOut("signOut");
    expect(store.libraryKey()).toBeNull();
    expect(existsSync(join(dir, "library-key.secret"))).toBe(false);
    const reopened = await open();
    expect(reopened.libraryKey()).toBeNull();
  });
});
