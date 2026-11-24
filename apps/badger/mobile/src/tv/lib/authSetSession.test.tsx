/**
 * @test-id TV-PAIR-AUTH-001
 * @level unit
 * @why A paired TV has a session token from the API but never typed a password, so it enters the app through
 *   `setSession(token, user)`. If that did not persist exactly like `login`, the TV would be signed out at the next
 *   cold start and every pairing would have to be repeated. Mounts the real AuthProvider with react-test-renderer.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestUser = { id: string; email: string; displayName: string };

const ctl = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  logouts: [] as string[],
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
vi.mock("../../lib/libraryDb", () => ({ LibraryDb: { clearLocalCache: async () => undefined } }));
vi.mock("../../lib/assets", () => ({ clearAssetUrlCache: () => undefined }));
vi.mock("../../lib/pairing/deviceWatch", () => ({ forgetKnownSessions: async () => undefined }));
vi.mock("../../lib/onboarding", () => ({
  clearLibraryKey: async () => undefined,
  keptKeyOwnerStore: { read: async () => null, write: async () => undefined, forget: async () => undefined },
}));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getMe: () => new Promise<{ user: TestUser }>(() => undefined),
    login: async () => {
      throw new Error("not used");
    },
    logout: async (token: string) => {
      ctl.logouts.push(token);
    },
  };
});

const { AuthProvider, useAuth } = await import("../../store/auth");

const PAIRED_USER: TestUser = { id: "u9", email: "tv@example.com", displayName: "TV owner" };

type Observed = { loading: boolean; token: string | null; userName: string | null };
let renderer: ReactTestRenderer | null = null;
let observed: Observed | null = null;
let setSessionFn: ((token: string, user: TestUser) => Promise<void>) | null = null;
let logoutFn: ((reason: "signOut") => Promise<void>) | null = null;

const Probe = () => {
  const { loading, token, user, setSession, logout } = useAuth();
  observed = { loading, token, userName: (user as TestUser | null)?.displayName ?? null };
  setSessionFn = setSession as unknown as (token: string, user: TestUser) => Promise<void>;
  logoutFn = logout;
  return null;
};

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.storage.clear();
  ctl.logouts.length = 0;
  observed = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await act(async () => {
    renderer = create(React.createElement(AuthProvider, null, React.createElement(Probe)));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("auth setSession (device pairing)", () => {
  it("starts signed out, then signs in with the paired token and user and saves both like a login", async () => {
    console.info("[tv-auth:phase] before", { observed, storage: [...ctl.storage.keys()] });
    expect(observed).toEqual({ loading: false, token: null, userName: null });

    await act(async () => {
      await setSessionFn?.("paired-token", PAIRED_USER);
    });
    await flush();
    console.info("[tv-auth:phase] after", { observed, storage: Object.fromEntries(ctl.storage) });

    expect(observed).toEqual({ loading: false, token: "paired-token", userName: "TV owner" });
    expect(ctl.storage.get("sf_auth_token")).toBe("paired-token");
    expect(JSON.parse(ctl.storage.get("sf_auth_user") ?? "null")).toEqual(PAIRED_USER);
  });

  it("can sign the paired session out again, clearing what it saved and revoking the token", async () => {
    await act(async () => {
      await setSessionFn?.("paired-token", PAIRED_USER);
    });
    await flush();
    await act(async () => {
      await logoutFn?.("signOut");
    });
    await flush();

    expect(observed).toEqual({ loading: false, token: null, userName: null });
    expect(ctl.storage.has("sf_auth_token")).toBe(false);
    expect(ctl.storage.has("sf_auth_user")).toBe(false);
    expect(ctl.logouts).toEqual(["paired-token"]);
  });
});
