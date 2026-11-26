/**
 * @test-id MOBILE-AUTH-STORED-SESSION-STARTUP-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: `AuthProvider` kept `loading` true until `/auth/me` answered, even with the token AND the
 * user already saved on the phone. Everything behind auth (the navigator, the library) therefore waited on a
 * network round trip at every cold start; with the API stalled that was ~10 s of splash before the saved
 * library could show. With a saved session the check now runs behind the first paint and only ever
 * confirms the session (fresh user) or rejects it (sign out).
 *
 * Mounts the real AuthProvider with react-test-renderer; `/auth/me` is a promise the test settles by hand.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestUser = { id: string; email: string; displayName: string };

const ctl = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  me: null as { resolve: (value: { user: TestUser }) => void; reject: (error: unknown) => void } | null,
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
    login: async () => {
      throw new Error("not used");
    },
    logout: async () => undefined,
  };
});

const { AuthProvider, useAuth } = await import("../src/store/auth");
const { ApiError } = await import("@space/shared/api");

const STORED_USER: TestUser = { id: "u1", email: "stored@example.com", displayName: "Stored" };
const FRESH_USER: TestUser = { id: "u1", email: "stored@example.com", displayName: "Fresh" };

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let observed: { loading: boolean; token: string | null; userName: string | null } | null = null;

const Probe = () => {
  const { loading, token, user } = useAuth();
  observed = { loading, token, userName: user?.displayName ?? null };
  return null;
};

const mount = async () => {
  await act(async () => {
    renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)));
  });
  await flush();
};

beforeEach(() => {
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.storage.clear();
  ctl.me = null;
  observed = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("auth restores a saved session without waiting for /auth/me", () => {
  it("@bugfix @regression-proof releases loading with the saved token and user while /auth/me is pending", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(STORED_USER));

    await mount();

    expect(ctl.me, "the session is still validated").not.toBeNull();
    expect(observed).toEqual({ loading: false, token: "saved-token", userName: "Stored" });
  });

  it("swaps in the fresh user and persists it once /auth/me answers", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(STORED_USER));
    await mount();

    await act(async () => {
      ctl.me?.resolve({ user: FRESH_USER });
    });
    await flush();

    expect(observed).toEqual({ loading: false, token: "saved-token", userName: "Fresh" });
    expect(JSON.parse(ctl.storage.get("sf_auth_user") ?? "null")).toEqual(FRESH_USER);
  });

  it("signs out when the server rejects the saved token", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(STORED_USER));
    await mount();

    await act(async () => {
      ctl.me?.reject(new ApiError(401, { error: "unauthorized" }));
    });
    await flush();

    expect(observed).toEqual({ loading: false, token: null, userName: null });
    expect(ctl.storage.has("sf_auth_token")).toBe(false);
    expect(ctl.storage.has("sf_auth_user")).toBe(false);
  });

  it("keeps the saved session when /auth/me fails for a non-auth reason (offline)", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");
    ctl.storage.set("sf_auth_user", JSON.stringify(STORED_USER));
    await mount();

    await act(async () => {
      ctl.me?.reject(new Error("Network request failed"));
    });
    await flush();

    expect(observed).toEqual({ loading: false, token: "saved-token", userName: "Stored" });
    expect(ctl.storage.get("sf_auth_token")).toBe("saved-token");
  });

  it("still waits for /auth/me when a token is saved but no user is", async () => {
    ctl.storage.set("sf_auth_token", "saved-token");

    await mount();
    expect(observed?.loading, "without a saved user there is nothing to render yet").toBe(true);

    await act(async () => {
      ctl.me?.resolve({ user: FRESH_USER });
    });
    await flush();

    expect(observed).toEqual({ loading: false, token: "saved-token", userName: "Fresh" });
  });

  it("opens straight to signed-out when nothing is saved", async () => {
    await mount();

    expect(ctl.me, "no token, no request").toBeNull();
    expect(observed).toEqual({ loading: false, token: null, userName: null });
  });
});
