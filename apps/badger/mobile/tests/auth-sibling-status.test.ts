/**
 * @test-id MOBILE-AUTH-SIBLING-STATUS-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile]
 * @why Parrot on the same phone offers "Continue with your Badger account" only while Badger is signed in, and names
 *   the account. Badger therefore tells the native status store which account it holds ({email, userId}, never the
 *   token) as soon as a session is known, and clears it when the session ends or the server refuses it.
 *
 * Mounts the real AuthProvider with react-test-renderer; the native status store is a spy.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { AuthProvider, useAuth, type AuthContextValue } from "../src/store/auth";

type TestUser = { id: string; email: string; displayName: string };

const SUITE = "[auth-sibling-status]";

const ctl = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  me: null as { resolve: (value: { user: TestUser }) => void; reject: (error: unknown) => void } | null,
  published: [] as unknown[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => ctl.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      ctl.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      ctl.storage.delete(key);
    },
  },
}));
vi.mock("@space/mobile-shell/sibling", () => ({
  publishSiblingStatus: async (status: unknown) => {
    ctl.published.push(status);
  },
}));
vi.mock("../src/lib/libraryDb", () => ({ LibraryDb: { clearLocalCache: async () => undefined } }));
vi.mock("../src/lib/assets", () => ({ clearAssetUrlCache: () => undefined }));
vi.mock("../src/lib/pairing/deviceWatch", () => ({ forgetKnownSessions: async () => undefined }));
vi.mock("../src/lib/onboarding", () => ({ clearLibraryKey: async () => undefined }));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getMe: () =>
      new Promise<{ user: TestUser }>((resolve, reject) => {
        ctl.me = { resolve, reject };
      }),
    logout: async () => undefined,
  };
});

const ADA: TestUser = { id: "u1", email: "ada@example.com", displayName: "Ada" };

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let auth: AuthContextValue | null = null;

const Probe = () => {
  auth = useAuth();
  return null;
};

const mount = async () => {
  await act(async () => {
    renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)));
  });
  await flush();
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.storage.clear();
  ctl.me = null;
  ctl.published = [];
  auth = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("Badger tells the sister app which account it is signed in to", () => {
  it("publishes the saved session's account, without the token", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(ADA));
    await mount();
    console.info(SUITE, "saved session", ctl.published);
    expect(ctl.published.at(-1)).toEqual({ email: "ada@example.com", userId: "u1" });
    expect(JSON.stringify(ctl.published)).not.toContain("saved-token");
  });

  it("publishes nothing while signed out, then the account after a paired sign-in", async () => {
    await mount();
    expect(ctl.published.at(-1) ?? null).toBeNull();
    await act(async () => {
      await auth?.setSession("paired-token", ADA);
    });
    await flush();
    console.info(SUITE, "after setSession", ctl.published);
    expect(ctl.published.at(-1)).toEqual({ email: "ada@example.com", userId: "u1" });
  });

  it("clears the status on Sign out", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(ADA));
    await mount();
    await act(async () => {
      await auth?.logout("signOut");
    });
    await flush();
    console.info(SUITE, "after logout", ctl.published);
    expect(ctl.published.at(-1)).toBeNull();
  });

  it("clears the status when the server refuses the saved session", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(ADA));
    await mount();
    await act(async () => {
      ctl.me?.reject(new ApiError(401, { error: "unauthorized" }));
    });
    await flush();
    console.info(SUITE, "after rejection", ctl.published);
    expect(ctl.published.at(-1)).toBeNull();
  });
});
