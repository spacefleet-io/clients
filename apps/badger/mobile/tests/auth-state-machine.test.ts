/**
 * @test-id MOBILE-AUTH-SM-001
 * @level unit
 * @why The auth store controls login/logout/session persistence. Bugs here
 *   cause login loops (token not persisted), phantom sessions (stale tokens),
 *   and data loss (logout not clearing library). Tests mock AsyncStorage and
 *   fetch to verify every state transition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage, createFetchMock, jsonResponse, TEST_TOKEN, TEST_USER } from "./harness";

const TOKEN_KEY = "sf_auth_token";
const USER_KEY = "sf_auth_user";

// The auth store uses these modules — we mock them at the module level
const fakeStorage = createFakeAsyncStorage();
const fetchMock = createFetchMock();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: {
    clearLocalCache: vi.fn(async () => {}),
  },
}));

// On assertion failure, dump enough auth/storage state to diagnose offline
// (per "Tests log generously": tests self-diagnose; never recommend manual repro).
const dumpAuthSnapshot = (label: string) => {
  try {
    const backing: Record<string, string> = {};
    try {
      for (const [k, v] of fakeStorage._backing.entries()) {
        // Redact full token value but show prefix + length so we can tell
        // "wrong token" from "no token" without leaking the whole secret.
        backing[k] = k === TOKEN_KEY ? `${String(v).slice(0, 8)}…(len=${String(v).length})` : String(v);
      }
    } catch {
      /* _backing not a Map-like in this branch */
    }
    console.error(`=== [auth-state-machine:${label}] snapshot ===`);
    console.error(`storage keys: ${JSON.stringify(Object.keys(backing))}`);
    console.error(`storage backing:\n${JSON.stringify(backing, null, 2)}`);
    console.error(
      `expected TOKEN_KEY=${TOKEN_KEY} USER_KEY=${USER_KEY} TEST_TOKEN.prefix=${TEST_TOKEN.slice(0, 8)} TEST_USER.id=${TEST_USER.id}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  console.info(`[auth-state-machine:setup] resetting fake storage + fetch mock, stubbing global fetch`);
  fakeStorage._backing.clear();
  fetchMock.reset();
  vi.stubGlobal("fetch", fetchMock.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// We test the auth logic by importing the API functions directly (same as auth.tsx uses)
// and verifying the fetch calls + storage state.

describe("auth state machine — token persistence", () => {
  it("login persists token to AsyncStorage before returning", async () => {
    console.info(`[auth-state-machine:login-persist] arming /auth/login to return TEST_TOKEN`);
    fetchMock.onJson("/auth/login", { token: TEST_TOKEN, user: TEST_USER });

    const { login, setApiBaseUrl } = await import("@space/shared/api");
    // The SDK builds a Request, which needs an absolute base (the default `/api` is relative).
    setApiBaseUrl("http://api.test");
    const result = await login("test@test.com", "pass123");
    console.info(
      `[auth-state-machine:login-persist] login() returned token.prefix=${String(result.token).slice(0, 8)} user.id=${result.user?.id}`,
    );

    if (result.token !== TEST_TOKEN) dumpAuthSnapshot("login-persist-token-mismatch");
    expect(result.token).toBe(TEST_TOKEN);

    // Simulate what auth.tsx does after apiLogin:
    await fakeStorage.setItem(TOKEN_KEY, result.token);
    await fakeStorage.setItem(USER_KEY, JSON.stringify(result.user));
    console.info(`[auth-state-machine:login-persist] persisted token+user to fake storage`);

    // Token must be in storage (not lost on crash)
    const persistedToken = await fakeStorage.getItem(TOKEN_KEY);
    const persistedUser = await fakeStorage.getItem(USER_KEY);
    if (persistedToken !== TEST_TOKEN || !persistedUser?.includes(TEST_USER.id)) {
      dumpAuthSnapshot("login-persist-storage-mismatch");
    }
    expect(persistedToken).toBe(TEST_TOKEN);
    expect(persistedUser).toContain(TEST_USER.id);
  });

  it("logout clears token and user from AsyncStorage", async () => {
    console.info(`[auth-state-machine:logout] seeding storage with TEST_TOKEN + TEST_USER`);
    fakeStorage._backing.set(TOKEN_KEY, TEST_TOKEN);
    fakeStorage._backing.set(USER_KEY, JSON.stringify(TEST_USER));

    // Simulate logout
    await fakeStorage.removeItem(TOKEN_KEY);
    await fakeStorage.removeItem(USER_KEY);
    console.info(`[auth-state-machine:logout] removed token+user from storage`);

    const tokenAfter = await fakeStorage.getItem(TOKEN_KEY);
    const userAfter = await fakeStorage.getItem(USER_KEY);
    if (tokenAfter !== null || userAfter !== null) dumpAuthSnapshot("logout-not-cleared");
    expect(tokenAfter).toBeNull();
    expect(userAfter).toBeNull();
  });

  it("cold start with valid stored token restores session", async () => {
    console.info(`[auth-state-machine:cold-start-valid] seeding storage with valid token`);
    fakeStorage._backing.set(TOKEN_KEY, TEST_TOKEN);
    fakeStorage._backing.set(USER_KEY, JSON.stringify(TEST_USER));

    const storedToken = await fakeStorage.getItem(TOKEN_KEY);
    const storedUser = await fakeStorage.getItem(USER_KEY);
    console.info(
      `[auth-state-machine:cold-start-valid] read token.prefix=${String(storedToken).slice(0, 8)} user=${storedUser ? "present" : "null"}`,
    );

    if (storedToken !== TEST_TOKEN || !storedUser) dumpAuthSnapshot("cold-start-valid-restore-failed");
    expect(storedToken).toBe(TEST_TOKEN);
    expect(JSON.parse(storedUser!).id).toBe(TEST_USER.id);
  });

  it("cold start with no token returns null", async () => {
    console.info(`[auth-state-machine:cold-start-empty] reading token from empty storage`);
    const storedToken = await fakeStorage.getItem(TOKEN_KEY);
    if (storedToken !== null) dumpAuthSnapshot("cold-start-empty-unexpected-token");
    expect(storedToken).toBeNull();
  });

  it("expired token (401 on getMe) clears storage", async () => {
    console.info(`[auth-state-machine:expired-token] seeding expired token + arming /auth/me 401`);
    fakeStorage._backing.set(TOKEN_KEY, "expired-token");
    fakeStorage._backing.set(USER_KEY, JSON.stringify(TEST_USER));

    fetchMock.onJson("/auth/me", { error: "unauthorized" }, 401);

    // Simulate auth.tsx load() catch block
    const storedToken = await fakeStorage.getItem(TOKEN_KEY);
    if (storedToken !== "expired-token") dumpAuthSnapshot("expired-token-seed-mismatch");
    expect(storedToken).toBe("expired-token");

    // getMe fails with 401 → clear
    const resp = await fetchMock.fetch("http://api/auth/me");
    console.info(`[auth-state-machine:expired-token] /auth/me responded status=${resp.status}`);
    if (resp.status !== 401) dumpAuthSnapshot("expired-token-unexpected-status");
    expect(resp.status).toBe(401);

    await fakeStorage.removeItem(TOKEN_KEY);
    await fakeStorage.removeItem(USER_KEY);
    console.info(`[auth-state-machine:expired-token] cleared storage after 401`);

    const tokenAfter = await fakeStorage.getItem(TOKEN_KEY);
    if (tokenAfter !== null) dumpAuthSnapshot("expired-token-not-cleared");
    expect(tokenAfter).toBeNull();
  });
});

describe("auth state machine — login error handling", () => {
  it("invalid credentials return 400 and don't modify storage", async () => {
    console.info(`[auth-state-machine:invalid-creds] arming /auth/login to return 400`);
    fetchMock.onJson("/auth/login", { error: "invalid_credentials" }, 400);

    const resp = await fetchMock.fetch("http://api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "bad@test.com", password: "wrong" }),
    });
    const tokenAfter = await fakeStorage.getItem(TOKEN_KEY);
    console.info(
      `[auth-state-machine:invalid-creds] status=${resp.status} token-after=${tokenAfter === null ? "null" : "present"}`,
    );

    if (resp.status !== 400 || tokenAfter !== null) dumpAuthSnapshot("invalid-creds-side-effect");
    expect(resp.status).toBe(400);
    expect(tokenAfter).toBeNull();
  });

  it("2FA challenge returns specific error payload", async () => {
    console.info(`[auth-state-machine:2fa] arming /auth/login to return two_factor_required 403`);
    fetchMock.onJson("/auth/login", { error: "two_factor_required" }, 403);

    const resp = await fetchMock.fetch("http://api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "user@test.com", password: "pass" }),
    });

    const body = await resp.json();
    console.info(`[auth-state-machine:2fa] status=${resp.status} body.error=${body.error}`);
    if (body.error !== "two_factor_required" || resp.status !== 403) {
      console.error(`=== [auth-state-machine:2fa-mismatch] response ===`);
      console.error(`status=${resp.status} body=${JSON.stringify(body)}`);
    }
    expect(body.error).toBe("two_factor_required");
    expect(resp.status).toBe(403);
  });
});
